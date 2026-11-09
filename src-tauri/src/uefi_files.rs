//! Изменяется только свежий каталог с nonce-именем; системный SecConfig.efi не перезаписывается.
use crate::uefi_transaction::{Journal, Presence};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

fn directory(root: &Path, plan: &Journal) -> Result<PathBuf, String> {
    plan.validate()?;
    for path in [root.to_path_buf(), root.join("EFI")] {
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("EFI недоступен: {e}"))?;
        if !meta.is_dir() || crate::safe_path::is_link(&meta) {
            return Err("Ссылка или неверный тип корня EFI".into());
        }
    }
    Ok(root
        .join("EFI")
        .join(format!("EclipseStudio-{}", plan.nonce)))
}
fn owner(plan: &Journal) -> Vec<u8> {
    format!(
        "Eclipse Studio UEFI Opt-Out\n{}\n{}\n",
        plan.nonce, plan.image_sha256
    )
    .into_bytes()
}
fn inspect_file(path: &Path, expected: &[u8], prefix: bool) -> Result<bool, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || crate::safe_path::is_link(&meta) || meta.len() > expected.len() as u64 {
        return Ok(false);
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(if prefix {
        expected.starts_with(&bytes)
    } else {
        expected == bytes
    })
}
pub fn inspect(root: &Path, plan: &Journal) -> Result<Presence, String> {
    let path = directory(root, plan)?;
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Presence::Absent),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_dir() || crate::safe_path::is_link(&meta) {
        return Ok(Presence::Conflict);
    }
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let expected = match entry.file_name().to_str() {
            Some(".owner") => (owner(plan), true),
            Some("SecConfig.efi") => (plan.image.clone(), false),
            Some("SecConfig.efi.partial") => (plan.image.clone(), true),
            _ => return Ok(Presence::Conflict),
        };
        if !inspect_file(&entry.path(), &expected.0, expected.1)? {
            return Ok(Presence::Conflict);
        }
    }
    // Пустой каталог или совпадающий маркер partial — восстановимый прерванный create.
    Ok(Presence::Owned)
}
fn new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn rename_new(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH},
        };
        let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(source, target).map_err(|e| e.to_string())?;
        fs::remove_file(source).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn install(root: &Path, plan: &Journal) -> Result<(), String> {
    if inspect(root, plan)? != Presence::Absent {
        return Err("Каталог EFI уже существует; перезапись запрещена".into());
    }
    let dir = directory(root, plan)?;
    fs::create_dir(&dir).map_err(|e| e.to_string())?;
    new_file(&dir.join(".owner"), &owner(plan))?;
    let partial = dir.join("SecConfig.efi.partial");
    new_file(&partial, &plan.image)?;
    if !inspect_file(&partial, &plan.image, false)? {
        return Err("SHA/содержимое EFI staging не совпадает".into());
    }
    rename_new(&partial, &dir.join("SecConfig.efi"))?;
    if !inspect_file(&dir.join("SecConfig.efi"), &plan.image, false)? {
        return Err("EFI-файл не прошёл итоговую проверку".into());
    }
    Ok(())
}
pub fn remove(root: &Path, plan: &Journal) -> Result<(), String> {
    let dir = directory(root, plan)?;
    match inspect(root, plan)? {
        Presence::Absent => return Ok(()),
        Presence::Conflict => return Err("EFI изменён извне; удаление запрещено".into()),
        Presence::Owned => {}
    }
    for name in ["SecConfig.efi", "SecConfig.efi.partial", ".owner"] {
        if inspect(root, plan)? != Presence::Owned {
            return Err("EFI изменился во время отката".into());
        }
        match fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    // Намеренно без рекурсии: появление чужого файла должно остановить очистку.
    fs::remove_dir(&dir).map_err(|e| format!("Собственный каталог EFI не удалён: {e}"))?;
    if inspect(root, plan)? != Presence::Absent {
        return Err("Удаление EFI не подтверждено".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::uefi_transaction::{digest, BitLocker, Phase, RegistryChange, REGISTRY_TARGETS};
    fn setup() -> (tempfile::TempDir, Journal) {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join("EFI")).unwrap();
        let image = b"MZ harmless test bytes".to_vec();
        let p = Journal {
            version: 1,
            nonce: "5f8a5242b3324fabac840b30f550e019".into(),
            boot_id: "boot".into(),
            loader_id: "{ecab19ae-988a-4527-af8b-e85e5753e5b1}".into(),
            volume_id: r"\\?\Volume{cb8af634-faf2-47ed-9e66-a8d0a1e9d723}\".into(),
            image_sha256: digest(&image),
            image,
            original_sequence: None,
            original_bitlocker: BitLocker::Off,
            registry: vec![RegistryChange {
                path: REGISTRY_TARGETS[2].0.into(),
                name: "Locked".into(),
                original: 1,
            }],
            disable_vbs: true,
            continuation_done: false,
            phase: Phase::Preparing,
        };
        (t, p)
    }
    #[test]
    fn efi_round_trip_leaves_original_system_file_untouched() {
        let (t, p) = setup();
        let old = t.path().join("EFI/Microsoft/Boot");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("SecConfig.efi"), b"original system file").unwrap();
        install(t.path(), &p).unwrap();
        assert_eq!(inspect(t.path(), &p).unwrap(), Presence::Owned);
        remove(t.path(), &p).unwrap();
        assert_eq!(
            fs::read(old.join("SecConfig.efi")).unwrap(),
            b"original system file"
        );
    }
    #[test]
    fn existing_directory_is_never_overwritten() {
        let (t, p) = setup();
        let d = directory(t.path(), &p).unwrap();
        fs::create_dir(&d).unwrap();
        fs::write(d.join("personal.txt"), b"keep").unwrap();
        assert!(install(t.path(), &p).is_err());
        assert!(remove(t.path(), &p).is_err());
        assert_eq!(fs::read(d.join("personal.txt")).unwrap(), b"keep");
    }
    #[test]
    fn externally_modified_image_blocks_cleanup() {
        let (t, p) = setup();
        install(t.path(), &p).unwrap();
        let d = directory(t.path(), &p).unwrap();
        fs::write(d.join("SecConfig.efi"), b"externally modified").unwrap();
        assert!(remove(t.path(), &p).is_err());
        assert!(d.join(".owner").exists());
    }
    #[test]
    fn interrupted_own_file_writes_can_be_cleaned() {
        for marker in [false, true] {
            let (t, p) = setup();
            let d = directory(t.path(), &p).unwrap();
            fs::create_dir(&d).unwrap();
            if marker {
                fs::write(d.join(".owner"), &owner(&p)[..5]).unwrap();
                fs::write(d.join("SecConfig.efi.partial"), &p.image[..7]).unwrap();
            }
            remove(t.path(), &p).unwrap();
            assert!(!d.exists());
        }
    }
    #[test]
    fn unknown_partial_data_is_preserved() {
        let (t, p) = setup();
        let d = directory(t.path(), &p).unwrap();
        fs::create_dir(&d).unwrap();
        fs::write(d.join("SecConfig.efi.partial"), b"foreign bytes").unwrap();
        assert!(remove(t.path(), &p).is_err());
        assert!(d.exists());
    }
    #[test]
    fn deletion_is_idempotent() {
        let (t, p) = setup();
        install(t.path(), &p).unwrap();
        remove(t.path(), &p).unwrap();
        remove(t.path(), &p).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn efi_symlink_is_not_followed() {
        let (t, p) = setup();
        let other = tempfile::tempdir().unwrap();
        let d = directory(t.path(), &p).unwrap();
        std::os::unix::fs::symlink(other.path(), &d).unwrap();
        assert_eq!(inspect(t.path(), &p).unwrap(), Presence::Conflict);
        assert!(remove(t.path(), &p).is_err());
    }
}
