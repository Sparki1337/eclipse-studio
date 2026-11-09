//! Поиск exe игры: явный путь → приоритетные лаунчеры → крупнейший бинарник.

use std::{fs, path::PathBuf};

use crate::hvlog;

const PRIORITY_LAUNCHER_NAMES: &[&str] = &[
    "hv-startgame.exe",
    "hypervisor-launcher.exe",
    "steamclient_loader_x64.exe",
    "launcher.exe",
    "hypervisorlauncher.exe",
];

/// Исключаемые из автопоиска служебные утилиты, краш-репортеры и установщики.
const EXCLUDED_EXE_PATTERNS: &[&str] = &[
    "eclipse-hv",
    "hv-launcher",
    "hv-plugnplay",
    "drvloader",
    "7zr",
    "7z",
    "unitycrashhandler",
    "crashreport",
    "crash_report",
    "crashreporter",
    "werfault",
    "unins",
    "uninstall",
    "setup.exe",
    "installer.exe",
    "vc_redist",
    "dxsetup",
    "epicgames",
    "epicwebhelper",
    "battleye",
    "easyanticheat",
];

/// Максимальная глубина сканирования подпапок.
const SCAN_DEPTH: usize = 4;

#[derive(Debug, Clone)]
pub struct SearchResult {
    pub exe: Option<PathBuf>,
    pub candidate_count: usize,
}

pub fn find_game_executable(root: &std::path::Path, explicit_target: Option<&PathBuf>) -> SearchResult {
    // Явно переданный путь (аргументом или перетаскиванием на файл)
    if let Some(target) = explicit_target {
        if target.is_file() {
            hvlog!(Info, "поиск", "использован явно переданный файл: {}", target.display());
            return SearchResult {
                exe: Some(target.clone()),
                candidate_count: 1,
            };
        }
        hvlog!(Warn, "поиск", "переданный путь не существует: {}", target.display());
    }

    // Приоритетные имена в корневом каталоге игры
    for name in PRIORITY_LAUNCHER_NAMES {
        let candidate = root.join(name);
        if candidate.is_file() && !is_excluded_exe(&candidate) {
            hvlog!(Info, "поиск", "найден приоритетный лаунчер в корне: {}", candidate.display());
            return SearchResult {
                exe: Some(candidate),
                candidate_count: 1,
            };
        }
    }

    // Рекурсивный сбор всех исполнимых файлов
    let mut all_exes = Vec::new();
    scan_directory_recursive(root, 0, &mut all_exes);
    hvlog!(Debug, "поиск", "собрано исполнимых файлов: {}", all_exes.len());

    // Приоритетные имена в подпапках
    for path in &all_exes {
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let lower = file_name.to_lowercase();
        if PRIORITY_LAUNCHER_NAMES.contains(&lower.as_str()) && !is_excluded_exe(path) {
            hvlog!(Info, "поиск", "найден приоритетный лаунчер в подпапке: {}", path.display());
            return SearchResult {
                exe: Some(path.clone()),
                candidate_count: all_exes.len(),
            };
        }
    }

    // Фильтрация валидных кандидатов
    let mut valid_candidates: Vec<(PathBuf, u64)> = all_exes
        .into_iter()
        .filter(|path| !is_excluded_exe(path))
        .filter_map(|path| fs::metadata(&path).ok().map(|meta| (path, meta.len())))
        .filter(|(_, size)| *size > 0)
        .collect();

    let candidate_count = valid_candidates.len();

    // Эвристика: главный бинарник игры обычно крупнейший
    valid_candidates.sort_by(|a, b| b.1.cmp(&a.1));
    if let Some((best_path, best_size)) = valid_candidates.into_iter().next() {
        hvlog!(
            Info,
            "поиск",
            "выбран файл по наибольшему размеру ({:.2} МБ): {}",
            best_size as f64 / (1024.0 * 1024.0),
            best_path.display()
        );
        return SearchResult {
            exe: Some(best_path),
            candidate_count,
        };
    }

    SearchResult {
        exe: None,
        candidate_count,
    }
}

fn scan_directory_recursive(dir: &std::path::Path, depth: usize, results: &mut Vec<PathBuf>) {
    if depth > SCAN_DEPTH {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            hvlog!(Debug, "поиск", "каталог недоступен: {} ({err})", dir.display());
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
                results.push(path);
            }
        } else if path.is_dir() {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_lowercase();

            // Служебные, скрытые и системные каталоги не сканируются
            let skipped = name.starts_with('.')
                || matches!(
                    name.as_str(),
                    "windows" | "temp" | "$recycle.bin" | "_commonredist" | "redist" | "support"
                        | "installers"
                );
            if !skipped {
                scan_directory_recursive(&path, depth + 1, results);
            }
        }
    }
}

fn is_excluded_exe(path: &std::path::Path) -> bool {
    // Сам запущенный лаунчер исключается вне зависимости от имени
    if let Ok(current_exe) = std::env::current_exe() {
        if path == current_exe {
            return true;
        }
    }

    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_lowercase();

    EXCLUDED_EXE_PATTERNS.iter().any(|pattern| name.contains(pattern))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("target")
            .join("eclipse-hv-tests")
            .join(tag);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Создаёт файл заданного размера.
    fn touch(path: &std::path::Path, size: usize) {
        fs::write(path, vec![0u8; size]).unwrap();
    }

    #[test]
    fn явный_путь_имеет_высший_приоритет() {
        let root = temp_root("explicit");
        let game = root.join("Game.exe");
        touch(&game, 4);

        let result = find_game_executable(&root, Some(&game));

        assert_eq!(result.exe, Some(game));
        assert_eq!(result.candidate_count, 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn выбирается_крупнейший_файл_без_служебных_имён() {
        let root = temp_root("biggest");
        touch(&root.join("small.exe"), 1024);
        touch(&root.join("big.exe"), 8192);
        touch(&root.join("uninstall.exe"), 65_536); // исключение по шаблону

        let result = find_game_executable(&root, None);

        assert_eq!(result.exe, Some(root.join("big.exe")));
        assert_eq!(result.candidate_count, 2); // служебный файл исключён из подсчёта
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn приоритетное_имя_в_корне_побеждает_размер() {
        let root = temp_root("priority");
        touch(&root.join("hv-startgame.exe"), 64);
        touch(&root.join("huge.exe"), 131_072);

        let result = find_game_executable(&root, None);

        assert_eq!(result.exe, Some(root.join("hv-startgame.exe")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn глубина_сканирования_ограничена() {
        let root = temp_root("depth");
        // Уровень 5 (глубже лимита 4): файл не должен быть найден
        let deep_dir = root
            .join("a")
            .join("b")
            .join("c")
            .join("d")
            .join("e");
        fs::create_dir_all(&deep_dir).unwrap();
        touch(&deep_dir.join("deep.exe"), 4096);

        let result = find_game_executable(&root, None);

        assert!(result.exe.is_none());
        assert_eq!(result.candidate_count, 0);
        let _ = fs::remove_dir_all(&root);
    }
}
