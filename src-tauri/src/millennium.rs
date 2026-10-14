use crate::{luatools::resolve_steam_path, models::OperationResult};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const PLUGIN_FOLDER_NAME: &str = "eclipse-manifest";
const BUNDLED_PLUGIN_VERSION: &str = "0.5.0";

const EMBEDDED_MILLENNIUM_FILES: &[(&str, &[u8])] = &[
    ("wsock32.dll", include_bytes!("../../millenium/wsock32.dll")),
    (
        "millennium/bin/millennium.crashhandler64.exe",
        include_bytes!("../../millenium/millennium/bin/millennium.crashhandler64.exe"),
    ),
    (
        "millennium/bin/millennium.luavm64.exe",
        include_bytes!("../../millenium/millennium/bin/millennium.luavm64.exe"),
    ),
    (
        "millennium/lib/millennium.dll",
        include_bytes!("../../millenium/millennium/lib/millennium.dll"),
    ),
    (
        "millennium/lib/millennium.hhx64.dll",
        include_bytes!("../../millenium/millennium/lib/millennium.hhx64.dll"),
    ),
];

const EMBEDDED_PLUGIN_FILES: &[(&str, &[u8])] = &[
    (
        "plugin.json",
        include_bytes!("assets/eclipse-manifest/plugin.json"),
    ),
    (
        "backend/main.lua",
        include_bytes!("assets/eclipse-manifest/backend/main.lua"),
    ),
    (
        ".millennium/Dist/index.js",
        include_bytes!("assets/eclipse-manifest/.millennium/Dist/index.js"),
    ),
    (
        ".millennium/Dist/webkit.js",
        include_bytes!("assets/eclipse-manifest/.millennium/Dist/webkit.js"),
    ),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MillenniumPluginStatus {
    pub steam_path: Option<String>,
    pub millennium_installed: bool,
    pub millennium_path: Option<String>,
    pub plugin_path: Option<String>,
    pub plugin_installed: bool,
    pub plugin_current: bool,
    pub plugin_version: Option<String>,
    pub bundled_version: String,
    pub legacy_croclua_found: bool,
    pub legacy_croclua_path: Option<String>,
    pub legacy_croclua_name: Option<String>,
    pub status: String,
    pub message: String,
}

fn millennium_dir(steam: &Path) -> PathBuf {
    steam.join("millennium")
}

fn plugin_dir(steam: &Path) -> PathBuf {
    millennium_dir(steam)
        .join("plugins")
        .join(PLUGIN_FOLDER_NAME)
}

// Поиск устаревших папок плагина CrocLua (Crocodile Manifest)
fn find_legacy_croclua_plugins(steam: &Path) -> Vec<PathBuf> {
    let plugins_dir = millennium_dir(steam).join("plugins");
    if !plugins_dir.is_dir() {
        return Vec::new();
    }
    let mut matches = Vec::new();
    let entries = match fs::read_dir(&plugins_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let folder_name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if folder_name == PLUGIN_FOLDER_NAME {
            continue;
        }
        if folder_name == "crocodile-manifest"
            || folder_name == "croclua"
            || folder_name == "croc-manifest"
            || folder_name == "crocodile-lua"
        {
            matches.push(path);
            continue;
        }
        let plugin_json = path.join("plugin.json");
        if plugin_json.is_file() {
            if let Ok(data) = fs::read(&plugin_json) {
                if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&data) {
                    let name = val
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    let common_name = val
                        .get("common_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if name == "crocodile-manifest"
                        || name == "croclua"
                        || name == "croc-manifest"
                        || common_name.contains("crocodile")
                        || common_name.contains("croclua")
                    {
                        matches.push(path);
                    }
                }
            }
        }
    }
    matches
}

fn millennium_is_installed(steam: &Path) -> bool {
    (steam.join("wsock32.dll").is_file()
        && millennium_dir(steam)
            .join("lib")
            .join("millennium.dll")
            .is_file()
        && millennium_dir(steam)
            .join("bin")
            .join("millennium.luavm64.exe")
            .is_file())
        || steam.join("millennium.dll").is_file()
        || steam.join("user32.dll").is_file()
}

fn installed_plugin_version(plugin: &Path) -> Option<String> {
    let data = fs::read(plugin.join("plugin.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&data).ok()?;
    value
        .get("version")
        .and_then(|version| version.as_str())
        .map(str::to_owned)
}

fn installed_plugin_name(plugin: &Path) -> Option<String> {
    let data = fs::read(plugin.join("plugin.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&data).ok()?;
    value
        .get("name")
        .and_then(|name| name.as_str())
        .map(str::to_owned)
}

fn status_for(steam_path: Option<String>) -> MillenniumPluginStatus {
    let Some(steam) = resolve_steam_path(steam_path) else {
        return MillenniumPluginStatus {
            steam_path: None,
            millennium_installed: false,
            millennium_path: None,
            plugin_path: None,
            plugin_installed: false,
            plugin_current: false,
            plugin_version: None,
            bundled_version: BUNDLED_PLUGIN_VERSION.into(),
            legacy_croclua_found: false,
            legacy_croclua_path: None,
            legacy_croclua_name: None,
            status: "steam_missing".into(),
            message: "Сначала укажите папку Steam".into(),
        };
    };

    let millennium = millennium_dir(&steam);
    let plugin = plugin_dir(&steam);
    let millennium_installed = millennium_is_installed(&steam);
    let plugin_version = installed_plugin_version(&plugin);
    let plugin_installed = plugin.join("plugin.json").is_file();
    let plugin_current = plugin_version.as_deref() == Some(BUNDLED_PLUGIN_VERSION);

    let legacy_croclua_paths = find_legacy_croclua_plugins(&steam);
    let legacy_croclua_found = !legacy_croclua_paths.is_empty();
    let legacy_croclua_path = legacy_croclua_paths.first().map(|p| p.display().to_string());
    let legacy_croclua_name = legacy_croclua_paths.first().and_then(|p| {
        installed_plugin_name(p).or_else(|| p.file_name().map(|f| f.to_string_lossy().to_string()))
    });

    let (status, message) = if !steam.join("steam.exe").is_file() {
        ("steam_invalid", "В выбранной папке не найден steam.exe")
    } else if !millennium_installed {
        (
            "millennium_missing",
            "Millennium не установлен. Программа может установить встроенные файлы напрямую в Steam",
        )
    } else if legacy_croclua_found && !plugin_installed {
        (
            "croclua_detected",
            "Обнаружен устаревший плагин CrocLua (Crocodile Manifest). Рекомендуется удалить его и установить Eclipse Manifest",
        )
    } else if !plugin_installed {
        (
            "plugin_missing",
            "Millennium найден — плагин готов к установке",
        )
    } else if !plugin_current {
        (
            "update_available",
            "Доступна новая встроенная версия плагина",
        )
    } else {
        ("ready", "Eclipse Manifest установлен и готов к работе")
    };

    MillenniumPluginStatus {
        steam_path: Some(steam.display().to_string()),
        millennium_installed,
        millennium_path: Some(millennium.display().to_string()),
        plugin_path: Some(plugin.display().to_string()),
        plugin_installed,
        plugin_current,
        plugin_version,
        bundled_version: BUNDLED_PLUGIN_VERSION.into(),
        legacy_croclua_found,
        legacy_croclua_path,
        legacy_croclua_name,
        status: status.into(),
        message: message.into(),
    }
}

#[tauri::command]
pub fn millennium_plugin_status(steam_path: Option<String>) -> MillenniumPluginStatus {
    status_for(steam_path)
}

#[tauri::command]
pub fn millennium_install_plugin(steam_path: Option<String>) -> OperationResult {
    let Some(steam) = resolve_steam_path(steam_path) else {
        return OperationResult::error("Папка Steam не найдена", vec![]);
    };
    if !steam.join("steam.exe").is_file() {
        return OperationResult::error("steam.exe не найден в выбранной папке", vec![]);
    }
    if !millennium_is_installed(&steam) {
        return OperationResult::error(
            "Millennium не установлен. Сначала установите встроенный комплект Millennium",
            vec![],
        );
    }

    let target_root = plugin_dir(&steam);
    let previous_version = installed_plugin_version(&target_root);
    let mut logs = Vec::new();
    let mut changed = 0_u32;

    // Автоматическое удаление устаревшей папки crocodile-manifest при миграции
    let legacy_plugin = millennium_dir(&steam).join("plugins").join("crocodile-manifest");
    if legacy_plugin.is_dir() {
        if fs::remove_dir_all(&legacy_plugin).is_ok() {
            logs.push("Удалена устаревшая папка плагина: crocodile-manifest".to_string());
        }
    }

    for (relative, contents) in EMBEDDED_PLUGIN_FILES {
        let target = relative
            .split('/')
            .fold(target_root.clone(), |path, part| path.join(part));
        if let Some(parent) = target.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                return OperationResult::error(
                    format!("Не удалось создать папку плагина: {error}"),
                    logs,
                );
            }
        }

        if fs::read(&target).ok().as_deref() == Some(*contents) {
            logs.push(format!("Без изменений: {relative}"));
            continue;
        }
        if let Err(error) = fs::write(&target, contents) {
            return OperationResult::error(
                format!("Не удалось записать {}: {error}", target.display()),
                logs,
            );
        }
        changed += 1;
        logs.push(format!("Установлен: {relative}"));
    }

    let action = match previous_version.as_deref() {
        None => "Плагин Eclipse Manifest установлен",
        Some(BUNDLED_PLUGIN_VERSION) if changed == 0 => "Плагин Eclipse Manifest уже установлен",
        Some(_) => "Плагин Eclipse Manifest обновлён",
    };
    logs.push(format!("Папка: {}", target_root.display()));
    OperationResult::ok(
        format!("{action}. Перезапустите Steam, чтобы применить изменения"),
        logs,
    )
}

#[tauri::command]
pub fn millennium_remove_plugin(steam_path: Option<String>) -> OperationResult {
    let Some(steam) = resolve_steam_path(steam_path) else {
        return OperationResult::error("Папка Steam не найдена", vec![]);
    };
    let target = plugin_dir(&steam);
    let legacy_target = millennium_dir(&steam).join("plugins").join("crocodile-manifest");
    if !target.is_dir() && !legacy_target.is_dir() {
        return OperationResult::error("Плагин Eclipse Manifest не установлен", vec![]);
    }
    if target.is_dir() && installed_plugin_name(&target).as_deref() != Some(PLUGIN_FOLDER_NAME) {
        return OperationResult::error(
            "Удаление отменено: папка не принадлежит Eclipse Manifest",
            vec![],
        );
    }

    let mut logs = Vec::new();
    if legacy_target.is_dir() {
        let _ = fs::remove_dir_all(&legacy_target);
        logs.push(format!("Удалена устаревшая папка: {}", legacy_target.display()));
    }
    if target.is_dir() {
        match fs::remove_dir_all(&target) {
            Ok(_) => {
                logs.push(format!("Удалена папка: {}", target.display()));
            }
            Err(error) => {
                return OperationResult::error(
                    format!("Не удалось удалить плагин: {error}"),
                    logs,
                );
            }
        }
    }

    OperationResult::ok(
        "Плагин Eclipse Manifest удалён. Перезапустите Steam, чтобы применить изменения",
        logs,
    )
}

// Замена устаревшего плагина CrocLua на Eclipse Manifest
#[tauri::command]
pub fn millennium_migrate_from_croclua(steam_path: Option<String>) -> OperationResult {
    let Some(steam) = resolve_steam_path(steam_path.clone()) else {
        return OperationResult::error("Папка Steam не найдена", vec![]);
    };
    let mut logs = Vec::new();
    let legacy_paths = find_legacy_croclua_plugins(&steam);
    for path in legacy_paths {
        if let Err(err) = fs::remove_dir_all(&path) {
            logs.push(format!("Не удалось удалить {}: {err}", path.display()));
        } else {
            logs.push(format!("Удалена папка устаревшего плагина CrocLua: {}", path.display()));
        }
    }
    let install_res = millennium_install_plugin(steam_path);
    logs.extend(install_res.logs);
    if install_res.success {
        OperationResult::ok(
            "CrocLua успешно заменён на Eclipse Manifest. Перезапустите Steam, чтобы применить изменения",
            logs,
        )
    } else {
        OperationResult::error(
            format!("Устаревший плагин удалён, но при установке Eclipse Manifest произошла ошибка: {}", install_res.message),
            logs,
        )
    }
}

// Удаление устаревшего плагина CrocLua без немедленной установки
#[tauri::command]
pub fn millennium_remove_legacy_croclua(steam_path: Option<String>) -> OperationResult {
    let Some(steam) = resolve_steam_path(steam_path) else {
        return OperationResult::error("Папка Steam не найдена", vec![]);
    };
    let mut logs = Vec::new();
    let legacy_paths = find_legacy_croclua_plugins(&steam);
    if legacy_paths.is_empty() {
        return OperationResult::ok("Устаревший плагин CrocLua не найден", logs);
    }
    for path in legacy_paths {
        if let Err(err) = fs::remove_dir_all(&path) {
            logs.push(format!("Не удалось удалить {}: {err}", path.display()));
        } else {
            logs.push(format!("Удалена папка CrocLua: {}", path.display()));
        }
    }
    OperationResult::ok(
        "Устаревший плагин CrocLua удалён. Перезапустите Steam, чтобы применить изменения",
        logs,
    )
}

fn install_bundled_runtime(steam: &Path) -> OperationResult {
    let mut logs = Vec::new();
    let mut changed = 0_u32;
    for (relative, contents) in EMBEDDED_MILLENNIUM_FILES {
        if contents.len() < 1024 || !contents.starts_with(b"MZ") {
            return OperationResult::error(
                format!("Встроенный файл Millennium повреждён: {relative}"),
                logs,
            );
        }
        let target = relative
            .split('/')
            .fold(steam.to_path_buf(), |path, part| path.join(part));
        if let Some(parent) = target.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                return OperationResult::error(
                    format!("Не удалось создать {}: {error}", parent.display()),
                    logs,
                );
            }
        }
        if fs::read(&target).ok().as_deref() == Some(*contents) {
            logs.push(format!("Без изменений: {relative}"));
            continue;
        }
        if let Err(error) = fs::write(&target, contents) {
            return OperationResult::error(
                format!("Не удалось записать {}: {error}", target.display()),
                logs,
            );
        }
        changed += 1;
        logs.push(format!("Установлен: {relative}"));
    }
    logs.push(format!("Папка Steam: {}", steam.display()));
    OperationResult::ok(
        if changed == 0 {
            "Millennium уже установлен. Перезапустите Steam, если плагин ещё не появился"
        } else {
            "Millennium установлен напрямую в папку Steam. Полностью перезапустите Steam"
        },
        logs,
    )
}

#[tauri::command]
pub fn millennium_install_bundled(steam_path: Option<String>) -> OperationResult {
    let Some(steam) = resolve_steam_path(steam_path) else {
        return OperationResult::error("Папка Steam не найдена", vec![]);
    };
    if !steam.join("steam.exe").is_file() {
        return OperationResult::error("steam.exe не найден в выбранной папке", vec![]);
    }
    install_bundled_runtime(&steam)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_steam_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "cgs-millennium-test-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn installs_plugin_into_millennium_plugins_folder() {
        let steam = test_steam_dir();
        fs::create_dir_all(&steam).expect("create fake Steam");
        fs::write(steam.join("steam.exe"), []).expect("create fake steam.exe");
        let runtime = install_bundled_runtime(&steam);
        assert!(runtime.success, "{}", runtime.message);

        let before = status_for(Some(steam.display().to_string()));
        assert_eq!(before.status, "plugin_missing");

        let result = millennium_install_plugin(Some(steam.display().to_string()));
        assert!(result.success, "{}", result.message);

        let expected = steam
            .join("millennium")
            .join("plugins")
            .join(PLUGIN_FOLDER_NAME);
        assert!(expected.join("plugin.json").is_file());
        assert!(expected.join("backend").join("main.lua").is_file());
        assert!(expected
            .join(".millennium")
            .join("Dist")
            .join("index.js")
            .is_file());

        let after = status_for(Some(steam.display().to_string()));
        assert_eq!(after.status, "ready");
        assert!(after.plugin_current);
        assert_eq!(
            after.plugin_version.as_deref(),
            Some(BUNDLED_PLUGIN_VERSION)
        );

        let removed = millennium_remove_plugin(Some(steam.display().to_string()));
        assert!(removed.success, "{}", removed.message);
        assert!(!expected.exists());
        assert_eq!(
            status_for(Some(steam.display().to_string())).status,
            "plugin_missing"
        );

        fs::remove_dir_all(steam).expect("clean test directory");
    }

    #[test]
    fn installs_bundled_millennium_directly_into_steam() {
        let steam = test_steam_dir();
        fs::create_dir_all(&steam).expect("create fake Steam");
        fs::write(steam.join("steam.exe"), []).expect("create fake steam.exe");

        let result = millennium_install_bundled(Some(steam.display().to_string()));
        assert!(result.success, "{}", result.message);
        assert!(steam.join("wsock32.dll").is_file());
        assert!(steam.join("millennium/lib/millennium.dll").is_file());
        assert!(steam
            .join("millennium/bin/millennium.luavm64.exe")
            .is_file());
        assert!(millennium_is_installed(&steam));

        fs::remove_dir_all(steam).expect("clean test directory");
    }

    #[test]
    fn reports_missing_after_millennium_directory_is_removed() {
        let steam = test_steam_dir();
        fs::create_dir_all(steam.join("ext")).expect("create leftover ext directory");
        fs::write(steam.join("steam.exe"), []).expect("create fake steam.exe");

        let status = status_for(Some(steam.display().to_string()));
        assert_eq!(status.status, "millennium_missing");
        assert!(!status.millennium_installed);
        assert!(!status.plugin_installed);

        fs::remove_dir_all(steam).expect("clean test directory");
    }

    #[test]
    fn detects_and_migrates_croclua_plugin() {
        let steam = test_steam_dir();
        fs::create_dir_all(&steam).expect("create fake Steam");
        fs::write(steam.join("steam.exe"), []).expect("create fake steam.exe");
        let runtime = install_bundled_runtime(&steam);
        assert!(runtime.success, "{}", runtime.message);

        // Имитируем наличие старого плагина crocodile-manifest
        let legacy = steam
            .join("millennium")
            .join("plugins")
            .join("crocodile-manifest");
        fs::create_dir_all(&legacy).expect("create legacy folder");
        fs::write(
            legacy.join("plugin.json"),
            br#"{"name":"crocodile-manifest","common_name":"Crocodile Manifest","version":"0.4.9"}"#,
        )
        .expect("write legacy plugin.json");

        let status = status_for(Some(steam.display().to_string()));
        assert_eq!(status.status, "croclua_detected");
        assert!(status.legacy_croclua_found);

        // Выполняем миграцию
        let migration = millennium_migrate_from_croclua(Some(steam.display().to_string()));
        assert!(migration.success, "{}", migration.message);
        assert!(!legacy.exists(), "legacy plugin must be removed");

        let after = status_for(Some(steam.display().to_string()));
        assert_eq!(after.status, "ready");
        assert!(!after.legacy_croclua_found);
        assert!(after.plugin_installed);

        fs::remove_dir_all(steam).expect("clean test directory");
    }
}
