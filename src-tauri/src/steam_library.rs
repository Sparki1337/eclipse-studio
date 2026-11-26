//! Библиотеки Steam: разбор libraryfolders.vdf и манифестов appmanifest_*.acf.

use crate::luatools::resolve_steam_path;
use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledSteamGame {
    pub appid: u64,
    pub name: String,
    pub game_dir: String,
    pub library_path: String,
    pub header_image: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SteamLibraryScan {
    pub games: Vec<InstalledSteamGame>,
    pub libraries: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SteamLibraryCover {
    pub bytes: Vec<u8>,
    pub mime: String,
}

fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        text.strip_prefix("\\\\?\\").unwrap_or(&text).to_string()
    }
}

// Парсинг формата Valve KeyValues (VDF)
pub(crate) fn parse_vdf(content: &str) -> Result<Value, String> {
    let chars: Vec<char> = content.trim_start_matches('\u{feff}').chars().collect();
    let mut tokens = Vec::new();
    let mut pos = 0;
    while pos < chars.len() {
        let ch = chars[pos];
        if ch.is_whitespace() {
            pos += 1;
            continue;
        }
        if ch == '/' && chars.get(pos + 1) == Some(&'/') {
            while pos < chars.len() && chars[pos] != '\n' {
                pos += 1;
            }
            continue;
        }
        if ch == '{' || ch == '}' {
            tokens.push(ch.to_string());
            pos += 1;
            continue;
        }
        if ch == '"' {
            pos += 1;
            let mut value = String::new();
            let mut closed = false;
            while pos < chars.len() {
                let ch = chars[pos];
                pos += 1;
                if ch == '"' {
                    closed = true;
                    break;
                }
                if ch == '\\' && matches!(chars.get(pos), Some('\\' | '"')) {
                    value.push(chars[pos]);
                    pos += 1;
                } else {
                    value.push(ch);
                }
            }
            if !closed {
                return Err("Незавершённая строка Steam VDF".into());
            }
            tokens.push(value);
        } else {
            let start = pos;
            while pos < chars.len()
                && !chars[pos].is_whitespace()
                && chars[pos] != '{'
                && chars[pos] != '}'
            {
                pos += 1;
            }
            tokens.push(chars[start..pos].iter().collect());
        }
    }
    fn object(
        tokens: &[String],
        pos: &mut usize,
        nested: bool,
        depth: usize,
    ) -> Result<Value, String> {
        if depth > 64 {
            return Err("Слишком глубокий Steam VDF".into());
        }
        let mut map = Map::new();
        while let Some(key) = tokens.get(*pos) {
            if key == "}" {
                if !nested {
                    return Err("Лишняя скобка Steam VDF".into());
                }
                *pos += 1;
                return Ok(Value::Object(map));
            }
            if key == "{" {
                return Err("Не указано имя секции Steam VDF".into());
            }
            let key = key.to_lowercase();
            *pos += 1;
            let token = tokens.get(*pos).ok_or("Отсутствует значение Steam VDF")?;
            let value = if token == "{" {
                *pos += 1;
                object(tokens, pos, true, depth + 1)?
            } else {
                if token == "}" {
                    return Err("Отсутствует значение Steam VDF".into());
                }
                *pos += 1;
                Value::String(token.clone())
            };
            map.insert(key, value);
        }
        if nested {
            Err("Незавершённая секция Steam VDF".into())
        } else {
            Ok(Value::Object(map))
        }
    }
    object(&tokens, &mut 0, false, 0)
}

fn normalized_library(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy();
    let root = if name.eq_ignore_ascii_case("common")
        && path
            .parent()?
            .file_name()?
            .to_string_lossy()
            .eq_ignore_ascii_case("steamapps")
    {
        path.parent()?.parent()?.to_path_buf()
    } else if name.eq_ignore_ascii_case("steamapps") {
        path.parent()?.to_path_buf()
    } else {
        path.to_path_buf()
    };
    root.join("steamapps").is_dir().then_some(root)
}

fn library_roots(
    steam: Option<&Path>,
    extra: Option<&Path>,
    warnings: &mut Vec<String>,
) -> Vec<PathBuf> {
    let mut roots = BTreeMap::new();
    let mut add = |path: PathBuf| {
        if let Some(root) = normalized_library(&path) {
            let root = fs::canonicalize(&root).unwrap_or(root);
            roots.insert(root.to_string_lossy().to_lowercase(), root);
        }
    };
    if let Some(steam) = steam {
        add(steam.to_path_buf());
        for path in [
            steam.join("steamapps/libraryfolders.vdf"),
            steam.join("config/libraryfolders.vdf"),
        ] {
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            match parse_vdf(&content) {
                Ok(data) => {
                    if let Some(folders) = data.get("libraryfolders").and_then(Value::as_object) {
                        for (id, value) in folders {
                            if id.parse::<u32>().is_err() {
                                continue;
                            }
                            if let Some(path) = value
                                .as_str()
                                .or_else(|| value.get("path").and_then(Value::as_str))
                            {
                                add(PathBuf::from(path));
                            }
                        }
                    }
                }
                Err(error) => warnings.push(format!("{}: {error}", path.display())),
            }
        }
    }
    if let Some(extra) = extra {
        add(extra.to_path_buf());
    }
    roots.into_values().collect()
}

fn games_in_library(root: &Path, warnings: &mut Vec<String>) -> Vec<InstalledSteamGame> {
    let steamapps = root.join("steamapps");
    let common = steamapps.join("common");
    let Ok(entries) = fs::read_dir(&steamapps) else {
        warnings.push(format!(
            "Не удалось прочитать библиотеку: {}",
            root.display()
        ));
        return Vec::new();
    };
    let entries: Vec<_> = entries.flatten().collect();
    let results = crate::http_pool::parallel_map(&entries, 8, |entry| {
        let path = entry.path();
        let file = entry.file_name().to_string_lossy().to_lowercase();
        let Some(id) = file
            .strip_prefix("appmanifest_")
            .and_then(|s| s.strip_suffix(".acf"))
            .and_then(|s| s.parse::<u64>().ok())
        else {
            return (None, None);
        };
        if id == 0 || id == 228980 {
            return (None, None);
        }
        let data = match fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|s| parse_vdf(&s))
        {
            Ok(data) => data,
            Err(error) => return (None, Some(format!("{}: {error}", path.display()))),
        };
        let Some(app) = data.get("appstate") else {
            return (None, None);
        };
        if app
            .get("appid")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<u64>().ok())
            != Some(id)
        {
            return (None, None);
        }
        let flags = app
            .get("stateflags")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        if flags & 4 == 0 {
            return (None, None);
        } // бит 4 в stateflags — игра полностью установлена
        let Some(install) = app
            .get("installdir")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return (None, None);
        };
        let relative = Path::new(install);
        if relative.is_absolute()
            || relative
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
        {
            return (None, None);
        }
        let dir = common.join(relative);
        if !dir.is_dir() {
            return (None, None);
        }
        let name = app
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && !s.starts_with("appid_"))
            .unwrap_or(install)
            .to_string();
        (
            Some(InstalledSteamGame {
                appid: id,
                name,
                game_dir: display_path(&dir),
                library_path: display_path(root),
                header_image: format!(
                    "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{id}/header.jpg"
                ),
            }),
            None,
        )
    });
    let mut games = Vec::new();
    for (game, warn) in results {
        if let Some(w) = warn {
            warnings.push(w);
        }
        if let Some(g) = game {
            games.push(g);
        }
    }
    games
}

pub(crate) fn scan_libraries(
    steam: Option<&Path>,
    extra: Option<&Path>,
) -> Result<SteamLibraryScan, String> {
    let mut warnings = Vec::new();
    let roots = library_roots(steam, extra, &mut warnings);
    if roots.is_empty() {
        return Err(
            "Библиотеки Steam не найдены. Выберите папку SteamLibrary, steamapps или common."
                .into(),
        );
    }
    let cache = steam
        .and_then(|path| read_appinfo(path).ok())
        .unwrap_or_default();
    let per_root = crate::http_pool::parallel_map(&roots, 4, |root| {
        let mut local_warnings = Vec::new();
        let games = games_in_library(root, &mut local_warnings);
        (games, local_warnings)
    });
    let mut found = BTreeMap::new();
    for (root_games, root_warnings) in per_root {
        warnings.extend(root_warnings);
        for mut game in root_games {
            if let Some(summary) = cache.get(&game.appid) {
                if summary.is_non_game {
                    continue;
                }
                if let Some(name) = summary.name.as_deref().filter(|s| !s.is_empty()) {
                    game.name = name.into();
                }
            }
            found.entry(game.appid).or_insert(game);
        }
    }
    let mut games: Vec<_> = found.into_values().collect();
    games.sort_by_key(|game| game.name.to_lowercase());
    Ok(SteamLibraryScan {
        games,
        libraries: roots.iter().map(|p| display_path(p)).collect(),
        warnings,
    })
}

#[tauri::command]
pub(crate) async fn scan_installed_steam_games(
    steam_path: Option<String>,
    library_path: Option<String>,
) -> Result<SteamLibraryScan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let steam = resolve_steam_path(steam_path);
        let extra = library_path.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        if extra.as_ref().is_some_and(|p| normalized_library(p).is_none()) {
            return Err("В выбранной папке не найдена библиотека Steam. Выберите SteamLibrary, steamapps или common.".into());
        }
        scan_libraries(steam.as_deref(), extra.as_deref())
    }).await.map_err(|error| format!("Сканирование библиотек прервано: {error}"))?
}

#[tauri::command]
pub(crate) async fn steam_library_cover(
    appid: u64,
    steam_path: Option<String>,
) -> Result<Option<SteamLibraryCover>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if appid == 0 {
            return Err("Некорректный AppID".into());
        }
        let steam = resolve_steam_path(steam_path)
            .filter(|path| path.join("appcache/librarycache").is_dir())
            .or_else(|| resolve_steam_path(None));
        let Some(steam) = steam else {
            return Ok(None);
        };
        read_local_cover(&steam, appid)
    })
    .await
    .map_err(|error| format!("Чтение обложки прервано: {error}"))?
}

pub(crate) fn read_local_cover(
    steam: &Path,
    appid: u64,
) -> Result<Option<SteamLibraryCover>, String> {
    let root = steam.join("appcache/librarycache").join(appid.to_string());
    if !root.is_dir() {
        return Ok(None);
    }
    let preferred = [
        "library_header.jpg",
        "header.jpg",
        "library_capsule.jpg",
        "library_600x900.jpg",
    ];
    let files = walkdir::WalkDir::new(&root)
        .follow_links(false)
        .max_depth(3)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .collect::<Vec<_>>();
    for name in preferred {
        let Some(file) = files.iter().find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(name)
        }) else {
            continue;
        };
        let size = file.metadata().map_err(|error| error.to_string())?.len();
        if size == 0 || size > 3 * 1024 * 1024 {
            continue;
        }
        let bytes = fs::read(file.path()).map_err(|error| error.to_string())?;
        return Ok(Some(SteamLibraryCover {
            bytes,
            mime: "image/jpeg".into(),
        }));
    }
    Ok(None)
}

pub(crate) fn installed_game_for_path(dir: &Path) -> Option<InstalledSteamGame> {
    let dir = fs::canonicalize(dir).ok()?;
    for ancestor in dir.ancestors() {
        if !ancestor
            .file_name()
            .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("common"))
        {
            continue;
        }
        let root = ancestor.parent()?.parent()?;
        return games_in_library(root, &mut Vec::new())
            .into_iter()
            .find(|game| fs::canonicalize(&game.game_dir).ok().as_deref() == Some(dir.as_path()));
    }
    None
}

#[derive(Default)]
pub(crate) struct AppSummary {
    pub name: Option<String>,
    pub is_non_game: bool,
    pub list_of_dlc: Vec<u64>,
}

/// Компактный индекс appinfo.vdf: вместо полного дерева serde_json::Value хранит только имена, типы и связи DLC.
#[derive(Default)]
pub(crate) struct AppInfoIndex {
    pub apps: HashMap<u64, AppSummary>,
    pub dlc_children: HashMap<u64, Vec<u64>>,
}

impl AppInfoIndex {
    pub(crate) fn contains_key(&self, appid: &u64) -> bool {
        self.apps.contains_key(appid)
    }

    pub(crate) fn get(&self, appid: &u64) -> Option<&AppSummary> {
        self.apps.get(appid)
    }
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum AppSection {
    Root,
    AppInfo,
    Common,
    Extended,
    Ignored,
}

struct BinaryReader<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> BinaryReader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or("Некорректная длина appinfo")?;
        let result = self
            .bytes
            .get(self.pos..end)
            .ok_or("Обрезанный appinfo.vdf")?;
        self.pos = end;
        Ok(result)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn skip_cstr(&mut self) -> Result<(), String> {
        let len = self
            .bytes
            .get(self.pos..)
            .and_then(|b| b.iter().position(|b| *b == 0))
            .ok_or("Незавершённая строка appinfo")?;
        self.take(len + 1)?;
        Ok(())
    }
    fn skip_wstr(&mut self) -> Result<(), String> {
        loop {
            let ch = u16::from_le_bytes(self.take(2)?.try_into().unwrap());
            if ch == 0 {
                return Ok(());
            }
        }
    }
    fn text(&mut self) -> Result<String, String> {
        let len = self
            .bytes
            .get(self.pos..)
            .and_then(|b| b.iter().position(|b| *b == 0))
            .ok_or("Незавершённая строка appinfo")?;
        let text = String::from_utf8_lossy(self.take(len)?).into_owned();
        self.take(1)?;
        Ok(text)
    }
    fn text_str(&mut self) -> Result<&'a str, String> {
        let len = self
            .bytes
            .get(self.pos..)
            .and_then(|b| b.iter().position(|b| *b == 0))
            .ok_or("Незавершённая строка appinfo")?;
        let slice = self.take(len)?;
        self.take(1)?;
        std::str::from_utf8(slice).map_err(|_| String::new())
    }
    fn parse_summary_section(
        &mut self,
        keys: Option<&[String]>,
        section: AppSection,
        depth: usize,
        summary: &mut AppSummary,
        dlc_for_appid: &mut Option<u64>,
    ) -> Result<(), String> {
        if depth > 64 {
            return Err("Слишком глубокий appinfo".into());
        }
        loop {
            let kind = self.take(1)?[0];
            if kind == 8 || kind == 11 {
                return Ok(());
            }
            let key_buf: String;
            let key: &str = if let Some(keys) = keys {
                keys.get(self.u32()? as usize)
                    .ok_or("Некорректный индекс appinfo")?
                    .as_str()
            } else if section == AppSection::Ignored {
                self.skip_cstr()?;
                ""
            } else {
                key_buf = self.text()?;
                &key_buf
            };

            if kind == 0 {
                let next_section = match section {
                    AppSection::Root if key.eq_ignore_ascii_case("appinfo") => AppSection::AppInfo,
                    AppSection::AppInfo if key.eq_ignore_ascii_case("common") => AppSection::Common,
                    AppSection::AppInfo if key.eq_ignore_ascii_case("extended") => {
                        AppSection::Extended
                    }
                    _ => AppSection::Ignored,
                };
                self.parse_summary_section(keys, next_section, depth + 1, summary, dlc_for_appid)?;
                continue;
            }

            let wanted = match section {
                AppSection::Common => {
                    key.eq_ignore_ascii_case("name") || key.eq_ignore_ascii_case("type")
                }
                AppSection::Extended => {
                    key.eq_ignore_ascii_case("listofdlc") || key.eq_ignore_ascii_case("dlcforappid")
                }
                _ => false,
            };

            if !wanted {
                match kind {
                    1 => self.skip_cstr()?,
                    2..=4 | 6 => {
                        self.take(4)?;
                    }
                    5 => self.skip_wstr()?,
                    7 | 10 => {
                        self.take(8)?;
                    }
                    _ => return Err(format!("Неизвестный тип appinfo: {kind}")),
                }
                continue;
            }

            let str_val = match kind {
                1 => Some(self.text_str().unwrap_or_default().to_string()),
                2 => Some(i32::from_le_bytes(self.take(4)?.try_into().unwrap()).to_string()),
                3 => {
                    self.take(4)?;
                    None
                }
                4 | 6 => Some(self.u32()?.to_string()),
                5 => {
                    self.skip_wstr()?;
                    None
                }
                7 => Some(u64::from_le_bytes(self.take(8)?.try_into().unwrap()).to_string()),
                10 => Some(i64::from_le_bytes(self.take(8)?.try_into().unwrap()).to_string()),
                _ => return Err(format!("Неизвестный тип appinfo: {kind}")),
            };

            if let Some(val) = str_val {
                match section {
                    AppSection::Common if key.eq_ignore_ascii_case("name") => {
                        if !val.is_empty() {
                            summary.name = Some(val);
                        }
                    }
                    AppSection::Common if key.eq_ignore_ascii_case("type") => {
                        summary.is_non_game = matches!(
                            val.to_ascii_lowercase().as_str(),
                            "dlc" | "tool" | "music" | "application" | "video"
                        );
                    }
                    AppSection::Extended if key.eq_ignore_ascii_case("listofdlc") => {
                        summary.list_of_dlc = val
                            .split(',')
                            .filter_map(|s| s.trim().parse::<u64>().ok())
                            .filter(|id| *id > 0)
                            .collect();
                    }
                    AppSection::Extended if key.eq_ignore_ascii_case("dlcforappid") => {
                        *dlc_for_appid = val.trim().parse::<u64>().ok().filter(|id| *id > 0);
                    }
                    _ => {}
                }
            }
        }
    }
}

fn read_u32_le<R: Read>(r: &mut R) -> Result<u32, String> {
    let mut buf = [0_u8; 4];
    r.read_exact(&mut buf)
        .map_err(|_| "Обрезанный appinfo.vdf".to_string())?;
    Ok(u32::from_le_bytes(buf))
}

fn read_u64_le<R: Read>(r: &mut R) -> Result<u64, String> {
    let mut buf = [0_u8; 8];
    r.read_exact(&mut buf)
        .map_err(|_| "Обрезанный appinfo.vdf".to_string())?;
    Ok(u64::from_le_bytes(buf))
}

fn read_cstr_from_reader<R: Read>(r: &mut R) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(32);
    let mut byte = [0_u8; 1];
    loop {
        r.read_exact(&mut byte)
            .map_err(|_| "Незавершённая строка appinfo".to_string())?;
        if byte[0] == 0 {
            break;
        }
        if bytes.len() > 4096 {
            return Err("Слишком длинный ключ appinfo".into());
        }
        bytes.push(byte[0]);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Потоковый разбор appinfo.vdf без загрузки всего 100-250 МБ файла в оперативную память.
fn parse_appinfo_file(path: &Path) -> Result<AppInfoIndex, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let version = read_u32_le(&mut reader)?;
    if ![0x07564427, 0x07564428, 0x07564429].contains(&version) {
        return Err("Неизвестная версия appinfo.vdf".into());
    }
    let _universe = read_u32_le(&mut reader)?;
    let keys = if version == 0x07564429 {
        let table_offset = read_u64_le(&mut reader)?;
        let entries_start = reader.stream_position().map_err(|e| e.to_string())?;
        reader
            .seek(SeekFrom::Start(table_offset))
            .map_err(|_| "Некорректный offset appinfo".to_string())?;
        let count = read_u32_le(&mut reader)? as usize;
        if count > 1_000_000 {
            return Err("Слишком большая таблица appinfo".into());
        }
        let mut keys = Vec::with_capacity(count);
        for _ in 0..count {
            keys.push(read_cstr_from_reader(&mut reader)?.to_ascii_lowercase());
        }
        reader
            .seek(SeekFrom::Start(entries_start))
            .map_err(|e| e.to_string())?;
        Some(keys)
    } else {
        None
    };

    let fixed = if version >= 0x07564428 { 60 } else { 40 };
    let mut index = AppInfoIndex::default();
    let mut record_buf = Vec::with_capacity(32 * 1024);

    loop {
        let appid = read_u32_le(&mut reader)? as u64;
        if appid == 0 {
            break;
        }
        let size = read_u32_le(&mut reader)? as usize;
        if size < fixed || size > 16 * 1024 * 1024 {
            return Err("Некорректная запись appinfo".into());
        }
        record_buf.resize(size, 0);
        reader
            .read_exact(&mut record_buf)
            .map_err(|_| "Обрезанный appinfo.vdf".to_string())?;

        let mut data = BinaryReader {
            bytes: &record_buf[fixed..],
            pos: 0,
        };
        let mut summary = AppSummary::default();
        let mut dlc_for_appid = None;
        if data
            .parse_summary_section(
                keys.as_deref(),
                AppSection::Root,
                0,
                &mut summary,
                &mut dlc_for_appid,
            )
            .is_ok()
        {
            if let Some(parent) = dlc_for_appid.filter(|p| *p != appid) {
                index.dlc_children.entry(parent).or_default().push(appid);
            }
            if summary.name.is_some() || summary.is_non_game || !summary.list_of_dlc.is_empty() {
                index.apps.insert(appid, summary);
            }
        }
    }
    Ok(index)
}

// Компактный кэш appinfo с TTL: экономит ОЗУ после закрытия вкладки DLC/библиотеки
pub(crate) fn read_appinfo(steam: &Path) -> Result<Arc<AppInfoIndex>, String> {
    let path = steam.join("appcache/appinfo.vdf");
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > 256 * 1024 * 1024 {
        return Err("appinfo.vdf слишком большой".into());
    }
    let stamp = (metadata.len(), metadata.modified().ok());

    type AppInfoCache = Option<(
        PathBuf,
        (u64, Option<SystemTime>),
        Instant,
        Arc<AppInfoIndex>,
    )>;
    static CACHE: OnceLock<Mutex<AppInfoCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));

    if let Ok(guard) = cache.lock() {
        if let Some((cached_path, cached_stamp, cached_at, parsed)) = guard.as_ref() {
            if cached_path == &path
                && cached_stamp == &stamp
                && cached_at.elapsed() < Duration::from_secs(180)
            {
                return Ok(Arc::clone(parsed));
            }
        }
    }

    let parsed = Arc::new(parse_appinfo_file(&path)?);
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((path, stamp, Instant::now(), Arc::clone(&parsed)));
    }
    Ok(parsed)
}

pub(crate) fn cached_dlc_names(index: &AppInfoIndex, appid: u64) -> BTreeMap<String, String> {
    let mut dlcs = BTreeMap::new();
    if let Some(summary) = index.get(&appid) {
        for &id in &summary.list_of_dlc {
            if id == 0 || id == appid {
                continue;
            }
            let name = index
                .get(&id)
                .and_then(|s| s.name.clone())
                .unwrap_or_else(|| format!("DLC {id}"));
            dlcs.insert(id.to_string(), name);
        }
    }
    if let Some(children) = index.dlc_children.get(&appid) {
        for &id in children {
            if id == 0 || id == appid {
                continue;
            }
            let name = index
                .get(&id)
                .and_then(|s| s.name.clone())
                .unwrap_or_else(|| format!("DLC {id}"));
            dlcs.insert(id.to_string(), name);
        }
    }
    dlcs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_library_paths_and_escaped_backslashes() {
        let value = parse_vdf(r#""libraryfolders" { "0" { "path" "C:\\Steam" "apps" { "480" "1" } } "1" "E:\\SteamLibrary" }"#).unwrap();
        assert_eq!(
            value
                .pointer("/libraryfolders/0/path")
                .and_then(Value::as_str),
            Some("C:\\Steam")
        );
        assert_eq!(
            value.pointer("/libraryfolders/1").and_then(Value::as_str),
            Some("E:\\SteamLibrary")
        );
        assert!(parse_vdf("\"broken\" {").is_err());
    }

    #[test]
    fn scans_only_present_installed_games_not_downloads_or_escaped_paths() {
        let dir = std::env::temp_dir().join(format!(
            "cgs-library-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let apps = dir.join("steamapps");
        fs::create_dir_all(apps.join("common/Installed")).unwrap();
        fs::create_dir_all(apps.join("common/Downloading")).unwrap();
        for (id, folder, state) in [
            (10, "Installed", 4),
            (11, "Downloading", 1026),
            (12, "Gone", 4),
            (13, "../escape", 4),
        ] {
            fs::write(apps.join(format!("appmanifest_{id}.acf")), format!(r#""AppState" {{ "appid" "{id}" "name" "Test {id}" "StateFlags" "{state}" "installdir" "{folder}" }}"#)).unwrap();
        }
        let result = scan_libraries(None, Some(&apps.join("common"))).unwrap();
        assert_eq!(result.games.len(), 1);
        assert_eq!(result.games[0].appid, 10);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn local_dlc_sources_merge_and_do_not_include_depot_ids() {
        let mut index = AppInfoIndex::default();
        index.apps.insert(
            10,
            AppSummary {
                name: Some("Base Game".into()),
                is_non_game: false,
                list_of_dlc: vec![11, 12, 11],
            },
        );
        index.apps.insert(
            11,
            AppSummary {
                name: Some("Pack One".into()),
                is_non_game: true,
                list_of_dlc: vec![],
            },
        );
        index.apps.insert(
            13,
            AppSummary {
                name: Some("Hidden Pack".into()),
                is_non_game: true,
                list_of_dlc: vec![],
            },
        );
        index.dlc_children.insert(10, vec![11, 13]);
        let dlcs = cached_dlc_names(&index, 10);
        assert_eq!(dlcs.len(), 3);
        assert_eq!(dlcs.get("13").map(String::as_str), Some("Hidden Pack"));
        assert!(!dlcs.contains_key("999"));
    }

    #[test]
    fn reads_real_local_steam_library_when_requested() {
        let Ok(root) = std::env::var("CGS_TEST_STEAM_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let apps = read_appinfo(&root).unwrap();
        assert!(!apps.apps.is_empty());
        let result = scan_libraries(Some(&root), None).unwrap();
        assert!(!result.games.is_empty());
        assert!(result.games.iter().all(|g| Path::new(&g.game_dir).is_dir()));
        assert!(result.games.iter().any(|game| {
            read_local_cover(&root, game.appid)
                .ok()
                .flatten()
                .is_some_and(|cover| !cover.bytes.is_empty())
        }));
    }
}
