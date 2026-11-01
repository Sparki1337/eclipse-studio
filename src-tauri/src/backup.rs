//! Общий манифест: первый оригинал неизменяем, журнал операций дополняется до изменения файлов.
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
            version: 3,
            originals: BTreeMap::new(),
            created: BTreeMap::new(),
            legacy_import: false,
            hashes: BTreeMap::new(),
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
    if !(1..=3).contains(&manifest.version)
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
/// Успех возвращается только после проверки копии и фиксации манифеста.
pub fn protect(root: &Path, name: &str, operation: &str) -> Result<(), String> {
    validate_name(name)?;
    let target = safe_path::join(root, name)?;
    let backup_dir = safe_path::join(root, DIR)?;
    let mut manifest = load(&backup_dir)?;
    let k = key(name);
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
                // Старый бэкап не перезаписывается; его назначение требует ручного подтверждения.
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
    manifest.version = 3;
    save(&backup_dir, &manifest)
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
}
