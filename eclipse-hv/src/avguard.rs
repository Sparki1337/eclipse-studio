//! Временные исключения Защитника Windows на время игровой сессии.
//! Снимаются только пути, добавленные лаунчером; следы прерванной сессии подчищает следующий запуск.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use crate::{avcheck, hvlog, process, rtcore};

/// Ключ реестра со списком путей, которые нужно снять после сессии.
const STATE_KEY: &str = r"SOFTWARE\Eclipse Studio\Hypervisor\Defender";

const STATE_VALUE: &str = "AddedPaths";

/// Предельное время выполнения служебного скрипта PowerShell.
const PS_TIMEOUT_MS: u64 = 45_000;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ActionOutput {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub failed_removals: Vec<(String, String)>,
    pub failed_additions: Vec<(String, String)>,
}

#[derive(Debug, Default)]
pub struct AvGuard {
    added: Vec<String>,
    pending: Vec<String>,
}

impl AvGuard {
    /// Добавляет недостающие пути в исключения защиты; чужие исключения не трогаются.
    /// Сбои только журналируются и не прерывают конвейер запуска.
    pub fn arm(defender: &avcheck::DefenderState, targets: &[PathBuf]) -> Self {
        let mut guard = Self::default();

        if !defender.probed {
            hvlog!(
                Warn,
                "антивирус",
                "состояние защиты не опрошено: временные исключения не добавляются"
            );
            return guard;
        }
        if !defender.present {
            hvlog!(Info, "антивирус", "Защитник Windows не установлен: исключения не требуются");
            return guard;
        }
        if !defender.realtime_enabled {
            // Исключения бессмысленны при выключенной защите (в т.ч. при стороннем антивирусе)
            hvlog!(
                Info,
                "антивирус",
                "защита в реальном времени выключена: исключения Защитника не требуются"
            );
            return guard;
        }

        // Следы принудительно завершённой сессии снимаются перед добавлением новых
        let stale = read_state();
        if !stale.is_empty() {
            hvlog!(
                Warn,
                "антивирус",
                "найдены исключения прерванной сессии ({}): снимаем перед запуском",
                stale.len()
            );
        }

        // Следы прошлой сессии не считаются исключениями пользователя — иначе нужные пути останутся без защиты
        let remaining = without_stale(&defender.exclusions, &stale);

        let missing = missing_targets(targets, &remaining);
        if stale.is_empty() && missing.is_empty() {
            hvlog!(
                Info,
                "антивирус",
                "каталог лаунчера уже в исключениях, изменения не требуются"
            );
            return guard;
        }

        let add: Vec<String> = missing
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect();

        // Снятие старых путей и добавление новых — одним вызовом
        let output = match run_script(&build_script(&stale, &add)) {
            Ok(text) => parse_action_output(&text),
            Err(cause) => {
                // Состояние в реестре не трогаем — повторит следующая сессия
                hvlog!(Warn, "антивирус", "не удалось изменить исключения защиты: {cause}");
                return guard;
            }
        };

        for path in &output.added {
            hvlog!(Info, "антивирус", "путь добавлен в исключения на время сессии: {path}");
        }
        for path in &output.removed {
            hvlog!(Info, "антивирус", "исключение прошлой сессии снято: {path}");
        }

        // Неудачные снятия — на повтор; добавленные пути — на очистку при завершении
        let mut state = output
            .failed_removals
            .iter()
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        for (path, message) in &output.failed_additions {
            hvlog!(Warn, "антивирус", "путь не добавлен в исключения: {path}: {message}");
        }
        state.extend(output.added.iter().cloned());

        guard.added = output.added;
        guard.pending = output.failed_removals.into_iter().map(|(path, _)| path).collect();
        save_state(&state);

        guard
    }

    /// Признак того, что лаунчер действительно изменил исключения защиты.
    pub fn active(&self) -> bool {
        !self.added.is_empty()
    }

    pub fn added(&self) -> &[String] {
        &self.added
    }

    /// Снимает добавленные лаунчером исключения; неснятое повторит следующая сессия.
    pub fn disarm(&mut self) {
        let mut targets = self.added.clone();
        targets.extend(self.pending.iter().cloned());
        targets.sort();
        targets.dedup();

        // Повторный вызов не должен ничего делать
        self.added.clear();
        self.pending.clear();
        if targets.is_empty() {
            return;
        }

        let output = match run_script(&build_script(&targets, &[])) {
            Ok(text) => parse_action_output(&text),
            Err(cause) => {
                // Состояние в реестре уже содержит пути — их снимет следующая сессия
                hvlog!(Warn, "антивирус", "не удалось снять временные исключения: {cause}");
                return;
            }
        };

        for path in &output.removed {
            hvlog!(Info, "антивирус", "временное исключение снято: {path}");
        }
        for (path, message) in &output.failed_removals {
            hvlog!(Warn, "антивирус", "исключение не снято, повтор при следующем запуске: {path}: {message}");
        }

        let leftover = output
            .failed_removals
            .iter()
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        save_state(&leftover);
    }
}

/// Пути, которые лаунчер исключает на время сессии.
pub fn default_targets(base_dir: &Path) -> Vec<PathBuf> {
    let mut targets = Vec::new();

    // Сам лаунчер: его файл и каталог, где лежит игра
    if let Ok(exe_path) = std::env::current_exe() {
        targets.push(exe_path);
    }
    targets.push(base_dir.to_path_buf());

    // Временный каталог сессии: сюда развёртывается драйвер RTCore64.sys
    targets.push(rtcore::session_temp_dir());

    targets
}

fn without_stale(exclusions: &[String], stale: &[String]) -> Vec<String> {
    let stale_keys: HashSet<String> = stale
        .iter()
        .map(|path| avcheck::normalize(path))
        .collect();

    exclusions
        .iter()
        .filter(|path| !stale_keys.contains(&avcheck::normalize(path)))
        .cloned()
        .collect()
}

/// Отбирает пути, которые ещё не покрыты исключениями пользователя.
fn missing_targets(targets: &[PathBuf], exclusions: &[String]) -> Vec<PathBuf> {
    let mut result: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for target in targets {
        if !is_safe_target(target) {
            hvlog!(
                Warn,
                "антивирус",
                "путь пропущен как слишком широкий для исключения: {}",
                target.display()
            );
            continue;
        }

        let key = avcheck::normalize(&target.to_string_lossy());
        if !seen.insert(key) {
            continue;
        }
        if avcheck::path_is_excluded(target, exclusions) {
            hvlog!(
                Debug,
                "антивирус",
                "путь уже покрыт исключением пользователя: {}",
                target.display()
            );
            continue;
        }
        result.push(target.clone());
    }

    result
}

/// Корень диска исключать нельзя — это отключило бы проверку почти для всей системы.
fn is_safe_target(path: &Path) -> bool {
    path.is_absolute() && avcheck::normalize(&path.to_string_lossy()).len() > 3
}

/// Формирует скрипт PowerShell: снятие и добавление исключений.
fn build_script(remove: &[String], add: &[String]) -> String {
    format!(
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n\
         $ErrorActionPreference = 'Continue'\n\
         $remove = @({})\n\
         $add = @({})\n\
         foreach ($p in $remove) {{\n\
           try {{ Remove-MpPreference -ExclusionPath $p -ErrorAction Stop; Write-Output ('REMOVED=' + $p) }}\n\
           catch {{ Write-Output ('REMFAIL=' + $p + '|' + $_.Exception.Message) }}\n\
         }}\n\
         foreach ($p in $add) {{\n\
           try {{ Add-MpPreference -ExclusionPath $p -ErrorAction Stop; Write-Output ('ADDED=' + $p) }}\n\
           catch {{ Write-Output ('ADDFAIL=' + $p + '|' + $_.Exception.Message) }}\n\
         }}",
        ps_array(remove),
        ps_array(add)
    )
}

fn ps_array(values: &[String]) -> String {
    values
        .iter()
        .map(|value| format!("'{}'", ps_quote(value)))
        .collect::<Vec<_>>()
        .join(",")
}

fn ps_quote(value: &str) -> String {
    value.replace('\'', "''")
}

fn run_script(script: &str) -> Result<String, String> {
    let output = process::run_capture_timeout(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
        PS_TIMEOUT_MS,
    )?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Разбирает построчный вывод скрипта исключений.
pub fn parse_action_output(text: &str) -> ActionOutput {
    let mut output = ActionOutput::default();

    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("ADDED=") {
            push_unique(&mut output.added, value);
        } else if let Some(value) = line.strip_prefix("REMOVED=") {
            push_unique(&mut output.removed, value);
        } else if let Some(value) = line.strip_prefix("REMFAIL=") {
            if let Some(item) = split_failure(value) {
                output.failed_removals.push(item);
            }
        } else if let Some(value) = line.strip_prefix("ADDFAIL=") {
            if let Some(item) = split_failure(value) {
                output.failed_additions.push(item);
            }
        }
    }

    output
}

fn split_failure(value: &str) -> Option<(String, String)> {
    let (path, message) = value.split_once('|')?;
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    Some((path.to_string(), message.trim().to_string()))
}

/// Добавляет путь без повторов (сравнение без учёта регистра).
fn push_unique(list: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    let key = avcheck::normalize(value);
    if list.iter().any(|item| avcheck::normalize(item) == key) {
        return;
    }
    list.push(value.to_string());
}

fn read_state() -> Vec<String> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(STATE_KEY) else {
        return Vec::new();
    };
    let mut state = key.get_value::<Vec<String>, _>(STATE_VALUE).unwrap_or_default();
    state.retain(|path| !path.trim().is_empty());
    state
}

fn save_state(paths: &[String]) {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    if paths.is_empty() {
        clear_state();
        return;
    }

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let Ok((key, _)) = hklm.create_subkey(STATE_KEY) else {
        hvlog!(Warn, "антивирус", "не удалось создать ключ состояния исключений в реестре");
        return;
    };

    let list = paths.to_vec();
    if let Err(cause) = key.set_value(STATE_VALUE, &list) {
        hvlog!(Warn, "антивирус", "не удалось сохранить список исключений в реестре: {cause}");
        return;
    }
    let _ = key.set_value("Timestamp", &crate::sys::timestamp());
}

fn clear_state() {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let _ = RegKey::predef(HKEY_LOCAL_MACHINE).delete_subkey_all(STATE_KEY);
}

/// Исключения, оставшиеся от прерванной сессии (для отчёта `--status`).
pub fn stale_paths() -> Vec<String> {
    read_state()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn экранирование_кавычек_в_пути() {
        assert_eq!(ps_quote(r"C:\Games\STAR WARS"), r"C:\Games\STAR WARS");
        assert_eq!(ps_quote(r"D:\It's game"), r"D:\It''s game");
    }

    #[test]
    fn массив_powershell_собирается_из_путей() {
        let list = vec![r"C:\Games\Game".to_string(), r"D:\O'Neil".to_string()];
        assert_eq!(ps_array(&list), r"'C:\Games\Game','D:\O''Neil'");
        assert_eq!(ps_array(&[]), "");
    }

    #[test]
    fn скрипт_содержит_обе_операции() {
        let script = build_script(&[r"C:\Old".to_string()], &[r"C:\Games\Game".to_string()]);
        assert!(script.contains("Remove-MpPreference"));
        assert!(script.contains("Add-MpPreference"));
        assert!(script.contains(r"'C:\Old'"));
        assert!(script.contains(r"'C:\Games\Game'"));
        // Пустые списки не ломают синтаксис
        let script = build_script(&[], &[]);
        assert!(script.contains("$remove = @()"));
        assert!(script.contains("$add = @()"));
    }

    #[test]
    fn разбор_вывода_операций() {
        let text = "ADDED=C:\\Games\\Game\r\nREMOVED=C:\\Old\r\n\
                    ADDFAIL=C:\\Locked|Access is denied\r\nREMFAIL=D:\\Broken|timeout\r\nмусор\n";
        let output = parse_action_output(text);
        assert_eq!(output.added, vec![r"C:\Games\Game".to_string()]);
        assert_eq!(output.removed, vec![r"C:\Old".to_string()]);
        assert_eq!(
            output.failed_additions,
            vec![(r"C:\Locked".to_string(), "Access is denied".to_string())]
        );
        assert_eq!(
            output.failed_removals,
            vec![(r"D:\Broken".to_string(), "timeout".to_string())]
        );

        // Повторы путей не дублируются, лишние строки игнорируются
        let output = parse_action_output("ADDED=C:\\Game\nADDED=c:\\game\n\n");
        assert_eq!(output.added.len(), 1);

        // Пустой ответ не считается сбоем
        assert_eq!(parse_action_output(""), ActionOutput::default());
        // Строка сбоя без разделителя отбрасывается
        let output = parse_action_output("ADDFAIL=без_разделителя\n");
        assert!(output.failed_additions.is_empty());
    }

    #[test]
    fn пустой_скрипт_выполняется_без_изменений() {
        // Настройки защиты не меняются; проверяется лишь принимаемость скрипта PowerShell
        let text = run_script(&build_script(&[], &[])).expect("скрипт должен выполниться");
        assert_eq!(parse_action_output(&text), ActionOutput::default());
    }

    #[test]
    fn следы_прошлой_сессии_не_считаются_исключениями_пользователя() {
        let exclusions = vec![r"C:\Games\Game".to_string(), r"D:\Tools".to_string()];
        let stale = vec![r"c:/games/game".to_string()];
        let remaining = without_stale(&exclusions, &stale);
        assert_eq!(remaining, vec![r"D:\Tools".to_string()]);

        // После снятия следа каталог снова требует исключения
        let missing = missing_targets(&[PathBuf::from(r"C:\Games\Game")], &remaining);
        assert_eq!(missing, vec![PathBuf::from(r"C:\Games\Game")]);

        // Без следов список исключений не меняется
        assert_eq!(without_stale(&exclusions, &[]), exclusions);
    }

    #[test]
    fn уже_исключённые_пути_не_добавляются() {
        let exclusions = vec![r"C:\Games\Game".to_string()];
        let targets = vec![
            PathBuf::from(r"C:\Games\Game"),
            PathBuf::from(r"C:\Games\Game\bin\game.exe"),
            PathBuf::from(r"D:\Tools\Eclipse-HV.exe"),
        ];
        let missing = missing_targets(&targets, &exclusions);
        assert_eq!(missing, vec![PathBuf::from(r"D:\Tools\Eclipse-HV.exe")]);
    }

    #[test]
    fn повторяющиеся_и_слишком_широкие_пути_отбрасываются() {
        let targets = vec![
            PathBuf::from(r"C:\Games\Game"),
            PathBuf::from("c:/games/game"),
            PathBuf::from(r"C:\"),
            PathBuf::from(""),
        ];
        let missing = missing_targets(&targets, &[]);
        assert_eq!(missing, vec![PathBuf::from(r"C:\Games\Game")]);
        assert!(!is_safe_target(Path::new(r"C:\")));
        assert!(is_safe_target(Path::new(r"C:\Games\Game")));
    }
}
