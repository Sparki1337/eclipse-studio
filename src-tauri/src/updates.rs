use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

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
}
