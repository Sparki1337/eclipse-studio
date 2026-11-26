//! Установка, переключение и диагностика загрузчика OpenSteamTool в папке Steam.

use super::*;

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

pub(crate) fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("luatools-settings.json"))
}

pub(crate) fn load_settings(app: &AppHandle) -> LuatoolsSettings {
    if let Some(path) = settings_path(app) {
        if let Ok(data) = fs::read(path) {
            if let Ok(settings) = serde_json::from_slice::<LuatoolsSettings>(&data) {
                return settings;
            }
        }
    }
    LuatoolsSettings::default()
}

pub(crate) fn save_settings(app: &AppHandle, settings: &LuatoolsSettings) {
    if let Some(path) = settings_path(app) {
        if let Ok(data) = serde_json::to_vec_pretty(settings) {
            let _ = fs::write(path, data);
        }
    }
}

// Определение активной версии OpenSteamTool в папке Steam с учётом Schema 2 и единого комплекта
pub fn detect_active_loader_in_steam(steam: &Path) -> (String, String) {
    if let Ok(Some(selection)) = crate::lua_loader::read_selection(steam) {
        if selection.variant == "compatibility" || selection.variant == "v2" {
            return ("v2".into(), "Версия 2 (Режим совместимости)".into());
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

    let embedded_ost = include_bytes!("../resources/opensteamtool/OpenSteamTool.dll");
    let cached_match = crate::loader_updates::cached(steam)
        .ok()
        .flatten()
        .and_then(|pkg| pkg.files.get("OpenSteamTool.dll").cloned())
        .is_some_and(|bytes| steam_bytes == bytes);

    if steam_bytes == embedded_ost || cached_match {
        if steam.join("bin/dwmapi.dll").is_file() {
            return ("v2".into(), "Версия 2 (Режим совместимости)".into());
        }
        return ("v1".into(), "Версия 1 (Основная)".into());
    }

    if steam.join("bin/dwmapi.dll").is_file() {
        return ("v2".into(), "Версия 2 (Режим совместимости)".into());
    }

    ("custom".into(), "Сторонняя версия".into())
}

pub(crate) fn configure_lua_folder(existing: &str) -> Result<String, String> {
    let source = if existing.trim().is_empty() {
        include_str!("../resources/opensteamtool/opensteamtool.toml")
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

pub(crate) fn atomic_loader_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    crate::durable::write(path, bytes)
}

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
    let result = crate::lua_loader::update(steam, Some(variant), false);
    if result.success {
        Ok(result.message)
    } else {
        Err(result.message)
    }
}

#[tauri::command]
pub async fn luatools_update_loader(
    steam_path: Option<String>,
    variant: Option<String>,
    online: Option<bool>,
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
        crate::lua_loader::update(&steam, variant.as_deref(), online.unwrap_or(true))
    })
    .await
    .unwrap_or_else(|e| OperationResult::error(format!("Ошибка фонового потока: {e}"), vec![]))
}

pub(crate) fn ensure_opensteamtool_installed(_app: &AppHandle, steam: &Path) {
    let _ = crate::lua_loader::ensure(steam);
}

pub(crate) fn parse_opensteamtool_lua_paths(content: &str) -> Vec<String> {
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

pub(crate) fn opensteamtool_lua_dirs(steam: &Path) -> Vec<PathBuf> {
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

pub(crate) fn stplugin_dir(steam: &Path) -> PathBuf {
    let preferred = default_lua_dir(steam);
    let ost_dirs = opensteamtool_lua_dirs(steam);
    if ost_dirs.iter().any(|d| d == &preferred) || preferred.is_dir() {
        return preferred;
    }
    ost_dirs.into_iter().next().unwrap_or(preferred)
}
pub(crate) fn loader_state(steam: &Path) -> (String, Option<String>, Option<String>) {
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

pub(crate) fn depotcache_dir(steam: &Path) -> PathBuf {
    DEPOTCACHE_REL
        .iter()
        .fold(steam.to_path_buf(), |acc, part| acc.join(part))
}

pub(crate) fn legacy_depotcache_dir(steam: &Path) -> PathBuf {
    LEGACY_DEPOTCACHE_REL
        .iter()
        .fold(steam.to_path_buf(), |acc, part| acc.join(part))
}

pub(crate) fn migrate_legacy_manifests(steam: &Path) -> usize {
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

pub(crate) fn sort_depots(items: &mut [DepotItem]) {
    items.sort_by_key(|item| item.id.parse::<u64>().unwrap_or(u64::MAX));
}

pub(crate) fn resolve_names_map(ids: &[u64]) -> BTreeMap<String, String> {
    let resolved = crate::http_pool::parallel_map(ids, 6, |&id| (id, crate::steam::app_name(id)));
    let mut names = BTreeMap::new();
    for (id, name) in resolved {
        if let Some(name) = name {
            names.insert(id.to_string(), name);
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

pub(crate) fn luatools_game_detail_blocking(
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

    let overview = crate::steam::app_overview(appid_num)
        .ok_or("Steam не ответил — попробуйте открыть ещё раз")?;
    let dlc_ids: BTreeSet<u64> = overview.dlc_ids.into_iter().collect();

    let mut need: BTreeSet<u64> = refs.iter().copied().filter(|id| *id != appid_num).collect();
    need.extend(dlc_ids.iter().copied());
    let names = resolve_names_map(&need.into_iter().collect::<Vec<_>>());

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

pub(crate) fn resolve_headers_map(ids: &[u64]) -> BTreeMap<String, String> {
    let resolved = crate::http_pool::parallel_map(ids, 6, |&id| {
        (
            id,
            crate::steam::app_overview(id).and_then(|app| app.header_image),
        )
    });
    let mut headers = BTreeMap::new();
    for (id, header) in resolved {
        if let Some(header) = header {
            headers.insert(id.to_string(), header);
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLoaderInfo {
    pub loader_source: String,
    pub v1_name: String,
    pub v1_desc: String,
    pub v2_name: String,
    pub v2_desc: String,
    pub active_in_steam: String,
    pub active_in_steam_label: String,
    pub steam_detected: bool,
}

#[tauri::command(async)]
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
        v1_desc: "Стандартное расположение OpenSteamTool (1.66 МБ): все DLL размещаются в корне Steam.".into(),
        v2_name: "Версия 2 (Режим совместимости)".into(),
        v2_desc: "Единый комплект OpenSteamTool с размещением dwmapi.dll в папке Steam/bin. Включайте, если основное расположение не срабатывает.".into(),
        active_in_steam,
        active_in_steam_label,
        steam_detected,
    }
}

#[tauri::command(async)]
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

#[tauri::command(async)]
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
