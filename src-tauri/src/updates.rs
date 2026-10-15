use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/Sparki1337/eclipse-studio/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/Sparki1337/eclipse-studio/releases";
const USER_AGENT: &str = "Eclipse-Studio-Update-Checker";

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
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
}

/// Данные о прогрессе скачивания обновления для передачи в веб-интерфейс
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressPayload {
    pub percentage: u8,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub status: String,
    pub completed: bool,
}

/// Результат успешной загрузки обновления в локальную папку программы
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadResult {
    pub file_path: String,
    pub file_name: String,
    pub version: String,
    pub ready_to_install: bool,
}

fn version_parts(version: &str) -> Option<Vec<u64>> {
    let clean = version
        .trim()
        .trim_start_matches(|character: char| character == 'v' || character == 'V')
        .split_once('-')
        .map(|(base, _)| base)
        .unwrap_or_else(|| {
            version
                .trim()
                .trim_start_matches(|character: char| character == 'v' || character == 'V')
        });
    let parts = clean
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (!parts.is_empty()).then_some(parts)
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (Some(mut latest), Some(mut current)) = (version_parts(latest), version_parts(current))
    else {
        return false;
    };
    let length = latest.len().max(current.len());
    latest.resize(length, 0);
    current.resize(length, 0);
    latest > current
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
            name.contains("eclipse") && name.ends_with(".exe") && !name.contains("setup") && !name.contains("installer")
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

    let release = match client
        .get(LATEST_RELEASE_API)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
    {
        Ok(response) if response.status().is_success() => {
            response.json::<GithubRelease>().map_err(|error| {
                format!("GitHub вернул некорректный ответ: {error}")
            })?
        }
        Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => {
            return Err("В репозитории пока нет опубликованных релизов".into());
        }
        _ => check_for_update_via_web(&client)?,
    };

    let latest = release
        .tag_name
        .trim()
        .trim_start_matches(|character: char| character == 'v' || character == 'V')
        .to_string();
    if version_parts(&latest).is_none() {
        return Err(format!(
            "У последнего релиза некорректный номер версии: {}",
            release.tag_name
        ));
    }

    Ok(UpdateInfo {
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

    let assets_url = format!("https://github.com/Sparki1337/eclipse-studio/releases/expanded_assets/{tag}");
    let assets = if let Ok(assets_res) = client.get(&assets_url).header(reqwest::header::USER_AGENT, USER_AGENT).send() {
        if let Ok(html) = assets_res.text() {
            extract_assets_from_html(&html, &tag)
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    Ok(GithubRelease {
        tag_name: tag.clone(),
        name: Some(format!("Eclipse Studio {tag}")),
        body: None,
        html_url: final_url,
        assets,
    })
}

fn extract_assets_from_html(html: &str, tag: &str) -> Vec<GithubAsset> {
    let prefix = format!("/Sparki1337/eclipse-studio/releases/download/{tag}/");
    let mut assets = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for part in html.split("href=\"") {
        if let Some(url_part) = part.split('"').next() {
            if let Some(file_name) = url_part.strip_prefix(&prefix) {
                let clean_name = file_name.split('?').next().unwrap_or(file_name).trim();
                if !clean_name.is_empty() && seen.insert(clean_name.to_string()) {
                    assets.push(GithubAsset {
                        name: clean_name.to_string(),
                        browser_download_url: format!("https://github.com{prefix}{clean_name}"),
                    });
                }
            }
        }
    }
    assets
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

        // 1. Очистка временных файлов обновлений и загрузок (.download, .part, .tmp)
        let is_temp_update_file = (lower.starts_with(".eclipse-studio") || lower.starts_with("eclipse-studio"))
            && (lower.ends_with(".download") || lower.ends_with(".part") || lower.ends_with(".tmp"));

        if is_temp_update_file {
            if delete_file_with_retry(&path, 5, Duration::from_millis(150)) {
                deleted_count += 1;
            }
            continue;
        }

        // 2. Очистка устаревших исполняемых файлов (.exe)
        if lower.ends_with(".exe") && (lower.contains("eclipse") || lower.contains("crocodile")) {
            if let Some(old_ver) = extract_version_from_filename(file_name) {
                // Удаляем только если текущая версия строго новее найденной
                if is_newer(current_version, &old_ver) {
                    if delete_file_with_retry(&path, 5, Duration::from_millis(150)) {
                        deleted_count += 1;
                    }
                }
            }
        }
    }

    deleted_count
}

/// Очистка старых версий приложения и временных файлов загрузки вокруг текущего исполняемого файла.
/// Возвращает количество успешно удаленных устаревших файлов.
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
    cleanup_old_versions_in_dir(app_dir, Some(&current_exe), current_version)
}

/// Команда Tauri: ручной запуск очистки старых версий приложения
#[tauri::command]
pub async fn cleanup_old_app_versions() -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(cleanup_old_versions)
        .await
        .map_err(|error| format!("Ошибка выполнения очистки: {error}"))
}

/// Скачивание новой портативной версии приложения в папку текущего исполняемого файла
#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    download_url: Option<String>,
    version: Option<String>,
) -> Result<UpdateDownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        download_app_update_blocking(&app, download_url.as_deref(), version.as_deref())
    })
    .await
    .map_err(|error| format!("Загрузка обновления прервана: {error}"))?
}

fn download_app_update_blocking(
    app: &AppHandle,
    provided_url: Option<&str>,
    provided_version: Option<&str>,
) -> Result<UpdateDownloadResult, String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("Не удалось определить путь текущего файла: {error}"))?;
    let app_dir = current_exe
        .parent()
        .ok_or_else(|| "Не удалось определить каталог приложения".to_string())?;

    // Получаем URL для скачивания и версию (из аргументов или через проверку релизов)
    let (url, target_version) = if let (Some(u), Some(v)) = (provided_url, provided_version) {
        (u.to_string(), v.to_string())
    } else {
        let update_info = check_for_update_blocking()?;
        let portable = update_info
            .portable_url
            .ok_or_else(|| "Для новой версии не найдена ссылка на портативный EXE-файл".to_string())?;
        (portable, update_info.latest_version)
    };

    if !url.starts_with("https://") {
        return Err("Разрешены только безопасные HTTPS-ссылки для обновления".into());
    }

    let target_filename = format!("Eclipse-Studio-v{target_version}.exe");
    let target_path = app_dir.join(&target_filename);
    let temp_filename = format!(".{target_filename}.download");
    let temp_path = app_dir.join(&temp_filename);

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("Не удалось инициализировать HTTP-клиент: {error}"))?;

    let mut response = client
        .get(&url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Не удалось начать загрузку обновления: {error}"))?;

    let total_bytes = response.content_length().unwrap_or(0);
    let mut file = fs::File::create(&temp_path)
        .map_err(|error| format!("Не удалось создать временный файл обновления: {error}"))?;

    let mut downloaded_bytes: u64 = 0;
    let mut buffer = [0u8; 64 * 1024];
    let start_time = Instant::now();
    let mut last_emit = Instant::now();

    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("Ошибка чтения данных обновления: {error}"))?;
        if read == 0 {
            break;
        }

        file.write_all(&buffer[..read])
            .map_err(|error| format!("Ошибка записи данных обновления: {error}"))?;

        downloaded_bytes += read as u64;

        if last_emit.elapsed() >= Duration::from_millis(150) || (total_bytes > 0 && downloaded_bytes >= total_bytes) {
            let elapsed_secs = start_time.elapsed().as_secs_f64().max(0.001);
            let speed = (downloaded_bytes as f64 / elapsed_secs) as u64;
            let percentage = if total_bytes > 0 {
                ((downloaded_bytes as f64 / total_bytes as f64) * 100.0).min(99.0) as u8
            } else {
                0
            };

            let _ = app.emit(
                "app-update-progress",
                UpdateProgressPayload {
                    percentage,
                    downloaded_bytes,
                    total_bytes,
                    speed_bytes_per_sec: speed,
                    status: "Скачивание…".into(),
                    completed: false,
                },
            );
            last_emit = Instant::now();
        }
    }

    file.flush()
        .map_err(|error| format!("Не удалось завершить запись файла: {error}"))?;
    drop(file);

    // Удаляем предыдущий файл с таким же именем, если он существовал
    if target_path.exists() {
        let _ = delete_file_with_retry(&target_path, 3, Duration::from_millis(200));
    }

    fs::rename(&temp_path, &target_path)
        .map_err(|error| format!("Не удалось сохранить скачанное обновление: {error}"))?;

    // Финальное оповещение о 100% завершении
    let _ = app.emit(
        "app-update-progress",
        UpdateProgressPayload {
            percentage: 100,
            downloaded_bytes,
            total_bytes: downloaded_bytes,
            speed_bytes_per_sec: 0,
            status: "Готово к запуску".into(),
            completed: true,
        },
    );

    Ok(UpdateDownloadResult {
        file_path: target_path.display().to_string(),
        file_name: target_filename,
        version: target_version,
        ready_to_install: true,
    })
}

/// Запуск скачанной новой версии приложения и немедленное завершение текущего процесса
#[tauri::command]
pub fn launch_app_update(file_path: String) -> Result<(), String> {
    let target = PathBuf::from(&file_path);
    if !target.is_file() {
        return Err(format!("Файл обновления не найден: {file_path}"));
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new(&target);
        if let Some(parent) = target.parent() {
            cmd.current_dir(parent);
        }
        cmd.spawn()
            .map_err(|error| format!("Не удалось запустить обновленную версию: {error}"))?;

        // Завершаем текущий процесс приложения, освобождая дескриптор исполняемого файла
        std::process::exit(0);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = std::process::Command::new(&target);
        if let Some(parent) = target.parent() {
            cmd.current_dir(parent);
        }
        cmd.spawn()
            .map_err(|error| format!("Не удалось запустить обновленную версию: {error}"))?;
        std::process::exit(0);
    }
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
                },
                GithubAsset {
                    name: "Eclipse Studio_4.0.1_x64-setup.exe".into(),
                    browser_download_url: "https://example.test/setup.exe".into(),
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
                },
                GithubAsset {
                    name: "eclipse-studio.exe".into(),
                    browser_download_url: "https://example.test/eclipse-studio.exe".into(),
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
                },
                GithubAsset {
                    name: "Eclipse.Studio.exe".into(),
                    browser_download_url: "https://example.test/Eclipse.Studio.exe".into(),
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
                },
                GithubAsset {
                    name: "Eclipse.zip".into(),
                    browser_download_url: "https://example.test/Eclipse.zip".into(),
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
        let temp_dir = std::env::temp_dir().join(format!("cgs_test_cleanup_{}", std::process::id()));
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
        assert!(!temp_download.exists(), "Временный файл загрузки должен быть удален");
        assert!(current_exe.exists(), "Текущая запущенная версия не должна удаляться");
        assert!(future_exe.exists(), "Более новая версия не должна удаляться");
        assert!(foreign_file.exists(), "Посторонние пользовательские файлы не должны удаляться");

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
