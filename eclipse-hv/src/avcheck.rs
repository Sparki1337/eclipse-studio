//! Проверка состояния Защитника Windows (только чтение).
//! Настройки не меняются: временные исключения ведёт [`crate::avguard`].

use std::path::Path;

use serde::Serialize;

use crate::{hvlog, process};

const BLOCKLIST_KEY: &str = r"SYSTEM\CurrentControlSet\Control\CI\Config";

const BLOCKLIST_VALUE: &str = "VulnerableDriverBlocklistEnable";

/// Результат опроса состояния защиты.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeOutput {
    pub present: bool,
    pub realtime: bool,
    pub exclusions: Vec<String>,
    pub products: Vec<String>,
}

/// Состояние Защитника Windows в отчёте и журнале.
#[derive(Debug, Clone, Default, Serialize)]
pub struct DefenderState {
    pub probed: bool,
    pub present: bool,
    pub realtime_enabled: bool,
    pub launcher_excluded: bool,
    pub exclusions: Vec<String>,
    pub blocklist_enabled: Option<bool>,
    pub products: Vec<String>,
    pub pending_cleanup: Vec<String>,
}

impl DefenderState {
    /// Сторонние антивирусы — частая причина блокировки RTCore64.sys.
    pub fn third_party_products(&self) -> Vec<String> {
        self.products
            .iter()
            .filter(|name| {
                let lower = name.to_lowercase();
                !(lower.contains("defender")
                    || lower.contains("защитник")
                    || lower.contains("windows security"))
            })
            .cloned()
            .collect()
    }
}

impl DefenderState {
    /// Предупреждение нужно, когда защита активна, а каталог лаунчера не в исключениях.
    pub fn should_warn(&self) -> bool {
        self.probed && self.present && self.realtime_enabled && !self.launcher_excluded
    }
}

/// Опрашивает состояние защиты и сопоставляет его с каталогом лаунчера.
pub fn inspect(launcher_dir: &Path) -> DefenderState {
    let mut state = DefenderState {
        blocklist_enabled: read_blocklist(),
        ..Default::default()
    };

    match probe() {
        Ok(output) => {
            state.probed = true;
            state.present = output.present;
            state.realtime_enabled = output.realtime;
            state.launcher_excluded = path_is_excluded(launcher_dir, &output.exclusions);
            state.exclusions = output.exclusions;
            state.products = output.products;
            if !state.products.is_empty() {
                hvlog!(
                    Debug,
                    "антивирус",
                    "продукты защиты: {}",
                    state.products.join(", ")
                );
            }
        }
        Err(err) => {
            hvlog!(Debug, "антивирус", "состояние защиты не опрошено: {err}");
        }
    }

    state
}

fn probe() -> Result<ProbeOutput, String> {
    // Скрипт только читает: статус, исключения, продукты Центра безопасности
    const SCRIPT: &str = "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n\
        $ErrorActionPreference = 'SilentlyContinue'\n\
        $status = Get-MpComputerStatus\n\
        if ($status) { Write-Output 'PRESENT=1'; Write-Output ('REALTIME=' + [int][bool]$status.RealTimeProtectionEnabled) } else { Write-Output 'PRESENT=0' }\n\
        $prefs = Get-MpPreference\n\
        if ($prefs -and $prefs.ExclusionPath) { $prefs.ExclusionPath | ForEach-Object { Write-Output ('EXCL=' + $_) } }\n\
        $av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct\n\
        if ($av) { $av | ForEach-Object { Write-Output ('AV=' + $_.displayName + '|' + [string]$_.productState) } }";

    let output = process::run_capture(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            SCRIPT,
        ],
    )?;

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    if text.trim().is_empty() {
        return Err("пустой ответ PowerShell".into());
    }
    Ok(parse_probe_output(&text))
}

pub fn parse_probe_output(text: &str) -> ProbeOutput {
    let mut output = ProbeOutput::default();

    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("PRESENT=") {
            output.present = value.trim() == "1";
        } else if let Some(value) = line.strip_prefix("REALTIME=") {
            output.realtime = value.trim() == "1";
        } else if let Some(value) = line.strip_prefix("EXCL=") {
            let path = value.trim();
            if !path.is_empty() {
                output.exclusions.push(path.to_string());
            }
        } else if let Some(value) = line.strip_prefix("AV=") {
            // Формат: «название|productState»; учитываются только включённые
            let (name, state) = value.split_once('|').unwrap_or((value, ""));
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            let enabled = state
                .trim()
                .parse::<u32>()
                .map(|state| state & 0x1000 != 0)
                .unwrap_or(true);
            if enabled {
                output.products.push(name.to_string());
            }
        }
    }

    output
}

/// Проверяет, покрывает ли хотя бы одно исключение указанный путь.
pub fn path_is_excluded(target: &Path, exclusions: &[String]) -> bool {
    let target = normalize(&target.to_string_lossy());
    if target.is_empty() {
        return false;
    }

    exclusions.iter().any(|raw| {
        let excluded = normalize(raw);
        if excluded.is_empty() {
            return false;
        }
        // Совпадение пути целиком либо вложенность в исключённый каталог
        target == excluded || target.starts_with(&format!("{excluded}\\"))
    })
}

/// Способ сравнения путей общий с модулем avguard.
pub(crate) fn normalize(value: &str) -> String {
    value
        .trim()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn read_blocklist() -> Option<bool> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(BLOCKLIST_KEY)
        .ok()
        .and_then(|key| key.get_value::<u32, _>(BLOCKLIST_VALUE).ok())
        .map(|value| value == 1)
}

pub fn summary_lines(state: &DefenderState) -> Vec<String> {
    let mut lines = Vec::new();

    if !state.probed {
        lines.push("Защитник Windows: состояние не определено (опрос недоступен)".to_string());
    } else if !state.present {
        lines.push("Защитник Windows: не установлен".to_string());
    } else {
        lines.push(format!(
            "Защитник Windows: {}",
            if state.realtime_enabled {
                "защита в реальном времени ВКЛЮЧЕНА"
            } else {
                "защита в реальном времени выключена"
            }
        ));
        lines.push(format!(
            "Каталог лаунчера в исключениях: {}",
            if state.launcher_excluded { "да" } else { "нет" }
        ));
    }

    if !state.pending_cleanup.is_empty() {
        lines.push(format!(
            "Исключения прерванной сессии: {} (будут сняты при следующем запуске)",
            state.pending_cleanup.len()
        ));
    }

    if !state.products.is_empty() {
        lines.push(format!("Продукты защиты: {}", state.products.join(", ")));
    }

    match state.blocklist_enabled {
        Some(true) => lines.push("Список уязвимых драйверов Microsoft: включён".to_string()),
        Some(false) => lines.push("Список уязвимых драйверов Microsoft: выключен".to_string()),
        None => lines.push("Список уязвимых драйверов Microsoft: состояние не определено".to_string()),
    }

    lines
}

pub fn log(state: &DefenderState) {
    for line in summary_lines(state) {
        hvlog!(Info, "антивирус", "{line}");
    }
}

pub const WARNING_TEXT: &str = "Защитник Windows активен (защита в реальном времени включена),\n\
    а каталог лаунчера не входит в исключения.\n\n\
    Лаунчер добавляет свои пути в исключения автоматически на время сессии,\n\
    но сейчас это не удалось: защита от изменений или политика системы\n\
    запрещают правку настроек защиты.\n\n\
    Драйвер RTCore64 входит в список уязвимых драйверов Microsoft, поэтому\n\
    загрузка драйвера может быть заблокирована — вы увидите отказ в доступе\n\
    (0x80070005).\n\n\
    Решение за вами:\n\
    • отключить проверку на время игровой сессии, либо\n\
    • добавить исключение вручную в настройках защиты.\n\n\
    Открыть настройки исключений Защитника Windows сейчас?";

pub const SETTINGS_URI: &str = "windowsdefender://threatsettings";

/// Похож ли текст сбоя на блокировку со стороны антивируса.
pub fn looks_like_av_block(cause: &str) -> bool {
    let lower = cause.to_lowercase();
    lower.contains("0x80070005")
        || lower.contains("отказано в доступе")
        || lower.contains("access is denied")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn разбор_вывода_опроса() {
        let text = "PRESENT=1\r\nREALTIME=1\r\nEXCL=C:\\Games\\STAR WARS Galactic Racer\r\nEXCL=D:\\Tools\r\n\
                    AV=ESET Security|266240\r\nAV=Windows Defender|0\r\n";
        let output = parse_probe_output(text);
        assert!(output.present);
        assert!(output.realtime);
        assert_eq!(output.exclusions.len(), 2);
        assert_eq!(output.exclusions[0], r"C:\Games\STAR WARS Galactic Racer");
        // ESET включён, Защитник Windows — нет
        assert_eq!(output.products, vec!["ESET Security".to_string()]);

        // Защита отсутствует
        let output = parse_probe_output("PRESENT=0\r\n");
        assert!(!output.present);
        assert!(!output.realtime);
        assert!(output.exclusions.is_empty());
        assert!(output.products.is_empty());

        let output = parse_probe_output("PRESENT=1\r\nREALTIME=0\r\n");
        assert!(output.present);
        assert!(!output.realtime);

        // Продукт без состояния считается включённым
        let output = parse_probe_output("AV=Kaspersky Internet Security\n");
        assert_eq!(output.products.len(), 1);

        // Пустой ответ: состояние не определяется
        let output = parse_probe_output("");
        assert!(!output.present);
    }

    #[test]
    fn сторонние_продукты_отделяются_от_защитника() {
        let state = DefenderState {
            products: vec![
                "ESET Security".to_string(),
                "Windows Defender".to_string(),
                "Защитник Windows".to_string(),
            ],
            ..Default::default()
        };
        assert_eq!(state.third_party_products(), vec!["ESET Security".to_string()]);

        let clean = DefenderState::default();
        assert!(clean.third_party_products().is_empty());
    }

    #[test]
    fn исключение_покрывает_каталог_лаунчера() {
        let exclusions = vec![r"C:\Games\STAR WARS Galactic Racer".to_string()];

        // Точное совпадение, вложенность, разный регистр, прямой слеш
        assert!(path_is_excluded(
            Path::new(r"C:\Games\STAR WARS Galactic Racer"),
            &exclusions
        ));
        assert!(path_is_excluded(
            Path::new(r"C:\Games\STAR WARS Galactic Racer\bin\x64"),
            &exclusions
        ));
        assert!(path_is_excluded(
            Path::new(r"c:\games\star wars galactic racer"),
            &exclusions
        ));
        assert!(path_is_excluded(
            Path::new("C:/Games/STAR WARS Galactic Racer"),
            &exclusions
        ));

        // Каталог не покрыт исключением
        assert!(!path_is_excluded(Path::new(r"C:\Games\Other Game"), &exclusions));
        assert!(!path_is_excluded(Path::new(r"C:\Games"), &exclusions));
        // Пустой список исключений
        assert!(!path_is_excluded(Path::new(r"C:\Games\Game"), &[]));
    }

    #[test]
    fn предупреждение_выводится_только_при_активной_защите() {
        let base = DefenderState {
            probed: true,
            present: true,
            realtime_enabled: true,
            launcher_excluded: false,
            exclusions: vec![],
            blocklist_enabled: Some(true),
            products: vec![],
            pending_cleanup: vec![],
        };
        assert!(base.should_warn());

        // Каталог уже исключён пользователем
        let excluded = DefenderState { launcher_excluded: true, ..base.clone() };
        assert!(!excluded.should_warn());

        // Защита в реальном времени выключена
        let disabled = DefenderState { realtime_enabled: false, ..base.clone() };
        assert!(!disabled.should_warn());

        // Защитник не установлен
        let absent = DefenderState { present: false, ..base.clone() };
        assert!(!absent.should_warn());

        // Опрос не удался
        let unprobed = DefenderState { probed: false, ..base };
        assert!(!unprobed.should_warn());
    }

    #[test]
    fn сбой_блокировки_распознаётся() {
        assert!(looks_like_av_block("StartServiceW: Отказано в доступе. (0x80070005)"));
        assert!(looks_like_av_block("Access is denied."));
        assert!(!looks_like_av_block("IOCTL 0x80002048 отклонён драйвером"));
    }

    #[test]
    fn сводка_описывает_состояние() {
        let state = DefenderState {
            probed: true,
            present: true,
            realtime_enabled: true,
            launcher_excluded: false,
            exclusions: vec![],
            blocklist_enabled: Some(true),
            products: vec!["ESET Security".to_string()],
            pending_cleanup: vec![r"C:\Games\Game".to_string()],
        };
        let text = summary_lines(&state).join("\n");
        assert!(text.contains("ВКЛЮЧЕНА"));
        assert!(text.contains("в исключениях: нет"));
        assert!(text.contains("Список уязвимых драйверов Microsoft: включён"));
        assert!(text.contains("Исключения прерванной сессии: 1"));
        assert!(text.contains("Продукты защиты: ESET Security"));

        let unprobed = DefenderState::default();
        let text = summary_lines(&unprobed).join("\n");
        assert!(text.contains("состояние не определено"));
    }
}
