//! Проверяемые копии и атомарная замена в том же каталоге без удаления оригинала.
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

pub fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|e| format!("Не удалось прочитать {}: {e}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub fn replace(staged: &Path, target: &Path) -> Result<(), String> {
    if staged.parent() != target.parent() {
        return Err("Атомарная замена требует одного каталога".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };
        let source: Vec<u16> = staged.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(destination.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|e| format!("Не удалось атомарно заменить {}: {e}", target.display()))?;
    }
    #[cfg(not(windows))]
    fs::rename(staged, target)
        .map_err(|e| format!("Не удалось атомарно заменить {}: {e}", target.display()))?;
    #[cfg(unix)]
    if let Some(parent) = target.parent() {
        fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    write_via(
        target,
        |file| file.write_all(bytes),
        |path| {
            if fs::read(path).map_err(|e| e.to_string())? != bytes {
                return Err("Проверка записанного файла не пройдена".into());
            }
            Ok(())
        },
    )
}
fn write_via(
    target: &Path,
    writer: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
    verify: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or("У файла нет родительского каталога")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    writer(temporary.as_file_mut())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|e| format!("Не удалось сохранить данные: {e}"))?;
    verify(temporary.path())?;
    replace(temporary.path(), target)
}

pub fn copy(source: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or("У файла нет родительского каталога")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    fs::copy(source, temporary.path())
        .map_err(|e| format!("Не удалось подготовить копию {}: {e}", source.display()))?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    let hash = hash_file(source)?;
    if hash_file(temporary.path())? != hash {
        return Err("SHA-256 копии не совпадает с оригиналом".into());
    }
    replace(temporary.path(), target)?;
    if hash_file(target)? != hash {
        return Err("SHA-256 конечного файла не совпадает".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_full_or_interruption_before_commit_keeps_original() {
        for kind in [
            std::io::ErrorKind::StorageFull,
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::Interrupted,
        ] {
            let temp = tempfile::tempdir().unwrap();
            let target = temp.path().join("save.zip");
            fs::write(&target, b"verified-old-archive").unwrap();
            let result = write_via(
                &target,
                |file| {
                    file.write_all(b"partial-new-data")?;
                    Err(std::io::Error::from(kind))
                },
                |_| Ok(()),
            );
            assert!(result.is_err());
            assert_eq!(fs::read(&target).unwrap(), b"verified-old-archive");
            assert_eq!(
                fs::read_dir(temp.path()).unwrap().count(),
                1,
                "временный файл должен быть очищен"
            );
        }
    }
    #[test]
    fn failed_copy_keeps_previous_file() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("archive.zip");
        fs::write(&target, b"old").unwrap();
        assert!(copy(&temp.path().join("missing"), &target).is_err());
        assert_eq!(fs::read(target).unwrap(), b"old");
    }
    #[test]
    fn same_length_corruption_is_detected() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        fs::write(&a, b"aaaa").unwrap();
        fs::write(&b, b"bbbb").unwrap();
        assert_ne!(hash_file(&a).unwrap(), hash_file(&b).unwrap());
        copy(&a, &b).unwrap();
        assert_eq!(hash_file(&a).unwrap(), hash_file(&b).unwrap());
    }
    #[test]
    fn replacement_does_not_delete_target_on_error() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("old");
        fs::write(&target, b"keep").unwrap();
        assert!(replace(&temp.path().join("missing"), &target).is_err());
        assert_eq!(fs::read(target).unwrap(), b"keep");
    }
}
