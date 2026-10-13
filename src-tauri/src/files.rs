use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

const GIST_ID: &str = "b314de5f9a3e2293b7e3c22136d49889";
const GIST_OWNER: &str = "LeoBanned";
const DOWNLOAD_BUFFER_SIZE: usize = 1024 * 1024;
const PARALLEL_DOWNLOAD_PARTS: u64 = 6;
static DOWNLOAD_CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

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
}

#[derive(Clone, Serialize)]
pub(crate) struct FileItem {
    name: String,
    build: String,
    url: String,
    password: String,
    pinned: bool,
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadResult {
    path: String,
    file_name: String,
}

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
) -> Result<DownloadResult, String> {
    let cancellation = Arc::new(AtomicBool::new(false));
    cancellation_registry()
        .lock()
        .map_err(|_| "Не удалось запустить загрузку".to_string())?
        .insert(url.clone(), Arc::clone(&cancellation));
    let registry_url = url.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        download_file(&app, &url, &suggested_name, target_dir.as_deref(), &cancellation)
    })
    .await
    .map_err(|error| format!("Загрузка файла прервана: {error}"))?;
    if let Ok(mut registry) = cancellation_registry().lock() {
        registry.remove(&registry_url);
    }
    result
}

#[tauri::command]
pub(crate) fn files_cancel_download(url: String) -> Result<bool, String> {
    let registry = cancellation_registry()
        .lock()
        .map_err(|_| "Не удалось отменить загрузку".to_string())?;
    if let Some(cancellation) = registry.get(&url) {
        cancellation.store(true, Ordering::Relaxed);
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
fn resolve_download_dir(app: &tauri::AppHandle, target_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(custom) = target_dir.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(custom);
        if !path.is_absolute() {
            return Err("Папка для загрузки указана неверно. Выберите её заново в настройках".into());
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
pub(crate) async fn files_pick_download_dir() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(pick_download_dir_blocking)
        .await
        .map_err(|error| format!("Диалог выбора прерван: {error}"))?
}

fn pick_download_dir_blocking() -> Result<Option<String>, String> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Выберите папку для загрузки'
$d.ValidateNames = $false
$d.CheckFileExists = $false
$d.CheckPathExists = $true
$d.FileName = 'Выбор папки'
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    Write-Output ([System.IO.Path]::GetDirectoryName($d.FileName))
}
"#;
    let mut command = std::process::Command::new("powershell.exe");
    command.args(["-NoProfile", "-STA", "-Command", script]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|error| format!("Не удалось открыть проводник: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!path.is_empty()).then_some(path))
}

#[tauri::command]
pub(crate) fn files_open_download_dir(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
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
    cancellation: &Arc<AtomicBool>,
) -> Result<DownloadResult, String> {
    if !url.starts_with("https://") {
        return Err("Разрешены только безопасные HTTPS-ссылки".into());
    }

    let downloads = resolve_download_dir(app, target_dir)?;
    fs::create_dir_all(&downloads)
        .map_err(|error| format!("Не удалось подготовить папку для загрузки: {error}"))?;

    let safe_name = safe_file_name(suggested_name);
    let destination = available_path(&downloads, &safe_name);
    let partial = destination.with_extension(format!(
        "{}part",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!("{value}."))
            .unwrap_or_default()
    ));

    let result = (|| {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(900))
            .pool_max_idle_per_host(PARALLEL_DOWNLOAD_PARTS as usize)
            .user_agent("EclipseStudio/6.3.0")
            .build()
            .map_err(|error| format!("HTTP-клиент не создан: {error}"))?;
        let head = client
            .head(url)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .ok();
        let total = head
            .as_ref()
            .and_then(reqwest::blocking::Response::content_length);
        let supports_ranges = head
            .as_ref()
            .and_then(|response| response.headers().get(reqwest::header::ACCEPT_RANGES))
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("bytes"));
        let resolved_url = head
            .as_ref()
            .map(|response| response.url().as_str())
            .unwrap_or(url)
            .to_string();

        let downloaded = if supports_ranges && total.is_some_and(|size| size >= 4 * 1024 * 1024) {
            download_parallel(
                app,
                &client,
                url,
                &resolved_url,
                &partial,
                total.unwrap_or_default(),
                cancellation,
            )?
        } else {
            download_sequential(app, &client, url, &partial, total, cancellation)?
        };
        ensure_not_cancelled(cancellation)?;
        fs::rename(&partial, &destination)
            .map_err(|error| format!("Не удалось сохранить загруженный файл: {error}"))?;
        emit_progress(app, url, downloaded, total.or(Some(downloaded)));
        Ok(())
    })();

    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }

    Ok(DownloadResult {
        file_name: destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&safe_name)
            .to_string(),
        path: destination.to_string_lossy().to_string(),
    })
}

fn cancellation_registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    DOWNLOAD_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ensure_not_cancelled(cancellation: &AtomicBool) -> Result<(), String> {
    if cancellation.load(Ordering::Relaxed) {
        Err("Загрузка отменена".into())
    } else {
        Ok(())
    }
}

fn download_sequential(
    app: &tauri::AppHandle,
    client: &reqwest::blocking::Client,
    event_url: &str,
    destination: &Path,
    known_total: Option<u64>,
    cancellation: &AtomicBool,
) -> Result<u64, String> {
    let mut response = client
        .get(event_url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Сервер вернул ошибку: {error}"))?;
    let total = known_total.or_else(|| response.content_length());
    let mut output = fs::File::create(destination)
        .map_err(|error| format!("Не удалось создать файл: {error}"))?;
    let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_SIZE];
    let mut downloaded = 0_u64;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    emit_progress(app, event_url, 0, total);
    loop {
        ensure_not_cancelled(cancellation)?;
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("Ошибка получения данных: {error}"))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("Ошибка записи файла: {error}"))?;
        downloaded += read as u64;
        if last_emit.elapsed() >= Duration::from_millis(180) {
            emit_progress(app, event_url, downloaded, total);
            last_emit = Instant::now();
        }
    }
    output
        .flush()
        .map_err(|error| format!("Не удалось завершить запись файла: {error}"))?;
    Ok(downloaded)
}

fn download_parallel(
    app: &tauri::AppHandle,
    client: &reqwest::blocking::Client,
    event_url: &str,
    resolved_url: &str,
    destination: &Path,
    total: u64,
    cancellation: &Arc<AtomicBool>,
) -> Result<u64, String> {
    let part_count = PARALLEL_DOWNLOAD_PARTS.min((total / (2 * 1024 * 1024)).max(2));
    let downloaded = Arc::new(AtomicU64::new(0));
    let last_emit = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1)));
    let segment_paths = (0..part_count)
        .map(|index| PathBuf::from(format!("{}.segment-{index}", destination.display())))
        .collect::<Vec<_>>();

    let results = thread::scope(|scope| {
        let mut handles = Vec::new();
        for index in 0..part_count {
            let start = total * index / part_count;
            let end = (total * (index + 1) / part_count).saturating_sub(1);
            let client = client.clone();
            let source = resolved_url.to_string();
            let segment = segment_paths[index as usize].clone();
            let cancellation = Arc::clone(cancellation);
            let downloaded = Arc::clone(&downloaded);
            let last_emit = Arc::clone(&last_emit);
            let app = app.clone();
            let event_url = event_url.to_string();
            handles.push(scope.spawn(move || -> Result<(), String> {
                let mut response = client
                    .get(source)
                    .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
                    .send()
                    .map_err(|error| format!("Не удалось получить часть файла: {error}"))?;
                if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                    return Err("Сервер не подтвердил ускоренную загрузку".into());
                }
                let mut output = fs::File::create(&segment)
                    .map_err(|error| format!("Не удалось создать часть файла: {error}"))?;
                let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_SIZE];
                loop {
                    ensure_not_cancelled(&cancellation)?;
                    let read = response
                        .read(&mut buffer)
                        .map_err(|error| format!("Ошибка получения части файла: {error}"))?;
                    if read == 0 {
                        break;
                    }
                    output
                        .write_all(&buffer[..read])
                        .map_err(|error| format!("Ошибка записи части файла: {error}"))?;
                    let current =
                        downloaded.fetch_add(read as u64, Ordering::Relaxed) + read as u64;
                    if let Ok(mut emitted_at) = last_emit.lock() {
                        if emitted_at.elapsed() >= Duration::from_millis(180) {
                            emit_progress(&app, &event_url, current, Some(total));
                            *emitted_at = Instant::now();
                        }
                    }
                }
                Ok(())
            }));
        }
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| "Поток ускоренной загрузки завершился с ошибкой".to_string())?
            })
            .collect::<Result<Vec<_>, String>>()
    });

    if let Err(error) = results {
        for segment in &segment_paths {
            let _ = fs::remove_file(segment);
        }
        return Err(error);
    }
    let assemble_result = (|| {
        ensure_not_cancelled(cancellation)?;
        let mut output = fs::File::create(destination)
            .map_err(|error| format!("Не удалось собрать файл: {error}"))?;
        let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_SIZE];
        for segment in &segment_paths {
            ensure_not_cancelled(cancellation)?;
            let mut input = fs::File::open(segment)
                .map_err(|error| format!("Не удалось открыть часть файла: {error}"))?;
            input
                .seek(SeekFrom::Start(0))
                .map_err(|error| format!("Не удалось прочитать часть файла: {error}"))?;
            loop {
                let read = input
                    .read(&mut buffer)
                    .map_err(|error| format!("Не удалось собрать часть файла: {error}"))?;
                if read == 0 {
                    break;
                }
                output
                    .write_all(&buffer[..read])
                    .map_err(|error| format!("Не удалось записать собранный файл: {error}"))?;
            }
        }
        output
            .flush()
            .map_err(|error| format!("Не удалось завершить файл: {error}"))
    })();
    for segment in &segment_paths {
        let _ = fs::remove_file(segment);
    }
    assemble_result?;
    Ok(downloaded.load(Ordering::Relaxed))
}

fn emit_progress(app: &tauri::AppHandle, url: &str, downloaded: u64, total: Option<u64>) {
    let percent = total
        .filter(|value| *value > 0)
        .map(|value| ((downloaded.saturating_mul(100) / value).min(100)) as u8);
    let _ = app.emit(
        "files-download-progress",
        DownloadProgress {
            url: url.to_string(),
            downloaded,
            total,
            percent,
        },
    );
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

fn available_path(directory: &Path, file_name: &str) -> PathBuf {
    let original = directory.join(file_name);
    if !original.exists() {
        return original;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..10_000 {
        let candidate = match extension {
            Some(extension) => directory.join(format!("{stem} ({index}).{extension}")),
            None => directory.join(format!("{stem} ({index})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}-new"))
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
            if !catalog.files.iter().any(|f| f.name.eq_ignore_ascii_case("Eclipse Studio")) {
                if let Some(croc_index) = catalog.files.iter().position(|f| f.name.to_ascii_lowercase().contains("crocodile gena studio")) {
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

    assets.iter().rev().find(|a| {
        is_match(a, |n| n.contains("eclipse") && n.ends_with(".exe") && !n.contains("setup") && !n.contains("installer"))
    })
    .or_else(|| {
        assets.iter().rev().find(|a| {
            is_match(a, |n| n.contains("eclipse") && !n.contains("setup") && !n.contains("installer"))
        })
    })
    .or_else(|| {
        assets.iter().rev().find(|a| {
            is_match(a, |n| n.contains("eclipse"))
        })
    })
    .or_else(|| {
        assets.iter().rev().find(|a| {
            is_match(a, |n| n.ends_with(".exe") && !n.contains("setup") && !n.contains("installer"))
        })
    })
    .or_else(|| {
        assets.iter().rev().find(|a| {
            is_match(a, |n| n.ends_with(".exe"))
        })
    })
    .or_else(|| assets.last())
}

fn fetch_latest_eclipse_studio_file() -> Option<FileItem> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent("Eclipse-Studio-Update-Checker")
        .build()
        .ok()?;

    if let Ok(response) = client
        .get("https://api.github.com/repos/Sparki1337/eclipse-studio/releases/latest")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
    {
        if response.status().is_success() {
            if let Ok(release) = response.json::<serde_json::Value>() {
                if let (Some(tag), Some(assets)) = (
                    release.get("tag_name").and_then(|t| t.as_str()),
                    release.get("assets").and_then(|a| a.as_array()),
                ) {
                    if let Some(exe_asset) = find_eclipse_release_asset(assets) {
                        if let Some(download_url) = exe_asset.get("browser_download_url").and_then(|u| u.as_str()) {
                            if download_url.starts_with("https://") {
                                return Some(FileItem {
                                    name: "Eclipse Studio".to_string(),
                                    build: format_build_string(tag),
                                    url: download_url.to_string(),
                                    password: String::new(),
                                    pinned: true,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    fetch_latest_eclipse_studio_file_via_web(&client)
}

fn fetch_latest_eclipse_studio_file_via_web(client: &reqwest::blocking::Client) -> Option<FileItem> {
    let response = client
        .get("https://github.com/Sparki1337/eclipse-studio/releases/latest")
        .send()
        .ok()?;
    let final_url = response.url().as_str().to_string();
    let tag = final_url
        .split("/releases/tag/")
        .nth(1)?
        .trim();
    if tag.is_empty() {
        return None;
    }

    let assets_url = format!("https://github.com/Sparki1337/eclipse-studio/releases/expanded_assets/{tag}");
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
        .user_agent("EclipseStudio/6.3.0")
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
    pub message: String,
    pub installed_files: Vec<String>,
    pub backup_dir: Option<String>,
    pub archive_deleted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExtractorKind {
    NanaZipOr7z,
    UnRar,
    WinRar,
    Tar,
}

fn find_extractor() -> Option<(PathBuf, ExtractorKind)> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let app_path = PathBuf::from(local).join("Microsoft\\WindowsApps\\7z.exe");
        if app_path.is_file() {
            return Some((app_path, ExtractorKind::NanaZipOr7z));
        }
    }
    let pf_roots = [
        std::env::var_os("ProgramFiles").map(PathBuf::from),
        std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
    ];
    for root in pf_roots.into_iter().flatten() {
        let p7z = root.join("7-Zip\\7z.exe");
        if p7z.is_file() {
            return Some((p7z, ExtractorKind::NanaZipOr7z));
        }
        let unrar = root.join("WinRAR\\UnRAR.exe");
        if unrar.is_file() {
            return Some((unrar, ExtractorKind::UnRar));
        }
        let winrar = root.join("WinRAR\\WinRAR.exe");
        if winrar.is_file() {
            return Some((winrar, ExtractorKind::WinRar));
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        for exe_name in &["7z.exe", "UnRAR.exe"] {
            let mut cmd = std::process::Command::new("where.exe");
            cmd.arg(exe_name);
            cmd.creation_flags(0x08000000);
            if let Ok(output) = cmd.output() {
                if output.status.success() {
                    if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            let kind = if exe_name.starts_with("7z") {
                                ExtractorKind::NanaZipOr7z
                            } else {
                                ExtractorKind::UnRar
                            };
                            return Some((PathBuf::from(trimmed), kind));
                        }
                    }
                }
            }
        }
    }
    let tar = PathBuf::from("C:\\Windows\\System32\\tar.exe");
    if tar.is_file() {
        return Some((tar, ExtractorKind::Tar));
    }
    None
}

fn extract_archive_file(
    archive: &Path,
    dest: &Path,
    password: Option<&str>,
) -> Result<(), String> {
    fs::create_dir_all(dest)
        .map_err(|e| format!("Не удалось создать временную папку распаковки: {e}"))?;

    let ext = archive
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let pass = password.map(str::trim).filter(|p| !p.is_empty());

    if let Some((exe, kind)) = find_extractor() {
        let mut cmd = std::process::Command::new(&exe);
        match kind {
            ExtractorKind::NanaZipOr7z => {
                cmd.arg("x");
                if let Some(p) = pass {
                    cmd.arg(format!("-p{p}"));
                } else {
                    cmd.arg("-p-");
                }
                cmd.arg("-y");
                cmd.arg(archive);
                cmd.arg(format!("-o{}", dest.display()));
            }
            ExtractorKind::UnRar => {
                cmd.arg("x");
                if let Some(p) = pass {
                    cmd.arg(format!("-p{p}"));
                } else {
                    cmd.arg("-p-");
                }
                cmd.arg("-y");
                cmd.arg(archive);
                cmd.arg(format!("{}\\", dest.display()));
            }
            ExtractorKind::WinRar => {
                cmd.args(["x", "-ibck", "-inul"]);
                if let Some(p) = pass {
                    cmd.arg(format!("-p{p}"));
                }
                cmd.arg("-y");
                cmd.arg(archive);
                cmd.arg(format!("{}\\", dest.display()));
            }
            ExtractorKind::Tar => {
                if pass.is_some() {
                    return Err("Архив защищён паролем, а системный tar.exe не поддерживает пароли. Установите WinRAR или 7-Zip.".into());
                }
                cmd.args(["-xf"]);
                cmd.arg(archive);
                cmd.args(["-C"]);
                cmd.arg(dest);
            }
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Ошибка запуска архиватора {}: {e}", exe.display()))?;
        if output.status.success() {
            return Ok(());
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let details = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("код выхода {:?}", output.status.code())
            };
            return Err(format!("Ошибка при распаковке архива: {details}"));
        }
    }

    if ext == "zip" {
        return extract_zip_fallback(archive, dest);
    }

    Err("Для распаковки архивов необходим WinRAR или 7-Zip. Пожалуйста, установите один из них.".into())
}

fn extract_zip_fallback(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive)
        .map_err(|e| format!("Не удалось открыть zip-архив: {e}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("Не удалось прочитать zip-архив: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("Ошибка чтения записи zip: {e}"))?;
        let outpath = match entry.enclosed_name() {
            Some(path) => dest.join(path),
            None => continue,
        };
        if entry.is_dir() {
            fs::create_dir_all(&outpath)
                .map_err(|e| format!("Не удалось создать папку: {e}"))?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    fs::create_dir_all(p)
                        .map_err(|e| format!("Не удалось создать папку: {e}"))?;
                }
            }
            let mut outfile = fs::File::create(&outpath)
                .map_err(|e| format!("Не удалось создать файл: {e}"))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("Ошибка записи файла: {e}"))?;
        }
    }
    Ok(())
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
        || (name.contains("source") && (name.ends_with(".7z") || name.ends_with(".zip") || name.ends_with(".rar")))
        || (name.contains("src") && (name.ends_with(".7z") || name.ends_with(".zip") || name.ends_with(".rar")))
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
        "Razor1911", "CODEX", "RUNE", "FLT", "SKIDROW", "PLAZA",
        "Crack", "Crack.Only", "Goldberg", "SteamEmu", "Mr_Goldberg",
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
    let game_dir_str = game_dir
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    let rel_str = rel_path.to_string_lossy().replace('/', "\\");

    let components: Vec<&str> = rel_str.split('\\').collect();
    if components.len() > 1 {
        for i in (1..components.len()).rev() {
            let prefix = components[0..i].join("\\").to_lowercase();
            if game_dir_str.ends_with(&prefix) {
                let remaining = components[i..].join("\\");
                return game_dir.join(remaining);
            }
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
        perform_install_crack(&app, &archive_path, &game_dir, password.as_deref(), delete_archive)
    })
    .await
    .map_err(|e| format!("Операция установки прервана: {e}"))?
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
        return Err("Файл архива не найден на диске".into());
    }

    let game_dir = PathBuf::from(game_dir_str.trim());
    if !game_dir.is_dir() {
        return Err("Выбранная папка с игрой не существует".into());
    }

    let temp_root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Не удалось определить папку данных: {e}"))?
        .join("temp_crack_extract");
    let extract_dir = temp_root.join(format!(
        "cgs_inst_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));

    // 1. Распаковка архива
    extract_archive_file(&archive_path, &extract_dir, password)?;

    // 2. Определение корневой папки кряка
    let source_dir = detect_crack_source_dir(&extract_dir);

    // 3. Обход файлов и установка
    let mut installed_files = Vec::new();
    let mut backed_up_files = Vec::new();
    let mut created_files = Vec::new();

    let backup_dir = game_dir.join(".backup_orig");

    for entry in walkdir::WalkDir::new(&source_dir)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let source_file = entry.path();
        let rel_path = match source_file.strip_prefix(&source_dir) {
            Ok(p) => p,
            Err(_) => continue,
        };

        // Пропуск мусорных файлов верхнего уровня
        if rel_path.parent().map(|p| p.as_os_str().is_empty()).unwrap_or(true)
            && is_metadata_or_junk_file(source_file)
        {
            continue;
        }

        let target_file = resolve_install_target_path(&game_dir, rel_path);

        // Создаем родительскую папку в игре
        if let Some(parent) = target_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Не удалось создать папку {}: {e}", parent.display()))?;
        }

        // Бэкап существующего файла
        if target_file.is_file() {
            let backup_target = backup_dir.join(rel_path);
            if let Some(b_parent) = backup_target.parent() {
                let _ = fs::create_dir_all(b_parent);
            }
            if !backup_target.is_file() {
                let _ = fs::copy(&target_file, &backup_target);
            }
            backed_up_files.push(rel_path.to_string_lossy().to_string());
        } else {
            created_files.push(rel_path.to_string_lossy().to_string());
        }

        // Копирование файла кряка в целевую папку
        fs::copy(source_file, &target_file)
            .map_err(|e| format!("Не удалось скопировать файл {}: {e}", target_file.display()))?;

        installed_files.push(target_file.to_string_lossy().to_string());
    }

    if installed_files.is_empty() {
        let _ = fs::remove_dir_all(&extract_dir);
        return Err("В распакованном архиве не обнаружены файлы кряка для установки".into());
    }

    // Сохранение манифеста бэкапа (совместимо с cgs-backup.json)
    if !backed_up_files.is_empty() || !created_files.is_empty() {
        let _ = fs::create_dir_all(&backup_dir);
        let manifest_path = backup_dir.join("cgs-backup.json");
        let originals_map: std::collections::BTreeMap<String, String> = backed_up_files
            .iter()
            .map(|f| (f.to_lowercase(), f.clone()))
            .collect();
        let created_map: std::collections::BTreeMap<String, String> = created_files
            .iter()
            .map(|f| (f.to_lowercase(), f.clone()))
            .collect();
        let manifest_json = serde_json::json!({
            "version": 2,
            "originals": originals_map,
            "created": created_map,
            "legacy_import": false
        });
        if let Ok(bytes) = serde_json::to_vec_pretty(&manifest_json) {
            let _ = fs::write(manifest_path, bytes);
        }
    }

    // 4. Удаление скачанного архива при необходимости
    let mut archive_was_deleted = false;
    if delete_archive {
        if let Err(e) = fs::remove_file(&archive_path) {
            eprintln!("Не удалось удалить архив {}: {e}", archive_path.display());
        } else {
            archive_was_deleted = true;
        }
    }

    // 5. Удаление временной папки распаковки
    let _ = fs::remove_dir_all(&extract_dir);

    let message = format!(
        "Успешно установлено файлов: {}.{}{}",
        installed_files.len(),
        if !backed_up_files.is_empty() {
            format!(" Создан бэкап оригиналов ({} файлов).", backed_up_files.len())
        } else {
            "".to_string()
        },
        if archive_was_deleted {
            " Скачанный архив удалён."
        } else {
            ""
        }
    );

    Ok(CrackInstallResult {
        success: true,
        message,
        installed_files,
        backup_dir: if backed_up_files.is_empty() {
            None
        } else {
            Some(backup_dir.to_string_lossy().to_string())
        },
        archive_deleted: archive_was_deleted,
    })
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
        let temp = std::env::temp_dir().join(format!("test_cgs_{}", std::time::SystemTime::now().elapsed().unwrap().as_nanos()));
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
        let temp = std::env::temp_dir().join(format!("test_cgs_{}", std::time::SystemTime::now().elapsed().unwrap().as_nanos()));
        let razor = temp.join("Razor1911");
        let _ = std::fs::create_dir_all(&razor);
        let detected = super::detect_crack_source_dir(&temp);
        assert_eq!(detected, razor);
        let _ = std::fs::remove_dir_all(&temp);
    }
}
