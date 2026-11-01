use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{Emitter, Manager};

const GIST_ID: &str = "b314de5f9a3e2293b7e3c22136d49889";
const GIST_OWNER: &str = "LeoBanned";
static DOWNLOAD_CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<crate::download::Control>>>> =
    OnceLock::new();

#[derive(Deserialize)]
struct RemoteCatalog {
    #[serde(default)]
    cracks: Vec<RemoteFile>,
}

#[derive(Deserialize)]
struct RemoteFile {
    #[serde(default)]
    name: String,
    #[serde(default)]
    build: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Clone, Serialize)]
pub(crate) struct FileItem {
    name: String,
    build: String,
    url: String,
    password: String,
    pinned: bool,
    sha256: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct FilesCatalog {
    files: Vec<FileItem>,
    total: usize,
    cached: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    url: String,
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
    resumable: bool,
}

type DownloadResult = crate::download::Downloaded;

#[tauri::command]
pub(crate) async fn files_catalog(app: tauri::AppHandle) -> Result<FilesCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || load_catalog(&app))
        .await
        .map_err(|error| format!("Загрузка списка файлов прервана: {error}"))?
}

#[tauri::command]
pub(crate) async fn files_download(
    app: tauri::AppHandle,
    url: String,
    suggested_name: String,
    target_dir: Option<String>,
    expected_sha256: Option<String>,
) -> Result<DownloadResult, String> {
    let cancellation = Arc::new(crate::download::Control::default());
    {
        let mut registry = cancellation_registry()
            .lock()
            .map_err(|_| "Не удалось запустить загрузку")?;
        if registry.contains_key(&url) {
            return Err("Эта загрузка уже выполняется".into());
        }
        registry.insert(url.clone(), Arc::clone(&cancellation));
    }

    let registry_url = url.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        download_file(
            &app,
            &url,
            &suggested_name,
            target_dir.as_deref(),
            &cancellation,
            expected_sha256.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("Загрузка файла прервана: {error}"));
    if let Ok(mut registry) = cancellation_registry().lock() {
        registry.remove(&registry_url);
    }
    result?
}

#[tauri::command]
pub(crate) fn files_cancel_download(url: String) -> Result<bool, String> {
    let registry = cancellation_registry()
        .lock()
        .map_err(|_| "Не удалось отменить загрузку".to_string())?;
    if let Some(cancellation) = registry.get(&url) {
        cancellation.cancelled.store(true, Ordering::Relaxed);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) fn files_reveal(path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());

    #[cfg(target_os = "windows")]
    {
        if target.is_file() {
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", target.to_string_lossy()))
                .spawn()
                .map(|_| ())
                .map_err(|error| format!("Не удалось открыть в проводнике: {error}"))
        } else if target.is_dir() {
            std::process::Command::new("explorer.exe")
                .arg(&target)
                .spawn()
                .map(|_| ())
                .map_err(|error| format!("Не удалось открыть в проводнике: {error}"))
        } else {
            if let Some(folder) = target.parent().filter(|p| p.is_dir()) {
                return std::process::Command::new("explorer.exe")
                    .arg(folder)
                    .spawn()
                    .map(|_| ())
                    .map_err(|error| format!("Не удалось открыть в проводнике: {error}"));
            }
            Err("Загруженный файл больше не найден".into())
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Err("Открытие папки поддерживается только в Windows".into())
    }
}

// Определение папки загрузки (пользовательская или системная)
fn resolve_download_dir(
    app: &tauri::AppHandle,
    target_dir: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(custom) = target_dir.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(custom);
        if !path.is_absolute() {
            return Err(
                "Папка для загрузки указана неверно. Выберите её заново в настройках".into(),
            );
        }
        return Ok(path);
    }
    app.path()
        .download_dir()
        .map_err(|error| format!("Не удалось определить папку «Загрузки»: {error}"))
}

#[tauri::command]
pub(crate) fn files_default_download_dir(app: tauri::AppHandle) -> Result<String, String> {
    resolve_download_dir(&app, None).map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) async fn files_pick_download_dir(
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    #[cfg(not(windows))]
    let owner = {
        let _ = window;
        0
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::native_dialog::pick_folder("Выберите папку для загрузки", owner)
    })
    .await
    .map_err(|error| format!("Диалог выбора прерван: {error}"))?
}

#[tauri::command]
pub(crate) fn files_open_download_dir(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<(), String> {
    let folder = resolve_download_dir(&app, path.as_deref())?;
    fs::create_dir_all(&folder)
        .map_err(|error| format!("Не удалось подготовить папку для загрузки: {error}"))?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(&folder)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Не удалось открыть папку: {error}"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = folder;
        Err("Открытие папки поддерживается только в Windows".into())
    }
}

fn download_file(
    app: &tauri::AppHandle,
    url: &str,
    suggested_name: &str,
    target_dir: Option<&str>,
    cancellation: &Arc<crate::download::Control>,
    expected_hash: Option<&str>,
) -> Result<DownloadResult, String> {
    let directory = resolve_download_dir(app, target_dir)?;
    let name = safe_file_name(suggested_name);
    let resource = directory.join(crate::download::work_name(url, &name));
    crate::jobs::run(&[resource], "Загрузка файла", || {
        crate::download::fetch(
            url,
            &name,
            &directory,
            expected_hash,
            cancellation,
            |downloaded, total, resumable| {
                let percent = total
                    .filter(|n| *n > 0)
                    .map(|n| ((downloaded.saturating_mul(100) / n).min(100)) as u8);
                let _ = app.emit(
                    "files-download-progress",
                    DownloadProgress {
                        url: url.into(),
                        downloaded,
                        total,
                        percent,
                        resumable,
                    },
                );
            },
        )
    })?
}
fn cancellation_registry() -> &'static Mutex<HashMap<String, Arc<crate::download::Control>>> {
    DOWNLOAD_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
#[tauri::command]
pub(crate) fn files_pause_download(url: String) -> Result<bool, String> {
    let registry = cancellation_registry()
        .lock()
        .map_err(|_| "Ошибка реестра загрузок")?;
    let control = registry.get(&url).ok_or("Загрузка не выполняется")?;
    if !control.resumable.load(Ordering::Relaxed) {
        return Err("Сервер не поддерживает проверяемую докачку. Можно отменить загрузку.".into());
    }
    control.paused.store(true, Ordering::Relaxed);
    Ok(true)
}
#[tauri::command]
pub(crate) async fn files_discard_download(
    app: tauri::AppHandle,
    url: String,
    suggested_name: String,
    target_dir: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if cancellation_registry()
            .lock()
            .map_err(|_| "Ошибка реестра")?
            .contains_key(&url)
        {
            return Err("Сначала дождитесь остановки загрузки".into());
        }
        let directory = resolve_download_dir(&app, target_dir.as_deref())?;
        let work = crate::safe_path::join(
            &directory,
            &crate::download::work_name(&url, &safe_file_name(&suggested_name)),
        )?;
        let _lock = crate::resource_lock::Guard::acquire(std::slice::from_ref(&work))?;
        if work.exists() {
            crate::archive_policy::validate_tree(&work)?;
            fs::remove_dir_all(work).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn safe_file_name(value: &str) -> String {
    let base = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download.bin");
    let cleaned = base
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>()
        .trim_matches([' ', '.'])
        .to_string();
    if cleaned.is_empty() {
        "download.bin".to_string()
    } else {
        cleaned
    }
}

fn load_catalog(app: &tauri::AppHandle) -> Result<FilesCatalog, String> {
    let cache = cache_path(app)?;
    let online = download_catalog();
    let (content, cached) = match online {
        Ok(content) => {
            if let Some(parent) = cache.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(&cache, &content);
            (content, false)
        }
        Err(network_error) => {
            let content = fs::read_to_string(&cache).map_err(|_| {
                format!(
                    "Не удалось загрузить список из Gist и локальный кэш отсутствует: {network_error}"
                )
            })?;
            (content, true)
        }
    };

    let mut catalog = parse_catalog(&content, cached)?;

    if !cached {
        if let Some(eclipse_item) = fetch_latest_eclipse_studio_file() {
            if !catalog
                .files
                .iter()
                .any(|f| f.name.eq_ignore_ascii_case("Eclipse Studio"))
            {
                if let Some(croc_index) = catalog.files.iter().position(|f| {
                    f.name
                        .to_ascii_lowercase()
                        .contains("crocodile gena studio")
                }) {
                    catalog.files.insert(croc_index + 1, eclipse_item);
                } else {
                    catalog.files.insert(0, eclipse_item);
                }
                catalog.total = catalog.files.len();
            }
        }
    }

    Ok(catalog)
}

fn find_eclipse_release_asset(assets: &[serde_json::Value]) -> Option<&serde_json::Value> {
    let is_match = |a: &serde_json::Value, check: fn(&str) -> bool| -> bool {
        a.get("name")
            .and_then(|n| n.as_str())
            .map(|n| check(&n.to_ascii_lowercase()))
            .unwrap_or(false)
    };

    assets
        .iter()
        .rev()
        .find(|a| {
            is_match(a, |n| {
                n.contains("eclipse")
                    && n.ends_with(".exe")
                    && !n.contains("setup")
                    && !n.contains("installer")
            })
        })
        .or_else(|| {
            assets.iter().rev().find(|a| {
                is_match(a, |n| {
                    n.contains("eclipse") && !n.contains("setup") && !n.contains("installer")
                })
            })
        })
        .or_else(|| {
            assets
                .iter()
                .rev()
                .find(|a| is_match(a, |n| n.contains("eclipse")))
        })
        .or_else(|| {
            assets.iter().rev().find(|a| {
                is_match(a, |n| {
                    n.ends_with(".exe") && !n.contains("setup") && !n.contains("installer")
                })
            })
        })
        .or_else(|| {
            assets
                .iter()
                .rev()
                .find(|a| is_match(a, |n| n.ends_with(".exe")))
        })
        .or_else(|| assets.last())
}

fn fetch_latest_eclipse_studio_file() -> Option<FileItem> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("Eclipse-Studio-Update-Checker")
        .build()
        .ok()?;

    // Прямой парсинг веб-релиза без использования GitHub API (во избежание rate limit)
    fetch_latest_eclipse_studio_file_via_web(&client)
}

fn fetch_latest_eclipse_studio_file_via_web(
    client: &reqwest::blocking::Client,
) -> Option<FileItem> {
    let response = client
        .get("https://github.com/Sparki1337/eclipse-studio/releases/latest")
        .send()
        .ok()?;
    let final_url = response.url().as_str().to_string();
    let tag = final_url.split("/releases/tag/").nth(1)?.trim();
    if tag.is_empty() {
        return None;
    }

    let assets_url =
        format!("https://github.com/Sparki1337/eclipse-studio/releases/expanded_assets/{tag}");
    let assets_res = client.get(&assets_url).send().ok()?;
    let html = assets_res.text().ok()?;
    let prefix = format!("/Sparki1337/eclipse-studio/releases/download/{tag}/");
    let mut raw_assets = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for part in html.split("href=\"") {
        if let Some(url_part) = part.split('"').next() {
            if let Some(file_name) = url_part.strip_prefix(&prefix) {
                let clean_name = file_name.split('?').next().unwrap_or(file_name).trim();
                if !clean_name.is_empty() && seen.insert(clean_name.to_string()) {
                    raw_assets.push(serde_json::json!({
                        "name": clean_name,
                        "browser_download_url": format!("https://github.com{prefix}{clean_name}"),
                    }));
                }
            }
        }
    }
    let chosen = find_eclipse_release_asset(&raw_assets)?;
    let download_url = chosen.get("browser_download_url")?.as_str()?.to_string();
    Some(FileItem {
        name: "Eclipse Studio".to_string(),
        build: format_build_string(tag),
        url: download_url,
        password: String::new(),
        pinned: true,
        sha256: None,
    })
}

fn format_build_string(tag: &str) -> String {
    let clean = tag.trim();
    if clean.to_ascii_lowercase().starts_with("build") {
        clean.to_string()
    } else if clean.starts_with('v') || clean.starts_with('V') {
        format!("Build {}", &clean[1..])
    } else {
        format!("Build {}", clean)
    }
}

fn download_catalog() -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("EclipseStudio/8.2.0")
        .build()
        .map_err(|error| format!("HTTP-клиент не создан: {error}"))?;
    let refs_url =
        format!("https://gist.github.com/{GIST_ID}.git/info/refs?service=git-upload-pack");
    let refs = client
        .get(refs_url)
        .header(reqwest::header::CACHE_CONTROL, "no-cache, no-store")
        .header(reqwest::header::PRAGMA, "no-cache")
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Не удалось проверить ревизию Gist: {error}"))?
        .text()
        .map_err(|error| format!("Не удалось прочитать ревизию Gist: {error}"))?;
    let revision = parse_head_revision(&refs)
        .ok_or_else(|| "GitHub не вернул текущую ревизию Gist".to_string())?;
    let catalog_url = format!(
        "https://gist.githubusercontent.com/{GIST_OWNER}/{GIST_ID}/raw/{revision}/cracks.json"
    );
    let response = client
        .get(catalog_url)
        .header(reqwest::header::CACHE_CONTROL, "no-cache, no-store")
        .header(reqwest::header::PRAGMA, "no-cache")
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("GitHub вернул ошибку: {error}"))?;
    response
        .text()
        .map_err(|error| format!("Ответ Gist не прочитан: {error}"))
}

fn parse_head_revision(advertisement: &str) -> Option<&str> {
    let head = advertisement.find(" HEAD")?;
    if head < 40 {
        return None;
    }
    let revision = &advertisement[head - 40..head];
    (revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(revision)
}

fn parse_catalog(content: &str, cached: bool) -> Result<FilesCatalog, String> {
    let remote: RemoteCatalog = serde_json::from_str(content)
        .map_err(|error| format!("Некорректный cracks.json: {error}"))?;

    let mut files = remote
        .cracks
        .into_iter()
        .filter_map(|item| {
            let name = item.name.trim().to_string();
            let url = item.url.trim().to_string();
            if name.is_empty() || !url.starts_with("https://") {
                return None;
            }
            Some(FileItem {
                name,
                build: item.build.trim().to_string(),
                url,
                password: item.password.trim().to_string(),
                pinned: item.pinned,
                sha256: item.sha256,
            })
        })
        .collect::<Vec<_>>();

    // Сортировка: новые файлы отображаются первыми
    files.reverse();
    let total = files.len();
    Ok(FilesCatalog {
        files,
        total,
        cached,
    })
}

fn cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("files").join("cracks.json"))
        .map_err(|error| format!("Не удалось определить папку кэша: {error}"))
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrackInstallResult {
    pub success: bool,
    pub status: String,
    pub skipped: Vec<String>,
    pub message: String,
    pub installed_files: Vec<String>,
    pub backup_dir: Option<String>,
    pub archive_deleted: bool,
}

fn extract_archive_file(archive: &Path, dest: &Path, password: Option<&str>) -> Result<(), String> {
    crate::archive_policy::extract(archive, dest, password)
}

fn is_metadata_or_junk_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    name.ends_with(".nfo")
        || name.ends_with(".url")
        || name.ends_with(".desktop")
        || name == "readme.txt"
        || name == "vbs.cmd"
        || (name.contains("source")
            && (name.ends_with(".7z") || name.ends_with(".zip") || name.ends_with(".rar")))
        || (name.contains("src")
            && (name.ends_with(".7z") || name.ends_with(".zip") || name.ends_with(".rar")))
}

fn detect_crack_source_dir(extracted_root: &Path) -> PathBuf {
    let entries: Vec<PathBuf> = fs::read_dir(extracted_root)
        .ok()
        .map(|iter| iter.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();

    // 1. Папка ARTIFACT (EA SPORTS FC 27, Borderlands 4, Jurassic World Evolution 3 и т.д.)
    for entry in &entries {
        if entry.is_dir() {
            if let Some(name) = entry.file_name().and_then(|s| s.to_str()) {
                if name.eq_ignore_ascii_case("ARTIFACT") {
                    return entry.clone();
                }
            }
        }
    }

    // 2. Папка DenuvOwO (Sonic Origins, Yakuza Kiwami 3, Persona, SMT V и т.д.)
    for entry in &entries {
        if entry.is_dir() {
            if let Some(name) = entry.file_name().and_then(|s| s.to_str()) {
                if name.eq_ignore_ascii_case("DenuvOwO") {
                    return entry.clone();
                }
            }
        }
    }

    // 3. Папки релиз-групп (Razor1911 в RDR2, CODEX, RUNE, FLT, SKIDROW, PLAZA, Crack, Goldberg)
    let group_names = [
        "Razor1911",
        "CODEX",
        "RUNE",
        "FLT",
        "SKIDROW",
        "PLAZA",
        "Crack",
        "Crack.Only",
        "Goldberg",
        "SteamEmu",
        "Mr_Goldberg",
    ];
    for entry in &entries {
        if entry.is_dir() {
            if let Some(name) = entry.file_name().and_then(|s| s.to_str()) {
                for group in &group_names {
                    if name.eq_ignore_ascii_case(group) {
                        return entry.clone();
                    }
                }
            }
        }
    }

    // 4. Если в корне ровно одна папка и остальное только readme/nfo
    let dirs: Vec<&PathBuf> = entries.iter().filter(|e| e.is_dir()).collect();
    if dirs.len() == 1 {
        let other_files_are_junk = entries
            .iter()
            .filter(|e| e.is_file())
            .all(|f| is_metadata_or_junk_file(f));
        if other_files_are_junk {
            return dirs[0].clone();
        }
    }

    // 5. Плоская структура
    extracted_root.to_path_buf()
}

fn resolve_install_target_path(game_dir: &Path, rel_path: &Path) -> PathBuf {
    let game = game_dir
        .components()
        .map(|p| p.as_os_str().to_string_lossy().to_lowercase())
        .collect::<Vec<_>>();
    let relative = rel_path.components().collect::<Vec<_>>();
    for length in (1..relative.len()).rev() {
        let prefix = relative[..length]
            .iter()
            .map(|p| p.as_os_str().to_string_lossy().to_lowercase())
            .collect::<Vec<_>>();
        if game.ends_with(&prefix) {
            return game_dir.join(relative[length..].iter().collect::<PathBuf>());
        }
    }
    game_dir.join(rel_path)
}

#[tauri::command]
pub(crate) async fn files_install_crack(
    app: tauri::AppHandle,
    archive_path: String,
    game_dir: String,
    password: Option<String>,
    delete_archive: bool,
) -> Result<CrackInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        perform_install_crack(
            &app,
            &archive_path,
            &game_dir,
            password.as_deref(),
            delete_archive,
        )
    })
    .await
    .map_err(|e| format!("Операция установки прервана: {e}"))?
}

// Поиск локального или прямая загрузка актуального Eclipse-HV.exe с GitHub без API
fn resolve_or_download_eclipse_hv(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // 1. Проверяем локальные пути (папка Hypervisor, локальная сборка eclipse-hv)
    let candidates = [
        PathBuf::from(r"C:\Users\Sparki\Desktop\Programms\Hypervisor\Eclipse-HV.exe"),
        PathBuf::from("eclipse-hv/target/release/eclipse-hv.exe"),
    ];

    for path in &candidates {
        if path.is_file()
            && fs::metadata(path)
                .map(|m| m.len() > 100_000)
                .unwrap_or(false)
        {
            return Ok(path.clone());
        }
    }

    // 2. Проверяем кэш приложения
    let cache_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Не удалось определить app_local_data_dir: {e}"))?
        .join("bin");
    let cached_exe = cache_dir.join("Eclipse-HV.exe");
    if cached_exe.is_file()
        && fs::metadata(&cached_exe)
            .map(|m| m.len() > 100_000)
            .unwrap_or(false)
    {
        return Ok(cached_exe);
    }

    // 3. Прямая загрузка с GitHub без использования GitHub API
    let download_url =
        "https://github.com/Sparki1337/eclipse-studio/releases/latest/download/Eclipse-HV.exe";
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Eclipse-Studio/8.0.0")
        .build()
        .map_err(|e| format!("Ошибка создания HTTP клиента: {e}"))?;

    let response = client
        .get(download_url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|e| format!("Не удалось скачать Eclipse-HV.exe: {e}"))?;

    let bytes = response
        .bytes()
        .map_err(|e| format!("Ошибка чтения данных Eclipse-HV.exe: {e}"))?;

    if bytes.len() < 100_000 || !bytes.starts_with(b"MZ") {
        return Err("Скачанный файл Eclipse-HV.exe повреждён или некорректен".into());
    }

    let _ = fs::create_dir_all(&cache_dir);
    fs::write(&cached_exe, &bytes)
        .map_err(|e| format!("Не удалось сохранить Eclipse-HV.exe в кэш: {e}"))?;

    Ok(cached_exe)
}

fn perform_install_crack(
    app: &tauri::AppHandle,
    archive_path_str: &str,
    game_dir_str: &str,
    password: Option<&str>,
    delete_archive: bool,
) -> Result<CrackInstallResult, String> {
    let archive_path = PathBuf::from(archive_path_str.trim());
    if !archive_path.is_file() {
        return Err("Файл архива не найден".into());
    }
    let game_dir = crate::safe_path::root(Path::new(game_dir_str.trim()))?;
    crate::jobs::run(
        &[game_dir.clone(), archive_path.clone()],
        "Установка файлов игры",
        || -> Result<CrackInstallResult, String> {
            let stage = tempfile::tempdir().map_err(|e| e.to_string())?;
            extract_archive_file(&archive_path, stage.path(), password)?;
            let source_dir = detect_crack_source_dir(stage.path());
            let operation = uuid::Uuid::new_v4().to_string();
            let mut files = Vec::new();
            let mut targets = std::collections::BTreeSet::new();
            for entry in walkdir::WalkDir::new(&source_dir).follow_links(false) {
                let entry = entry.map_err(|e| e.to_string())?;
                if !entry.file_type().is_file() {
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(&source_dir)
                    .map_err(|e| e.to_string())?;
                if relative.parent().is_none_or(|p| p.as_os_str().is_empty())
                    && is_metadata_or_junk_file(entry.path())
                {
                    continue;
                }
                let resolved = resolve_install_target_path(&game_dir, relative);
                let target = crate::safe_path::child(&game_dir, &resolved)?;
                let name = target
                    .strip_prefix(&game_dir)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                crate::backup::validate_name(&name)?;
                if !targets.insert(name.to_lowercase()) {
                    return Err(format!("Несколько записей направлены в один файл: {name}"));
                }
                files.push((entry.path().to_path_buf(), target, name));
            }
            if files.is_empty() {
                return Err("В архиве нет файлов для установки".into());
            }
            let mut skipped = Vec::new();
            let hv_target = crate::safe_path::join(&game_dir, "Eclipse-HV.exe")?;
            if !targets.contains("eclipse-hv.exe") {
                match resolve_or_download_eclipse_hv(app) {
                    Ok(source) => files.push((source, hv_target, "Eclipse-HV.exe".into())),
                    Err(e) => skipped.push(format!("Дополнительный лаунчер не установлен: {e}")),
                }
            }
            // Все бэкапы и записи манифеста фиксируются до первой перезаписи в игре.
            for (_, _, name) in &files {
                crate::backup::protect(&game_dir, name, &operation)?;
            }
            let mut installed_files = Vec::new();
            for (source, target, name) in files {
                let result = crate::safe_path::join(&game_dir, &name).and_then(|checked| {
                    if checked != target {
                        return Err("Целевой путь изменился во время задания".into());
                    }
                    crate::durable::copy(&source, &checked)
                });
                match result {
                    Ok(()) => installed_files.push(target.display().to_string()),
                    Err(e) => skipped.push(format!("{name}: {e}")),
                }
            }
            let success = skipped.is_empty();
            let mut archive_deleted = false;
            if success && delete_archive {
                match fs::remove_file(&archive_path) {
                    Ok(()) => archive_deleted = true,
                    Err(e) => skipped.push(format!("Файлы установлены, но архив не удалён: {e}")),
                }
            }
            let success = skipped.is_empty();
            Ok(CrackInstallResult {
                success,
                status: if success {
                    "success"
                } else if installed_files.is_empty() {
                    "failed"
                } else {
                    "partial"
                }
                .into(),
                message: if success {
                    format!("Установлено и проверено файлов: {}", installed_files.len())
                } else {
                    format!("Выполнено частично: установлено {}, замечаний {}. Архив и бэкапы сохранены.", installed_files.len(), skipped.len())
                },
                installed_files,
                backup_dir: Some(game_dir.join(crate::backup::DIR).display().to_string()),
                archive_deleted,
                skipped,
            })
        },
    )?
}

#[cfg(test)]
mod tests {
    use super::{parse_catalog, parse_head_revision};

    #[test]
    fn reads_current_revision_from_git_advertisement() {
        let response = "001e# service=git-upload-pack\n000001591d770c9e1b5c87b59b667c4378310a16bc4191f2 HEAD\0multi_ack";
        assert_eq!(
            parse_head_revision(response),
            Some("1d770c9e1b5c87b59b667c4378310a16bc4191f2")
        );
    }

    #[test]
    fn catalog_is_reversed_to_newest_first() {
        let json = r#"{"cracks":[
          {"name":"Старый","build":"Build 1","url":"https://example.com/1","password":""},
          {"name":"Новый","build":"Build 2","url":"https://example.com/2","password":"pass"}
        ]}"#;
        let result = parse_catalog(json, false).expect("catalog");
        assert_eq!(result.total, 2);
        assert_eq!(result.files[0].name, "Новый");
        assert_eq!(result.files[0].password, "pass");
    }

    #[test]
    fn catalog_skips_entries_without_https_download() {
        let json = r#"{"cracks":[{"name":"Bad","url":"http://example.com/file"}]}"#;
        let result = parse_catalog(json, true).expect("catalog");
        assert_eq!(result.total, 0);
        assert!(result.cached);
    }

    #[test]
    fn catalog_reads_pinned_flag_without_relying_on_name() {
        let json = r#"{"cracks":[
          {"name":"Обычный файл","url":"https://example.com/regular"},
          {"name":"Любое название","url":"https://example.com/pinned","pinned":true}
        ]}"#;
        let result = parse_catalog(json, false).expect("catalog");
        assert!(result.files[0].pinned);
        assert!(!result.files[1].pinned);
    }

    #[test]
    fn selects_latest_eclipse_asset() {
        let assets = serde_json::json!([
            { "name": "other.exe", "browser_download_url": "https://example.com/other.exe" },
            { "name": "eclipse-build-1.exe", "browser_download_url": "https://example.com/eclipse-build-1.exe" },
            { "name": "Eclipse.Studio.exe", "browser_download_url": "https://example.com/Eclipse.Studio.exe" }
        ]);
        let chosen = super::find_eclipse_release_asset(assets.as_array().unwrap()).unwrap();
        assert_eq!(chosen["name"], "Eclipse.Studio.exe");
    }

    #[test]
    fn selects_any_eclipse_file_if_no_pure_exe() {
        let assets = serde_json::json!([
            { "name": "some-unrelated.txt", "browser_download_url": "https://example.com/some.txt" },
            { "name": "eclipse-archive.zip", "browser_download_url": "https://example.com/eclipse.zip" }
        ]);
        let chosen = super::find_eclipse_release_asset(assets.as_array().unwrap()).unwrap();
        assert_eq!(chosen["name"], "eclipse-archive.zip");
    }

    #[test]
    fn resolves_install_target_path_with_nested_prefix() {
        let game_dir = std::path::Path::new(r"D:\Games\Borderlands 4\OakGame\Binaries\Win64");
        let rel_path = std::path::Path::new(r"OakGame\Binaries\Win64\artifact.dll");
        let target = super::resolve_install_target_path(game_dir, rel_path);
        assert_eq!(
            target,
            std::path::PathBuf::from(r"D:\Games\Borderlands 4\OakGame\Binaries\Win64\artifact.dll")
        );
    }

    #[test]
    fn resolves_install_target_path_from_root() {
        let game_dir = std::path::Path::new(r"D:\Games\Borderlands 4");
        let rel_path = std::path::Path::new(r"OakGame\Binaries\Win64\artifact.dll");
        let target = super::resolve_install_target_path(game_dir, rel_path);
        assert_eq!(
            target,
            std::path::PathBuf::from(r"D:\Games\Borderlands 4\OakGame\Binaries\Win64\artifact.dll")
        );
    }

    #[test]
    fn detects_artifact_folder() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("test_cgs_artifact_{ts}"));
        let artifact = temp.join("ARTIFACT");
        let _ = std::fs::create_dir_all(&artifact);
        let _ = std::fs::write(temp.join("readme.txt"), "hello");
        let _ = std::fs::write(temp.join("VBS.cmd"), "echo");
        let detected = super::detect_crack_source_dir(&temp);
        assert_eq!(detected, artifact);
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn detects_razor1911_folder() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("test_cgs_razor_{ts}"));
        let razor = temp.join("Razor1911");
        let _ = std::fs::create_dir_all(&razor);
        let detected = super::detect_crack_source_dir(&temp);
        assert_eq!(detected, razor);
        let _ = std::fs::remove_dir_all(&temp);
    }
}
