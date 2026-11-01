use crate::models::OperationResult;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const NO_WINDOW: u32 = 0x08000000;

// Основной каталог для Lua-скриптов в Steam
const LUA_DIR_REL: &[&str] = &["config", "lua"];
// Устаревший каталог плагинов SteamTools
const LEGACY_STPLUGIN_REL: &[&str] = &["config", "stplug-in"];
// Пути к кэшу манифестов
const DEPOTCACHE_REL: &[&str] = &["depotcache"];
const LEGACY_DEPOTCACHE_REL: &[&str] = &["config", "depotcache"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaGame {
    pub appid: String,
    pub enabled: bool,
    pub status: String,
    pub manifest_count: u64,
    pub missing_manifest_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaStatus {
    pub steam_path: Option<String>,
    pub steam_detected: bool,
    pub steam_exe: bool,
    pub plugin_folder: bool,
    pub lua_folder: Option<String>,
    pub loader_status: String,
    pub loader_name: Option<String>,
    pub loader_issue: Option<String>,
    pub lua_count: u64,
    pub games: Vec<LuaGame>,
}

// Путь к локальному реестру добавленных игр
fn registry_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("luatools-games.json"))
}

// Каталог резервных копий манифестов
fn manifest_cache_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app
        .path()
        .app_local_data_dir()
        .ok()?
        .join("luatools-manifest-cache");
    let _ = fs::create_dir_all(&dir);
    Some(dir)
}

// Загрузка реестра добавленных игр
fn load_registry(app: &AppHandle) -> BTreeMap<String, u64> {
    let Some(bytes) = registry_path(app).and_then(|path| fs::read(path).ok()) else {
        return BTreeMap::new();
    };
    if let Ok(map) = serde_json::from_slice::<BTreeMap<String, u64>>(&bytes) {
        return map;
    }
    if let Ok(list) = serde_json::from_slice::<Vec<String>>(&bytes) {
        return list.into_iter().map(|appid| (appid, 0)).collect();
    }
    BTreeMap::new()
}

fn save_registry(app: &AppHandle, registry: &BTreeMap<String, u64>) {
    if let Some(path) = registry_path(app) {
        if let Ok(data) = serde_json::to_vec_pretty(registry) {
            let _ = fs::write(path, data);
        }
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub struct LuaInstallResult {
    pub success: bool,
    pub message: String,
    pub logs: Vec<String>,
    pub added_appids: Vec<String>,
}

impl Serialize for LuaInstallResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        crate::operation_outcome::serialize(
            self.success,
            &self.message,
            &self.logs,
            Some(&self.added_appids),
            serializer,
        )
    }
}

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    command.creation_flags(NO_WINDOW);
    command
}

// Чтение значения из реестра Windows
fn query_registry(key: &str, name: &str) -> Option<String> {
    let output = hidden_command("reg")
        .args(["query", key, "/v", name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if let Some(position) = line.find("REG_SZ") {
            let value = line[position + "REG_SZ".len()..].trim();
            if !value.is_empty() {
                return Some(value.replace('/', "\\"));
            }
        }
    }
    None
}

// Определение пути к Steam через реестр
fn detect_steam_path() -> Option<PathBuf> {
    let candidates = [
        (r"HKLM\SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
        (r"HKLM\SOFTWARE\Valve\Steam", "InstallPath"),
        (r"HKCU\Software\Valve\Steam", "SteamPath"),
    ];
    for (key, name) in candidates {
        if let Some(value) = query_registry(key, name) {
            let path = PathBuf::from(&value);
            if path.is_dir() {
                return Some(path);
            }
        }
    }
    None
}

pub(crate) fn resolve_steam_path(override_path: Option<String>) -> Option<PathBuf> {
    if let Some(path) = override_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_dir() {
                return Some(path);
            }
        }
    }
    detect_steam_path()
}

fn default_lua_dir(steam: &Path) -> PathBuf {
    LUA_DIR_REL
        .iter()
        .fold(steam.to_path_buf(), |acc, part| acc.join(part))
}

fn legacy_stplugin_dir(steam: &Path) -> PathBuf {
    LEGACY_STPLUGIN_REL
        .iter()
        .fold(steam.to_path_buf(), |acc, part| acc.join(part))
}

// Настройки источника загрузчика для манифестов
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LuatoolsSettings {
    // Выбранная версия загрузчика: "v1" (базовая встроенная) или "v2" (встроенная с десктопа)
    pub loader_source: String,
    // Пользовательский путь к загрузчику, если задан
    pub custom_loader_path: Option<String>,
}

impl Default for LuatoolsSettings {
    fn default() -> Self {
        Self {
            loader_source: "v1".into(),
            custom_loader_path: None,
        }
    }
}

// Путь к файлу настроек luatools
fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("luatools-settings.json"))
}

// Загрузка настроек luatools
fn load_settings(app: &AppHandle) -> LuatoolsSettings {
    if let Some(path) = settings_path(app) {
        if let Ok(data) = fs::read(path) {
            if let Ok(settings) = serde_json::from_slice::<LuatoolsSettings>(&data) {
                return settings;
            }
        }
    }
    LuatoolsSettings::default()
}

// Сохранение настроек luatools
fn save_settings(app: &AppHandle, settings: &LuatoolsSettings) {
    if let Some(path) = settings_path(app) {
        if let Ok(data) = serde_json::to_vec_pretty(settings) {
            let _ = fs::write(path, data);
        }
    }
}

// Определение активной версии OpenSteamTool в папке Steam с учётом Schema 2
pub fn detect_active_loader_in_steam(steam: &Path) -> (String, String) {
    if let Ok(Some(selection)) = crate::lua_loader::read_selection(steam) {
        if selection.variant == "compatibility" || selection.variant == "v2" {
            return ("v2".into(), "Версия 2 (Альтернативная)".into());
        } else if selection.variant == "standard" || selection.variant == "v1" {
            return ("v1".into(), "Версия 1 (Основная)".into());
        }
    }
    let steam_ost = steam.join("OpenSteamTool.dll");
    if !steam_ost.is_file() {
        return ("none".into(), "Загрузчик не установлен".into());
    }

    let Ok(steam_bytes) = fs::read(&steam_ost) else {
        return ("unknown".into(), "Ошибка чтения файлов Steam".into());
    };

    // Сверяем с версией 2 (альтернативная сборка)
    let v2_bytes = include_bytes!("../resources/opensteamtool/v2/OpenSteamTool.dll");
    if steam_bytes == v2_bytes || steam.join("bin/dwmapi.dll").is_file() {
        return ("v2".into(), "Версия 2 (Альтернативная)".into());
    }

    // Сверяем с версией 1 (основная сборка)
    let v1_bytes = include_bytes!("../resources/opensteamtool/v1/OpenSteamTool.dll");
    if steam_bytes == v1_bytes {
        return ("v1".into(), "Версия 1 (Основная)".into());
    }

    ("custom".into(), "Сторонняя версия".into())
}

// Настройка рабочей папки [lua] paths = ["config/lua"] в opensteamtool.toml
pub(crate) fn configure_lua_folder(existing: &str) -> Result<String, String> {
    let source = if existing.trim().is_empty() {
        include_str!("../resources/opensteamtool/v1/opensteamtool.toml")
    } else {
        existing
    };
    let mut config = source.parse::<toml_edit::DocumentMut>()
        .map_err(|error| format!("Не удалось обновить opensteamtool.toml: {error}. Существующий конфиг сохранён без изменений."))?;
    if config
        .get("lua")
        .is_some_and(|item| !item.is_table() && !item.is_inline_table())
    {
        return Err(
            "В opensteamtool.toml секция lua имеет неверный формат. Файлы не изменены.".into(),
        );
    }
    let mut paths = toml_edit::Array::new();
    paths.push("config/lua");
    config["lua"]["paths"] = toml_edit::value(paths);
    Ok(config.to_string())
}

// Атомарная запись файла во временный файл с последующим переименованием
fn atomic_loader_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    crate::durable::write(path, bytes)
}

// Транзакционное применение изменений в файлах загрузчика с бэкапом и откатом
pub(crate) fn install_loader_changes(
    steam: &Path,
    files: &[(&str, Option<&[u8]>)],
) -> Result<(), String> {
    let _resource_guard = match crate::resource_lock::Guard::scope(&[steam.to_path_buf()]) {
        Ok(guard) => guard,
        Err(error) => {
            return Err(error);
        }
    };

    let read =
        |path: &Path| -> Result<Option<Vec<u8>>, String> { crate::lua_loader::read_optional(path) };
    let mut changes = Vec::new();
    for &(name, desired) in files {
        let relative = Path::new(name);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Недопустимый путь загрузчика".into());
        }
        let destination = steam.join(relative);
        let mut parent = steam.to_path_buf();
        let parts: Vec<_> = relative.components().collect();
        for part in &parts[..parts.len().saturating_sub(1)] {
            parent.push(part.as_os_str());
            crate::lua_loader::reject_link(&parent)?;
            if desired.is_some() {
                fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
            }
        }
        let previous = read(&destination)?;
        if previous.as_deref() == desired {
            continue;
        }
        changes.push((name, desired, previous));
    }
    if changes.is_empty() {
        return Ok(());
    }
    let backup = steam
        .join("config/cgs-luatools-backups")
        .join(uuid::Uuid::new_v4().to_string());
    for (name, _, previous) in &changes {
        if let Some(bytes) = previous {
            let output = backup.join(name);
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            crate::durable::write(&output, bytes).map_err(|e| {
                format!("Не удалось сохранить резервную копию: {e}. DLL не изменены.")
            })?;
        }
    }
    for (index, (name, desired, previous)) in changes.iter().enumerate() {
        let destination = steam.join(name);
        let operation = match read(&destination) {
            Ok(current) if &current == previous => {
                if let Some(bytes) = desired {
                    atomic_loader_write(&destination, bytes)
                } else {
                    fs::remove_file(&destination).map_err(|e| e.to_string())
                }
            }
            Ok(_) => Err("Файл изменился во время обновления".into()),
            Err(error) => Err(error),
        };
        if let Err(error) = operation {
            let mut failures = Vec::new();
            for (old_name, installed, original) in changes[..index].iter().rev() {
                let path = steam.join(old_name);
                if !read(&path).is_ok_and(|current| current.as_deref() == *installed) {
                    failures.push(format!("{old_name}: файл изменён извне"));
                    continue;
                }
                let rollback = if let Some(bytes) = original {
                    atomic_loader_write(&path, bytes)
                } else {
                    fs::remove_file(&path).map_err(|e| e.to_string())
                };
                if let Err(error) = rollback {
                    failures.push(format!("{old_name}: {error}"));
                }
            }
            return Err(format!(
                "Не удалось обновить {name}: {error}. Закройте Steam и повторите. Откат: {}. Резервная копия: {}",
                if failures.is_empty() { "изменения отменены".into() } else { failures.join("; ") },
                backup.display()
            ));
        }
    }
    Ok(())
}

// Установка или обновление файлов OpenSteamTool в папке Steam
pub fn apply_opensteamtool_loader(
    _app: &AppHandle,
    steam: &Path,
    source: &str,
) -> Result<String, String> {
    if !steam.is_dir() {
        return Err("Папка Steam не найдена — укажите её вручную".into());
    }

    let is_v2 = source == "v2" || source == "desktop";
    let variant = if is_v2 { "compatibility" } else { "standard" };
    let result = crate::lua_loader::update_embedded(steam, Some(variant));
    if result.success {
        Ok(result.message)
    } else {
        Err(result.message)
    }
}

// Обновление библиотек загрузчика с проверкой запущенного Steam
#[tauri::command]
pub async fn luatools_update_loader(
    steam_path: Option<String>,
    variant: Option<String>,
) -> OperationResult {
    #[cfg(windows)]
    if process_is_running("steam.exe") {
        return OperationResult::error(
            "Steam запущен и блокирует файлы библиотек. Закройте Steam перед обновлением DLL.",
            vec!["Завершите Steam через трей или воспользуйтесь кнопкой безопасного закрытия в Eclipse Studio".into()],
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        let steam = match steam_path.filter(|s| !s.trim().is_empty()) {
            Some(s) => PathBuf::from(s.trim()),
            None => match resolve_steam_path(None) {
                Some(p) => p,
                None => return OperationResult::error("Папка Steam не найдена", vec![]),
            },
        };
        let variant = match variant {
            Some(v) => v,
            None => {
                crate::lua_loader::selected_variant(&steam).unwrap_or_else(|_| "standard".into())
            }
        };
        crate::loader_github::update(&steam, &variant)
    })
    .await
    .unwrap_or_else(|e| OperationResult::error(format!("Ошибка фонового потока: {e}"), vec![]))
}

// Гарантированная установка или обновление OpenSteamTool в Steam согласно выбранному источнику
fn ensure_opensteamtool_installed(_app: &AppHandle, steam: &Path) {
    let _ = crate::lua_loader::ensure(steam);
}

// Парсинг путей к lua из opensteamtool.toml
fn parse_opensteamtool_lua_paths(content: &str) -> Vec<String> {
    let mut in_lua = false;
    let mut section = String::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.starts_with('[') && line.ends_with(']') {
            if line.eq_ignore_ascii_case("[lua]") {
                in_lua = true;
                continue;
            }
            if in_lua {
                break;
            }
        }
        if in_lua && !line.starts_with('#') {
            section.push_str(line);
            section.push('\n');
        }
    }

    let Some(key_position) = section.to_ascii_lowercase().find("paths") else {
        return Vec::new();
    };
    let value = &section[key_position + "paths".len()..];
    let Some(array_start) = value.find('[') else {
        return Vec::new();
    };
    let value = &value[array_start + 1..];
    let Some(array_end) = value.find(']') else {
        return Vec::new();
    };

    let mut paths = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in value[..array_end].chars() {
        match quote {
            Some(delimiter) => {
                if escaped && delimiter == '"' {
                    current.push(character);
                    escaped = false;
                } else if character == '\\' && delimiter == '"' {
                    escaped = true;
                } else if character == delimiter {
                    let path = current.trim();
                    if !path.is_empty() {
                        paths.push(path.to_string());
                    }
                    current.clear();
                    quote = None;
                } else {
                    current.push(character);
                }
            }
            None if character == '"' || character == '\'' => quote = Some(character),
            None => {}
        }
    }
    paths
}

fn opensteamtool_lua_dirs(steam: &Path) -> Vec<PathBuf> {
    if !steam.join("OpenSteamTool.dll").is_file() {
        return Vec::new();
    }
    let Ok(content) = fs::read_to_string(steam.join("opensteamtool.toml")) else {
        return Vec::new();
    };
    parse_opensteamtool_lua_paths(&content)
        .into_iter()
        .map(|configured| {
            let path = PathBuf::from(configured.replace('/', "\\"));
            if path.is_absolute() {
                path
            } else {
                steam.join(path)
            }
        })
        .collect()
}

// Рабочая папка Lua для текущего загрузчика
pub(crate) fn stplugin_dir(steam: &Path) -> PathBuf {
    let preferred = default_lua_dir(steam);
    let ost_dirs = opensteamtool_lua_dirs(steam);
    if ost_dirs.iter().any(|d| d == &preferred) || preferred.is_dir() {
        return preferred;
    }
    ost_dirs.into_iter().next().unwrap_or(preferred)
}
fn loader_state(steam: &Path) -> (String, Option<String>, Option<String>) {
    if steam.join("OpenSteamTool.dll").is_file() {
        let proxy_present = steam.join("dwmapi.dll").is_file()
            || steam.join("bin/dwmapi.dll").is_file()
            || steam.join("version.dll").is_file()
            || steam.join("xinput1_4.dll").is_file();
        if !proxy_present {
            return (
                "misconfigured".into(),
                Some("OpenSteamTool".into()),
                Some("OpenSteamTool установлен не полностью: не найден загрузчик dwmapi.dll, version.dll или xinput1_4.dll".into()),
            );
        }
        if !steam.join("opensteamtool.toml").is_file() {
            return (
                "misconfigured".into(),
                Some("OpenSteamTool".into()),
                Some("Не найден opensteamtool.toml с настройкой папки Lua".into()),
            );
        }
        if opensteamtool_lua_dirs(steam).is_empty() {
            return (
                "misconfigured".into(),
                Some("OpenSteamTool".into()),
                Some("В opensteamtool.toml не указано [lua] paths = [...]".into()),
            );
        }
        return ("ready".into(), Some("OpenSteamTool".into()), None);
    }

    if default_lua_dir(steam).is_dir() || legacy_stplugin_dir(steam).is_dir() {
        // Старые версии SteamTools без отдельного маркера
        return ("legacy".into(), Some("SteamTools".into()), None);
    }

    (
        "missing".into(),
        None,
        Some("SteamTools или OpenSteamTool не обнаружен. Одна папка с Lua не добавляет игру в Steam.".into()),
    )
}

// Миграция Lua-скриптов в рабочую папку OpenSteamTool
pub(crate) fn migrate_legacy_lua(steam: &Path, target: &Path) -> usize {
    let legacy = legacy_stplugin_dir(steam);
    if legacy == target || !legacy.is_dir() {
        return 0;
    }
    if fs::create_dir_all(target).is_err() {
        return 0;
    }
    let Ok(entries) = fs::read_dir(legacy) else {
        return 0;
    };
    let mut copied = 0;
    for entry in entries.flatten() {
        let source = entry.path();
        let Some(name) = source.file_name() else {
            continue;
        };
        let lower = name.to_string_lossy().to_ascii_lowercase();
        if !source.is_file() || !(lower.ends_with(".lua") || lower.ends_with(".lua.disabled")) {
            continue;
        }
        let destination = target.join(name);
        if !destination.exists() && fs::copy(&source, &destination).is_ok() {
            copied += 1;
        }
    }
    copied
}

fn depotcache_dir(steam: &Path) -> PathBuf {
    DEPOTCACHE_REL
        .iter()
        .fold(steam.to_path_buf(), |acc, part| acc.join(part))
}

fn legacy_depotcache_dir(steam: &Path) -> PathBuf {
    LEGACY_DEPOTCACHE_REL
        .iter()
        .fold(steam.to_path_buf(), |acc, part| acc.join(part))
}

// Перенос кэша манифестов в корневой depotcache
fn migrate_legacy_manifests(steam: &Path) -> usize {
    let legacy = legacy_depotcache_dir(steam);
    if !legacy.is_dir() {
        return 0;
    }
    let target = depotcache_dir(steam);
    if fs::create_dir_all(&target).is_err() {
        return 0;
    }

    let Ok(entries) = fs::read_dir(legacy) else {
        return 0;
    };
    let mut copied = 0;
    for entry in entries.flatten() {
        let source = entry.path();
        let Some(name) = source.file_name() else {
            continue;
        };
        if !source.is_file()
            || source
                .extension()
                .and_then(|ext| ext.to_str())
                .map(str::to_ascii_lowercase)
                != Some("manifest".into())
        {
            continue;
        }
        let destination = target.join(name);
        if !destination.exists() && fs::copy(&source, &destination).is_ok() {
            copied += 1;
        }
    }
    copied
}

// Извлечение AppID из имени lua-файла
fn appid_from_lua(name: &str) -> Option<String> {
    let base = name
        .strip_suffix(".disabled")
        .unwrap_or(name)
        .strip_suffix(".lua")?;
    (!base.is_empty() && base.chars().all(|c| c.is_ascii_digit())).then(|| base.to_string())
}

fn contains_root_addappid(content: &str, appid: &str) -> bool {
    content.lines().any(|line| {
        let line = line
            .trim_start()
            .trim_start_matches('\u{feff}')
            .trim_start();
        if line.starts_with("--") {
            return false;
        }
        let lower = line.to_ascii_lowercase();
        let Some(position) = lower.find("addappid") else {
            return false;
        };
        let rest = line[position + "addappid".len()..].trim_start();
        let Some(rest) = rest.strip_prefix('(') else {
            return false;
        };
        let rest = rest.trim_start();
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if digits != appid {
            return false;
        }
        rest[digits.len()..].trim_start().starts_with(')')
    })
}

// Подготовка Lua-скрипта перед установкой
fn patch_lua(content: &str, auto_update: bool, appid: &str) -> String {
    let content = content.trim_start_matches('\u{feff}');
    let mut patched = content
        .lines()
        .map(|line| {
            if auto_update && line.trim_start().starts_with("setManifestid") {
                format!("--{line}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !contains_root_addappid(&patched, appid) {
        patched = format!("addappid({appid})\n{patched}");
    }
    patched
}

// Поиск связок depot/manifest в коде скрипта
fn parse_manifest_refs(content: &str) -> BTreeSet<(String, String)> {
    let mut refs = BTreeSet::new();
    for line in content.lines() {
        let lower = line.to_ascii_lowercase();
        let Some(position) = lower.find("setmanifestid") else {
            continue;
        };
        let numbers = line[position + "setmanifestid".len()..]
            .split(|character: char| !character.is_ascii_digit())
            .filter(|part| !part.is_empty())
            .take(2)
            .collect::<Vec<_>>();
        if numbers.len() == 2 {
            refs.insert((numbers[0].to_string(), numbers[1].to_string()));
        }
    }
    refs
}

fn sync_game_manifest_cache(lua_path: &Path, depotcache: &Path, cache: &Path) -> usize {
    let Ok(content) = fs::read_to_string(lua_path) else {
        return 0;
    };
    let _ = fs::create_dir_all(depotcache);
    let _ = fs::create_dir_all(cache);
    let mut restored = 0;
    for (depot, manifest) in parse_manifest_refs(&content) {
        let name = format!("{depot}_{manifest}.manifest");
        let target = depotcache.join(&name);
        let backup = cache.join(&name);
        if target.is_file() {
            if !backup.is_file() {
                let _ = fs::copy(&target, &backup);
            }
            continue;
        }
        let Ok(bytes) = fs::read(&backup) else {
            continue;
        };
        let temporary = depotcache.join(format!(".{name}.restore-{}.tmp", std::process::id()));
        let restored_ok = fs::write(&temporary, bytes).is_ok()
            && fs::rename(&temporary, &target).is_ok()
            && target.is_file();
        if restored_ok {
            restored += 1;
        } else {
            let _ = fs::remove_file(&temporary);
        }
    }
    restored
}

fn game_health(lua_path: &Path, depotcache: &Path, enabled: bool) -> (String, u64, u64) {
    if !enabled {
        return ("disabled".into(), 0, 0);
    }
    let Ok(content) = fs::read_to_string(lua_path) else {
        return ("invalid_lua".into(), 0, 0);
    };
    if content.trim().is_empty() || !content.to_ascii_lowercase().contains("addappid") {
        return ("invalid_lua".into(), 0, 0);
    }
    let refs = parse_manifest_refs(&content);
    let manifest_count = refs
        .iter()
        .filter(|(depot, manifest)| {
            depotcache
                .join(format!("{depot}_{manifest}.manifest"))
                .is_file()
        })
        .count() as u64;
    let missing = refs.len() as u64 - manifest_count;
    let status = if missing > 0 {
        "missing_manifests"
    } else {
        "ready"
    };
    (status.into(), manifest_count, missing)
}

// Игры из реестра с существующими lua-файлами
fn registry_games(
    registry: &BTreeMap<String, u64>,
    stplugin: &Path,
    depotcache: &Path,
    manifest_cache: Option<&Path>,
) -> Vec<LuaGame> {
    let mut games = Vec::new();
    for appid in registry.keys() {
        let active = stplugin.join(format!("{appid}.lua"));
        let disabled = stplugin.join(format!("{appid}.lua.disabled"));
        let (path, enabled) = if active.is_file() {
            (active, true)
        } else if disabled.is_file() {
            (disabled, false)
        } else {
            continue;
        };
        if let Some(cache) = manifest_cache {
            sync_game_manifest_cache(&path, depotcache, cache);
        }
        let (status, manifest_count, missing_manifest_count) =
            game_health(&path, depotcache, enabled);
        games.push(LuaGame {
            appid: appid.clone(),
            enabled,
            status,
            manifest_count,
            missing_manifest_count,
        });
    }
    games.sort_by(|a, b| {
        a.appid
            .parse::<u64>()
            .unwrap_or(u64::MAX)
            .cmp(&b.appid.parse::<u64>().unwrap_or(u64::MAX))
    });
    games
}

#[tauri::command]
pub fn luatools_status(app: AppHandle, steam_path: Option<String>) -> LuaStatus {
    let Some(steam) = resolve_steam_path(steam_path) else {
        return LuaStatus {
            steam_path: None,
            steam_detected: false,
            steam_exe: false,
            plugin_folder: false,
            lua_folder: None,
            loader_status: "missing".into(),
            loader_name: None,
            loader_issue: Some("Папка Steam не найдена".into()),
            lua_count: 0,
            games: Vec::new(),
        };
    };
    // Просмотр состояния не изменяет Steam. Миграция выполняется при явной установке.
    let stplugin = stplugin_dir(&steam);
    let cache = manifest_cache_dir(&app);
    let games = registry_games(
        &load_registry(&app),
        &stplugin,
        &depotcache_dir(&steam),
        cache.as_deref(),
    );
    let (loader_status, loader_name, loader_issue) = loader_state(&steam);

    LuaStatus {
        steam_detected: true,
        steam_exe: steam.join("steam.exe").is_file(),
        plugin_folder: stplugin.is_dir(),
        lua_folder: Some(stplugin.display().to_string()),
        loader_status,
        loader_name,
        loader_issue,
        lua_count: games.len() as u64,
        games,
        steam_path: Some(steam.display().to_string()),
    }
}

#[tauri::command]
pub fn luatools_restore_manifests(app: AppHandle, steam_path: Option<String>) -> OperationResult {
    let _resource_guard =
        match crate::resource_lock::Guard::scope(&[match resolve_steam_path(steam_path.clone()) {
            Some(p) => p,
            None => return OperationResult::error("Папка Steam не найдена", vec![]),
        }]) {
            Ok(guard) => guard,
            Err(error) => {
                return OperationResult::error(error, vec![]);
            }
        };

    let Some(steam) = resolve_steam_path(steam_path) else {
        return OperationResult::error("Папка Steam не найдена", vec![]);
    };
    let Some(cache) = manifest_cache_dir(&app) else {
        return OperationResult::error("Не удалось открыть кэш манифестов", vec![]);
    };
    let stplugin = stplugin_dir(&steam);
    let depotcache = depotcache_dir(&steam);
    let mut restored = 0;
    for appid in load_registry(&app).keys() {
        let (active, disabled) = game_lua_paths(&stplugin, appid);
        let lua = if active.is_file() {
            active
        } else if disabled.is_file() {
            disabled
        } else {
            continue;
        };
        restored += sync_game_manifest_cache(&lua, &depotcache, &cache);
    }
    OperationResult::ok(
        if restored > 0 {
            format!("Восстановлено манифестов: {restored}")
        } else {
            "Манифесты проверены".into()
        },
        vec![],
    )
}

#[tauri::command]
pub fn luatools_detect_steam() -> Option<String> {
    detect_steam_path().map(|path| path.display().to_string())
}

#[tauri::command]
pub async fn luatools_pick_files() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(luatools_pick_files_blocking)
        .await
        .map_err(|error| format!("Диалог выбора прерван: {error}"))?
}

fn luatools_pick_files_blocking() -> Result<Vec<String>, String> {
    let script = r#"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Выберите файлы .lua, .manifest или .zip'; $d.Multiselect = $true; $d.Filter = 'LuaTools (*.lua;*.manifest;*.zip)|*.lua;*.manifest;*.zip|Все файлы (*.*)|*.*'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d.FileNames -join [Environment]::NewLine }"#;
    let output = hidden_command("powershell.exe")
        .args(["-NoProfile", "-STA", "-Command", script])
        .output()
        .map_err(|error| format!("Не удалось открыть выбор файлов: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

struct InstallContext {
    stplugin: PathBuf,
    depotcache: PathBuf,
    manifest_cache: Option<PathBuf>,
    auto_update: bool,
}

fn install_lua_bytes(
    context: &InstallContext,
    file_name: &str,
    bytes: &[u8],
    logs: &mut Vec<String>,
    added: &mut Vec<String>,
) {
    let Some(appid) = appid_from_lua(&file_name.to_lowercase()) else {
        logs.push(format!(
            "⚠ Пропущен {file_name}: имя lua должно состоять из цифр"
        ));
        return;
    };
    let content = match std::str::from_utf8(bytes) {
        Ok(text) => patch_lua(text, context.auto_update, &appid),
        Err(_) => {
            logs.push(format!(
                "⚠ Пропущен {file_name}: файл не в текстовом формате"
            ));
            return;
        }
    };
    let target = context.stplugin.join(format!("{appid}.lua"));
    let disabled = context.stplugin.join(format!("{appid}.lua.disabled"));
    let prepare = (|| -> Result<(), String> {
        crate::safe_path::join(&context.stplugin, &format!("{appid}.lua"))?;
        crate::backup::protect(&context.stplugin, &format!("{appid}.lua"), "lua-install")?;
        if disabled.exists() {
            crate::backup::protect(
                &context.stplugin,
                &format!("{appid}.lua.disabled"),
                "lua-install",
            )?;
        }
        Ok(())
    })();
    if let Err(e) = prepare {
        logs.push(format!("⚠ {e}; Lua не изменён"));
        return;
    }
    if disabled.exists() {
        if let Err(e) = fs::remove_file(&disabled) {
            logs.push(format!("⚠ Не удалось убрать отключённую Lua: {e}"));
            return;
        }
    }
    match crate::durable::write(&target, content.as_bytes()) {
        Ok(()) => {
            logs.push(format!("Добавлен lua: {appid}.lua"));
            if !added.contains(&appid) {
                added.push(appid);
            }
        }
        Err(error) => logs.push(format!("⚠ Не удалось записать {appid}.lua: {error}")),
    }
}

fn install_manifest_bytes(
    context: &InstallContext,
    file_name: &str,
    bytes: &[u8],
    logs: &mut Vec<String>,
) {
    let target = match crate::safe_path::join(&context.depotcache, file_name).and_then(|path| {
        crate::backup::protect(&context.depotcache, file_name, "manifest-install")?;
        Ok(path)
    }) {
        Ok(path) => path,
        Err(e) => {
            logs.push(format!("⚠ Манифест не изменён: {e}"));
            return;
        }
    };
    match crate::durable::write(&target, bytes) {
        Ok(()) => {
            logs.push(format!("Добавлен манифест: {file_name}"));
            if let Some(cache) = &context.manifest_cache {
                if fs::create_dir_all(cache).is_ok() {
                    if let Err(error) = crate::durable::write(&cache.join(file_name), bytes) {
                        logs.push(format!(
                            "⚠ Не удалось сохранить резервную копию {file_name}: {error}"
                        ));
                    }
                }
            }
        }
        Err(error) => logs.push(format!("⚠ Не удалось записать {file_name}: {error}")),
    }
}

fn install_bytes(
    context: &InstallContext,
    file_name: &str,
    bytes: &[u8],
    logs: &mut Vec<String>,
    added: &mut Vec<String>,
) {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".lua") {
        install_lua_bytes(context, file_name, bytes, logs, added);
    } else if lower.ends_with(".manifest") {
        install_manifest_bytes(context, file_name, bytes, logs);
    }
}

fn install_zip_reader<R: std::io::Read + std::io::Seek>(
    context: &InstallContext,
    reader: R,
    logs: &mut Vec<String>,
    added: &mut Vec<String>,
) {
    let result = (|| -> Result<(), String> {
        let stage = tempfile::tempdir().map_err(|e| e.to_string())?;
        let archive_path = stage.path().join("source.zip");
        let output = stage.path().join("out");
        let mut source = reader;
        let mut file = fs::File::create(&archive_path).map_err(|e| e.to_string())?;
        use std::io::Read;
        let copied = std::io::copy(
            &mut std::io::Read::by_ref(&mut source).take(crate::archive_policy::MAX_BYTES + 1),
            &mut file,
        )
        .map_err(|e| e.to_string())?;
        if copied > crate::archive_policy::MAX_BYTES {
            return Err("Слишком большой архив манифестов".into());
        }
        file.sync_all().map_err(|e| e.to_string())?;
        fs::create_dir(&output).map_err(|e| e.to_string())?;
        crate::archive_policy::zip_extract(&archive_path, &output, None)?;
        let mut names = std::collections::BTreeSet::new();
        for entry in walkdir::WalkDir::new(&output).follow_links(false) {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.to_lowercase().ends_with(".lua")
                || name.to_lowercase().ends_with(".manifest"))
            {
                continue;
            }
            if !names.insert(name.to_lowercase()) {
                return Err("Повторяющееся имя манифеста".into());
            }
            if entry.metadata().map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
                return Err("Файл манифеста больше 32 МБ".into());
            }
        }
        for entry in walkdir::WalkDir::new(&output).follow_links(false) {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if !(lower.ends_with(".lua") || lower.ends_with(".manifest")) {
                continue;
            }
            install_bytes(
                context,
                &name,
                &fs::read(entry.path()).map_err(|e| e.to_string())?,
                logs,
                added,
            );
        }
        Ok(())
    })();
    if let Err(e) = result {
        logs.push(format!("⚠ Архив не установлен: {e}"));
    }
}

fn install_archive(
    context: &InstallContext,
    path: &Path,
    logs: &mut Vec<String>,
    added: &mut Vec<String>,
) {
    match fs::File::open(path) {
        Ok(file) => install_zip_reader(context, file, logs, added),
        Err(error) => logs.push(format!("⚠ Не удалось открыть архив: {error}")),
    }
}

// Установка zip-пакета игры из байтов
pub(crate) fn install_zip_bytes(
    app: &AppHandle,
    bytes: &[u8],
    steam_path: Option<String>,
    auto_update: bool,
) -> LuaInstallResult {
    let _resource_guard =
        match crate::resource_lock::Guard::scope(&[match resolve_steam_path(steam_path.clone()) {
            Some(p) => p,
            None => {
                return LuaInstallResult {
                    success: false,
                    message: "Папка Steam не найдена".into(),
                    logs: vec![],
                    added_appids: vec![],
                }
            }
        }]) {
            Ok(guard) => guard,
            Err(error) => {
                return LuaInstallResult {
                    success: false,
                    message: error,
                    logs: vec![],
                    added_appids: vec![],
                };
            }
        };

    let Some(steam) = resolve_steam_path(steam_path) else {
        return LuaInstallResult {
            success: false,
            message: "Папка Steam не найдена — укажите её вручную".into(),
            logs: vec![],
            added_appids: vec![],
        };
    };
    ensure_opensteamtool_installed(app, &steam);
    let (_, _, loader_issue) = loader_state(&steam);
    if let Some(issue) = loader_issue {
        return LuaInstallResult {
            success: false,
            message: issue,
            logs: vec![],
            added_appids: vec![],
        };
    }
    let stplugin = stplugin_dir(&steam);
    let migrated_lua = migrate_legacy_lua(&steam, &stplugin);
    let context = InstallContext {
        stplugin,
        depotcache: depotcache_dir(&steam),
        manifest_cache: manifest_cache_dir(app),
        auto_update,
    };
    let migrated = migrate_legacy_manifests(&steam);
    if let Err(error) = fs::create_dir_all(&context.stplugin) {
        return LuaInstallResult {
            success: false,
            message: format!("Не удалось подготовить папку lua: {error}"),
            logs: vec![],
            added_appids: vec![],
        };
    }
    let _ = fs::create_dir_all(&context.depotcache);

    let mut logs = Vec::new();
    if migrated > 0 {
        logs.push(format!(
            "Исправлено старых манифестов: {migrated} (перенесены в Steam\\depotcache)"
        ));
    }
    if migrated_lua > 0 {
        logs.push(format!(
            "Исправлено старых Lua: {migrated_lua} (перенесены в папку загрузчика)"
        ));
    }
    let mut added = Vec::new();
    install_zip_reader(&context, std::io::Cursor::new(bytes), &mut logs, &mut added);

    if added.is_empty() {
        return LuaInstallResult {
            success: false,
            message: "В пакете не найдено lua-файлов".into(),
            logs,
            added_appids: added,
        };
    }
    let mut registry = load_registry(app);
    let stamp = now_unix();
    for appid in &added {
        registry.entry(appid.clone()).or_insert(stamp);
    }
    save_registry(app, &registry);
    LuaInstallResult {
        success: true,
        message: format!(
            "Добавлено игр: {}. Перезапустите Steam, чтобы они появились в библиотеке.",
            added.len()
        ),
        logs,
        added_appids: added,
    }
}

#[tauri::command]
pub async fn luatools_install(
    app: AppHandle,
    paths: Vec<String>,
    steam_path: Option<String>,
    auto_update: bool,
) -> LuaInstallResult {
    match tauri::async_runtime::spawn_blocking(move || {
        luatools_install_blocking(app, paths, steam_path, auto_update)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => LuaInstallResult {
            success: false,
            message: format!("Установка прервана: {error}"),
            logs: vec![],
            added_appids: vec![],
        },
    }
}

fn luatools_install_blocking(
    app: AppHandle,
    paths: Vec<String>,
    steam_path: Option<String>,
    auto_update: bool,
) -> LuaInstallResult {
    let _resource_guard =
        match crate::resource_lock::Guard::scope(&[match resolve_steam_path(steam_path.clone()) {
            Some(p) => p,
            None => {
                return LuaInstallResult {
                    success: false,
                    message: "Папка Steam не найдена".into(),
                    logs: vec![],
                    added_appids: vec![],
                }
            }
        }]) {
            Ok(guard) => guard,
            Err(error) => {
                return LuaInstallResult {
                    success: false,
                    message: error,
                    logs: vec![],
                    added_appids: vec![],
                };
            }
        };

    let Some(steam) = resolve_steam_path(steam_path) else {
        return LuaInstallResult {
            success: false,
            message: "Папка Steam не найдена — укажите её вручную".into(),
            logs: vec![],
            added_appids: vec![],
        };
    };
    ensure_opensteamtool_installed(&app, &steam);
    let (_, _, loader_issue) = loader_state(&steam);
    if let Some(issue) = loader_issue {
        return LuaInstallResult {
            success: false,
            message: issue,
            logs: vec![],
            added_appids: vec![],
        };
    }
    let stplugin = stplugin_dir(&steam);
    let migrated_lua = migrate_legacy_lua(&steam, &stplugin);
    let context = InstallContext {
        stplugin,
        depotcache: depotcache_dir(&steam),
        manifest_cache: manifest_cache_dir(&app),
        auto_update,
    };
    let migrated = migrate_legacy_manifests(&steam);
    if let Err(error) = fs::create_dir_all(&context.stplugin) {
        return LuaInstallResult {
            success: false,
            message: format!("Не удалось подготовить папку lua: {error}"),
            logs: vec![],
            added_appids: vec![],
        };
    }
    let _ = fs::create_dir_all(&context.depotcache);

    let mut logs = Vec::new();
    if migrated > 0 {
        logs.push(format!(
            "Исправлено старых манифестов: {migrated} (перенесены в Steam\\depotcache)"
        ));
    }
    if migrated_lua > 0 {
        logs.push(format!(
            "Исправлено старых Lua: {migrated_lua} (перенесены в папку загрузчика)"
        ));
    }
    let mut added = Vec::new();
    for raw in &paths {
        let path = PathBuf::from(raw);
        if !path.is_file() {
            logs.push(format!("⚠ Файл не найден: {raw}"));
            continue;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let lower = name.to_lowercase();
        if lower.ends_with(".zip") {
            install_archive(&context, &path, &mut logs, &mut added);
        } else if lower.ends_with(".lua") || lower.ends_with(".manifest") {
            match fs::read(&path) {
                Ok(bytes) => install_bytes(&context, &name, &bytes, &mut logs, &mut added),
                Err(error) => logs.push(format!("⚠ Не удалось прочитать {name}: {error}")),
            }
        } else {
            logs.push(format!(
                "⚠ Пропущен {name}: поддерживаются .lua, .manifest, .zip"
            ));
        }
    }

    if added.is_empty() {
        LuaInstallResult {
            success: false,
            message: "Не добавлено ни одной игры — проверьте файлы".into(),
            logs,
            added_appids: added,
        }
    } else {
        let mut registry = load_registry(&app);
        let stamp = now_unix();
        for appid in &added {
            registry.entry(appid.clone()).or_insert(stamp);
        }
        save_registry(&app, &registry);
        LuaInstallResult {
            success: true,
            message: format!(
                "Добавлено игр: {}. Перезапустите Steam, чтобы они появились в библиотеке.",
                added.len()
            ),
            logs,
            added_appids: added,
        }
    }
}

fn game_lua_paths(stplugin: &Path, appid: &str) -> (PathBuf, PathBuf) {
    (
        stplugin.join(format!("{appid}.lua")),
        stplugin.join(format!("{appid}.lua.disabled")),
    )
}

#[tauri::command]
pub fn luatools_toggle(appid: String, enable: bool, steam_path: Option<String>) -> OperationResult {
    let _resource_guard =
        match crate::resource_lock::Guard::scope(&[match resolve_steam_path(steam_path.clone()) {
            Some(p) => p,
            None => return OperationResult::error("Папка Steam не найдена", vec![]),
        }]) {
            Ok(guard) => guard,
            Err(error) => {
                return OperationResult::error(error, vec![]);
            }
        };

    let Some(steam) = resolve_steam_path(steam_path) else {
        return OperationResult::error("Папка Steam не найдена", vec![]);
    };
    let (active, disabled) = game_lua_paths(&stplugin_dir(&steam), &appid);
    let (from, to) = if enable {
        (&disabled, &active)
    } else {
        (&active, &disabled)
    };
    if !from.is_file() {
        return OperationResult::error("Файл lua для этой игры не найден", vec![]);
    }
    let _ = fs::remove_file(to);
    match fs::rename(from, to) {
        Ok(()) => OperationResult::ok(
            if enable {
                "Игра включена"
            } else {
                "Игра отключена"
            },
            vec![],
        ),
        Err(error) => {
            OperationResult::error(format!("Не удалось изменить состояние: {error}"), vec![])
        }
    }
}

#[tauri::command]
pub fn luatools_remove(
    app: AppHandle,
    appid: String,
    steam_path: Option<String>,
) -> OperationResult {
    let _resource_guard =
        match crate::resource_lock::Guard::scope(&[match resolve_steam_path(steam_path.clone()) {
            Some(p) => p,
            None => return OperationResult::error("Папка Steam не найдена", vec![]),
        }]) {
            Ok(guard) => guard,
            Err(error) => {
                return OperationResult::error(error, vec![]);
            }
        };

    let Some(steam) = resolve_steam_path(steam_path) else {
        return OperationResult::error("Папка Steam не найдена", vec![]);
    };
    let (active, disabled) = game_lua_paths(&stplugin_dir(&steam), &appid);
    let mut removed = false;
    for path in [active, disabled] {
        if path.is_file() {
            match fs::remove_file(&path) {
                Ok(()) => removed = true,
                Err(error) => {
                    return OperationResult::error(format!("Не удалось удалить: {error}"), vec![])
                }
            }
        }
    }
    let mut registry = load_registry(&app);
    if registry.remove(&appid).is_some() {
        save_registry(&app, &registry);
        removed = true;
    }
    if removed {
        OperationResult::ok("Игра удалена из загрузчика", vec![])
    } else {
        OperationResult::error("Файл lua для этой игры не найден", vec![])
    }
}

#[tauri::command]
pub async fn luatools_restart_steam(steam_path: Option<String>) -> OperationResult {
    match tauri::async_runtime::spawn_blocking(move || luatools_restart_steam_blocking(steam_path))
        .await
    {
        Ok(result) => result,
        Err(error) => OperationResult::error(format!("Перезапуск прерван: {error}"), vec![]),
    }
}

fn luatools_restart_steam_blocking(steam_path: Option<String>) -> OperationResult {
    let Some(steam) = resolve_steam_path(steam_path) else {
        return OperationResult::error("Папка Steam не найдена", vec![]);
    };
    let steam_exe = steam.join("steam.exe");
    if !steam_exe.is_file() {
        return OperationResult::error("steam.exe не найден в папке Steam", vec![]);
    }

    // Завершаем запущенные процессы Steam
    let _ = close_steam_process(Some(&steam_exe));
    std::thread::sleep(std::time::Duration::from_millis(600));

    match hidden_command(steam_exe.to_string_lossy().as_ref()).spawn() {
        Ok(_) => OperationResult::ok("Steam перезапускается…", vec![]),
        Err(error) => {
            OperationResult::error(format!("Не удалось запустить Steam: {error}"), vec![])
        }
    }
}

// Завершение работы процессов Steam (штатно, затем принудительно)
pub fn close_steam_process(steam_exe: Option<&Path>) -> bool {
    if !process_is_running("steam.exe") {
        return true;
    }
    if let Some(exe) = steam_exe {
        if exe.is_file() {
            let _ = hidden_command(exe.to_string_lossy().as_ref())
                .arg("-shutdown")
                .output();
            for _ in 0..15 {
                if !process_is_running("steam.exe") {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
    }
    if process_is_running("steam.exe") {
        let _ = hidden_command("taskkill.exe")
            .args(["/F", "/T", "/IM", "steam.exe"])
            .output();
    }
    if process_is_running("steamwebhelper.exe") {
        let _ = hidden_command("taskkill.exe")
            .args(["/F", "/T", "/IM", "steamwebhelper.exe"])
            .output();
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    !process_is_running("steam.exe")
}

// Проверка, запущен ли клиент Steam в данный момент
#[tauri::command]
pub fn luatools_is_steam_running() -> bool {
    process_is_running("steam.exe")
}

// Завершение работы клиента Steam
#[tauri::command]
pub async fn luatools_close_steam(steam_path: Option<String>) -> OperationResult {
    tauri::async_runtime::spawn_blocking(move || {
        let steam_exe = resolve_steam_path(steam_path).map(|p| p.join("steam.exe"));
        if close_steam_process(steam_exe.as_deref()) {
            OperationResult::ok("Steam успешно завершён", vec![])
        } else {
            OperationResult::error("Не удалось завершить процесс Steam", vec![])
        }
    })
    .await
    .map_err(|error| OperationResult::error(format!("Завершение прервано: {error}"), vec![]))
    .unwrap_or_else(|err| err)
}

fn process_is_running(image_name: &str) -> bool {
    let Ok(output) = hidden_command("tasklist.exe")
        .args(["/FI", &format!("IMAGENAME eq {image_name}"), "/NH"])
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout)
        .to_ascii_lowercase()
        .contains(&image_name.to_ascii_lowercase())
}

// Извлечение всех AppID и депо из lua
fn parse_lua_appids(content: &str) -> BTreeSet<u64> {
    let mut ids = BTreeSet::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("--") {
            continue;
        }
        for keyword in ["addappid(", "setManifestid("] {
            if let Some(pos) = trimmed.find(keyword) {
                let rest = &trimmed[pos + keyword.len()..];
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                if let Ok(id) = digits.parse::<u64>() {
                    ids.insert(id);
                }
            }
        }
    }
    ids
}

fn read_lua_content(stplugin: &Path, appid: &str) -> Option<String> {
    fs::read_to_string(stplugin.join(format!("{appid}.lua")))
        .or_else(|_| fs::read_to_string(stplugin.join(format!("{appid}.lua.disabled"))))
        .ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepotItem {
    pub id: String,
    pub name: String,
    pub is_dlc: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaGameDetail {
    pub appid: String,
    pub name: String,
    pub header: Option<String>,
    pub release_date: Option<String>,
    pub added_unix: Option<u64>,
    pub in_lua: Vec<DepotItem>,
    pub missing: Vec<DepotItem>,
}

fn sort_depots(items: &mut [DepotItem]) {
    items.sort_by_key(|item| item.id.parse::<u64>().unwrap_or(u64::MAX));
}

// Запрос названий приложений пачками для избежания rate-limit
fn resolve_names_map(ids: &[u64]) -> BTreeMap<String, String> {
    let mut names = BTreeMap::new();
    for chunk in ids.chunks(5) {
        let resolved = std::thread::scope(|scope| {
            let handles = chunk
                .iter()
                .map(|id| (*id, scope.spawn(move || crate::steam::app_name(*id))))
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|(id, handle)| (id, handle.join().ok().flatten()))
                .collect::<Vec<_>>()
        });
        for (id, name) in resolved {
            if let Some(name) = name {
                names.insert(id.to_string(), name);
            }
        }
    }
    names
}

#[tauri::command]
pub async fn luatools_game_detail(
    app: AppHandle,
    appid: String,
    steam_path: Option<String>,
) -> Result<LuaGameDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        luatools_game_detail_blocking(app, appid, steam_path)
    })
    .await
    .map_err(|error| format!("Запрос прерван: {error}"))?
}

fn luatools_game_detail_blocking(
    app: AppHandle,
    appid: String,
    steam_path: Option<String>,
) -> Result<LuaGameDetail, String> {
    let Some(steam) = resolve_steam_path(steam_path) else {
        return Err("Папка Steam не найдена".into());
    };
    let stplugin = stplugin_dir(&steam);
    let content = read_lua_content(&stplugin, &appid).ok_or("lua-файл игры не найден")?;
    let refs = parse_lua_appids(&content);
    let appid_num = appid.parse::<u64>().unwrap_or(0);

    // Запрос метаданных игры и списка DLC
    let overview = crate::steam::app_overview(appid_num)
        .ok_or("Steam не ответил — попробуйте открыть ещё раз")?;
    let dlc_ids: BTreeSet<u64> = overview.dlc_ids.into_iter().collect();

    // Получение названий для депо и DLC
    let mut need: BTreeSet<u64> = refs.iter().copied().filter(|id| *id != appid_num).collect();
    need.extend(dlc_ids.iter().copied());
    let names = resolve_names_map(&need.into_iter().collect::<Vec<_>>());

    // Формирование списка разблокированных DLC
    let mut in_lua = Vec::new();
    for id in &refs {
        if *id == appid_num || !dlc_ids.contains(id) {
            continue;
        }
        let key = id.to_string();
        in_lua.push(DepotItem {
            name: names
                .get(&key)
                .cloned()
                .unwrap_or_else(|| format!("DLC {key}")),
            is_dlc: true,
            id: key,
        });
    }
    sort_depots(&mut in_lua);

    // Формирование списка отсутствующих DLC
    let mut missing = Vec::new();
    for id in &dlc_ids {
        if *id == appid_num || refs.contains(id) {
            continue;
        }
        let key = id.to_string();
        missing.push(DepotItem {
            name: names
                .get(&key)
                .cloned()
                .unwrap_or_else(|| format!("DLC {key}")),
            is_dlc: true,
            id: key,
        });
    }
    sort_depots(&mut missing);

    Ok(LuaGameDetail {
        added_unix: load_registry(&app)
            .get(&appid)
            .copied()
            .filter(|time| *time > 0),
        appid,
        name: overview.name,
        header: overview.header_image,
        release_date: overview.release_date,
        in_lua,
        missing,
    })
}

#[tauri::command]
pub async fn luatools_names(appids: Vec<u64>) -> BTreeMap<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_names_map(&appids))
        .await
        .unwrap_or_default()
}

// Запрос прямых ссылок на обложки приложений пачками для исключения rate-limit
fn resolve_headers_map(ids: &[u64]) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    for chunk in ids.chunks(5) {
        let resolved = std::thread::scope(|scope| {
            let handles = chunk
                .iter()
                .map(|id| {
                    (
                        *id,
                        scope.spawn(move || {
                            crate::steam::app_overview(*id).and_then(|app| app.header_image)
                        }),
                    )
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|(id, handle)| (id, handle.join().ok().flatten()))
                .collect::<Vec<_>>()
        });
        for (id, header) in resolved {
            if let Some(header) = header {
                headers.insert(id.to_string(), header);
            }
        }
    }
    headers
}

#[tauri::command]
pub async fn luatools_headers(appids: Vec<u64>) -> BTreeMap<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_headers_map(&appids))
        .await
        .unwrap_or_default()
}

// Сведения о состоянии и доступных версиях загрузчика манифестов Steam
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLoaderInfo {
    // Выбранный источник загрузчика ("v1" или "v2")
    pub loader_source: String,
    // Название версии 1
    pub v1_name: String,
    // Описание версии 1
    pub v1_desc: String,
    // Название версии 2
    pub v2_name: String,
    // Описание версии 2
    pub v2_desc: String,
    // Активная версия в папке Steam ("v1", "v2", "custom", "none")
    pub active_in_steam: String,
    // Человекочитаемая подпись текущей версии в Steam
    pub active_in_steam_label: String,
    // Обнаружена ли папка Steam
    pub steam_detected: bool,
}

// Получение информации о текущем и доступных загрузчиках OpenSteamTool
#[tauri::command]
pub fn luatools_get_loader_info(app: AppHandle, steam_path: Option<String>) -> ManifestLoaderInfo {
    let settings = load_settings(&app);

    let (active_in_steam, active_in_steam_label, steam_detected) =
        if let Some(steam) = resolve_steam_path(steam_path) {
            let (status, label) = detect_active_loader_in_steam(&steam);
            (status, label, true)
        } else {
            ("none".into(), "Steam не найден".into(), false)
        };

    let source = if settings.loader_source == "v2" || settings.loader_source == "desktop" {
        "v2".into()
    } else {
        "v1".into()
    };

    ManifestLoaderInfo {
        loader_source: source,
        v1_name: "Версия 1 (Основная)".into(),
        v1_desc: "Основная стабильная сборка OpenSteamTool (1.57 МБ)".into(),
        v2_name: "Версия 2 (Альтернативная)".into(),
        v2_desc: "Альтернативная встроенная сборка OpenSteamTool (1.75 МБ). Включайте, если не работает основная версия.".into(),
        active_in_steam,
        active_in_steam_label,
        steam_detected,
    }
}

// Переключение выбранного источника загрузчика (встроенный v1 или встроенный v2)
#[tauri::command]
pub fn luatools_set_loader_source(
    app: AppHandle,
    source: String,
    steam_path: Option<String>,
) -> OperationResult {
    let _resource_guard =
        match crate::resource_lock::Guard::scope(&[match resolve_steam_path(steam_path.clone()) {
            Some(p) => p,
            None => return OperationResult::error("Папка Steam не найдена", vec![]),
        }]) {
            Ok(guard) => guard,
            Err(error) => {
                return OperationResult::error(error, vec![]);
            }
        };

    let mut settings = load_settings(&app);
    let valid_source = if source == "v2" || source == "desktop" {
        "v2"
    } else {
        "v1"
    };
    settings.loader_source = valid_source.into();
    save_settings(&app, &settings);

    let Some(steam) = resolve_steam_path(steam_path) else {
        return OperationResult::ok(
            format!(
                "Настройка сохранена ({}). Папка Steam не найдена — применится при обнаружении Steam.",
                if valid_source == "v2" { "Версия 2 (Альтернативная)" } else { "Версия 1 (Основная)" }
            ),
            vec![],
        );
    };

    match apply_opensteamtool_loader(&app, &steam, valid_source) {
        Ok(msg) => OperationResult::ok(msg, vec![]),
        Err(err) => OperationResult::error(err, vec![]),
    }
}

// Принудительное применение текущего загрузчика в папку Steam
#[tauri::command]
pub fn luatools_apply_loader(app: AppHandle, steam_path: Option<String>) -> OperationResult {
    let _resource_guard =
        match crate::resource_lock::Guard::scope(&[match resolve_steam_path(steam_path.clone()) {
            Some(p) => p,
            None => return OperationResult::error("Папка Steam не найдена", vec![]),
        }]) {
            Ok(guard) => guard,
            Err(error) => {
                return OperationResult::error(error, vec![]);
            }
        };

    let settings = load_settings(&app);
    let Some(steam) = resolve_steam_path(steam_path) else {
        return OperationResult::error("Папка Steam не найдена — укажите её вручную", vec![]);
    };

    match apply_opensteamtool_loader(&app, &steam, &settings.loader_source) {
        Ok(msg) => OperationResult::ok(msg, vec![]),
        Err(err) => OperationResult::error(err, vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_referenced_appids_ignoring_comments() {
        let lua =
            "addappid(480)\n--addappid(999)\nsetManifestid(481,\"12\")\naddappid(482,0,\"key\")\n";
        let ids = parse_lua_appids(lua);
        assert!(ids.contains(&480));
        assert!(ids.contains(&481));
        assert!(ids.contains(&482));
        assert!(
            !ids.contains(&999),
            "закомментированные строки игнорируются"
        );
    }

    #[test]
    fn extracts_appid_only_from_numeric_names() {
        assert_eq!(appid_from_lua("613100.lua").as_deref(), Some("613100"));
        assert_eq!(
            appid_from_lua("613100.lua.disabled").as_deref(),
            Some("613100")
        );
        assert_eq!(appid_from_lua("readme.lua"), None);
        assert_eq!(appid_from_lua("613100.manifest"), None);
    }

    #[test]
    fn comments_setmanifestid_when_auto_update() {
        let source = "addappid(480)\nsetManifestid(481,\"123\")\naddappid(481,0,\"key\")\n";
        let patched = patch_lua(source, true, "480");
        assert!(patched.contains("--setManifestid(481,\"123\")"));
        assert!(patched.contains("addappid(480)"));
        assert!(patched.contains("addappid(481,0,\"key\")"));
    }

    #[test]
    fn keeps_file_intact_when_updates_disabled() {
        let source = "addappid(480)\nsetManifestid(481,\"123\")\n";
        assert_eq!(patch_lua(source, false, "480"), source.trim_end());
    }

    #[test]
    fn adds_missing_root_appid_and_removes_bom() {
        let source = "\u{feff}addappid(481,0,\"key\")\nsetManifestid(481,\"123\")\n";
        let patched = patch_lua(source, true, "480");
        assert!(patched.starts_with("addappid(480)\n"));
        assert!(!patched.contains('\u{feff}'));
        assert!(patched.contains("--setManifestid(481,\"123\")"));
    }

    #[test]
    fn reads_opensteamtool_lua_paths() {
        let config = r#"
[general]
enabled = true

[lua]
paths = [
  "config/lua",
  'config/stplug-in'
]

[other]
paths = ["ignore"]
"#;
        assert_eq!(
            parse_opensteamtool_lua_paths(config),
            vec!["config/lua", "config/stplug-in"]
        );
    }

    #[test]
    fn uses_steam_root_depotcache() {
        let steam = PathBuf::from(r"C:\Steam");
        assert_eq!(
            legacy_stplugin_dir(&steam),
            steam.join("config").join("stplug-in")
        );
        assert_eq!(default_lua_dir(&steam), steam.join("config").join("lua"));
        assert_eq!(depotcache_dir(&steam), steam.join("depotcache"));
        assert_eq!(
            legacy_depotcache_dir(&steam),
            steam.join("config").join("depotcache")
        );
    }

    #[test]
    fn migrates_legacy_manifests_without_overwriting() {
        let dir = std::env::temp_dir().join(format!(
            "cgs-lua-migration-{}-{}",
            std::process::id(),
            now_unix()
        ));
        let legacy = legacy_depotcache_dir(&dir);
        let target = depotcache_dir(&dir);
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("10_100.manifest"), b"legacy-new").unwrap();
        fs::write(legacy.join("20_200.manifest"), b"legacy-old").unwrap();
        fs::write(legacy.join("ignore.txt"), b"ignore").unwrap();
        fs::write(target.join("20_200.manifest"), b"keep-current").unwrap();

        assert_eq!(migrate_legacy_manifests(&dir), 1);
        assert_eq!(
            fs::read(target.join("10_100.manifest")).unwrap(),
            b"legacy-new"
        );
        assert_eq!(
            fs::read(target.join("20_200.manifest")).unwrap(),
            b"keep-current"
        );
        assert!(!target.join("ignore.txt").exists());
        assert!(legacy.join("10_100.manifest").exists());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn registry_games_only_counts_registered_and_existing() {
        let dir = std::env::temp_dir().join(format!("cgs-lua-{}", std::process::id()));
        let stplugin = dir.join("config").join("stplug-in");
        let depotcache = dir.join("depotcache");
        fs::create_dir_all(&stplugin).unwrap();
        fs::create_dir_all(&depotcache).unwrap();
        // Тестовые наборы состояний файлов и реестра
        fs::write(stplugin.join("480.lua"), b"addappid(480)").unwrap();
        fs::write(stplugin.join("70.lua.disabled"), b"addappid(70)").unwrap();
        fs::write(stplugin.join("555.lua"), b"addappid(555)").unwrap();
        let registry: BTreeMap<String, u64> = [
            ("480".to_string(), 0),
            ("70".to_string(), 0),
            ("999".to_string(), 0),
        ]
        .into_iter()
        .collect();

        let games = registry_games(&registry, &stplugin, &depotcache, None);
        assert_eq!(
            games.len(),
            2,
            "555 не в реестре, 999 без файла — оба исключены"
        );
        assert_eq!(games[0].appid, "70");
        assert!(!games[0].enabled);
        assert_eq!(games[1].appid, "480");
        assert!(games[1].enabled);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reports_missing_and_installed_manifests() {
        let dir = std::env::temp_dir().join(format!(
            "cgs-lua-health-{}-{}",
            std::process::id(),
            now_unix()
        ));
        let depotcache = dir.join("depotcache");
        fs::create_dir_all(&depotcache).unwrap();
        let lua = dir.join("game.lua");
        fs::write(
            &lua,
            "addappid(480)\n-- setManifestid(481, \"123\")\nsetManifestid(482,\"456\")",
        )
        .unwrap();
        fs::write(depotcache.join("481_123.manifest"), b"manifest").unwrap();

        let (status, installed, missing) = game_health(&lua, &depotcache, true);
        assert_eq!(status, "missing_manifests");
        assert_eq!(installed, 1);
        assert_eq!(missing, 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restores_deleted_manifest_from_program_cache() {
        let dir = std::env::temp_dir().join(format!(
            "cgs-lua-restore-{}-{}",
            std::process::id(),
            now_unix()
        ));
        let depotcache = dir.join("depotcache");
        let cache = dir.join("manifest-cache");
        fs::create_dir_all(&depotcache).unwrap();
        fs::create_dir_all(&cache).unwrap();
        let lua = dir.join("480.lua");
        fs::write(&lua, "addappid(480)\n--setManifestid(481,\"123\")").unwrap();
        fs::write(cache.join("481_123.manifest"), b"cached-manifest").unwrap();

        assert_eq!(sync_game_manifest_cache(&lua, &depotcache, &cache), 1);
        assert_eq!(
            fs::read(depotcache.join("481_123.manifest")).unwrap(),
            b"cached-manifest"
        );
        assert_eq!(sync_game_manifest_cache(&lua, &depotcache, &cache), 0);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn detects_bundled_and_desktop_loader_files() {
        let temp_steam =
            std::env::temp_dir().join(format!("cgs-loader-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_steam);

        // Без файлов в Steam
        let (status, _) = detect_active_loader_in_steam(&temp_steam);
        assert_eq!(status, "none");

        // Записываем версию 1 (базовая)
        fs::write(
            temp_steam.join("OpenSteamTool.dll"),
            include_bytes!("../resources/opensteamtool/v1/OpenSteamTool.dll"),
        )
        .unwrap();
        let (status_v1, _) = detect_active_loader_in_steam(&temp_steam);
        assert_eq!(status_v1, "v1");

        // Записываем версию 2 (с десктопа)
        fs::write(
            temp_steam.join("OpenSteamTool.dll"),
            include_bytes!("../resources/opensteamtool/v2/OpenSteamTool.dll"),
        )
        .unwrap();
        let (status_v2, _) = detect_active_loader_in_steam(&temp_steam);
        assert_eq!(status_v2, "v2");

        // Записываем сторонний файл
        fs::write(
            temp_steam.join("OpenSteamTool.dll"),
            b"custom-dll-bytes-for-unit-test",
        )
        .unwrap();
        let (status_custom, _) = detect_active_loader_in_steam(&temp_steam);
        assert_eq!(status_custom, "custom");

        let _ = fs::remove_dir_all(temp_steam);
    }
}
