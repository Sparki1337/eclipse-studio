//! Загрузчик OpenSteamTool: единый встроенный комплект DLL, кэш обновлений и проверка хешей.
use crate::{
    loader_updates::{self, Package, CACHE, MAX_DLL},
    luatools,
    models::OperationResult,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub(crate) const STANDARD: &[(&str, &[u8])] = &[
    (
        "OpenSteamTool.dll",
        include_bytes!("../resources/opensteamtool/OpenSteamTool.dll"),
    ),
    (
        "dwmapi.dll",
        include_bytes!("../resources/opensteamtool/dwmapi.dll"),
    ),
    (
        "xinput1_4.dll",
        include_bytes!("../resources/opensteamtool/xinput1_4.dll"),
    ),
];

pub(crate) struct Bundle {
    pub variant: String,
    pub files: BTreeMap<String, Vec<u8>>,
}

const SELECTION: &str = "config/cgs-luatools-loader.json";

static INSTALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Selection {
    pub(crate) schema: u32,
    pub(crate) variant: String,
    pub(crate) hashes: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderInfo {
    steam_path: String,
    selected_variant: String,
    pinned: bool,
    current: bool,
    issue: Option<String>,
}

fn canonical_variant(variant: &str) -> Result<&'static str, String> {
    match variant {
        "standard" | "v1" => Ok("standard"),
        "compatibility" | "v2" | "desktop" => Ok("compatibility"),
        _ => Err("Неизвестная версия загрузчика".into()),
    }
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn validate_layout(
    variant: &str,
    schema: u32,
    paths: &BTreeMap<String, String>,
) -> Result<(), String> {
    let canonical = canonical_variant(variant)?;
    if paths.len() != 3
        || !paths.contains_key("OpenSteamTool.dll")
        || !paths.contains_key("xinput1_4.dll")
    {
        return Err("Неполный комплект DLL".into());
    }
    // Схема 2 хранит точные пути библиотек, включая bin/dwmapi.dll
    let valid = match (schema, canonical) {
        (1, _) => paths.contains_key("dwmapi.dll"),
        (2, "compatibility") => paths.contains_key("bin/dwmapi.dll"),
        (2, "standard") => paths.contains_key("dwmapi.dll") || paths.contains_key("version.dll"),
        _ => false,
    };
    if !valid {
        return Err("Неподдерживаемые пути DLL".into());
    }
    Ok(())
}

fn bundle_selection(bundle: &Bundle) -> Result<Selection, String> {
    let canonical = canonical_variant(&bundle.variant)?;
    let selection = Selection {
        schema: 2,
        variant: canonical.to_string(),
        hashes: bundle
            .files
            .iter()
            .map(|(p, b)| (p.clone(), hash(b)))
            .collect(),
    };
    validate_layout(&selection.variant, 2, &selection.hashes)?;
    Ok(selection)
}

pub(crate) fn embedded_bundle(variant: &str, schema: u32) -> Result<Bundle, String> {
    let canonical = canonical_variant(variant)?;
    Ok(Bundle {
        variant: canonical.into(),
        files: STANDARD
            .iter()
            .map(|(name, b)| {
                let target = if schema == 2 && canonical == "compatibility" && *name == "dwmapi.dll"
                {
                    "bin/dwmapi.dll"
                } else {
                    *name
                };
                (target.into(), b.to_vec())
            })
            .collect(),
    })
}

fn available_bundle(variant: &str, package: Option<&Package>) -> Result<Bundle, String> {
    let mut bundle = embedded_bundle(variant, 2)?;
    if let Some(package) = package {
        for (path, bytes) in &mut bundle.files {
            let name = path.rsplit('/').next().unwrap_or(path);
            if let Some(updated) = package.files.get(name) {
                *bytes = updated.clone();
            }
        }
    }
    Ok(bundle)
}

// Проверка на символические ссылки и точки повторной обработки
pub(crate) fn reject_link(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        let mut link = metadata.file_type().is_symlink();
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            link |= metadata.file_attributes() & 0x400 != 0;
        }
        if link {
            return Err(format!(
                "Проверка DLL отменена: {} является ссылкой.",
                path.display()
            ));
        }
    }
    Ok(())
}

// Безопасное чтение файла с проверкой размера и отсутствия ссылок
pub(crate) fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    reject_link(path)?;
    if let Some(parent) = path.parent() {
        reject_link(parent)?;
    }
    if fs::metadata(path).is_ok_and(|m| m.len() > MAX_DLL) {
        return Err(format!("Слишком большой файл: {}", path.display()));
    }
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "Не удалось прочитать {}: {e}. Закройте Steam и повторите.",
            path.display()
        )),
    }
}

fn parse_selection(bytes: &[u8]) -> Result<Selection, String> {
    if bytes.len() > 16384 {
        return Err("Слишком большой файл выбора DLL".into());
    }
    let value: Selection = serde_json::from_slice(bytes)
        .map_err(|_| "Файл выбора DLL повреждён. Нажмите «Обновить DLL».")?;
    validate_layout(&value.variant, value.schema, &value.hashes)?;
    if value.hashes.values().any(|h| {
        h.len() != 64
            || !h
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    }) {
        return Err("Некорректный отпечаток закреплённой DLL".into());
    }
    Ok(value)
}

pub(crate) fn read_selection(steam: &Path) -> Result<Option<Selection>, String> {
    reject_link(&steam.join("config"))?;
    read_optional(&steam.join(SELECTION))?
        .map(|b| parse_selection(&b))
        .transpose()
}

fn detect_variant(steam: &Path) -> Result<&'static str, String> {
    if read_optional(&steam.join("bin/dwmapi.dll"))?.is_some() {
        return Ok("compatibility");
    }
    Ok("standard")
}

pub(crate) fn selected_variant(steam: &Path) -> Result<String, String> {
    match read_selection(steam)? {
        Some(s) => Ok(canonical_variant(&s.variant)?.into()),
        None => Ok(detect_variant(steam)?.into()),
    }
}

fn matches_selection(steam: &Path, selection: &Selection) -> Result<bool, String> {
    let mut current = true;
    for (path, expected) in &selection.hashes {
        current &= read_optional(&steam.join(path))?.is_some_and(|b| hash(&b) == *expected);
    }
    Ok(current)
}

// Захват файловой межпроцессной блокировки
pub(crate) fn acquire_file_lock(steam: &Path) -> Result<fs::File, String> {
    reject_link(&steam.join("config"))?;
    fs::create_dir_all(steam.join("config")).map_err(|e| e.to_string())?;
    let path = steam.join("config/cgs-luatools-loader.lock");
    reject_link(&path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options
        .open(path)
        .map_err(|_| "Загрузчик занят другой операцией или плагином. Повторите позже.".into())
}

fn apply_selection(
    steam: &Path,
    selection: Selection,
    bundle: Bundle,
    manual: bool,
    downloaded: Option<&Package>,
) -> Result<bool, String> {
    validate_layout(&selection.variant, selection.schema, &selection.hashes)?;
    let current = matches_selection(steam, &selection)?;
    let previous = read_selection(steam).ok().flatten();
    let config = if manual && current {
        None
    } else {
        let bytes = read_optional(&steam.join("opensteamtool.toml"))?.unwrap_or_default();
        let content =
            String::from_utf8(bytes).map_err(|_| "opensteamtool.toml должен быть UTF-8")?;
        Some(luatools::configure_lua_folder(
            content.trim_start_matches('\u{feff}'),
        )?)
    };

    let mut owned = BTreeMap::new();
    if let Some(old) = previous {
        owned = old.hashes;
    } else {
        // Подхватываем только известные прокси прошлых установок, чтобы корректно убрать старый путь при смене режима
        for name in ["dwmapi.dll", "version.dll", "bin/dwmapi.dll"] {
            if let Some(bytes) = read_optional(&steam.join(name))? {
                if STANDARD.iter().any(|(_, b)| **b == bytes) {
                    owned.insert(name.into(), hash(&bytes));
                }
            }
        }
    }

    let mut changes: BTreeMap<String, Option<Vec<u8>>> = BTreeMap::new();
    if !current {
        for (path, bytes) in &bundle.files {
            changes.insert(path.clone(), Some(bytes.clone()));
        }
    }
    for (path, expected) in &owned {
        if !selection.hashes.contains_key(path) {
            if let Some(bytes) = read_optional(&steam.join(path))? {
                if hash(&bytes) != *expected {
                    return Err(format!(
                        "Прежняя DLL {path} изменена извне. Удаление отменено; файлы не заменены."
                    ));
                }
                changes.insert(path.clone(), None);
            }
        }
    }
    if let Some(config) = &config {
        fs::create_dir_all(luatools::stplugin_dir(steam)).map_err(|e| e.to_string())?;
        changes.insert(
            "opensteamtool.toml".into(),
            Some(config.as_bytes().to_vec()),
        );
    }
    if let Some(package) = downloaded {
        for (name, bytes) in &package.files {
            changes.insert(format!("{CACHE}/{name}"), Some(bytes.clone()));
        }
        changes.insert(
            format!("{CACHE}/latest.json"),
            Some(serde_json::to_vec(&package.manifest).map_err(|e| e.to_string())?),
        );
    }

    // Маркер пишется последним: при сбое подмены файлов режим не переключится
    let marker = read_optional(&steam.join(SELECTION))?;
    let marker_changed = marker
        .as_deref()
        .and_then(|b| parse_selection(b).ok())
        .as_ref()
        != Some(&selection);
    let marker_bytes = serde_json::to_vec_pretty(&selection).map_err(|e| e.to_string())?;
    let mut plan: Vec<_> = changes
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_deref()))
        .collect();
    if marker_changed {
        plan.push((SELECTION, Some(marker_bytes.as_slice())));
    }
    luatools::install_loader_changes(steam, &plan)?;
    if config.is_some() {
        luatools::migrate_legacy_lua(steam, &luatools::stplugin_dir(steam));
    }
    Ok(!current)
}

pub(crate) fn ensure(steam: &Path) -> Result<(), String> {
    let _guard = INSTALL_LOCK
        .lock()
        .map_err(|_| "Перезапустите программу после ошибки DLL")?;
    let _file = acquire_file_lock(steam)?;
    let variant = selected_variant(steam)?;
    let cached = loader_updates::cached(steam)?;
    let bundle = available_bundle(&variant, cached.as_ref())?;
    apply_selection(steam, bundle_selection(&bundle)?, bundle, false, None).map(|_| ())
}

fn install(
    steam: &Path,
    variant: &str,
    downloaded: Option<Package>,
    fallback: Option<String>,
) -> OperationResult {
    let result = (|| {
        let _guard = INSTALL_LOCK
            .lock()
            .map_err(|_| "Перезапустите программу после ошибки DLL")?;
        let _file = acquire_file_lock(steam)?;
        let cached = if downloaded.is_some() {
            loader_updates::cached(steam).unwrap_or(None)
        } else {
            loader_updates::cached(steam)?
        };
        let downloaded = downloaded.as_ref().filter(|package| {
            cached
                .as_ref()
                .is_none_or(|c| package.manifest.revision > c.manifest.revision)
        });
        let bundle = available_bundle(variant, downloaded.or(cached.as_ref()))?;
        apply_selection(steam, bundle_selection(&bundle)?, bundle, true, downloaded)
    })();
    #[cfg(windows)]
    if result.is_ok() {
        if let Err(error) = crate::millennium::update_installed_for_loader(steam) {
            return OperationResult::error(
                format!("DLL закреплены, но не удалось обновить плагин: {error}. Повторите действие до использования старого плагина."),
                vec![],
            );
        }
    }
    let mut outcome = match result {
        Ok(false) => OperationResult::ok("DLL уже актуальны. Совпадающие файлы пропущены.", vec![]),
        Ok(true) => OperationResult::ok(
            "DLL обновлены. Полностью перезапустите Steam.",
            vec!["Предыдущие файлы сохранены в config/cgs-luatools-backups".into()],
        ),
        Err(error) => OperationResult::error(error, vec![]),
    };
    if let Some(reason) = fallback {
        outcome.logs.push(reason);
        if outcome.success {
            outcome.message = format!(
                "Онлайн-проверка недоступна. Использован локальный комплект. {}",
                outcome.message
            );
        }
    }
    outcome
}

// Установка или обновление загрузчика (онлайн из croclua-dll-feed с откатом на кэш/встроенные DLL)
pub(crate) fn update(steam: &Path, variant: Option<&str>, online: bool) -> OperationResult {
    if !steam.join("steam.exe").is_file() {
        return OperationResult::error(
            "steam.exe не найден в выбранной папке. DLL не изменены",
            vec![],
        );
    }
    let variant = match variant {
        Some(value) => match canonical_variant(value) {
            Ok(v) => v.to_string(),
            Err(e) => return OperationResult::error(e, vec![]),
        },
        None => match selected_variant(steam) {
            Ok(v) => v,
            Err(e) => return OperationResult::error(e, vec![]),
        },
    };
    let (downloaded, fallback) = if online {
        let revision = loader_updates::cached(steam)
            .ok()
            .flatten()
            .map_or_else(loader_updates::embedded_revision, |package| {
                package.manifest.revision
            });
        match loader_updates::download(revision) {
            Ok(package) => (package, None),
            Err(error) => (None, Some(error)),
        }
    } else {
        (None, None)
    };
    install(steam, &variant, downloaded, fallback)
}

// Разрешение пути к каталогу Steam с проверкой наличия steam.exe
pub(crate) fn resolve(steam_path: Option<String>) -> Result<PathBuf, String> {
    let path = match steam_path.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s.trim()),
        None => luatools::resolve_steam_path(None).ok_or("Папка Steam не найдена")?,
    };
    if !path.join("steam.exe").is_file() {
        return Err("В выбранной папке не найден steam.exe".into());
    }
    Ok(path)
}

#[tauri::command(async)]
pub fn luatools_loader_info(steam_path: Option<String>) -> Result<LoaderInfo, String> {
    let steam = resolve(steam_path)?;
    let (saved, mut issue) = match read_selection(&steam) {
        Ok(s) => (s, None),
        Err(e) => (None, Some(e)),
    };
    let variant = saved
        .as_ref()
        .map(|s| s.variant.clone())
        .unwrap_or_else(|| detect_variant(&steam).unwrap_or("standard").into());
    let cached = loader_updates::cached(&steam)?;
    let expected = bundle_selection(&available_bundle(&variant, cached.as_ref())?)?;
    let current = match matches_selection(&steam, &expected) {
        Ok(v) => v,
        Err(e) => {
            issue = Some(e);
            false
        }
    };
    Ok(LoaderInfo {
        steam_path: steam.display().to_string(),
        selected_variant: variant,
        pinned: saved.is_some(),
        current,
        issue,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steam() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("steam.exe"), []).unwrap();
        dir
    }

    fn assert_bundle(steam: &Path, variant: &str) {
        for &(name, bytes) in STANDARD {
            let name = if variant == "compatibility" && name == "dwmapi.dll" {
                "bin/dwmapi.dll"
            } else {
                name
            };
            assert_eq!(
                hash(&fs::read(steam.join(name)).unwrap()),
                hash(bytes),
                "{name}"
            );
        }
        assert_eq!(read_selection(steam).unwrap().unwrap().variant, variant);
    }

    #[test]
    fn compatibility_layout_is_pinned_and_automatic_install_does_not_rewrite_it() {
        let dir = steam();
        let steam = dir.path();
        assert!(update(steam, Some("compatibility"), false).success);
        let times: Vec<_> = STANDARD
            .iter()
            .map(|(name, _)| {
                fs::metadata(steam.join(if *name == "dwmapi.dll" {
                    "bin/dwmapi.dll"
                } else {
                    *name
                }))
                .unwrap()
                .modified()
                .unwrap()
            })
            .collect();
        ensure(steam).unwrap();
        assert_bundle(steam, "compatibility");
        for (index, &(name, _)) in STANDARD.iter().enumerate() {
            let name = if name == "dwmapi.dll" {
                "bin/dwmapi.dll"
            } else {
                name
            };
            assert_eq!(
                fs::metadata(steam.join(name)).unwrap().modified().unwrap(),
                times[index]
            );
        }
    }

    #[test]
    fn switching_both_directions_is_explicit_and_backed_up() {
        let dir = steam();
        let steam = dir.path();
        assert!(update(steam, Some("standard"), false).success);
        assert!(update(steam, Some("compatibility"), false).success);
        assert_bundle(steam, "compatibility");
        assert!(fs::read_dir(steam.join("config/cgs-luatools-backups"))
            .unwrap()
            .flatten()
            .any(|entry| fs::read(entry.path().join("dwmapi.dll"))
                .is_ok_and(|bytes| bytes == STANDARD[1].1)));
        assert!(update(steam, Some("standard"), false).success);
        ensure(steam).unwrap();
        assert_bundle(steam, "standard");
    }

    #[test]
    fn detects_existing_compatibility_layout_without_preference_file() {
        let dir = steam();
        let steam = dir.path();
        fs::create_dir_all(steam.join("bin")).unwrap();
        fs::write(steam.join("OpenSteamTool.dll"), STANDARD[0].1).unwrap();
        fs::write(steam.join("bin/dwmapi.dll"), STANDARD[1].1).unwrap();
        fs::write(steam.join("xinput1_4.dll"), STANDARD[2].1).unwrap();
        ensure(steam).unwrap();
        assert_bundle(steam, "compatibility");
    }

    #[test]
    fn repairs_missing_files_only_from_the_pinned_variant() {
        let dir = steam();
        let steam = dir.path();
        assert!(update(steam, Some("compatibility"), false).success);
        fs::remove_file(steam.join("bin/dwmapi.dll")).unwrap();
        fs::write(steam.join("xinput1_4.dll"), b"broken").unwrap();
        ensure(steam).unwrap();
        assert_bundle(steam, "compatibility");
    }
}
