// Модуль закрепления и управления библиотеками загрузчика OpenSteamTool.
// Schema 2 фиксирует точные относительные пути библиотек, включая bin/dwmapi.dll.
use crate::{
    loader_github::{self, Bundle},
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

// Встроенные файлы основной версии (standard / v1)
pub(crate) const STANDARD: &[(&str, &[u8])] = &[
    (
        "OpenSteamTool.dll",
        include_bytes!("assets/OpenSteamTool.dll"),
    ),
    ("dwmapi.dll", include_bytes!("assets/dwmapi.dll")),
    ("xinput1_4.dll", include_bytes!("assets/xinput1_4.dll")),
];

// Встроенные файлы альтернативной версии (compatibility / v2)
const COMPATIBILITY: &[(&str, &[u8])] = &[
    (
        "OpenSteamTool.dll",
        include_bytes!("assets/ost_desktop/OpenSteamTool.dll"),
    ),
    ("dwmapi.dll", include_bytes!("assets/ost_desktop/dwmapi.dll")),
    (
        "xinput1_4.dll",
        include_bytes!("assets/ost_desktop/xinput1_4.dll"),
    ),
];

// Относительный путь к файлу фиксации выбора загрузчика
const SELECTION: &str = "config/cgs-luatools-loader.json";

// Мьютекс блокировки одновременной установки DLL в одном процессе
static INSTALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// Структура конфигурации закреплённого комплекта DLL
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Selection {
    pub(crate) schema: u32,
    pub(crate) variant: String,
    pub(crate) hashes: BTreeMap<String, String>,
}

// Информация о текущем установленном загрузчике для интерфейса
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderInfo {
    steam_path: String,
    selected_variant: String,
    pinned: bool,
    current: bool,
    issue: Option<String>,
}

// Получение списка встроенных ресурсов по имени комплекта
fn resources(variant: &str) -> Result<&'static [(&'static str, &'static [u8])], String> {
    match variant {
        "standard" | "v1" => Ok(STANDARD),
        "compatibility" | "v2" | "desktop" => Ok(COMPATIBILITY),
        _ => Err("Неизвестная версия загрузчика".into()),
    }
}

// Вычисление SHA-256 хеша байтов
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// Проверка структуры комплекта DLL под выбранную схему
pub(crate) fn validate_layout(
    variant: &str,
    schema: u32,
    paths: &BTreeMap<String, String>,
) -> Result<(), String> {
    resources(variant)?;
    if paths.len() != 3
        || !paths.contains_key("OpenSteamTool.dll")
        || !paths.contains_key("xinput1_4.dll")
    {
        return Err("Неполный комплект DLL".into());
    }
    let valid = match (schema, variant) {
        (1, _) => paths.contains_key("dwmapi.dll"),
        (2, "compatibility") | (2, "v2") | (2, "desktop") => paths.contains_key("bin/dwmapi.dll"),
        (2, "standard") | (2, "v1") => {
            paths.contains_key("dwmapi.dll") || paths.contains_key("version.dll")
        }
        _ => false,
    };
    if !valid {
        return Err("Неподдерживаемые пути DLL".into());
    }
    Ok(())
}

// Создание структуры Selection из загруженного или встроенного комплекта
fn bundle_selection(bundle: &Bundle) -> Result<Selection, String> {
    let canonical_variant = match bundle.variant.as_str() {
        "v2" | "desktop" => "compatibility",
        "v1" => "standard",
        other => other,
    };
    let selection = Selection {
        schema: 2,
        variant: canonical_variant.to_string(),
        hashes: bundle
            .files
            .iter()
            .map(|(p, b)| (p.clone(), hash(b)))
            .collect(),
    };
    validate_layout(&selection.variant, 2, &selection.hashes)?;
    Ok(selection)
}

// Создание пакета Bundle из встроенных ассетов программы
pub(crate) fn embedded_bundle(variant: &str, schema: u32) -> Result<Bundle, String> {
    let canonical_variant = match variant {
        "v2" | "desktop" => "compatibility",
        "v1" => "standard",
        other => other,
    };
    Ok(Bundle {
        variant: canonical_variant.into(),
        files: resources(variant)?
            .iter()
            .map(|(name, b)| {
                let target = if schema == 2 && canonical_variant == "compatibility" && *name == "dwmapi.dll" {
                    "bin/dwmapi.dll"
                } else {
                    *name
                };
                (target.into(), b.to_vec())
            })
            .collect(),
    })
}

// Формирование структуры Selection для встроенного комплекта
fn bundled_selection(variant: &str) -> Result<Selection, String> {
    bundle_selection(&embedded_bundle(variant, 2)?)
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
    if fs::metadata(path).is_ok_and(|m| m.len() > loader_github::MAX_DLL as u64) {
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

// Разбор JSON-файла фиксации выбора
fn parse_selection(bytes: &[u8]) -> Result<Selection, String> {
    if bytes.len() > 16384 {
        return Err("Слишком большой файл выбора DLL".into());
    }
    let value: Selection = serde_json::from_slice(bytes)
        .map_err(|_| "Файл выбора DLL повреждён. Выберите комплект заново через «Обновить DLL».")?;
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

// Чтение закреплённой конфигурации из папки Steam
pub(crate) fn read_selection(steam: &Path) -> Result<Option<Selection>, String> {
    reject_link(&steam.join("config"))?;
    read_optional(&steam.join(SELECTION))?
        .map(|b| parse_selection(&b))
        .transpose()
}

// Определение установленного варианта комплекта по имеющимся файлам
fn detect_variant(steam: &Path) -> Result<&'static str, String> {
    if let Some(bytes) = read_optional(&steam.join("OpenSteamTool.dll"))? {
        return Ok(if bytes == COMPATIBILITY[0].1 {
            "compatibility"
        } else {
            "standard"
        });
    }
    if read_optional(&steam.join("bin/dwmapi.dll"))?.is_some_and(|b| b == COMPATIBILITY[1].1) {
        return Ok("compatibility");
    }
    Ok("standard")
}

// Получение текущего активного варианта загрузчика
pub(crate) fn selected_variant(steam: &Path) -> Result<String, String> {
    Ok(read_selection(steam)?
        .map(|s| s.variant)
        .unwrap_or_else(|| detect_variant(steam).unwrap_or("standard").into()))
}

// Проверка соответствия файлов на диске хешам закреплённой конфигурации
fn matches_selection(steam: &Path, selection: &Selection) -> Result<bool, String> {
    let mut current = true;
    for (path, expected) in &selection.hashes {
        current &= read_optional(&steam.join(path))?.is_some_and(|b| hash(&b) == *expected);
    }
    Ok(current)
}

// Захват файловой межпроцессной блокировки
fn acquire_file_lock(steam: &Path) -> Result<fs::File, String> {
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

// Путь к каталогу локального кэша комплекта
fn cache_dir(steam: &Path, selection: &Selection) -> Result<PathBuf, String> {
    Ok(steam
        .join("config/cgs-luatools-loader-cache")
        .join(&selection.variant)
        .join(hash(
            &serde_json::to_vec(selection).map_err(|e| e.to_string())?,
        )))
}

// Сохранение комплекта в локальный кэш
fn store_bundle(steam: &Path, selection: &Selection, bundle: &Bundle) -> Result<(), String> {
    let path = cache_dir(steam, selection)?;
    let mut parent = steam.to_path_buf();
    for component in path.strip_prefix(steam).unwrap().components() {
        parent.push(component);
        reject_link(&parent)?;
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    }
    for (target, bytes) in &bundle.files {
        let file = path.join(Path::new(target).file_name().unwrap());
        reject_link(&file)?;
        if read_optional(&file)?.as_deref() != Some(bytes) {
            fs::write(file, bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// Получение закреплённого комплекта из встроенных ассетов или локального кэша
fn pinned_bundle(steam: &Path, selection: &Selection) -> Result<Bundle, String> {
    let embedded = embedded_bundle(&selection.variant, selection.schema)?;
    let expected = Selection {
        schema: selection.schema,
        variant: selection.variant.clone(),
        hashes: embedded
            .files
            .iter()
            .map(|(p, b)| (p.clone(), hash(b)))
            .collect(),
    };
    if expected == *selection {
        return Ok(embedded);
    }
    let path = cache_dir(steam, selection)?;
    reject_link(&path)?;
    let mut files = BTreeMap::new();
    for (target, expected) in &selection.hashes {
        let file = path.join(Path::new(target).file_name().unwrap());
        let bytes = read_optional(&file)?.ok_or("Закреплённый комплект повреждён и отсутствует в кэше. Автозамена запрещена. Выберите комплект через «Обновить DLL».")?;
        if hash(&bytes) != *expected {
            return Err("Кэш закреплённых DLL повреждён. Автозамена запрещена.".into());
        }
        files.insert(target.clone(), bytes);
    }
    Ok(Bundle {
        variant: selection.variant.clone(),
        files,
    })
}

// Применение и закрепление выбранной конфигурации DLL
fn apply_selection(
    steam: &Path,
    selection: Selection,
    bundle: Option<Bundle>,
    manual: bool,
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
    let bundle = if let Some(b) = bundle {
        Some(b)
    } else if !current {
        Some(pinned_bundle(steam, &selection)?)
    } else {
        None
    };
    if let Some(bundle) = &bundle {
        let hashes: BTreeMap<_, _> = bundle
            .files
            .iter()
            .map(|(p, b)| (p.clone(), hash(b)))
            .collect();
        if hashes != selection.hashes {
            return Err("Комплект не соответствует закреплённой версии".into());
        }
        store_bundle(steam, &selection, bundle)?;
    }
    let mut owned = BTreeMap::new();
    if let Some(old) = previous {
        owned = old.hashes;
    } else {
        // Подхватываем только известные файлы прошлых сборок программы
        for name in ["dwmapi.dll", "version.dll", "bin/dwmapi.dll"] {
            if let Some(bytes) = read_optional(&steam.join(name))? {
                if [STANDARD, COMPATIBILITY]
                    .iter()
                    .any(|set| set.iter().any(|(_, b)| **b == bytes))
                {
                    owned.insert(name.into(), hash(&bytes));
                }
            }
        }
    }
    let mut changes: BTreeMap<String, Option<Vec<u8>>> = BTreeMap::new();
    if !current {
        for (path, bytes) in &bundle.as_ref().unwrap().files {
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
    // Маркер пишется последним: при сбое подмены файлов версия не переключится
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

// Гарантированная проверка и восстановление закреплённых DLL при запуске
pub(crate) fn ensure(steam: &Path) -> Result<(), String> {
    let _guard = INSTALL_LOCK
        .lock()
        .map_err(|_| "Перезапустите программу после ошибки DLL")?;
    let _file = acquire_file_lock(steam)?;
    let saved = read_selection(steam)?;
    if let Some(selection) = saved {
        apply_selection(steam, selection, None, false).map(|_| ())
    } else {
        let variant = detect_variant(steam)?;
        let bundle = embedded_bundle(variant, 2)?;
        apply_selection(steam, bundle_selection(&bundle)?, Some(bundle), false).map(|_| ())
    }
}

// Установка комплекта в каталог Steam
fn install(steam: &Path, bundle: Bundle) -> OperationResult {
    if !steam.join("steam.exe").is_file() {
        return OperationResult::error(
            "steam.exe не найден в выбранной папке. DLL не изменены",
            vec![],
        );
    }
    let result = (|| {
        let _guard = INSTALL_LOCK
            .lock()
            .map_err(|_| "Перезапустите программу после ошибки DLL")?;
        let _file = acquire_file_lock(steam)?;
        apply_selection(steam, bundle_selection(&bundle)?, Some(bundle), true)
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
    match result {
        Ok(false) => OperationResult::ok(
            "DLL уже актуальны. Выбранный комплект закреплён, DLL не переписаны",
            vec![],
        ),
        Ok(true) => OperationResult::ok(
            "DLL обновлены. Комплект закреплён. Полностью перезапустите Steam",
            vec!["Предыдущие файлы сохранены в config/cgs-luatools-backups".into()],
        ),
        Err(error) => OperationResult::error(error, vec![]),
    }
}

// Публичный интерфейс установки загруженного комплекта
pub(crate) fn install_downloaded(steam: &Path, bundle: Bundle) -> OperationResult {
    install(steam, bundle)
}

// Офлайн-установка или обновление из встроенных ассетов
pub(crate) fn update_embedded(steam: &Path, variant: Option<&str>) -> OperationResult {
    let variant = match variant {
        Some(value) => value.to_string(),
        None => match selected_variant(steam) {
            Ok(v) => v,
            Err(e) => return OperationResult::error(e, vec![]),
        },
    };
    match embedded_bundle(&variant, 2) {
        Ok(bundle) => install(steam, bundle),
        Err(e) => OperationResult::error(e, vec![]),
    }
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

// Tauri-команда получения сведений об установленном комплекте
#[tauri::command]
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
    let expected = saved.clone().unwrap_or(bundled_selection(&variant)?);
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
        for &(name, bytes) in resources(variant).unwrap() {
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
    fn second_version_is_pinned_and_automatic_install_does_not_rewrite_it() {
        let dir = steam();
        let steam = dir.path();
        assert!(update_embedded(steam, Some("compatibility")).success);
        let times: Vec<_> = COMPATIBILITY
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
        for (index, &(name, _)) in COMPATIBILITY.iter().enumerate() {
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
        assert!(update_embedded(steam, Some("standard")).success);
        assert!(update_embedded(steam, Some("compatibility")).success);
        assert_bundle(steam, "compatibility");
        assert!(fs::read_dir(steam.join("config/cgs-luatools-backups"))
            .unwrap()
            .flatten()
            .any(|entry| fs::read(entry.path().join("OpenSteamTool.dll"))
                .is_ok_and(|bytes| bytes == STANDARD[0].1)));
        assert!(update_embedded(steam, Some("standard")).success);
        ensure(steam).unwrap();
        assert_bundle(steam, "standard");
    }

    #[test]
    fn repairs_missing_files_only_from_the_pinned_variant() {
        let dir = steam();
        let steam = dir.path();
        assert!(update_embedded(steam, Some("compatibility")).success);
        fs::remove_file(steam.join("bin/dwmapi.dll")).unwrap();
        fs::write(steam.join("xinput1_4.dll"), STANDARD[2].1).unwrap();
        ensure(steam).unwrap();
        assert_bundle(steam, "compatibility");
    }
}

