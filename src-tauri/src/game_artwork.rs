// Модуль поиска обложек и идентификации игр по исполняемым файлам
// Поддерживает стандартные библиотеки Steam, вложенные пути Unreal Engine, Unity и сторонние репаки

use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

// Структура данных обложки игры для интерфейса
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GameArtwork {
    pub appid: u64,
    pub name: Option<String>,
    pub local: Option<crate::steam_library::SteamLibraryCover>,
    pub urls: Vec<String>,
}

// Чтение числового AppID из текстового файла (steam_appid.txt)
fn read_id(path: &Path) -> Option<u64> {
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(256)
        .read_to_string(&mut text)
        .ok()?;
    let id = text
        .trim()
        .trim_start_matches('\u{feff}')
        .split(|c: char| !c.is_ascii_digit())
        .find_map(|s| s.parse::<u64>().ok())?;
    // Spacewar (480) и Steamworks SDK (228980) отсекаются как фиктивные идентификаторы
    (id > 0 && id <= u32::MAX as u64 && id != 480 && id != 228980).then_some(id)
}

// Извлечение AppID из installscript.vdf или runasadmin.vdf
fn read_vdf_id(path: &Path) -> Option<u64> {
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(16384)
        .read_to_string(&mut text)
        .ok()?;

    for line in text.lines() {
        let lower = line.to_lowercase();
        // Поиск шаблонов Apps\12345, Apps\\12345 или Apps/12345
        if let Some(idx) = lower.find("apps") {
            let after = &line[idx + 4..];
            let trimmed = after.trim_start_matches(|c: char| c == '\\' || c == '/');
            let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(id) = digits.parse::<u64>() {
                if id > 0 && id <= u32::MAX as u64 && id != 480 && id != 228980 {
                    return Some(id);
                }
            }
        }
    }
    None
}

// Извлечение AppID из файлов конфигурации эмуляторов (OnlineFix.ini, steam_emu.ini, cream_api.ini)
fn read_ini_id(path: &Path) -> Option<u64> {
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(4096)
        .read_to_string(&mut text)
        .ok()?;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(';') || trimmed.starts_with('#') {
            continue;
        }
        let lower = trimmed.to_lowercase();
        for key in ["realappid", "appid", "steamappid"] {
            if lower.starts_with(key) {
                if let Some((_, val)) = trimmed.split_once('=') {
                    let cleaned: String = val.chars().filter(|c| c.is_ascii_digit()).collect();
                    if let Ok(id) = cleaned.parse::<u64>() {
                        if id > 0 && id <= u32::MAX as u64 && id != 480 && id != 228980 {
                            return Some(id);
                        }
                    }
                }
            }
        }
    }
    None
}

// Проверка, является ли каталог системным или временным каталогом ОС
fn is_system_or_temp_dir(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    matches!(
        lower.as_str(),
        "users"
            | "user"
            | "windows"
            | "appdata"
            | "local"
            | "locallow"
            | "roaming"
            | "temp"
            | "tmp"
            | "target"
            | "system32"
            | "syswow64"
            | "program files"
            | "program files (x86)"
            | "programdata"
    )
}

// Определение корневой папки игры даже при глубоких вложенных путях
fn game_root(exe: &Path) -> Option<PathBuf> {
    let parent = exe.parent()?;

    // 1. Проверяем стандартную структуру Steam: steamapps/common/<Game>
    for dir in parent.ancestors() {
        if let (Some(p1), Some(p2)) = (dir.parent(), dir.parent().and_then(|p| p.parent())) {
            if p1.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("common"))
                && p2.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("steamapps"))
            {
                return Some(dir.to_path_buf());
            }
        }
    }

    // 2. Проверяем вложенные каталоги движков (Unreal Engine: Project/Binaries/Win64, Unity, bin/x64)
    let mut current = parent.to_path_buf();
    let mut depth = 0;
    while let Some(p) = current.parent().map(|p| p.to_path_buf()) {
        depth += 1;
        if depth > 4 {
            break;
        }

        let name = current.file_name().unwrap_or_default().to_string_lossy();
        let lower = name.to_lowercase();

        // Пропускаем папки архитектур и бинарников
        if matches!(lower.as_str(), "win64" | "win32" | "x64" | "x86" | "binaries" | "bin" | "shipping") {
            current = p;
            continue;
        }

        // Системные папки Windows не могут быть игрой
        if is_system_or_temp_dir(&lower) {
            break;
        }

        // Проверяем, является ли родитель общей папкой каталога игр или корнем диска
        let p_name = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        let is_lib_parent = matches!(
            p_name.as_str(),
            "games" | "steamlibrary" | "steam" | "steamapps" | "common" | "torrent games" | "repacks" | "игры"
        ) || (p.parent().is_none() && !is_system_or_temp_dir(&p_name));

        // Проверяем маркеры корня проекта игры
        let has_engine = current.join("Engine").is_dir();
        let has_installscript = current.join("installscript.vdf").is_file() || current.join("runasadmin.vdf").is_file();
        let has_backup_orig = current.join(".backup_orig").is_dir();
        let has_appid_txt = current.join("steam_appid.txt").is_file();

        if has_engine || has_installscript || has_backup_orig || has_appid_txt {
            return Some(current);
        }

        if is_lib_parent && !matches!(lower.as_str(), "engine" | "epic" | "epiconlineservices" | "directx" | "_redist" | "redist") {
            return Some(current);
        }

        current = p;
    }

    None
}

// Проверка, является ли строка шаблонным общим словом (Game, Launcher, temp, test и т.д.), которое нельзя угадывать через Steam
fn is_generic_title(title: &str) -> bool {
    let lower = title.trim().to_lowercase();
    if lower.len() < 4 || lower.contains("test") || lower.contains("temp") {
        return true;
    }
    matches!(
        lower.as_str(),
        "game" | "games" | "launcher" | "samplegame" | "main" | "app" | "play" | "start" | "client" | "unityplayer" | "shipping" | "unknown" | "users" | "user" | "windows" | "target" | "debug" | "release"
    )
}

// Очистка названия игры от технических тегов репаков и версий для поиска в Steam
fn clean_game_title(raw: &str) -> String {
    let mut cleaned = String::new();
    let mut in_bracket = false;
    let mut in_paren = false;

    for ch in raw.chars() {
        match ch {
            '[' => in_bracket = true,
            ']' => in_bracket = false,
            '(' => in_paren = true,
            ')' => in_paren = false,
            _ if !in_bracket && !in_paren => cleaned.push(ch),
            _ => {}
        }
    }

    // Удаляем технические суффиксы движков
    let mut result = cleaned
        .replace("-Win64-Shipping", "")
        .replace("-Win32-Shipping", "")
        .replace("-Shipping", "")
        .replace("_Shipping", "")
        .replace(".exe", "")
        .trim()
        .to_string();

    // Удаляем распространенные суффиксы версий вроде "v1.0"
    if let Some(pos) = result.to_lowercase().find(" v1.") {
        result.truncate(pos);
    } else if let Some(pos) = result.to_lowercase().find(" v2.") {
        result.truncate(pos);
    }

    result.trim().to_string()
}

// Идентификация AppID игры
#[allow(dead_code)]
pub(crate) fn identify(exe: &Path) -> Option<u64> {
    identify_with_name(exe).map(|(id, _)| id)
}

// Идентификация AppID и названия игры с поиском по дереву каталогов и Steam API
fn identify_with_name(exe: &Path) -> Option<(u64, Option<String>)> {
    if !exe.is_file() || !exe.extension()?.eq_ignore_ascii_case("exe") {
        return None;
    }
    let exe = exe.canonicalize().ok().unwrap_or_else(|| exe.to_path_buf());
    let root = game_root(&exe);
    let parent = exe.parent()?;

    // 1. Проверяем локальную библиотеку Steam
    if let Some(game) = root
        .as_deref()
        .and_then(crate::steam_library::installed_game_for_path)
    {
        return Some((game.appid, Some(game.name)));
    }
    if let Some(game) = crate::steam_library::installed_game_for_path(parent) {
        return Some((game.appid, Some(game.name)));
    }

    // 2. Проверяем файл steam_appid.txt прямо рядом с исполняемым файлом
    for name in ["steam_appid.txt", "steam_settings/steam_appid.txt"] {
        if let Some(id) = read_id(&parent.join(name)) {
            let name = crate::steam::app_overview(id).map(|o| o.name);
            return Some((id, name));
        }
    }

    // 3. Проверяем файл steam_appid.txt в корне игры, если он найден
    if let Some(ref r) = root {
        for name in ["steam_appid.txt", "steam_settings/steam_appid.txt"] {
            if let Some(id) = read_id(&r.join(name)) {
                let name = crate::steam::app_overview(id).map(|o| o.name);
                return Some((id, name));
            }
        }
    }

    // 4. Проверяем прямые цепочки предков до корня
    for dir in parent.ancestors().take(6) {
        if dir.parent().is_none()
            || dir
                .file_name()
                .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("common"))
        {
            break;
        }
        for name in ["steam_appid.txt", "steam_settings/steam_appid.txt"] {
            if let Some(id) = read_id(&dir.join(name)) {
                let name = crate::steam::app_overview(id).map(|o| o.name);
                return Some((id, name));
            }
        }
        if root.as_deref() == Some(dir) {
            break;
        }
    }

    // 5. Глубокий рекурсивный поиск в корне игры (или папке исполняемого файла)
    let search = root.as_deref().unwrap_or(parent);
    let mut ids = BTreeSet::new();

    for entry in walkdir::WalkDir::new(search)
        .follow_links(false)
        .max_depth(10)
        .into_iter()
        .filter_entry(|e| {
            ![".cgs-backups", ".backup_orig", ".git"]
                .iter()
                .any(|s| e.file_name().to_string_lossy().eq_ignore_ascii_case(s))
        })
        .take(5000)
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let fname = entry.file_name().to_string_lossy();
        if fname.eq_ignore_ascii_case("steam_appid.txt") {
            if let Some(id) = read_id(entry.path()) {
                ids.insert(id);
            }
        } else if fname.eq_ignore_ascii_case("installscript.vdf") || fname.eq_ignore_ascii_case("runasadmin.vdf") {
            if let Some(id) = read_vdf_id(entry.path()) {
                ids.insert(id);
            }
        } else if fname.eq_ignore_ascii_case("onlinefix.ini")
            || fname.eq_ignore_ascii_case("onlinefix64.ini")
            || fname.eq_ignore_ascii_case("steam_emu.ini")
            || fname.eq_ignore_ascii_case("cream_api.ini")
        {
            if let Some(id) = read_ini_id(entry.path()) {
                ids.insert(id);
            }
        }
    }

    if ids.len() == 1 {
        let id = ids.into_iter().next().unwrap();
        let name = crate::steam::app_overview(id).map(|o| o.name);
        return Some((id, name));
    } else if ids.len() > 1 {
        // При наличии нескольких конфликтующих AppID возвращаем None во избежание ложного определения
        return None;
    }

    // 6. Поиск через Steam Store API по названию корневой папки или исполняемого файла
    if let Some(ref r) = root {
        if let Some(folder_name) = r.file_name().and_then(|n| n.to_str()) {
            let clean = clean_game_title(folder_name);
            if !is_generic_title(&clean) {
                if let Ok(Some(summary)) = crate::steam::search_game_inner(&clean) {
                    let sum_name = summary.name.to_lowercase();
                    let query_lower = clean.to_lowercase();
                    if sum_name.contains(&query_lower) || query_lower.contains(&sum_name) || {
                        let words: Vec<&str> = query_lower.split_whitespace().collect();
                        !words.is_empty() && words.iter().all(|w| w.len() < 3 || sum_name.contains(w))
                    } {
                        return Some((summary.appid, Some(summary.name)));
                    }
                }
            }
        }
    }

    let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let clean_stem = clean_game_title(stem);
    if !is_generic_title(&clean_stem) {
        if let Ok(Some(summary)) = crate::steam::search_game_inner(&clean_stem) {
            let sum_name = summary.name.to_lowercase();
            let query_lower = clean_stem.to_lowercase();
            if sum_name.contains(&query_lower) || query_lower.contains(&sum_name) || {
                let words: Vec<&str> = query_lower.split_whitespace().collect();
                !words.is_empty() && words.iter().all(|w| w.len() < 3 || sum_name.contains(w))
            } {
                return Some((summary.appid, Some(summary.name)));
            }
        }
    }

    None
}

// Запрос обложки игры по пути к исполняемому файлу
#[tauri::command]
pub(crate) async fn game_artwork(exe_path: String) -> Result<Option<GameArtwork>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some((appid, game_name)) = identify_with_name(Path::new(&exe_path)) else { return Ok(None); };
        let local = crate::luatools::resolve_steam_path(None)
            .and_then(|steam| crate::steam_library::read_local_cover(&steam, appid).ok().flatten());

        let mut urls = Vec::new();
        // 1. Точный URL обложки из Steam Store (включая актуальные хешированные пути CDN)
        if let Some(store_url) = crate::steam::app_overview(appid).and_then(|app| app.header_image) {
            urls.push(store_url);
        }
        // 2. Стандартные резервные пути Steam CDN
        urls.push(format!("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg"));
        urls.push(format!("https://cdn.akamai.steamstatic.com/steam/apps/{appid}/header.jpg"));
        urls.push(format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/header.jpg"));

        Ok(Some(GameArtwork {
            appid,
            name: game_name,
            local,
            urls,
        }))
    }).await.map_err(|e| e.to_string())?
}

// Запрос обложки игры по AppID из магазина Steam
#[tauri::command]
pub(crate) async fn game_artwork_store_url(appid: u64) -> Result<Option<String>, String> {
    if appid == 0 || appid > u32::MAX as u64 {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::steam::app_overview(appid).and_then(|app| app.header_image)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "test_artwork_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let _ = fs::create_dir_all(&path);
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn manifest_identifies_nested_exe_before_a_spoofed_appid() {
        let temp = TempDir::new();
        let apps = temp.path().join("steamapps");
        let root = apps.join("common/Far Changing Tides");
        let exe = root.join("Binaries/Win64/Game.exe");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"test").unwrap();
        fs::write(exe.parent().unwrap().join("steam_appid.txt"), "480").unwrap();
        fs::write(apps.join("appmanifest_876650.acf"), "\"AppState\" { \"appid\" \"876650\" \"name\" \"FAR: Changing Tides\" \"installdir\" \"Far Changing Tides\" \"StateFlags\" \"4\" }").unwrap();
        assert_eq!(identify(&exe), Some(876650));
    }

    #[test]
    fn standalone_appid_works_but_unknown_and_ambiguous_games_have_no_guessed_cover() {
        let temp = TempDir::new();
        let exe = temp.path().join("Game.exe");
        fs::write(&exe, b"test").unwrap();
        assert_eq!(identify(&exe), None);
        let settings = temp.path().join("Game_Data/Plugins/x86_64/steam_settings");
        fs::create_dir_all(&settings).unwrap();
        fs::write(settings.join("steam_appid.txt"), "\u{feff}876650\r\n").unwrap();
        assert_eq!(identify(&exe), Some(876650));
        fs::create_dir(temp.path().join("Other")).unwrap();
        fs::write(temp.path().join("Other/steam_appid.txt"), "49520").unwrap();
        assert_eq!(identify(&exe), None);
        fs::write(temp.path().join("steam_appid.txt"), "49520").unwrap();
        assert_eq!(identify(&exe), Some(49520));
    }

    #[test]
    fn backup_metadata_and_spacewar_are_not_mistaken_for_the_game() {
        let temp = TempDir::new();
        let exe = temp.path().join("Game.exe");
        fs::write(&exe, b"test").unwrap();
        fs::create_dir_all(temp.path().join(".cgs-backups/old")).unwrap();
        fs::write(
            temp.path().join(".cgs-backups/old/steam_appid.txt"),
            "49520",
        )
        .unwrap();
        fs::write(temp.path().join("steam_appid.txt"), "480").unwrap();
        assert_eq!(identify(&exe), None);
    }

    #[test]
    fn identifies_unreal_engine_deep_layout_with_engine_steam_settings() {
        let temp = TempDir::new();
        let root = temp.path().join("Games/My Awesome Game");
        let exe = root.join("Griffin/Binaries/Win64/SWGR-Win64-Shipping.exe");
        let engine_settings = root.join("Engine/Binaries/ThirdParty/Steamworks/Steamv162/Win64/steam_settings");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::create_dir_all(&engine_settings).unwrap();
        fs::write(&exe, b"MZ_TEST_EXE").unwrap();
        fs::write(engine_settings.join("steam_appid.txt"), "4078430").unwrap();
        assert_eq!(identify(&exe), Some(4078430));
    }

    #[test]
    fn identifies_via_installscript_vdf() {
        let temp = TempDir::new();
        let root = temp.path().join("Games/Sample Game");
        let exe = root.join("Binaries/Win64/SampleGame.exe");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"MZ_TEST_EXE").unwrap();
        fs::write(
            root.join("installscript.vdf"),
            r#""InstallScript" { "Registry" { "HKEY_LOCAL_MACHINE\\Software\\Valve\\Steam\\Apps\\1091500" { } } }"#,
        )
        .unwrap();
        assert_eq!(identify(&exe), Some(1091500));
    }
}
