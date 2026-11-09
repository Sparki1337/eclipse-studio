//! Ядро локального облака без Tauri: проверки Lua, секция [cloud], состояние и перенос данных.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};
use toml_edit::{DocumentMut, Item};

/// Имя библиотеки движка в корне Steam (путь задаётся относительно папки Steam)
pub const DLL_NAME: &str = "cgs_cloud_redirect.dll";
/// Загрузчик OpenSteamTool, который подключает CloudRedirect через секцию [cloud]
pub const LOADER_DLL: &str = "OpenSteamTool.dll";
pub const LOADER_CONFIG: &str = "opensteamtool.toml";
/// Конфигурация провайдера: путь зашит в модифицированной сборке CloudRedirect
pub const PROVIDER_CONFIG: &str = "config/cgs-local-cloud.json";
/// Состояние программы: признак управления, исходная секция [cloud] и хеш DLL
pub const STATE_FILE: &str = "config/cgs-local-cloud-state.json";
pub const BACKUPS_DIR: &str = "config/cgs-local-cloud-backups";
/// Каталог принадлежит CloudRedirect: сохраняется при выключении, чтобы не потерять несинхронизированные данные.
#[allow(dead_code)]
pub const WORK_DIR: &str = "cgs-local-cloud";
/// Экспорт, по которому OpenSteamTool инициализирует облачный модуль
pub const CLOUD_EXPORT: &[u8] = b"CR_InitCloudSave";
pub const COMPONENT_VERSION: &str = "2.6.6-cgs-local.2";
/// Количество хранимых резервных копий конфигурации
pub const MAX_BACKUPS: usize = 10;
const LUA_DIRS: [&str; 2] = ["config/lua", "config/stplug-in"];
const BAD_CLOUD: &str =
    "Секция cloud в opensteamtool.toml имеет неверный формат. Файлы не изменены.";
pub const FOREIGN_CLOUD: &str =
    "Уже настроен другой CloudRedirect. Сначала отключите его через прежнюю программу.";
pub const CORRUPT_STATE: &str = "Повреждены настройки локального облака. Выключите режим, чтобы сбросить их: сохранения не удаляются.";
pub const DLL_CHANGED: &str =
    "Файл cgs_cloud_redirect.dll изменён извне; автоматическая замена отменена.";

pub fn steam_file(steam: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(steam.to_path_buf(), |path, part| path.join(part))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// ── Область действия: порт CgsManifestGame из third_party/cloudredirect/src/common/cgs_scope.h

/// Пробельные символы C isspace() в локали "C"
fn is_c_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Lua относится к локальному облаку, если объявляет собственный addappid
/// и содержит хотя бы одну ссылку setManifestid (даже закомментированную)
pub fn lua_declares_manifest_game(bytes: &[u8], app: u32) -> bool {
    if app == 0 {
        return false;
    }
    let marker = format!("addappid({app}");
    let (mut own, mut manifest) = (false, false);
    for raw in bytes.split(|byte| *byte == b'\n') {
        let line = raw.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(raw);
        let compact: Vec<u8> = line
            .iter()
            .filter(|byte| !is_c_space(**byte))
            .map(|byte| byte.to_ascii_lowercase())
            .collect();
        if compact.starts_with(marker.as_bytes())
            && matches!(compact.get(marker.len()), Some(b')') | Some(b','))
        {
            own = true;
        }
        let Some(start) = find(&compact, b"setmanifestid(") else {
            continue;
        };
        let mut position = start + "setmanifestid(".len();
        let mut numbers = [false; 2];
        for found in numbers.iter_mut() {
            while position < compact.len() && !compact[position].is_ascii_digit() {
                position += 1;
            }
            while position < compact.len() && compact[position].is_ascii_digit() {
                *found = true;
                position += 1;
            }
        }
        // Кэш загрузок Steam может быть очищен: связь с манифестом хранится в самом Lua
        if numbers[0] && numbers[1] {
            manifest = true;
        }
    }
    own && manifest
}

/// Проверка одной игры так же, как это делает DLL при каждом запросе Steam Cloud
pub fn manifest_game(steam: &Path, app: u32) -> bool {
    if app == 0 {
        return false;
    }
    for dir in LUA_DIRS {
        let lua = steam_file(steam, dir).join(format!("{app}.lua"));
        match fs::symlink_metadata(&lua) {
            Ok(meta) if meta.file_type().is_symlink() => continue,
            Ok(meta) if meta.is_file() => {}
            _ => continue,
        }
        if fs::read(&lua).is_ok_and(|bytes| lua_declares_manifest_game(&bytes, app)) {
            return true;
        }
    }
    false
}

/// Список AppID, сохранения которых обрабатывает локальное облако (выключенные .lua.disabled не входят)
pub fn eligible_apps(steam: &Path) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for dir in LUA_DIRS {
        let Ok(entries) = fs::read_dir(steam_file(steam, dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let Some(stem) = name.strip_suffix(".lua") else {
                continue;
            };
            if stem.is_empty() || stem.len() > 10 || !stem.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            if let Ok(app) = stem.parse::<u32>() {
                if manifest_game(steam, app) {
                    ids.insert(app);
                }
            }
        }
    }
    ids.into_iter().map(|id| id.to_string()).collect()
}

/// Поддержку определяет экспорт CR_InitCloudSave в установленном OpenSteamTool.dll
pub fn loader_supports_cloud(loader: &[u8]) -> bool {
    find(loader, CLOUD_EXPORT).is_some()
}

// ── Секция [cloud] в opensteamtool.toml

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudSection {
    pub enabled: bool,
    pub library: Option<String>,
    pub text: String,
}

pub fn parse_loader_config(bytes: &[u8]) -> Result<DocumentMut, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        "Конфигурация загрузчика не в UTF-8: сохраните opensteamtool.toml в кодировке UTF-8."
            .to_string()
    })?;
    text.trim_start_matches('\u{feff}')
        .parse::<DocumentMut>()
        .map_err(|error| {
            format!("Не удалось прочитать opensteamtool.toml: {error}. Файлы не изменены.")
        })
}

fn item_text(item: &Item) -> String {
    let mut document = DocumentMut::new();
    document.insert("cloud", item.clone());
    document.to_string()
}

pub fn cloud_section(document: &DocumentMut) -> Result<Option<CloudSection>, String> {
    let Some(item) = document.get("cloud") else {
        return Ok(None);
    };
    if !item.is_table() && !item.is_inline_table() {
        return Err(BAD_CLOUD.into());
    }
    let enabled = match item.get("enabled") {
        None => false,
        Some(value) => value.as_bool().ok_or(BAD_CLOUD)?,
    };
    let library = match item.get("library") {
        None => None,
        Some(value) => Some(value.as_str().ok_or(BAD_CLOUD)?.to_string()),
    };
    Ok(Some(CloudSection {
        enabled,
        library,
        text: item_text(item),
    }))
}

/// Библиотека указывает на встроенный движок (относительно Steam или абсолютным путём)
pub fn library_is_ours(library: Option<&str>, steam: &Path) -> bool {
    let Some(library) = library.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let normalized = library.replace('/', "\\");
    let normalized = normalized.trim_start_matches(".\\");
    if normalized.eq_ignore_ascii_case(DLL_NAME) {
        return true;
    }
    let ours = steam.join(DLL_NAME).to_string_lossy().replace('/', "\\");
    normalized.eq_ignore_ascii_case(&ours)
}

/// Включение: [cloud] enabled = true, library = 'cgs_cloud_redirect.dll'; прочие секции не меняются
pub fn enable_cloud(document: &mut DocumentMut) -> Result<(), String> {
    let section: DocumentMut = format!("[cloud]\nenabled = true\nlibrary = '{DLL_NAME}'\n")
        .parse()
        .map_err(|error| format!("{error}"))?;
    let mut item = section.get("cloud").cloned().ok_or(BAD_CLOUD)?;
    if let Some(table) = item.as_table_mut() {
        table.set_position(None);
    }
    document.insert("cloud", item);
    Ok(())
}

/// Выключение: возвращаем прежнюю секцию [cloud] или удаляем её, если раньше её не было
pub fn restore_cloud(document: &mut DocumentMut, previous: Option<&str>) -> Result<(), String> {
    match previous.filter(|text| !text.trim().is_empty()) {
        None => {
            document.remove("cloud");
        }
        Some(text) => {
            let parsed: DocumentMut = text.parse().map_err(|_| CORRUPT_STATE.to_string())?;
            let mut item = parsed.get("cloud").cloned().ok_or(CORRUPT_STATE)?;
            if let Some(table) = item.as_table_mut() {
                table.set_position(None);
            }
            document.insert("cloud", item);
        }
    }
    Ok(())
}

// ── Конфигурация провайдера и состояние

/// Только провайдер "folder"; статистика, достижения, время и родительский контроль выключены
pub fn provider_config(folder: &str) -> Vec<u8> {
    let value = serde_json::json!({
        "provider": "folder",
        "sync_path": folder,
        "sync_luas": false,
        "sync_achievements": false,
        "sync_playtime": false,
        "show_non_steam_game": false,
        "parental_bypass_playtime": false,
        "parental_ignore_playtime": false
    });
    let mut bytes = serde_json::to_vec_pretty(&value).unwrap_or_default();
    bytes.push(b'\n');
    bytes
}

pub fn provider_folder(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if value.get("provider")?.as_str()? != "folder" {
        return None;
    }
    value
        .get("sync_path")?
        .as_str()
        .map(str::to_string)
        .filter(|path| !path.trim().is_empty())
}

/// Поля необязательны: файл совместим с состоянием Crocodile Gena Studio той же структуры
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub schema: u32,
    pub managed: bool,
    pub folder: Option<String>,
    pub dll_sha256: Option<String>,
    pub previous_cloud: Option<String>,
    pub updated_unix: u64,
}

pub fn parse_state(bytes: Option<&[u8]>) -> Result<State, String> {
    match bytes {
        None => Ok(State::default()),
        Some(bytes) => {
            let text = std::str::from_utf8(bytes).map_err(|_| CORRUPT_STATE.to_string())?;
            serde_json::from_str::<State>(text.trim_start_matches('\u{feff}'))
                .map_err(|_| CORRUPT_STATE.to_string())
        }
    }
}

pub fn state_bytes(state: &State) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(state).unwrap_or_default();
    bytes.push(b'\n');
    bytes
}

// ── Снимок файлов Steam

/// Содержимое файлов, которые изменяет локальное облако (None — файла нет)
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Snapshot {
    pub config: Option<Vec<u8>>,
    pub provider: Option<Vec<u8>>,
    pub state: Option<Vec<u8>>,
    pub dll: Option<Vec<u8>>,
    pub dll_sha256: Option<String>,
    pub loader: Option<Vec<u8>>,
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if crate::safe_path::is_link(&meta) => Err(format!(
            "Ссылки запрещены для файлов локального облака: {}",
            path.display()
        )),
        Ok(meta) if !meta.is_file() => Err(format!("Ожидался файл: {}", path.display())),
        Ok(_) => fs::read(path)
            .map(Some)
            .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Не удалось проверить {}: {error}", path.display())),
    }
}

pub fn snapshot(steam: &Path) -> Result<Snapshot, String> {
    let dll = read_optional(&steam.join(DLL_NAME))?;
    Ok(Snapshot {
        config: read_optional(&steam.join(LOADER_CONFIG))?,
        provider: read_optional(&steam_file(steam, PROVIDER_CONFIG))?,
        state: read_optional(&steam_file(steam, STATE_FILE))?,
        dll_sha256: dll.as_deref().map(sha256_hex),
        dll,
        loader: read_optional(&steam.join(LOADER_DLL))?,
    })
}

/// Итоговое состояние для интерфейса (переводы выполняет UI)
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub managed: bool,
    pub folder: Option<String>,
    pub eligible_apps: Vec<String>,
    pub loader_supported: bool,
    pub issue: Option<String>,
    pub steam_path: Option<String>,
    pub component_version: String,
    pub component_outdated: bool,
}

/// Внешне изменённая DLL и неподдерживаемый загрузчик обновлением не считаются.
pub fn component_update_available(
    state: &State,
    snap: &Snapshot,
    embedded_sha256: &str,
    loader_supported: bool,
) -> bool {
    if !state.managed || !loader_supported {
        return false;
    }
    match snap.dll_sha256.as_deref() {
        Some(hash) if hash == embedded_sha256 => false,
        Some(hash) => state.dll_sha256.as_deref() == Some(hash),
        // Управляемую DLL удалили: её можно восстановить обновлением
        None => true,
    }
}

pub fn status(steam: &Path, snap: &Snapshot, embedded_sha256: &str) -> Status {
    let mut issue = None;
    let state = match parse_state(snap.state.as_deref()) {
        Ok(state) => state,
        Err(error) => {
            issue = Some(error);
            State::default()
        }
    };
    let section = match snap.config.as_deref().map(parse_loader_config).transpose() {
        Ok(document) => match document.as_ref().map(cloud_section).transpose() {
            Ok(section) => section.flatten(),
            Err(error) => {
                issue.get_or_insert(error);
                None
            }
        },
        Err(error) => {
            issue.get_or_insert(error);
            None
        }
    };
    let ours = section
        .as_ref()
        .is_some_and(|s| library_is_ours(s.library.as_deref(), steam));
    let configured = section.as_ref().is_some_and(|s| s.enabled) && ours;
    let loader_supported = snap.loader.as_deref().is_some_and(loader_supports_cloud);
    let dll_known = snap
        .dll_sha256
        .as_deref()
        .is_some_and(|hash| hash == embedded_sha256 || state.dll_sha256.as_deref() == Some(hash));
    if section.as_ref().is_some_and(|s| s.enabled) && !ours && issue.is_none() {
        issue = Some(FOREIGN_CLOUD.into());
    }
    if configured && issue.is_none() {
        // Изменённую извне DLL автозамена не трогает; отсутствующую восстановит обновление
        if snap.dll_sha256.is_some() && !dll_known {
            issue = Some("Файл локального облака отсутствует или изменён. Включите режим заново, чтобы восстановить его.".into());
        } else if !loader_supported {
            issue = Some("Установленный OpenSteamTool не поддерживает CloudRedirect. Выберите совместимый комплект DLL в разделе загрузчика.".into());
        }
    }
    if state.managed && !configured && issue.is_none() {
        issue = Some(
            "Секция cloud изменена другой программой. Включите режим заново или выключите его."
                .into(),
        );
    }
    let folder = state
        .folder
        .clone()
        .or_else(|| snap.provider.as_deref().and_then(provider_folder));
    let component_outdated = issue.is_none()
        && component_update_available(&state, snap, embedded_sha256, loader_supported);
    Status {
        enabled: configured,
        managed: state.managed || configured,
        folder,
        eligible_apps: eligible_apps(steam),
        loader_supported,
        issue,
        steam_path: Some(steam.display().to_string()),
        component_version: COMPONENT_VERSION.into(),
        component_outdated,
    }
}

// ── План изменений

/// Файл относительно папки Steam и новое содержимое (None — удалить)
pub type Change = (&'static str, Option<Vec<u8>>);

#[derive(Debug)]
pub struct EnablePlan {
    pub changes: Vec<Change>,
    pub state: State,
}

/// Включение или повторное применение (смена папки, обновление DLL)
pub fn plan_enable(
    steam: &Path,
    snap: &Snapshot,
    folder: &str,
    embedded: &[u8],
    now_unix: u64,
) -> Result<EnablePlan, String> {
    if !snap.loader.as_deref().is_some_and(loader_supports_cloud) {
        return Err(if snap.loader.is_none() {
            "OpenSteamTool не установлен в Steam. Сначала примените загрузчик в разделе «Версия OpenSteamTool».".into()
        } else {
            "Этот загрузчик не поддерживает CloudRedirect. Выберите совместимый комплект DLL (Версия 1 или Версия 2) и примените его в Steam.".into()
        });
    }
    let previous_state = parse_state(snap.state.as_deref())?;
    let mut document = parse_loader_config(snap.config.as_deref().unwrap_or_default())?;
    let section = cloud_section(&document)?;
    let ours = section
        .as_ref()
        .is_some_and(|s| library_is_ours(s.library.as_deref(), steam));
    if section.as_ref().is_some_and(|s| s.enabled) && !ours {
        return Err(FOREIGN_CLOUD.into());
    }
    // Прежнюю секцию запоминаем только при первом включении
    let previous_cloud = if previous_state.managed || ours {
        previous_state.previous_cloud.clone()
    } else {
        section.as_ref().map(|s| s.text.clone())
    };
    let embedded_hash = sha256_hex(embedded);
    let mut changes: Vec<Change> = Vec::new();
    match snap.dll_sha256.as_deref() {
        Some(hash) if hash == embedded_hash => {}
        Some(hash) if previous_state.dll_sha256.as_deref() == Some(hash) => {
            changes.push((DLL_NAME, Some(embedded.to_vec())));
        }
        Some(_) => return Err(DLL_CHANGED.into()),
        None => changes.push((DLL_NAME, Some(embedded.to_vec()))),
    }
    enable_cloud(&mut document)?;
    let config = document.to_string().into_bytes();
    if snap.config.as_deref() != Some(config.as_slice()) {
        changes.push((LOADER_CONFIG, Some(config)));
    }
    let provider = provider_config(folder);
    if snap.provider.as_deref() != Some(provider.as_slice()) {
        changes.push((PROVIDER_CONFIG, Some(provider)));
    }
    let state = State {
        schema: 1,
        managed: true,
        folder: Some(folder.to_string()),
        dll_sha256: Some(embedded_hash),
        previous_cloud,
        updated_unix: now_unix,
    };
    changes.push((STATE_FILE, Some(state_bytes(&state))));
    Ok(EnablePlan { changes, state })
}

/// Обновление только встроенной DLL: режим, папка и конфигурация не меняются
pub fn plan_component_update(
    steam: &Path,
    snap: &Snapshot,
    embedded: &[u8],
    now_unix: u64,
) -> Result<EnablePlan, String> {
    if !snap.loader.as_deref().is_some_and(loader_supports_cloud) {
        return Err("Установленный OpenSteamTool не поддерживает CloudRedirect.".into());
    }
    let mut state = parse_state(snap.state.as_deref())?;
    if !state.managed {
        return Err("Локальное облако не настроено. Включите режим и выберите папку.".into());
    }
    // Секцию cloud могла забрать другая программа: тогда DLL не трогаем
    let document = parse_loader_config(snap.config.as_deref().unwrap_or_default())?;
    let ours = cloud_section(&document)?.is_some_and(|section| {
        section.enabled && library_is_ours(section.library.as_deref(), steam)
    });
    if !ours {
        return Err(
            "Секция cloud больше не управляется Eclipse Studio. Включите режим заново.".into(),
        );
    }
    let embedded_hash = sha256_hex(embedded);
    if snap.dll_sha256.as_deref() == Some(embedded_hash.as_str()) {
        return Err("Встроенная DLL уже установлена: обновление не требуется.".into());
    }
    // Заменяем только свою DLL: изменённый извне файл не трогаем
    if let Some(hash) = snap.dll_sha256.as_deref() {
        if state.dll_sha256.as_deref() != Some(hash) {
            return Err(DLL_CHANGED.into());
        }
    }
    state.schema = 1;
    state.dll_sha256 = Some(embedded_hash);
    state.updated_unix = now_unix;
    // Конфигурация загрузчика и провайдера остаётся прежней: обновляется только компонент
    let changes = vec![
        (DLL_NAME, Some(embedded.to_vec())),
        (STATE_FILE, Some(state_bytes(&state))),
    ];
    Ok(EnablePlan { changes, state })
}

/// Выключение: секция [cloud] возвращается, сохранения и рабочие данные остаются на месте
pub fn plan_disable(
    steam: &Path,
    snap: &Snapshot,
    embedded_sha256: &str,
    now_unix: u64,
) -> Result<EnablePlan, String> {
    // Повреждённое состояние сбрасывается: исходную секцию узнать нельзя, поэтому удаляем свою
    let previous_state = parse_state(snap.state.as_deref()).unwrap_or_default();
    let mut changes: Vec<Change> = Vec::new();
    if let Some(bytes) = snap.config.as_deref() {
        let mut document = parse_loader_config(bytes)?;
        let section = cloud_section(&document)?;
        if section
            .as_ref()
            .is_some_and(|s| library_is_ours(s.library.as_deref(), steam))
        {
            restore_cloud(&mut document, previous_state.previous_cloud.as_deref())?;
            let config = document.to_string().into_bytes();
            if config != bytes {
                changes.push((LOADER_CONFIG, Some(config)));
            }
        }
    }
    // DLL удаляется только если её не меняли: Steam её больше не загружает
    if let Some(hash) = snap.dll_sha256.as_deref() {
        if hash == embedded_sha256 || previous_state.dll_sha256.as_deref() == Some(hash) {
            changes.push((DLL_NAME, None));
        }
    }
    let state = State {
        schema: 1,
        managed: false,
        folder: previous_state
            .folder
            .clone()
            .or_else(|| snap.provider.as_deref().and_then(provider_folder)),
        dll_sha256: None,
        previous_cloud: None,
        updated_unix: now_unix,
    };
    changes.push((STATE_FILE, Some(state_bytes(&state))));
    Ok(EnablePlan { changes, state })
}

// ── Применение с резервной копией и откатом

fn backup_stamp(now_unix: u64) -> String {
    format!(
        "{now_unix}-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    )
}

/// Резервная копия opensteamtool.toml, конфигурации провайдера, состояния и DLL
pub fn backup(steam: &Path, snap: &Snapshot, now_unix: u64) -> Result<PathBuf, String> {
    let root = steam_file(steam, BACKUPS_DIR);
    let folder = root.join(backup_stamp(now_unix));
    fs::create_dir_all(&folder)
        .map_err(|error| format!("Не удалось создать резервную копию: {error}"))?;
    for (name, bytes) in [
        ("opensteamtool.toml", &snap.config),
        ("cgs-local-cloud.json", &snap.provider),
        ("cgs-local-cloud-state.json", &snap.state),
        (DLL_NAME, &snap.dll),
    ] {
        if let Some(bytes) = bytes {
            crate::durable::write(&folder.join(name), bytes)?;
        }
    }
    // Старые копии удаляются, последние MAX_BACKUPS сохраняются
    if let Ok(entries) = fs::read_dir(&root) {
        let mut folders: Vec<_> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .map(|entry| entry.path())
            .collect();
        folders.sort();
        while folders.len() > MAX_BACKUPS {
            let oldest = folders.remove(0);
            let _ = fs::remove_dir_all(oldest);
        }
    }
    Ok(folder)
}

/// Изменения применяются по очереди; при ошибке уже записанные файлы возвращаются из снимка
pub fn apply(steam: &Path, snap: &Snapshot, changes: &[Change]) -> Result<(), String> {
    let original = |name: &str| -> Option<Option<Vec<u8>>> {
        match name {
            LOADER_CONFIG => Some(snap.config.clone()),
            PROVIDER_CONFIG => Some(snap.provider.clone()),
            STATE_FILE => Some(snap.state.clone()),
            DLL_NAME => Some(snap.dll.clone()),
            _ => None,
        }
    };
    let mut done: Vec<(&str, Option<Vec<u8>>)> = Vec::new();
    for (name, bytes) in changes {
        let target = steam_file(steam, name);
        let result = match bytes {
            Some(bytes) => crate::durable::write(&target, bytes),
            None => match fs::remove_file(&target) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!("Не удалось удалить {}: {error}", target.display())),
            },
        };
        if let Err(error) = result {
            for (written, previous) in done.into_iter().rev() {
                let path = steam_file(steam, written);
                let previous = original(written).flatten().or(previous);
                let _ = match previous {
                    Some(bytes) => crate::durable::write(&path, &bytes),
                    None => fs::remove_file(&path).map_err(|e| e.to_string()),
                };
            }
            return Err(format!(
                "{}. Изменения отменены.",
                error.trim_end_matches('.')
            ));
        }
        done.push((name, None));
    }
    Ok(())
}

// ── Папка хранения

/// Ключ пути для сравнения: существующая часть разрешается, регистр в Windows не важен
pub fn path_key(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut suffix = Vec::new();
    while !existing.exists() {
        match (
            existing.file_name().map(|name| name.to_os_string()),
            existing.parent(),
        ) {
            (Some(name), Some(parent)) => {
                suffix.push(name);
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut key = fs::canonicalize(&existing)
        .map(crate::safe_path::strip_verbatim)
        .unwrap_or(existing);
    for part in suffix.into_iter().rev() {
        key.push(part);
    }
    #[cfg(windows)]
    {
        key = PathBuf::from(key.to_string_lossy().to_lowercase());
    }
    key
}

pub fn nested(left: &Path, right: &Path) -> bool {
    let (left, right) = (path_key(left), path_key(right));
    left.starts_with(&right) || right.starts_with(&left)
}

/// Проверка формы пути без обращения к диску; тип диска и запись проверяет платформенный код
pub fn normalize_folder(folder: &str, steam: &Path) -> Result<PathBuf, String> {
    let trimmed = folder.trim().trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return Err("Сначала выберите папку локального облака.".into());
    }
    let path = PathBuf::from(trimmed);
    #[cfg(windows)]
    {
        let mut components = path.components();
        let local_drive = matches!(
            components.next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::Disk(_))
        ) && matches!(components.next(), Some(Component::RootDir));
        if !local_drive {
            return Err("Выберите папку на локальном диске, например D:\\Game Saves.".into());
        }
    }
    if !path.is_absolute() {
        return Err("Выберите папку на локальном диске, например D:\\Game Saves.".into());
    }
    if !path
        .components()
        .any(|component| matches!(component, Component::Normal(_)))
    {
        return Err("Выберите отдельную папку, а не корень диска: нет родительской папки.".into());
    }
    crate::safe_path::validate_absolute(&path)
        .map_err(|error| format!("Неверный путь папки: {error}"))?;
    if nested(&path, steam) {
        return Err("Папка облака должна находиться отдельно от папки Steam.".into());
    }
    Ok(path)
}

/// Проверка записи в выбранную папку (создаётся при необходимости)
pub fn ensure_writable(folder: &Path) -> Result<(), String> {
    if let Ok(meta) = fs::symlink_metadata(folder) {
        if crate::safe_path::is_link(&meta) {
            return Err("Папка облака не должна быть ссылкой или точкой соединения.".into());
        }
        if !meta.is_dir() {
            return Err(format!("Путь занят файлом: {}", folder.display()));
        }
    }
    fs::create_dir_all(folder).map_err(|error| {
        format!(
            "Папка недоступна для записи: {} ({error})",
            folder.display()
        )
    })?;
    let probe = folder.join(format!(
        ".eclipse-cloud-probe-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::write(&probe, b"probe")
        .and_then(|_| fs::remove_file(&probe))
        .map_err(|error| {
            format!(
                "Папка недоступна для записи: {} ({error})",
                folder.display()
            )
        })
}

/// Данные провайдера folder: каталоги с числовыми именами (ID аккаунтов Steam)
fn provider_entries(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut result: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_dir())
                && entry.file_name().to_str().is_some_and(|name| {
                    !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit())
                })
        })
        .map(|entry| entry.path())
        .collect();
    result.sort();
    result
}

/// Перенос сохранений в новую папку: копирование с проверкой, оригиналы остаются на месте
pub fn migrate_folder(old: &Path, new: &Path) -> Result<usize, String> {
    if path_key(old) == path_key(new) {
        return Ok(0);
    }
    if nested(old, new) {
        return Err("Папки хранения не должны быть вложены друг в друга.".into());
    }
    if !old.exists() {
        // Диск отключён — перенос невозможен; сама папка могла быть ещё не создана
        let drive_present = old
            .ancestors()
            .last()
            .map(|root| root.as_os_str().is_empty() || root.exists())
            .unwrap_or(true);
        let root_present = old.components().take(2).collect::<PathBuf>().exists();
        if !drive_present || !root_present {
            return Err("Прежняя папка облака недоступна. Подключите диск перед переносом.".into());
        }
        return Ok(0);
    }
    let mut files = Vec::new();
    for account in provider_entries(old) {
        for entry in walkdir::WalkDir::new(&account).follow_links(false) {
            let entry = entry
                .map_err(|error| format!("Не удалось прочитать прежнюю папку облака: {error}"))?;
            if entry.file_type().is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(old)
                    .map_err(|_| "Неверный путь в папке облака".to_string())?
                    .to_path_buf();
                files.push(relative);
            }
        }
    }
    // Сначала проверяем конфликты, чтобы не оставить частичную копию
    for relative in &files {
        let destination = new.join(relative);
        if destination.exists() {
            let same = crate::durable::hash_file(&destination)?
                == crate::durable::hash_file(&old.join(relative))?;
            if !same {
                return Err(format!(
                    "В новой папке уже есть другое сохранение: {}. Выберите пустую папку.",
                    relative.display()
                ));
            }
        }
    }
    let mut copied = 0;
    for relative in &files {
        let destination = new.join(relative);
        if destination.exists() {
            continue;
        }
        crate::durable::copy(&old.join(relative), &destination)?;
        copied += 1;
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMBEDDED: &[u8] = b"MZ embedded cloud redirect";

    fn steam_with_loader() -> tempfile::TempDir {
        let steam = tempfile::tempdir().unwrap();
        fs::write(steam.path().join(LOADER_DLL), b"MZ...CR_InitCloudSave...").unwrap();
        steam
    }

    fn write(steam: &Path, relative: &str, bytes: &str) {
        let path = steam_file(steam, relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn manifest_scope_matches_native_rules() {
        let steam = tempfile::tempdir().unwrap();
        let root = steam.path();
        write(
            root,
            "config/lua/10.lua",
            "addappid(10)\n--setManifestid(11,\"123\")\naddappid(11,0,\"key\")",
        );
        write(
            root,
            "config/lua/20.lua",
            "addappid(21)\nsetManifestid(11,\"123\")",
        );
        write(
            root,
            "config/lua/30.lua.disabled",
            "addappid(30)\nsetManifestid(11,\"123\")",
        );
        write(
            root,
            "config/stplug-in/50.lua",
            "\u{feff}AddAppId( 50 , 1 )\r\nsetManifestid(51, \"77\")\r\n",
        );
        assert!(
            manifest_game(root, 10),
            "закомментированная ссылка на манифест"
        );
        assert!(!manifest_game(root, 11), "ID депо или DLC");
        assert!(!manifest_game(root, 20), "Lua открывает другое приложение");
        assert!(!manifest_game(root, 30), "выключенный Lua");
        assert!(!manifest_game(root, 40), "обычная игра Steam");
        assert!(manifest_game(root, 50), "BOM, регистр и пробелы");
        write(root, "config/lua/40.lua", "addappid(40)");
        assert!(!manifest_game(root, 40), "Lua без манифеста");
        assert!(!lua_declares_manifest_game(
            b"addappid(100)\nsetManifestid(5)",
            100
        ));
        assert!(!lua_declares_manifest_game(
            b"addappid(1000)\nsetManifestid(1,2)",
            100
        ));
        assert_eq!(
            eligible_apps(root),
            vec!["10".to_string(), "50".to_string()]
        );
        fs::remove_file(root.join("config/lua/10.lua")).unwrap();
        assert!(
            !manifest_game(root, 10),
            "удалённый Lua больше не входит в область"
        );
    }

    #[test]
    fn enable_preserves_other_sections_and_disable_restores_previous_cloud() {
        let steam = steam_with_loader();
        let root = steam.path();
        let original = "# custom\n[general]\nlog = true\n[lua]\npaths = [\n  'config/stplug-in', # old folder\n]\nother = 'keep'\n[cloud]\nenabled = false\nlibrary = 'cloud_redirect.dll'\n";
        fs::write(root.join(LOADER_CONFIG), original).unwrap();
        let snap = snapshot(root).unwrap();
        let plan = plan_enable(root, &snap, "D:\\Game Saves", EMBEDDED, 1).unwrap();
        apply(root, &snap, &plan.changes).unwrap();
        let config = fs::read_to_string(root.join(LOADER_CONFIG)).unwrap();
        assert!(
            config.contains("# custom")
                && config.contains("other = 'keep'")
                && config.contains("# old folder")
        );
        assert!(config.contains("[cloud]\nenabled = true\nlibrary = 'cgs_cloud_redirect.dll'"));
        assert_eq!(fs::read(root.join(DLL_NAME)).unwrap(), EMBEDDED);
        let provider: serde_json::Value =
            serde_json::from_slice(&fs::read(steam_file(root, PROVIDER_CONFIG)).unwrap()).unwrap();
        assert_eq!(provider["provider"], "folder");
        assert_eq!(provider["sync_path"], "D:\\Game Saves");
        for key in [
            "sync_luas",
            "sync_achievements",
            "sync_playtime",
            "show_non_steam_game",
            "parental_bypass_playtime",
            "parental_ignore_playtime",
        ] {
            assert_eq!(provider[key], false, "{key}");
        }
        let embedded_hash = sha256_hex(EMBEDDED);
        let enabled = status(root, &snapshot(root).unwrap(), &embedded_hash);
        assert!(
            enabled.enabled && enabled.managed && enabled.issue.is_none(),
            "{enabled:?}"
        );
        assert_eq!(enabled.folder.as_deref(), Some("D:\\Game Saves"));

        // Повторное применение не теряет исходную секцию
        let snap = snapshot(root).unwrap();
        let again = plan_enable(root, &snap, "E:\\Saves", EMBEDDED, 2).unwrap();
        assert!(again
            .state
            .previous_cloud
            .as_deref()
            .unwrap()
            .contains("cloud_redirect.dll"));
        apply(root, &snap, &again.changes).unwrap();

        let snap = snapshot(root).unwrap();
        let plan = plan_disable(root, &snap, &embedded_hash, 3).unwrap();
        apply(root, &snap, &plan.changes).unwrap();
        assert_eq!(
            fs::read_to_string(root.join(LOADER_CONFIG)).unwrap(),
            original
        );
        assert!(!root.join(DLL_NAME).exists());
        let disabled = status(root, &snapshot(root).unwrap(), &embedded_hash);
        assert!(
            !disabled.enabled && !disabled.managed && disabled.issue.is_none(),
            "{disabled:?}"
        );
        assert_eq!(
            disabled.folder.as_deref(),
            Some("E:\\Saves"),
            "папка остаётся после выключения"
        );
    }

    #[test]
    fn foreign_cloud_and_changed_dll_are_not_overwritten() {
        let steam = steam_with_loader();
        let root = steam.path();
        fs::write(
            root.join(LOADER_CONFIG),
            "[cloud]\nenabled = true\nlibrary = 'cloud_redirect.dll'\n",
        )
        .unwrap();
        let snap = snapshot(root).unwrap();
        assert_eq!(
            plan_enable(root, &snap, "D:\\S", EMBEDDED, 1)
                .err()
                .as_deref(),
            Some(FOREIGN_CLOUD)
        );
        assert_eq!(
            status(root, &snap, &sha256_hex(EMBEDDED)).issue.as_deref(),
            Some(FOREIGN_CLOUD)
        );

        fs::write(root.join(LOADER_CONFIG), "[lua]\npaths = ['config/lua']\n").unwrap();
        fs::write(root.join(DLL_NAME), b"MZ foreign build").unwrap();
        let snap = snapshot(root).unwrap();
        assert_eq!(
            plan_enable(root, &snap, "D:\\S", EMBEDDED, 1)
                .err()
                .as_deref(),
            Some(DLL_CHANGED)
        );

        fs::write(root.join(LOADER_CONFIG), "cloud = 'broken'\n").unwrap();
        let snap = snapshot(root).unwrap();
        assert!(plan_enable(root, &snap, "D:\\S", EMBEDDED, 1)
            .unwrap_err()
            .contains("неверный формат"));

        fs::write(root.join(LOADER_CONFIG), [0xff, 0xfe, 0x00]).unwrap();
        let snap = snapshot(root).unwrap();
        assert!(plan_enable(root, &snap, "D:\\S", EMBEDDED, 1)
            .unwrap_err()
            .contains("UTF-8"));
    }

    #[test]
    fn loader_without_cloud_export_is_rejected() {
        let steam = tempfile::tempdir().unwrap();
        let root = steam.path();
        let snap = snapshot(root).unwrap();
        assert!(plan_enable(root, &snap, "D:\\S", EMBEDDED, 1)
            .unwrap_err()
            .contains("не установлен"));
        fs::write(root.join(LOADER_DLL), b"MZ old loader").unwrap();
        let snap = snapshot(root).unwrap();
        assert!(plan_enable(root, &snap, "D:\\S", EMBEDDED, 1)
            .unwrap_err()
            .contains("не поддерживает CloudRedirect"));
        assert!(!status(root, &snap, "x").loader_supported);
    }

    #[test]
    fn outdated_own_dll_is_replaced_and_corrupt_state_can_be_reset() {
        let steam = steam_with_loader();
        let root = steam.path();
        let snap = snapshot(root).unwrap();
        let mut plan = plan_enable(root, &snap, "D:\\S", b"MZ old build", 1).unwrap();
        apply(root, &snap, &plan.changes).unwrap();
        let snap = snapshot(root).unwrap();
        assert!(status(root, &snap, &sha256_hex(EMBEDDED)).component_outdated);
        plan = plan_enable(root, &snap, "D:\\S", EMBEDDED, 2).unwrap();
        assert!(plan.changes.iter().any(|(name, _)| *name == DLL_NAME));
        apply(root, &snap, &plan.changes).unwrap();
        assert_eq!(fs::read(root.join(DLL_NAME)).unwrap(), EMBEDDED);

        write(root, STATE_FILE, "{broken");
        let snap = snapshot(root).unwrap();
        assert_eq!(
            status(root, &snap, &sha256_hex(EMBEDDED)).issue.as_deref(),
            Some(CORRUPT_STATE)
        );
        assert_eq!(
            plan_enable(root, &snap, "D:\\S", EMBEDDED, 3)
                .err()
                .as_deref(),
            Some(CORRUPT_STATE)
        );
        let reset = plan_disable(root, &snap, &sha256_hex(EMBEDDED), 3).unwrap();
        apply(root, &snap, &reset.changes).unwrap();
        let config = fs::read_to_string(root.join(LOADER_CONFIG)).unwrap();
        assert!(!config.contains("[cloud]"));
        assert!(
            status(root, &snapshot(root).unwrap(), &sha256_hex(EMBEDDED))
                .issue
                .is_none()
        );
    }

    #[test]
    fn failed_apply_rolls_back_written_files() {
        let steam = steam_with_loader();
        let root = steam.path();
        fs::write(root.join(LOADER_CONFIG), "[lua]\npaths = ['config/lua']\n").unwrap();
        let snap = snapshot(root).unwrap();
        // Каталог на месте файла состояния делает последнюю запись невозможной
        fs::create_dir_all(steam_file(root, STATE_FILE).join("blocked")).unwrap();
        let plan = plan_enable(root, &snap, "D:\\S", EMBEDDED, 1).unwrap();
        assert!(apply(root, &snap, &plan.changes).is_err());
        assert_eq!(
            fs::read_to_string(root.join(LOADER_CONFIG)).unwrap(),
            "[lua]\npaths = ['config/lua']\n"
        );
        assert!(!root.join(DLL_NAME).exists());
        assert!(!steam_file(root, PROVIDER_CONFIG).exists());
    }

    #[test]
    fn folder_rules_and_migration() {
        let steam = tempfile::tempdir().unwrap();
        let place = tempfile::tempdir().unwrap();
        assert!(normalize_folder("  ", steam.path())
            .unwrap_err()
            .contains("Сначала выберите"));
        assert!(normalize_folder("relative/saves", steam.path()).is_err());
        assert!(
            normalize_folder(&steam.path().join("saves").to_string_lossy(), steam.path())
                .unwrap_err()
                .contains("отдельно от папки Steam")
        );
        let old = place.path().join("old");
        let new = place.path().join("new");
        assert_eq!(
            normalize_folder(&format!("{}/", old.display()), steam.path()).unwrap(),
            old
        );
        ensure_writable(&old).unwrap();
        fs::create_dir_all(old.join("123/10/blobs")).unwrap();
        fs::write(old.join("123/10/blobs/save.dat"), b"slot").unwrap();
        fs::write(old.join("unrelated.txt"), b"user file").unwrap();
        assert!(migrate_folder(&old, &old.join("123"))
            .unwrap_err()
            .contains("вложены"));
        fs::create_dir_all(new.join("123/10/blobs")).unwrap();
        fs::write(new.join("123/10/blobs/save.dat"), b"other").unwrap();
        assert!(migrate_folder(&old, &new)
            .unwrap_err()
            .contains("другое сохранение"));
        fs::write(new.join("123/10/blobs/save.dat"), b"slot").unwrap();
        fs::create_dir_all(old.join("123/20")).unwrap();
        fs::write(old.join("123/20/data.bin"), b"second").unwrap();
        assert_eq!(migrate_folder(&old, &new).unwrap(), 1);
        assert_eq!(fs::read(new.join("123/20/data.bin")).unwrap(), b"second");
        assert!(old.join("123/20/data.bin").exists(), "оригиналы остаются");
        assert!(
            !new.join("unrelated.txt").exists(),
            "посторонние файлы не переносятся"
        );
        assert_eq!(
            migrate_folder(&place.path().join("missing"), &new).unwrap(),
            0
        );
    }

    #[test]
    fn component_update_replaces_only_the_managed_dll() {
        let steam = steam_with_loader();
        let root = steam.path();
        let snap = snapshot(root).unwrap();
        let plan = plan_enable(root, &snap, "D:\\Game Saves", EMBEDDED, 1).unwrap();
        apply(root, &snap, &plan.changes).unwrap();
        // Имитируем управляемую DLL предыдущей версии и её хеш в состоянии
        let old = b"MZ old managed cloud redirect";
        fs::write(root.join(DLL_NAME), old).unwrap();
        let mut state = parse_state(snapshot(root).unwrap().state.as_deref()).unwrap();
        state.dll_sha256 = Some(sha256_hex(old));
        fs::write(steam_file(root, STATE_FILE), state_bytes(&state)).unwrap();
        let config_before = fs::read(root.join(LOADER_CONFIG)).unwrap();
        let provider_before = fs::read(steam_file(root, PROVIDER_CONFIG)).unwrap();
        let snap = snapshot(root).unwrap();
        assert!(status(root, &snap, &sha256_hex(EMBEDDED)).component_outdated);
        let update = plan_component_update(root, &snap, EMBEDDED, 2).unwrap();
        assert!(update
            .changes
            .iter()
            .all(|(name, _)| *name == DLL_NAME || *name == STATE_FILE));
        backup(root, &snap, 2).unwrap();
        apply(root, &snap, &update.changes).unwrap();
        assert_eq!(fs::read(root.join(DLL_NAME)).unwrap(), EMBEDDED);
        assert_eq!(fs::read(root.join(LOADER_CONFIG)).unwrap(), config_before);
        assert_eq!(
            fs::read(steam_file(root, PROVIDER_CONFIG)).unwrap(),
            provider_before
        );
        let updated = status(root, &snapshot(root).unwrap(), &sha256_hex(EMBEDDED));
        assert!(
            updated.enabled && !updated.component_outdated,
            "{updated:?}"
        );
        // Резервная копия компонентного обновления содержит прежнюю DLL
        let latest = fs::read_dir(root.join(BACKUPS_DIR))
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .max()
            .unwrap();
        assert_eq!(fs::read(latest.join(DLL_NAME)).unwrap(), old);
        // Изменённую извне DLL не заменяем
        fs::write(root.join(DLL_NAME), b"MZ external").unwrap();
        let snap = snapshot(root).unwrap();
        assert!(!status(root, &snap, &sha256_hex(EMBEDDED)).component_outdated);
        assert!(plan_component_update(root, &snap, EMBEDDED, 3).is_err());
        // Удалённую управляемую DLL можно восстановить обновлением
        fs::remove_file(root.join(DLL_NAME)).unwrap();
        let snap = snapshot(root).unwrap();
        assert!(status(root, &snap, &sha256_hex(EMBEDDED)).component_outdated);
        let restore = plan_component_update(root, &snap, EMBEDDED, 4).unwrap();
        apply(root, &snap, &restore.changes).unwrap();
        assert_eq!(fs::read(root.join(DLL_NAME)).unwrap(), EMBEDDED);
        // Без настроенного режима обновлять нечего
        let empty = tempfile::tempdir().unwrap();
        assert!(
            plan_component_update(empty.path(), &snapshot(empty.path()).unwrap(), EMBEDDED, 1)
                .is_err()
        );
    }
}
