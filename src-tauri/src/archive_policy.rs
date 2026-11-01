//! Все распаковщики используют одинаковую политику; небезопасный CLI-fallback запрещён.
use crate::safe_path;
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::Path,
};
pub const MAX_FILES: usize = 250_000;
pub const MAX_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const MAX_RAR_FILE: u64 = 256 * 1024 * 1024;
#[derive(Default)]
struct Budget {
    names: BTreeSet<String>,
    files: BTreeSet<String>,
    bytes: u64,
}
impl Budget {
    fn add(&mut self, name: &str, size: u64, directory: bool) -> Result<String, String> {
        let name = name.trim_end_matches(['/', '\\']);
        let path = safe_path::relative(name)?;
        let normalized = path.to_string_lossy().replace('\\', "/");
        let key = normalized.to_lowercase();
        if self.names.len() >= MAX_FILES || !self.names.insert(key.clone()) {
            return Err("Слишком много записей или повторяющееся имя в архиве".into());
        }
        let mut prefix = String::new();
        for part in key.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            if prefix != key && self.files.contains(&prefix) {
                return Err("Файл подменяет каталог в архиве".into());
            }
        }
        if !directory {
            if self
                .names
                .iter()
                .any(|n| n.starts_with(&(key.clone() + "/")))
            {
                return Err("Каталог подменяется файлом в архиве".into());
            }
            self.files.insert(key);
        }
        self.bytes = self
            .bytes
            .checked_add(size)
            .ok_or("Переполнение размера архива")?;
        if self.bytes > MAX_BYTES {
            return Err("Распакованный архив превышает 10 ГБ".into());
        }
        Ok(normalized)
    }
}
fn regular_mode(mode: Option<u32>) -> bool {
    mode.is_none_or(|mode| matches!(mode & 0o170000, 0 | 0o100000 | 0o040000))
}
pub fn extract(archive: &Path, destination: &Path, password: Option<&str>) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    match archive
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "zip" => zip_extract(archive, destination, password),
        "rar" => rar_extract(archive, destination, password),
        _ => Err(
            "Поддерживаются только ZIP и RAR. Внешняя распаковка без проверки отключена.".into(),
        ),
    }?;
    validate_tree(destination)
}
pub fn zip_extract(path: &Path, dest: &Path, password: Option<&str>) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Повреждён ZIP: {e}"))?;
    let mut budget = Budget::default();
    // Полная проверка заголовков выполняется до первой записи.
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(|e| e.to_string())?;
        if !regular_mode(entry.unix_mode()) {
            return Err("Ссылки и специальные файлы в ZIP запрещены".into());
        }
        budget.add(entry.name(), entry.size(), entry.is_dir())?;
        if entry.size() > 1024 * 1024 && entry.size() / entry.compressed_size().max(1) > 1000 {
            return Err("Слишком высокая степень сжатия ZIP".into());
        }
    }
    for i in 0..archive.len() {
        let mut entry = if let Some(password) = password {
            archive.by_index_decrypt(i, password.as_bytes())
        } else {
            archive.by_index(i)
        }
        .map_err(|e| format!("Не удалось прочитать ZIP (проверьте пароль): {e}"))?;
        let name = entry.name().trim_end_matches(['/', '\\']).to_string();
        let target = safe_path::join(dest, &name)?;
        if entry.is_dir() {
            fs::create_dir_all(target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| e.to_string())?;
        let size = entry.size();
        let copied = std::io::copy(&mut (&mut entry).take(size.saturating_add(1)), &mut output)
            .map_err(|e| format!("ZIP/CRC: {e}"))?;
        if copied != size {
            return Err("Размер записи ZIP не совпадает с заголовком".into());
        }
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn rar_extract(path: &Path, dest: &Path, password: Option<&str>) -> Result<(), String> {
    let mut archive = unrar::Archive::with_password(path, password.unwrap_or(""))
        .open_for_processing()
        .map_err(|e| format!("Не удалось открыть RAR: {e}"))?;
    let mut budget = Budget::default();
    while let Some(header) = archive.read_header().map_err(|e| format!("RAR: {e}"))? {
        let entry = header.entry();
        if entry.is_split() || entry.file_attr & 0x400 != 0 || !regular_mode(Some(entry.file_attr))
        {
            return Err("Многотомные RAR, ссылки и специальные файлы запрещены".into());
        }
        let name = budget.add(
            &entry.filename.to_string_lossy(),
            entry.unpacked_size,
            entry.is_directory(),
        )?;
        let target = safe_path::join(dest, &name)?;
        if entry.is_directory() {
            fs::create_dir_all(target).map_err(|e| e.to_string())?;
            archive = header.skip().map_err(|e| e.to_string())?;
            continue;
        }
        if entry.unpacked_size > MAX_RAR_FILE {
            return Err(
                "Одна запись RAR превышает 256 МБ; используйте ZIP для крупных файлов".into(),
            );
        }
        let size = entry.unpacked_size;
        // Библиотека не получает конечный путь и не может создать ссылку из RAR.
        let (bytes, next) = header
            .read()
            .map_err(|e| format!("Ошибка данных или CRC RAR: {e}"))?;
        if bytes.len() as u64 != size {
            return Err("Размер записи RAR не совпадает с заголовком".into());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|e| e.to_string())?;
        output
            .write_all(&bytes)
            .and_then(|_| output.sync_all())
            .map_err(|e| e.to_string())?;
        archive = next;
    }
    Ok(())
}
pub fn validate_tree(root: &Path) -> Result<(), String> {
    let mut bytes = 0u64;
    let mut count = 0usize;
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path() == root {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if safe_path::is_link(&metadata) || !(metadata.is_dir() || metadata.is_file()) {
            return Err("Ссылки и специальные файлы после распаковки запрещены".into());
        }
        safe_path::child(root, entry.path())?;
        count += 1;
        bytes = bytes
            .checked_add(if metadata.is_file() {
                metadata.len()
            } else {
                0
            })
            .ok_or("Переполнение размера")?;
        if count > MAX_FILES || bytes > MAX_BYTES {
            return Err("Превышены ограничения распаковки".into());
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn zip_with(path: &Path, names: &[&str]) {
        let mut z = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for name in names {
            z.start_file(
                *name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
            z.write_all(b"data").unwrap();
        }
        z.finish().unwrap();
    }
    #[test]
    fn rejects_traversal_and_case_aliases_before_writing() {
        for names in [
            vec!["good", "../outside"],
            vec!["A", "a"],
            vec!["dir\\..\\outside"],
            vec!["nul.txt"],
            vec!["a", "a/b"],
        ] {
            let temp = tempfile::tempdir().unwrap();
            let zip = temp.path().join("x.zip");
            let out = temp.path().join("out");
            fs::create_dir(&out).unwrap();
            zip_with(&zip, &names);
            assert!(zip_extract(&zip, &out, None).is_err());
            assert_eq!(fs::read_dir(out).unwrap().count(), 0);
        }
    }
    #[test]
    fn extracts_valid_zip_and_checks_crc() {
        let temp = tempfile::tempdir().unwrap();
        let zip = temp.path().join("x.zip");
        let out = temp.path().join("out");
        fs::create_dir(&out).unwrap();
        zip_with(&zip, &["game/slot.dat"]);
        zip_extract(&zip, &out, None).unwrap();
        assert_eq!(fs::read(out.join("game/slot.dat")).unwrap(), b"data");
    }
    #[test]
    fn corrupt_payload_fails_crc_validation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bad.zip");
        zip_with(&path, &["slot.sav"]);
        let mut bytes = fs::read(&path).unwrap();
        let position = bytes.windows(4).position(|w| w == b"data").unwrap();
        bytes[position] ^= 1;
        fs::write(&path, bytes).unwrap();
        let out = temp.path().join("out");
        fs::create_dir(&out).unwrap();
        assert!(zip_extract(&path, &out, None).is_err());
    }
}
