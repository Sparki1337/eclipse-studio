//! Проверка релизов Eclipse Studio и обновление внутри программы.
//! Новый EXE скачивается с докачкой и проверкой SHA-256, затем копия текущей программы
//! в роли помощника заменяет файл на месте: путь, имя и ярлыки сохраняются.
use crate::update_core as core;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
// Instant и Emitter нужны только установке обновления, которая работает в Windows
#[cfg(target_os = "windows")]
use std::time::Instant;
use tauri::AppHandle;
#[cfg(target_os = "windows")]
use tauri::Emitter;

// Проверка web-релизов и releases.atom без лимитов GitHub API
const REPO: &str = "Sparki1337/eclipse-studio";
const RELEASES_PAGE: &str = "https://github.com/Sparki1337/eclipse-studio/releases";
const RELEASES_ATOM: &str = "https://github.com/Sparki1337/eclipse-studio/releases.atom";
const USER_AGENT: &str = "Eclipse-Studio-Update-Checker";
/// Событие хода обновления для интерфейса
const PROGRESS_EVENT: &str = "cgs-update-progress";
const NO_VERIFIED_EXE: &str = "В релизе нет проверяемого EXE для обновления внутри программы.";
const BUSY: &str = "Дождитесь завершения текущих операций перед обновлением.";
const DOWNLOAD_ATTEMPTS: u32 = 3;

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub title: String,
    pub notes: String,
    pub release_url: String,
    pub installer_url: Option<String>,
    pub portable_url: Option<String>,
    /// В релизе есть портативный EXE с опубликованной SHA-256: можно обновиться внутри программы
    pub in_app_supported: bool,
    pub asset_name: Option<String>,
    pub asset_sha256: Option<String>,
    #[serde(skip)]
    asset_url: Option<String>,
}

/// Этап обновления для окна прогресса
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub phase: &'static str,
    pub downloaded: u64,
    pub total: u64,
    pub percent: u8,
    pub attempt: u32,
    pub message: String,
}

impl UpdateProgress {
    fn phase(phase: &'static str) -> Self {
        Self {
            phase,
            downloaded: 0,
            total: 0,
            percent: 0,
            attempt: 0,
            message: String::new(),
        }
    }
}

/// Итог запуска после обновления: показывается один раз при загрузке интерфейса
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOutcome {
    pub success: bool,
    pub message: String,
    pub version: String,
}

fn version_parts(version: &str) -> Option<Vec<u64>> {
    core::version_parts(version)
}

fn is_newer(latest: &str, current: &str) -> bool {
    core::is_newer(latest, current)
}

fn installer_url(release: &GithubRelease) -> Option<String> {
    release
        .assets
        .iter()
        .find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.ends_with(".exe") && (name.contains("setup") || name.contains("installer"))
        })
        .map(|asset| asset.browser_download_url.clone())
}

fn portable_url(release: &GithubRelease) -> Option<String> {
    release
        .assets
        .iter()
        .rev()
        .find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.contains("eclipse")
                && name.ends_with(".exe")
                && !name.contains("setup")
                && !name.contains("installer")
        })
        .or_else(|| {
            release.assets.iter().rev().find(|asset| {
                let name = asset.name.to_ascii_lowercase();
                name.contains("eclipse") && !name.contains("setup") && !name.contains("installer")
            })
        })
        .or_else(|| {
            release.assets.iter().rev().find(|asset| {
                let name = asset.name.to_ascii_lowercase();
                name.ends_with(".exe") && !name.contains("setup") && !name.contains("installer")
            })
        })
        .or_else(|| {
            release.assets.iter().rev().find(|asset| {
                let name = asset.name.to_ascii_lowercase();
                name.contains("eclipse")
            })
        })
        .or_else(|| {
            release.assets.iter().rev().find(|asset| {
                let name = asset.name.to_ascii_lowercase();
                name.ends_with(".exe")
            })
        })
        .or_else(|| release.assets.last())
        .map(|asset| asset.browser_download_url.clone())
}

#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(check_for_update_blocking)
        .await
        .map_err(|error| format!("Проверка обновлений прервана: {error}"))?
}

fn check_for_update_blocking() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Не удалось подготовить проверку обновлений: {error}"))?;

    // Прямая проверка релизов через web и Atom-ленту без GitHub API (во избежание rate limit)
    let release = check_for_update_via_web(&client)?;

    let latest = release
        .tag_name
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    if version_parts(&latest).is_none() {
        return Err(format!(
            "У последнего релиза некорректный номер версии: {}",
            release.tag_name
        ));
    }

    let asset =
        core_assets(&release).and_then(|assets| core::update_asset(&assets, &latest).cloned());
    let in_app_supported =
        cfg!(target_os = "windows") && asset.as_ref().is_some_and(|asset| asset.sha256.is_some());
    Ok(UpdateInfo {
        in_app_supported,
        asset_name: asset.as_ref().map(|asset| asset.name.clone()),
        asset_sha256: asset.as_ref().and_then(|asset| asset.sha256.clone()),
        asset_url: asset.map(|asset| asset.url),
        available: is_newer(&latest, &current),
        title: release
            .name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| format!("Eclipse Studio {latest}")),
        notes: release.body.clone().unwrap_or_default(),
        release_url: release.html_url.clone(),
        installer_url: installer_url(&release),
        portable_url: portable_url(&release),
        current_version: current,
        latest_version: latest,
    })
}

fn check_for_update_via_web(client: &Client) -> Result<GithubRelease, String> {
    let response = client
        .get("https://github.com/Sparki1337/eclipse-studio/releases/latest")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .map_err(|error| format!("Не удалось подключиться к странице релизов: {error}"))?;
    let final_url = response.url().as_str().to_string();
    let tag = final_url
        .split("/releases/tag/")
        .nth(1)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "Не удалось определить номер версии со страницы релизов".to_string())?
        .to_string();

    let assets_url = format!("https://github.com/{REPO}/releases/expanded_assets/{tag}");
    let assets = if let Ok(assets_res) = client
        .get(&assets_url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
    {
        if let Ok(html) = assets_res.text() {
            assets_from_html(&html, &tag)
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let body = fetch_release_notes_from_atom(client, &tag);

    Ok(GithubRelease {
        tag_name: tag.clone(),
        name: Some(format!("Eclipse Studio {tag}")),
        body,
        html_url: final_url,
        assets,
    })
}

// Получение заметок о релизе из Atom-ленты без обращения к GitHub API
fn fetch_release_notes_from_atom(client: &Client, tag: &str) -> Option<String> {
    let resp = client
        .get(RELEASES_ATOM)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .ok()?;
    let text = resp.text().ok()?;
    let tag_needle = format!("/{tag}");

    for entry in text.split("<entry>") {
        if entry.contains(&tag_needle) {
            if let Some(content_start) = entry.find("<content type=\"html\">") {
                let after = &entry[content_start + 21..];
                if let Some(content_end) = after.find("</content>") {
                    let html = &after[..content_end];
                    return Some(unescape_html(html));
                }
            }
        }
    }
    None
}

// Базовое экранирование HTML-сущностей в описании
fn unescape_html(input: &str) -> String {
    input
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// Файлы релиза со страницы expanded_assets вместе с опубликованными SHA-256
fn assets_from_html(html: &str, tag: &str) -> Vec<GithubAsset> {
    core::parse_release_assets(html, REPO, tag)
        .into_iter()
        .map(|asset| GithubAsset {
            name: asset.name,
            browser_download_url: asset.url,
            sha256: asset.sha256,
        })
        .collect()
}

fn core_assets(release: &GithubRelease) -> Option<Vec<core::ReleaseAsset>> {
    Some(
        release
            .assets
            .iter()
            .map(|asset| core::ReleaseAsset {
                name: asset.name.clone(),
                url: asset.browser_download_url.clone(),
                sha256: asset.sha256.clone(),
            })
            .collect(),
    )
}

#[tauri::command]
pub fn updates_page_url() -> String {
    RELEASES_PAGE.into()
}

/// Извлечение семантической версии из названия исполняемого файла приложения
pub fn extract_version_from_filename(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    // Обрабатываем только файлы линейки приложения
    if !lower.contains("eclipse") && !lower.contains("crocodile") {
        return None;
    }

    // Отрезаем расширение файла
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name);

    // Разбиваем по разделителям дефис, подчеркивание, пробел
    for segment in stem.split(['-', '_', ' ']) {
        let trimmed = segment.trim();
        let without_v = trimmed.strip_prefix(['v', 'V']).unwrap_or(trimmed);
        if let Some(parts) = version_parts(without_v) {
            if parts.len() >= 2 {
                return Some(
                    parts
                        .iter()
                        .map(|p| p.to_string())
                        .collect::<Vec<_>>()
                        .join("."),
                );
            }
        }
    }

    None
}

/// Удаление файла с повторными попытками для предотвращения ошибок блокировки в Windows
fn delete_file_with_retry(path: &Path, retries: usize, delay: Duration) -> bool {
    for attempt in 0..retries {
        match fs::remove_file(path) {
            Ok(_) => return true,
            Err(_) => {
                if attempt + 1 < retries {
                    std::thread::sleep(delay);
                }
            }
        }
    }
    false
}

/// Внутренняя функция очистки устаревших версий в указанной директории
pub fn cleanup_old_versions_in_dir(
    dir: &Path,
    current_exe: Option<&Path>,
    current_version: &str,
) -> u32 {
    let current_canonical = current_exe.and_then(|path| path.canonicalize().ok());
    let mut deleted_count = 0;

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        // Ни в коем случае не удаляем текущий запущенный бинарник
        if let Some(exe) = current_exe {
            if path == exe {
                continue;
            }
        }
        if let Some(ref canon) = current_canonical {
            if path.canonicalize().ok().as_ref() == Some(canon) {
                continue;
            }
        }

        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(name) => name,
            None => continue,
        };

        let lower = file_name.to_ascii_lowercase();
        // Этапы обновления внутри программы обрабатывает update_core::cleanup_stale
        if lower.starts_with(core::STAGE_PREFIX) {
            continue;
        }

        // Очистка временных файлов обновлений и загрузок (.download, .part, .tmp)
        let is_temp_update_file = (lower.starts_with(".eclipse-studio")
            || lower.starts_with("eclipse-studio"))
            && (lower.ends_with(".download")
                || lower.ends_with(".part")
                || lower.ends_with(".tmp"));

        if is_temp_update_file {
            if delete_file_with_retry(&path, 5, Duration::from_millis(150)) {
                deleted_count += 1;
            }
            continue;
        }

        // Очистка устаревших исполняемых файлов (.exe)
        if lower.ends_with(".exe") && (lower.contains("eclipse") || lower.contains("crocodile")) {
            if let Some(old_ver) = extract_version_from_filename(file_name) {
                // Удаляем только если текущая версия строго новее найденной
                if is_newer(current_version, &old_ver)
                    && delete_file_with_retry(&path, 5, Duration::from_millis(150))
                {
                    deleted_count += 1;
                }
            }
        }
    }

    deleted_count
}

/// Удаление старых версий и временных загрузок рядом с текущим исполняемым файлом
pub fn cleanup_old_versions() -> u32 {
    let current_exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return 0,
    };

    let app_dir = match current_exe.parent() {
        Some(dir) => dir,
        None => return 0,
    };

    let current_version = env!("CARGO_PKG_VERSION");
    let keep = active_nonce();
    cleanup_old_versions_in_dir(app_dir, Some(&current_exe), current_version)
        + core::cleanup_stale(app_dir, keep.as_deref(), Some(&current_exe))
}

/// Команда Tauri: ручной запуск очистки старых версий приложения
#[tauri::command]
pub async fn cleanup_old_app_versions() -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(cleanup_old_versions)
        .await
        .map_err(|error| format!("Ошибка выполнения очистки: {error}"))
}

// ---------------------------------------------------------------------------
// Обновление внутри программы
// ---------------------------------------------------------------------------

struct Install {
    cancelled: AtomicBool,
    /// После команды go помощнику отмена уже невозможна
    committed: AtomicBool,
    download: Arc<crate::download::Control>,
}

static INSTALL: OnceLock<Mutex<Option<Arc<Install>>>> = OnceLock::new();

fn install_slot() -> &'static Mutex<Option<Arc<Install>>> {
    INSTALL.get_or_init(|| Mutex::new(None))
}

/// Скачивание, проверка и передача замены помощнику; при успехе программа закрывается
#[tauri::command]
pub async fn install_update(app: AppHandle, version: String) -> Result<(), String> {
    let install = Arc::new(Install {
        cancelled: AtomicBool::new(false),
        committed: AtomicBool::new(false),
        download: Arc::new(crate::download::Control::default()),
    });
    {
        let mut slot = install_slot().lock().map_err(|_| "Обновление недоступно")?;
        if slot.is_some() {
            return Err("Обновление уже выполняется.".into());
        }
        *slot = Some(install.clone());
    }
    let worker = install.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || install_blocking(&app, &version, &worker))
            .await
            .map_err(|error| format!("Обновление прервано: {error}"))
            .and_then(|result| result);
    // После передачи помощнику повторный запуск не допускается до выхода программы
    if result.is_err() {
        if let Ok(mut slot) = install_slot().lock() {
            *slot = None;
        }
    }
    result
}

/// Отмена до начала замены EXE
#[tauri::command]
pub fn cancel_update() -> Result<bool, String> {
    let slot = install_slot().lock().map_err(|_| "Обновление недоступно")?;
    let Some(install) = slot.as_ref() else {
        return Ok(false);
    };
    if install.committed.load(Ordering::SeqCst) {
        return Err("Замена EXE уже началась: отмена невозможна.".into());
    }
    install.cancelled.store(true, Ordering::SeqCst);
    install.download.cancelled.store(true, Ordering::SeqCst);
    Ok(true)
}

fn check_cancel(install: &Install) -> Result<(), String> {
    if install.cancelled.load(Ordering::SeqCst) {
        Err(core::CANCELLED.into())
    } else {
        Ok(())
    }
}

/// Папка этапа удаляется при любой ошибке до передачи помощнику
#[cfg(target_os = "windows")]
struct StageGuard {
    stage: PathBuf,
    nonce: String,
    armed: bool,
}

#[cfg(target_os = "windows")]
impl Drop for StageGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let _ = core::signal(&self.stage, core::ABORT, &self.nonce);
        // Помощник мог ещё не выйти: его EXE лежит в папке этапа
        for _ in 0..10 {
            if fs::remove_dir_all(&self.stage).is_ok() || !self.stage.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn install_blocking(_app: &AppHandle, _version: &str, _install: &Install) -> Result<(), String> {
    Err("Обновление внутри программы доступно только в Windows.".into())
}

#[cfg(target_os = "windows")]
fn install_blocking(app: &AppHandle, version: &str, install: &Install) -> Result<(), String> {
    let emit = |progress: UpdateProgress| {
        let _ = app.emit(PROGRESS_EVENT, progress);
    };
    emit(UpdateProgress::phase("preparing"));
    let current = std::env::current_exe()
        .map_err(|error| format!("Не удалось определить путь программы: {error}"))?;
    let target = crate::safe_path::strip_verbatim(fs::canonicalize(&current).unwrap_or(current));
    let directory = target
        .parent()
        .ok_or("Не удалось определить папку программы")?
        .to_path_buf();
    // Сведения о релизе запрашиваются заново: интерфейс мог показать устаревшую версию
    let release = check_for_update_blocking()?;
    if !release.available || !core::same_version(&release.latest_version, version) {
        return Err(format!(
            "Версия {version} больше не предлагается для обновления. Проверьте обновления ещё раз."
        ));
    }
    let (Some(url), Some(sha256)) = (release.asset_url.clone(), release.asset_sha256.clone())
    else {
        return Err(NO_VERIFIED_EXE.into());
    };
    check_cancel(install)?;
    let (stage, nonce) = core::create_stage(&directory)?;
    let mut guard = StageGuard {
        stage: stage.clone(),
        nonce: nonce.clone(),
        armed: true,
    };
    let payload = download_payload(app, &url, &sha256, &stage, install)?;
    check_cancel(install)?;
    emit(UpdateProgress {
        percent: 100,
        ..UpdateProgress::phase("verifying")
    });
    let bytes =
        fs::read(&payload).map_err(|error| format!("Не удалось прочитать обновление: {error}"))?;
    core::verify_payload(&bytes, version)?;
    drop(bytes);
    let new_hash = crate::durable::hash_file(&payload)?;
    if !new_hash.eq_ignore_ascii_case(&sha256) {
        return Err("SHA-256 скачанного EXE не совпадает с опубликованной в релизе.".into());
    }
    check_cancel(install)?;
    emit(UpdateProgress {
        percent: 100,
        ..UpdateProgress::phase("installing")
    });
    crate::durable::copy(&target, &stage.join(core::UPDATER))?;
    let plan = core::Plan {
        schema: core::PLAN_SCHEMA,
        nonce: nonce.clone(),
        target: target.display().to_string(),
        parent_pid: std::process::id(),
        old_hash: crate::durable::hash_file(&target)?,
        new_hash,
        version: version.to_string(),
    };
    let plan_hash = core::write_plan(&stage, &plan)?;
    let mut helper = spawn_helper(&stage, &plan_hash)?;
    let started = Instant::now();
    while !core::has_signal(&stage, core::READY, &nonce) {
        if install.cancelled.load(Ordering::SeqCst) {
            let _ = core::signal(&stage, core::ABORT, &nonce);
            let _ = wait_child(&mut helper, Duration::from_secs(5));
            return Err(core::CANCELLED.into());
        }
        if let Ok(Some(status)) = helper.try_wait() {
            let reason = fs::read_to_string(stage.join(core::LOG))
                .ok()
                .and_then(|log| log.lines().last().map(str::to_string))
                .unwrap_or_else(|| status.to_string());
            return Err(format!("Помощник обновления завершился: {reason}"));
        }
        if started.elapsed() > Duration::from_secs(30) {
            let _ = helper.kill();
            return Err("Помощник обновления не ответил за 30 секунд.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    check_cancel(install)?;
    // Новые операции больше не запускаются; занятые ресурсы отменяют обновление
    let handoff = crate::resource_lock::begin_handoff().map_err(|_| BUSY.to_string())?;
    install.committed.store(true, Ordering::SeqCst);
    emit(UpdateProgress {
        percent: 100,
        ..UpdateProgress::phase("restarting")
    });
    if let Err(error) = core::signal(&stage, core::GO, &nonce) {
        install.committed.store(false, Ordering::SeqCst);
        return Err(error);
    }
    guard.armed = false;
    std::mem::forget(handoff);
    let app = app.clone();
    std::thread::spawn(move || {
        // Окно успевает показать этап перезапуска
        std::thread::sleep(Duration::from_millis(400));
        app.exit(0);
    });
    Ok(())
}

#[cfg(target_os = "windows")]
fn wait_child(child: &mut std::process::Child, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if let Ok(Some(_)) = child.try_wait() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Скачивание с докачкой и повтором: проверенные части сохраняются между попытками
#[cfg(target_os = "windows")]
fn download_payload(
    app: &AppHandle,
    url: &str,
    sha256: &str,
    stage: &Path,
    install: &Install,
) -> Result<PathBuf, String> {
    let last = Mutex::new(Instant::now() - Duration::from_secs(1));
    let progress = |downloaded: u64, total: Option<u64>, _resumable: bool| {
        let total = total.unwrap_or(0);
        let finished = total > 0 && downloaded >= total;
        if let Ok(mut last) = last.lock() {
            if !finished && last.elapsed() < Duration::from_millis(120) {
                return;
            }
            *last = Instant::now();
        }
        let percent = if total > 0 {
            (downloaded.saturating_mul(100) / total).min(100) as u8
        } else {
            0
        };
        let _ = app.emit(
            PROGRESS_EVENT,
            UpdateProgress {
                downloaded,
                total,
                percent,
                ..UpdateProgress::phase("downloading")
            },
        );
    };
    let mut attempt = 1;
    loop {
        match crate::download::fetch(
            url,
            core::PAYLOAD,
            stage,
            Some(sha256),
            &install.download,
            &progress,
        ) {
            Ok(done) => {
                let path = PathBuf::from(done.path);
                let payload = stage.join(core::PAYLOAD);
                if path != payload {
                    fs::rename(&path, &payload)
                        .map_err(|error| format!("Не удалось подготовить обновление: {error}"))?;
                }
                return Ok(payload);
            }
            Err(_) if install.cancelled.load(Ordering::SeqCst) => {
                return Err(core::CANCELLED.into())
            }
            Err(error) if attempt < DOWNLOAD_ATTEMPTS && retryable(&error) => {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    UpdateProgress {
                        // Номер следующей попытки: интерфейс показывает «Попытка N из 3»
                        attempt: attempt + 1,
                        message: error,
                        ..UpdateProgress::phase("retrying")
                    },
                );
                let pause = Instant::now();
                while pause.elapsed() < Duration::from_secs(2 * u64::from(attempt)) {
                    check_cancel(install)?;
                    std::thread::sleep(Duration::from_millis(100));
                }
                attempt += 1;
            }
            Err(error) => return Err(format!("Не удалось скачать обновление: {error}")),
        }
    }
}

/// Сетевые сбои повторяются, а несовпадение контрольной суммы и размера — нет
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn retryable(error: &str) -> bool {
    !["SHA-256", "HTTPS", "лимит", "размер"]
        .iter()
        .any(|marker| error.contains(marker))
}

/// Помощник отделяется от задания процесса программы, чтобы пережить её закрытие
#[cfg(target_os = "windows")]
fn spawn_helper(stage: &Path, plan_hash: &str) -> Result<std::process::Child, String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let exe = stage.join(core::UPDATER);
    let command = |flags: u32| {
        let mut command = std::process::Command::new(&exe);
        command
            .arg(core::HELPER_ARG)
            .arg(stage)
            .arg(plan_hash)
            .current_dir(stage)
            .creation_flags(flags);
        command
    };
    command(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
        .or_else(|_| command(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP).spawn())
        .map_err(|error| format!("Не удалось запустить помощник обновления: {error}"))
}

/// Режим помощника выполняется до запуска Tauri и WebView
pub fn helper_main() -> Option<i32> {
    let args: Vec<String> = std::env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let (stage, hash) = core::helper_request(&args)?;
    let outcome = core::run_helper(&stage, &hash, &core::HelperOptions::default());
    Some(if outcome.success { 0 } else { 1 })
}

enum LaunchContext {
    /// Новая версия подтверждает запуск помощнику
    Probe(PathBuf, String),
    /// Прежняя версия после отката показывает причину
    Failed(PathBuf, String),
}

static LAUNCH: OnceLock<Mutex<Option<LaunchContext>>> = OnceLock::new();
static ACTIVE_NONCE: OnceLock<Option<String>> = OnceLock::new();

/// Разбор аргументов запуска после обновления (вызывается до Tauri)
pub fn init_launch_context() {
    let args: Vec<String> = std::env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let context = match args.as_slice() {
        [_, flag, stage, nonce, ..] if flag == core::PROBE_ARG && core::valid_nonce(nonce) => {
            Some(LaunchContext::Probe(PathBuf::from(stage), nonce.clone()))
        }
        [_, flag, stage, nonce, ..] if flag == core::FAILED_ARG && core::valid_nonce(nonce) => {
            Some(LaunchContext::Failed(PathBuf::from(stage), nonce.clone()))
        }
        _ => None,
    };
    let nonce = context.as_ref().map(|context| match context {
        LaunchContext::Probe(_, nonce) | LaunchContext::Failed(_, nonce) => nonce.clone(),
    });
    let _ = ACTIVE_NONCE.set(nonce);
    let _ = LAUNCH.set(Mutex::new(context));
}

fn active_nonce() -> Option<String> {
    ACTIVE_NONCE.get().cloned().flatten()
}

fn remove_stage_later(stage: PathBuf, nonce: String) {
    std::thread::spawn(move || {
        core::remove_stage_when_done(&stage, &nonce, Duration::from_secs(180));
    });
}

/// Интерфейс загрузился: новая версия подтверждает запуск, прежняя показывает причину отката
#[tauri::command]
pub fn update_launch_ready() -> Option<LaunchOutcome> {
    let context = LAUNCH.get()?.lock().ok()?.take()?;
    let version = env!("CARGO_PKG_VERSION").to_string();
    Some(match context {
        LaunchContext::Probe(stage, nonce) => match core::confirm_probe(&stage, &nonce) {
            Ok(()) => {
                remove_stage_later(stage, nonce);
                LaunchOutcome {
                    success: true,
                    message: format!("Eclipse Studio обновлён до версии {version}."),
                    version,
                }
            }
            Err(error) => LaunchOutcome {
                success: false,
                message: format!("Не удалось подтвердить запуск новой версии: {error}"),
                version,
            },
        },
        LaunchContext::Failed(stage, nonce) => {
            let reason = core::read_outcome(&stage, &nonce)
                .map(|outcome| outcome.message)
                .unwrap_or_else(|| "новая версия не запустилась, восстановлена прежняя.".into());
            remove_stage_later(stage, nonce);
            LaunchOutcome {
                success: false,
                message: format!("Обновление не установлено: {reason}"),
                version,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_semantic_versions() {
        assert!(is_newer("4.0.1", "4.0.0"));
        assert!(is_newer("v4.1.0", "4.0.9"));
        assert!(is_newer("5.0", "4.99.99"));
        assert!(!is_newer("4.0.0", "4.0.0"));
        assert!(!is_newer("4.0.0", "4.0.1"));
    }

    #[test]
    fn ignores_prerelease_suffix_when_comparing() {
        assert!(is_newer("v4.0.1-beta.1", "4.0.0"));
        assert!(!is_newer("v4.0.0-beta.1", "4.0.0"));
    }

    #[test]
    fn selects_setup_and_portable_executables() {
        let release = GithubRelease {
            tag_name: "v4.0.1".into(),
            name: None,
            body: None,
            html_url: "https://example.test/release".into(),
            assets: vec![
                GithubAsset {
                    name: "portable.exe".into(),
                    browser_download_url: "https://example.test/portable.exe".into(),
                    sha256: None,
                },
                GithubAsset {
                    name: "Eclipse Studio_4.0.1_x64-setup.exe".into(),
                    browser_download_url: "https://example.test/setup.exe".into(),
                    sha256: None,
                },
            ],
        };
        assert_eq!(
            installer_url(&release).as_deref(),
            Some("https://example.test/setup.exe")
        );
        assert_eq!(
            portable_url(&release).as_deref(),
            Some("https://example.test/portable.exe")
        );
    }

    #[test]
    fn prefers_canonical_portable_name() {
        let release = GithubRelease {
            tag_name: "v4.0.1".into(),
            name: None,
            body: None,
            html_url: "https://example.test/release".into(),
            assets: vec![
                GithubAsset {
                    name: "alternate.exe".into(),
                    browser_download_url: "https://example.test/alternate.exe".into(),
                    sha256: None,
                },
                GithubAsset {
                    name: "eclipse-studio.exe".into(),
                    browser_download_url: "https://example.test/eclipse-studio.exe".into(),
                    sha256: None,
                },
            ],
        };
        assert_eq!(
            portable_url(&release).as_deref(),
            Some("https://example.test/eclipse-studio.exe")
        );
    }

    #[test]
    fn prefers_latest_eclipse_file() {
        let release = GithubRelease {
            tag_name: "v6.0.0".into(),
            name: None,
            body: None,
            html_url: "https://example.test/release".into(),
            assets: vec![
                GithubAsset {
                    name: "eclipse-v5.exe".into(),
                    browser_download_url: "https://example.test/eclipse-v5.exe".into(),
                    sha256: None,
                },
                GithubAsset {
                    name: "Eclipse.Studio.exe".into(),
                    browser_download_url: "https://example.test/Eclipse.Studio.exe".into(),
                    sha256: None,
                },
            ],
        };
        assert_eq!(
            portable_url(&release).as_deref(),
            Some("https://example.test/Eclipse.Studio.exe")
        );
    }

    #[test]
    fn selects_any_eclipse_file() {
        let release = GithubRelease {
            tag_name: "v6.0.0".into(),
            name: None,
            body: None,
            html_url: "https://example.test/release".into(),
            assets: vec![
                GithubAsset {
                    name: "random-tool.exe".into(),
                    browser_download_url: "https://example.test/random-tool.exe".into(),
                    sha256: None,
                },
                GithubAsset {
                    name: "Eclipse.zip".into(),
                    browser_download_url: "https://example.test/Eclipse.zip".into(),
                    sha256: None,
                },
            ],
        };
        assert_eq!(
            portable_url(&release).as_deref(),
            Some("https://example.test/Eclipse.zip")
        );
    }

    #[test]
    fn extracts_version_from_various_executable_names() {
        assert_eq!(
            extract_version_from_filename("Eclipse-Studio-v6.6.6.exe").as_deref(),
            Some("6.6.6")
        );
        assert_eq!(
            extract_version_from_filename("Eclipse-Studio-6.6.5.exe").as_deref(),
            Some("6.6.5")
        );
        assert_eq!(
            extract_version_from_filename("Eclipse_Studio_v6.6.7-setup.exe").as_deref(),
            Some("6.6.7")
        );
        assert_eq!(
            extract_version_from_filename("crocodile-gena-studio-v4.0.0.exe").as_deref(),
            Some("4.0.0")
        );
        assert_eq!(
            extract_version_from_filename("RandomProgram-v1.2.3.exe"),
            None
        );
    }

    #[test]
    fn cleans_up_older_versions_and_temp_files_safely() {
        let temp_dir =
            std::env::temp_dir().join(format!("cgs_test_cleanup_{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);

        let old_exe = temp_dir.join("Eclipse-Studio-v6.6.0.exe");
        let current_exe = temp_dir.join("Eclipse-Studio-v6.6.7.exe");
        let future_exe = temp_dir.join("Eclipse-Studio-v6.7.0.exe");
        let temp_download = temp_dir.join(".Eclipse-Studio-v6.6.8.exe.download");
        let foreign_file = temp_dir.join("user_config.ini");

        fs::write(&old_exe, b"old").unwrap();
        fs::write(&current_exe, b"current").unwrap();
        fs::write(&future_exe, b"future").unwrap();
        fs::write(&temp_download, b"partial").unwrap();
        fs::write(&foreign_file, b"data").unwrap();

        // Запускаем очистку для текущей версии 6.6.7
        let deleted = cleanup_old_versions_in_dir(&temp_dir, Some(&current_exe), "6.6.7");

        // Должны удалиться: старая версия (6.6.0) и временный файл (.download)
        assert_eq!(deleted, 2);
        assert!(!old_exe.exists(), "Старая версия должна быть удалена");
        assert!(
            !temp_download.exists(),
            "Временный файл загрузки должен быть удален"
        );
        assert!(
            current_exe.exists(),
            "Текущая запущенная версия не должна удаляться"
        );
        assert!(
            future_exe.exists(),
            "Более новая версия не должна удаляться"
        );
        assert!(
            foreign_file.exists(),
            "Посторонние пользовательские файлы не должны удаляться"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
