//! Общий манифест: первый оригинал неизменяем, журнал операций дополняется до изменения файлов
use crate::{durable, safe_path};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
pub const DIR: &str = ".backup_orig";
pub const MANIFEST: &str = "cgs-backup.json";
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u8,
    #[serde(default)]
    pub originals: BTreeMap<String, String>,
    #[serde(default)]
    pub created: BTreeMap<String, String>,
    #[serde(default)]
    pub legacy_import: bool,
    #[serde(default)]
    pub hashes: BTreeMap<String, String>,
    #[serde(default)]
    pub installed_hashes: BTreeMap<String, String>,
    #[serde(default)]
    pub operations: Vec<BackupOperation>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupOperation {
    pub id: String,
    pub unix: u64,
    pub files: Vec<String>,
}
impl Default for Manifest {
    fn default() -> Self {
        Self {
            version: 4,
            originals: BTreeMap::new(),
            created: BTreeMap::new(),
            legacy_import: false,
            hashes: BTreeMap::new(),
            installed_hashes: BTreeMap::new(),
            operations: Vec::new(),
        }
    }
}
fn key(name: &str) -> String {
    name.replace('\\', "/").to_lowercase()
}
pub fn validate_name(name: &str) -> Result<(), String> {
    safe_path::relative(name)?;
    if name.split(['/', '\\']).any(|p| {
        p.eq_ignore_ascii_case(DIR)
            || p.eq_ignore_ascii_case(MANIFEST)
            || p.eq_ignore_ascii_case("cgs-backup.tmp")
    }) {
        return Err("Манифест не может ссылаться на собственный каталог".into());
    }
    Ok(())
}
pub fn validate(manifest: &Manifest) -> Result<(), String> {
    if !(1..=4).contains(&manifest.version)
        || manifest.originals.len() + manifest.created.len() > 250_000
    {
        return Err("Неподдерживаемая версия или размер манифеста".into());
    }
    let mut seen = BTreeSet::new();
    for (k, name) in manifest.originals.iter().chain(manifest.created.iter()) {
        validate_name(name)?;
        if *k != key(name) || !seen.insert(key(name)) {
            return Err("Дублированный или несогласованный путь в манифесте".into());
        }
    }
    for (k, hash) in &manifest.hashes {
        if !manifest.originals.contains_key(k)
            || hash.len() != 64
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Некорректная контрольная сумма манифеста".into());
        }
    }
    for (k, hash) in &manifest.installed_hashes {
        if (!manifest.originals.contains_key(k) && !manifest.created.contains_key(k))
            || hash.len() != 64
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Некорректный хеш установленного файла".into());
        }
    }
    Ok(())
}
pub fn load(backup_dir: &Path) -> Result<Manifest, String> {
    if !backup_dir.exists() {
        return Ok(Manifest::default());
    }
    let path = safe_path::join(backup_dir, MANIFEST)?;
    let data = match fs::read(path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Manifest {
                legacy_import: true,
                ..Manifest::default()
            })
        }
        Err(e) => return Err(e.to_string()),
    };
    if data.len() > 32 * 1024 * 1024 {
        return Err("Слишком большой манифест бэкапа".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&data).map_err(|e| format!("Повреждённый манифест: {e}"))?;
    validate(&manifest)?;
    Ok(manifest)
}
pub fn save(backup_dir: &Path, manifest: &Manifest) -> Result<(), String> {
    validate(manifest)?;
    fs::create_dir_all(backup_dir).map_err(|e| e.to_string())?;
    let path = safe_path::join(backup_dir, MANIFEST)?;
    durable::write(
        &path,
        &serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?,
    )
}
/// Успех возвращается только после проверки копии и фиксации манифеста
pub fn protect(root: &Path, name: &str, operation: &str) -> Result<(), String> {
    validate_name(name)?;
    let target = safe_path::join(root, name)?;
    let backup_dir = safe_path::join(root, DIR)?;
    let mut manifest = load(&backup_dir)?;
    let k = key(name);
    if manifest.originals.contains_key(&k) || manifest.created.contains_key(&k) {
        check_current(root, name, &manifest)?;
    }
    if let Some(original) = manifest.originals.get(&k) {
        let backup = safe_path::join(&backup_dir, original)?;
        let actual = durable::hash_file(&backup)?;
        if let Some(expected) = manifest.hashes.get(&k) {
            if expected != &actual {
                return Err(format!("Повреждён оригинал в бэкапе: {name}"));
            }
        } else {
            manifest.hashes.insert(k.clone(), actual);
        }
    } else if !manifest.created.contains_key(&k) {
        fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
        if target.exists() {
            if !target.is_file() {
                return Err(format!("Ожидался обычный файл: {name}"));
            }
            let backup = safe_path::join(&backup_dir, name)?;
            if backup.exists() {
                // Старый бэкап не перезаписывается; его назначение требует ручного подтверждения
                return Err(format!("Найден оригинал без записи в манифесте: {name}. Сначала восстановите старый бэкап."));
            }
            durable::copy(&target, &backup)?;
            manifest
                .hashes
                .insert(k.clone(), durable::hash_file(&backup)?);
            manifest
                .originals
                .insert(k.clone(), name.replace('\\', "/"));
        } else {
            manifest.created.insert(k.clone(), name.replace('\\', "/"));
        }
    }
    let id = if operation.is_empty() {
        "file-change"
    } else {
        operation
    };
    if let Some(last) = manifest.operations.last_mut().filter(|last| last.id == id) {
        if !last.files.contains(&k) {
            last.files.push(k);
        }
    } else {
        manifest.operations.push(BackupOperation {
            id: id.into(),
            unix: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            files: vec![k],
        });
    }
    manifest.version = 4;
    save(&backup_dir, &manifest)
}

/// Проверка владения перед повторной записью и откатом. Отсутствующий файл
/// безопасен; существующий неизвестный или изменённый файл не трогаем.
pub fn check_current(root: &Path, name: &str, manifest: &Manifest) -> Result<(), String> {
    validate_name(name)?;
    let target = safe_path::join(root, name)?;
    if !target.exists() {
        return Ok(());
    }
    let hash = durable::hash_file(&target)?;
    let k = key(name);
    if manifest.installed_hashes.get(&k) == Some(&hash) || manifest.hashes.get(&k) == Some(&hash) {
        return Ok(());
    }
    Err(format!("Конфликт: {name} изменён после установки или его версия не подтверждена. Файл и бэкап сохранены."))
}

/// Вызывается только после проверенной записи. Сбой фиксации не выдаётся за успех.
pub fn record_installed(root: &Path, name: &str) -> Result<(), String> {
    validate_name(name)?;
    let backup_dir = safe_path::join(root, DIR)?;
    let mut manifest = load(&backup_dir)?;
    let k = key(name);
    if !manifest.originals.contains_key(&k) && !manifest.created.contains_key(&k) {
        return Err("Нельзя подтвердить файл без предварительного бэкапа".into());
    }
    let path = safe_path::join(root, name)?;
    if path.exists() {
        manifest
            .installed_hashes
            .insert(k, durable::hash_file(&path)?);
    } else {
        manifest.installed_hashes.remove(&k);
    }
    manifest.version = 4;
    save(&backup_dir, &manifest)
}

pub fn record_path(path: &Path) -> Result<(), String> {
    record_installed(
        path.parent().ok_or("Нет каталога файла")?,
        path.file_name()
            .and_then(|n| n.to_str())
            .ok_or("Некорректное имя")?,
    )
}

/// Полная предварительная проверка журнала до первого изменения на диске.
pub fn preflight_restore(root: &Path, manifest: &Manifest) -> Result<(), String> {
    validate(manifest)?;
    let backup_dir = safe_path::join(root, DIR)?;
    for entry in walkdir::WalkDir::new(&backup_dir).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.depth() == 0 {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&backup_dir)
            .map_err(|e| e.to_string())?;
        let name = relative.to_string_lossy().replace('\\', "/");
        let k = key(&name);
        if safe_path::is_link(&fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?) {
            return Err(format!("Ссылка в бэкапе запрещена: {name}"));
        }
        if entry.file_type().is_dir() {
            if !manifest
                .originals
                .keys()
                .any(|original| original.starts_with(&(k.clone() + "/")))
            {
                return Err(format!("Неизвестный каталог в бэкапе: {name}"));
            }
        } else if k != MANIFEST && !manifest.originals.contains_key(&k) {
            return Err(format!("Незарегистрированный файл в бэкапе: {name}"));
        }
    }
    for (k, name) in &manifest.originals {
        let backup = safe_path::join(&backup_dir, name)?;
        let expected = manifest.hashes.get(k).ok_or_else(|| {
            format!(
                "Старый бэкап {name} не имеет подтверждённого SHA-256; требуется ручная проверка"
            )
        })?;
        if durable::hash_file(&backup)? != *expected {
            return Err(format!("Контрольная сумма оригинала не совпадает: {name}"));
        }
    }
    for name in manifest.originals.values().chain(manifest.created.values()) {
        check_current(root, name, manifest)?;
    }
    Ok(())
}

/// Выборочный откат только явно запрошенных подтверждённых записей. Журнал
/// очищается после проверенного восстановления; чужие файлы не удаляются.
pub fn restore_selected(root: &Path, names: &[String]) -> Result<usize, String> {
    let backup_dir = safe_path::join(root, DIR)?;
    let mut manifest = load(&backup_dir)?;
    let keys: BTreeSet<_> = names.iter().map(|name| key(name)).collect();
    if keys.is_empty() {
        return Err("Нет подтверждённых файлов для отката".into());
    }
    for k in &keys {
        let name = manifest
            .originals
            .get(k)
            .or_else(|| manifest.created.get(k))
            .ok_or_else(|| format!("Нет записи владения: {k}"))?;
        check_current(root, name, &manifest)?;
        if manifest.originals.contains_key(k) {
            let expected = manifest
                .hashes
                .get(k)
                .ok_or("Старый бэкап не имеет SHA-256")?;
            if durable::hash_file(&safe_path::join(&backup_dir, name)?)? != *expected {
                return Err(format!("Повреждён оригинал: {name}"));
            }
        }
    }
    for k in &keys {
        let name = manifest
            .originals
            .get(k)
            .or_else(|| manifest.created.get(k))
            .unwrap();
        check_current(root, name, &manifest)?;
        let target = safe_path::join(root, name)?;
        if manifest.originals.contains_key(k) {
            durable::copy(&safe_path::join(&backup_dir, name)?, &target)?;
        } else if target.exists() {
            fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
    }
    let originals: Vec<_> = keys
        .iter()
        .filter_map(|k| manifest.originals.get(k).cloned())
        .collect();
    for k in &keys {
        manifest.originals.remove(k);
        manifest.created.remove(k);
        manifest.hashes.remove(k);
        manifest.installed_hashes.remove(k);
    }
    for operation in &mut manifest.operations {
        operation.files.retain(|k| !keys.contains(k));
    }
    manifest
        .operations
        .retain(|operation| !operation.files.is_empty());
    manifest.version = 4;
    save(&backup_dir, &manifest)?;
    for name in originals {
        fs::remove_file(safe_path::join(&backup_dir, &name)?)
            .map_err(|e| format!("Оригинал восстановлен; резервная копия оставлена: {e}"))?;
    }
    Ok(keys.len())
}

pub fn restore_operation(root: &Path, id: &str) -> Result<usize, String> {
    let manifest = load(&safe_path::join(root, DIR)?)?;
    let names: BTreeSet<_> = manifest
        .operations
        .iter()
        .filter(|operation| operation.id == id)
        .flat_map(|operation| operation.files.iter().cloned())
        .collect();
    for k in &names {
        if manifest
            .operations
            .iter()
            .rev()
            .find(|operation| operation.files.contains(k))
            .is_some_and(|operation| operation.id != id)
        {
            return Err("Файл изменён более поздней операцией другого модуля. Используйте полный общий откат.".into());
        }
    }
    restore_selected(root, &names.into_iter().collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_operations_keep_first_original_and_both_records() {
        let temp = tempfile::tempdir().unwrap();
        let f = temp.path().join("a.dll");
        fs::write(&f, b"original").unwrap();
        protect(temp.path(), "a.dll", "job-1").unwrap();
        fs::write(&f, b"changed").unwrap();
        record_installed(temp.path(), "a.dll").unwrap();
        protect(temp.path(), "a.dll", "job-2").unwrap();
        assert_eq!(
            fs::read(temp.path().join(DIR).join("a.dll")).unwrap(),
            b"original"
        );
        assert_eq!(load(&temp.path().join(DIR)).unwrap().operations.len(), 2);
    }
    #[test]
    fn refuses_corruption_before_new_change() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("x"), b"safe").unwrap();
        protect(temp.path(), "x", "1").unwrap();
        fs::write(temp.path().join(DIR).join("x"), b"evil").unwrap();
        assert!(protect(temp.path(), "x", "2").is_err());
        assert_eq!(fs::read(temp.path().join("x")).unwrap(), b"safe");
    }
    #[test]
    fn rejects_malicious_manifest_before_restoration() {
        let mut m = Manifest::default();
        m.created.insert("../outside".into(), "../outside".into());
        assert!(validate(&m).is_err());
        m.created.clear();
        m.originals.insert("x".into(), "X".into());
        m.created.insert("x".into(), "x".into());
        assert!(validate(&m).is_err());
    }
    #[test]
    fn invalid_manifest_is_not_silently_reset() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(MANIFEST), b"{broken").unwrap();
        assert!(load(temp.path()).is_err());
    }
    #[test]
    fn changed_created_file_and_unknown_legacy_are_not_owned() {
        let temp = tempfile::tempdir().unwrap();
        protect(temp.path(), "new.ini", "one").unwrap();
        fs::write(temp.path().join("new.ini"), b"installed").unwrap();
        record_installed(temp.path(), "new.ini").unwrap();
        fs::write(temp.path().join("new.ini"), b"user edit").unwrap();
        let manifest = load(&temp.path().join(DIR)).unwrap();
        assert!(preflight_restore(temp.path(), &manifest).is_err());
        assert!(protect(temp.path(), "new.ini", "two").is_err());
        assert_eq!(fs::read(temp.path().join("new.ini")).unwrap(), b"user edit");
        assert!(temp.path().join(DIR).exists());
    }

    #[test]
    fn selective_restore_keeps_other_operations_and_detects_later_owner() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for (name, op) in [("a.dll", "creamapi"), ("b.dll", "engine")] {
            fs::write(root.join(name), b"original").unwrap();
            protect(root, name, op).unwrap();
            fs::write(root.join(name), b"installed").unwrap();
            record_installed(root, name).unwrap();
        }
        assert_eq!(restore_operation(root, "creamapi").unwrap(), 1);
        assert_eq!(fs::read(root.join("a.dll")).unwrap(), b"original");
        assert_eq!(fs::read(root.join("b.dll")).unwrap(), b"installed");
        protect(root, "b.dll", "creamapi").unwrap();
        protect(root, "b.dll", "engine").unwrap();
        assert!(restore_operation(root, "creamapi").is_err());
    }
}
