//! Обновление библиотек OpenSteamTool через статический фид croclua-dll-feed.
use crate::lua_loader::{self, read_optional, reject_link, STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

const FEED: &str =
    "https://raw.githubusercontent.com/LeoBanned/crocodile-gena-studio-releases/croclua-dll-feed/";
pub(crate) const CACHE: &str = "config/cgs-luatools-online";
pub(crate) const MAX_DLL: u64 = 16 * 1024 * 1024;
const MAX_ZIP: u64 = 3 * MAX_DLL + 65536;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub revision: u32,
    pub sha256: String,
    pub files: BTreeMap<String, String>,
}

pub(crate) struct Package {
    pub manifest: Manifest,
    pub files: BTreeMap<String, Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub bytes: Option<usize>,
    pub current_bytes: Option<usize>,
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariantInfo {
    variant: String,
    available: bool,
    update_available: bool,
    status: String,
    files: Vec<FileInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    commit: String,
    selected_variant: String,
    update_available: bool,
    variants: Vec<VariantInfo>,
}

pub(crate) fn embedded_revision() -> u32 {
    include_str!("../resources/opensteamtool/loader-revision.txt")
        .trim()
        .parse()
        .expect("встроенная ревизия DLL")
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_valid_pe_dll(bytes: &[u8]) -> bool {
    if bytes.len() < 1024 || bytes.len() as u64 > MAX_DLL || !bytes.starts_with(b"MZ") {
        return false;
    }
    let Some(offset) = bytes
        .get(60..64)
        .map(|slice| u32::from_le_bytes(slice.try_into().unwrap()) as usize)
    else {
        return false;
    };
    let Some(header) = offset
        .checked_add(24)
        .and_then(|end| bytes.get(offset..end))
    else {
        return false;
    };
    header.starts_with(b"PE\0\0") && header[23] & 0x20 != 0
}

fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let valid_hash = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if manifest.revision == 0
        || !valid_hash(&manifest.sha256)
        || manifest.files.len() != STANDARD.len()
        || !STANDARD
            .iter()
            .all(|(name, _)| manifest.files.get(*name).is_some_and(|v| valid_hash(v)))
    {
        return Err("Некорректный список файлов обновления DLL".into());
    }
    Ok(manifest)
}

fn verify_package(manifest: Manifest, files: BTreeMap<String, Vec<u8>>) -> Result<Package, String> {
    for (name, bytes) in &files {
        if !is_valid_pe_dll(bytes) || manifest.files.get(name) != Some(&sha256_hex(bytes)) {
            return Err(format!("Проверка DLL не пройдена: {name}"));
        }
    }
    Ok(Package { manifest, files })
}

pub(crate) fn cached(steam: &Path) -> Result<Option<Package>, String> {
    reject_link(&steam.join("config"))?;
    let root = steam.join(CACHE);
    let Some(bytes) = read_optional(&root.join("latest.json"))? else {
        return Ok(None);
    };
    let manifest = parse_manifest(&bytes)?;
    if manifest.revision <= embedded_revision() {
        return Ok(None);
    }
    let mut files = BTreeMap::new();
    for name in manifest.files.keys() {
        let bytes = read_optional(&root.join(name))?
            .ok_or("В кэше отсутствует DLL. Повторите обновление.")?;
        files.insert(name.clone(), bytes);
    }
    verify_package(manifest, files).map(Some)
}

fn fetch(client: &reqwest::blocking::Client, name: &str, max: u64) -> Result<Vec<u8>, String> {
    let response = client.get(format!("{FEED}{name}")).send().map_err(|_| {
        "Не удалось подключиться к GitHub. Установленные DLL не изменены.".to_string()
    })?;
    if matches!(response.status().as_u16(), 403 | 429) {
        return Err("GitHub временно ограничил частоту запросов. Повторите попытку позже.".into());
    }
    let response = response.error_for_status().map_err(|e| {
        format!("Ошибка загрузки обновления DLL с GitHub: {e}. Установленные DLL не изменены.")
    })?;
    if response.content_length().is_some_and(|n| n > max) {
        return Err("Размер файла обновления превышает допустимый".into());
    }
    let mut bytes = Vec::new();
    response
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max {
        return Err("Размер файла обновления превышает допустимый".into());
    }
    Ok(bytes)
}

fn unpack(manifest: Manifest, bytes: Vec<u8>) -> Result<Package, String> {
    if sha256_hex(&bytes) != manifest.sha256 {
        return Err("SHA-256 архива DLL не совпадает".into());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    if zip.len() != manifest.files.len() {
        return Err("Неожиданное содержимое архива DLL".into());
    }
    let mut files = BTreeMap::new();
    for name in manifest.files.keys() {
        let file = zip.by_name(name).map_err(|e| e.to_string())?;
        let mut dll = Vec::new();
        file.take(MAX_DLL + 1)
            .read_to_end(&mut dll)
            .map_err(|e| e.to_string())?;
        files.insert(name.clone(), dll);
    }
    verify_package(manifest, files)
}

fn client() -> Result<&'static reqwest::blocking::Client, String> {
    crate::http_pool::no_redirect_client()
}

fn fetch_manifest(client: &reqwest::blocking::Client) -> Result<Manifest, String> {
    let minute = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 60;
    parse_manifest(&fetch(
        client,
        &format!("latest.json?check={minute}"),
        16384,
    )?)
}

#[derive(Default)]
struct RevisionCheck {
    last: Option<(Instant, Result<Manifest, String>)>,
}

static REVISION_CHECK: Mutex<RevisionCheck> = Mutex::new(RevisionCheck { last: None });

pub(crate) fn latest_manifest(force: bool) -> Result<Manifest, String> {
    let mut cache = REVISION_CHECK.lock().map_err(|error| error.to_string())?;
    if let Some((checked, result)) = &cache.last {
        let ttl = if force {
            3
        } else if result.is_ok() {
            60
        } else {
            15
        };
        if checked.elapsed() < Duration::from_secs(ttl) {
            return result.clone();
        }
    }
    let result = client().and_then(fetch_manifest);
    cache.last = Some((Instant::now(), result.clone()));
    result
}

pub(crate) fn download(current: u32) -> Result<Option<Package>, String> {
    let client = client()?;
    let manifest = fetch_manifest(client)?;
    if manifest.revision <= current {
        return Ok(None);
    }
    let archive = fetch(client, &format!("dll-{}.zip", manifest.revision), MAX_ZIP)?;
    unpack(manifest, archive).map(Some)
}

fn build_update_info(steam: &Path, remote: Option<&Manifest>) -> Result<UpdateInfo, String> {
    let selected = lua_loader::selected_variant(steam).unwrap_or_else(|_| "standard".into());
    let cached_pkg = cached(steam)?;
    let local_revision = cached_pkg
        .as_ref()
        .map_or_else(embedded_revision, |pkg| pkg.manifest.revision);
    let remote_newer = remote.filter(|m| m.revision > local_revision);

    let local_files: BTreeMap<&str, &[u8]> = if let Some(ref pkg) = cached_pkg {
        pkg.files
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_slice()))
            .collect()
    } else {
        STANDARD.iter().copied().collect()
    };

    let mut variants = Vec::new();
    for variant in ["standard", "compatibility"] {
        let mut info = Vec::new();
        let mut current = true;
        for &(name, _) in STANDARD {
            let target = if variant == "compatibility" && name == "dwmapi.dll" {
                "bin/dwmapi.dll".to_string()
            } else {
                name.to_string()
            };
            let (expected_hash, expected_bytes) = if let Some(manifest) = remote_newer {
                (manifest.files[name].clone(), None)
            } else {
                let bytes = local_files[name];
                (sha256_hex(bytes), Some(bytes.len()))
            };

            let local_data = read_optional(&steam.join(&target))?;
            let local_size = local_data.as_ref().map(|b| b.len());
            let state = if variant != selected {
                "available"
            } else {
                match local_data {
                    Some(bytes) if sha256_hex(&bytes) == expected_hash => "current",
                    Some(_) => {
                        current = false;
                        "changed"
                    }
                    None => {
                        current = false;
                        "missing"
                    }
                }
            };

            info.push(FileInfo {
                path: target,
                bytes: expected_bytes,
                current_bytes: local_size,
                status: state.into(),
            });
        }
        let state = if variant != selected {
            "not_installed"
        } else if current {
            "current"
        } else {
            "update"
        };
        variants.push(VariantInfo {
            variant: variant.into(),
            available: true,
            update_available: state == "update",
            status: state.into(),
            files: info,
        });
    }

    let update_available = variants
        .iter()
        .any(|v| v.variant == selected && v.update_available);
    let revision_tag = remote_newer.map(|m| m.revision).unwrap_or(local_revision);

    Ok(UpdateInfo {
        commit: format!("rev-{revision_tag}"),
        selected_variant: selected,
        update_available,
        variants,
    })
}

#[tauri::command]
pub async fn luatools_check_loader_updates(
    steam_path: Option<String>,
    force: Option<bool>,
) -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let steam = lua_loader::resolve(steam_path)?;
        let remote = latest_manifest(force.unwrap_or(false))?;
        build_update_info(&steam, Some(&remote))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fake_dll(marker: u8) -> Vec<u8> {
        let mut data = vec![0_u8; 2048];
        data[0..2].copy_from_slice(b"MZ");
        data[60..64].copy_from_slice(&0x80_u32.to_le_bytes());
        data[0x80..0x84].copy_from_slice(b"PE\0\0");
        // Флаг IMAGE_FILE_DLL (0x2000) в старшем байте Characteristics
        data[0x80 + 23] = 0x20;
        data[1024] = marker;
        data
    }

    fn make_zip_and_manifest(revision: u32, files: &[(&str, &[u8])]) -> (Vec<u8>, Manifest) {
        let mut buffer = Cursor::new(Vec::new());
        let mut hashes = BTreeMap::new();
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            for &(name, bytes) in files {
                zip.start_file(name, options).unwrap();
                zip.write_all(bytes).unwrap();
                hashes.insert(name.to_string(), sha256_hex(bytes));
            }
            zip.finish().unwrap();
        }
        let zip_bytes = buffer.into_inner();
        let manifest = Manifest {
            revision,
            sha256: sha256_hex(&zip_bytes),
            files: hashes,
        };
        (zip_bytes, manifest)
    }

    #[test]
    fn unpacks_and_verifies_valid_package() {
        let a = fake_dll(1);
        let b = fake_dll(2);
        let c = fake_dll(3);
        let (zip_bytes, manifest) = make_zip_and_manifest(
            99,
            &[
                ("OpenSteamTool.dll", &a),
                ("dwmapi.dll", &b),
                ("xinput1_4.dll", &c),
            ],
        );
        let package = unpack(manifest, zip_bytes).unwrap();
        assert_eq!(package.manifest.revision, 99);
        assert_eq!(package.files["OpenSteamTool.dll"], a);
    }

    #[test]
    fn rejects_invalid_pe_and_corrupted_hashes() {
        assert!(!is_valid_pe_dll(b"<html>error</html>"));
        assert!(!is_valid_pe_dll(&vec![0x4d; 2048]));

        let a = fake_dll(1);
        let b = fake_dll(2);
        let c = fake_dll(3);
        let (mut zip_bytes, mut manifest) = make_zip_and_manifest(
            99,
            &[
                ("OpenSteamTool.dll", &a),
                ("dwmapi.dll", &b),
                ("xinput1_4.dll", &c),
            ],
        );
        zip_bytes[0] ^= 0xff;
        assert!(unpack(manifest.clone(), zip_bytes).is_err());

        manifest.revision = 0;
        assert!(parse_manifest(&serde_json::to_vec(&manifest).unwrap()).is_err());
    }

    #[test]
    fn build_update_info_detects_remote_and_local_state() {
        let dir = tempfile::tempdir().unwrap();
        let steam = dir.path();
        std::fs::write(steam.join("steam.exe"), []).unwrap();
        for &(name, bytes) in STANDARD {
            std::fs::write(steam.join(name), bytes).unwrap();
        }

        let current_info = build_update_info(steam, None).unwrap();
        assert!(!current_info.update_available);
        assert_eq!(current_info.selected_variant, "standard");

        let newer = Manifest {
            revision: embedded_revision() + 1,
            sha256: "a".repeat(64),
            files: STANDARD
                .iter()
                .map(|(name, _)| ((*name).to_string(), "b".repeat(64)))
                .collect(),
        };
        let remote_info = build_update_info(steam, Some(&newer)).unwrap();
        assert!(remote_info.update_available);
        assert_eq!(
            remote_info.commit,
            format!("rev-{}", embedded_revision() + 1)
        );
    }
}
