//! Единая политика путей для архивов, манифестов и конечных каталогов Windows.
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

/// Удаляет префикс Windows verbatim (\\?\ или \\?\UNC\) для совместимости путей.
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{stripped}"));
        }
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

pub fn relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 32_000 || value.starts_with(['/', '\\']) {
        return Err("Пустой, абсолютный или слишком длинный относительный путь".into());
    }
    let mut result = PathBuf::new();
    for part in value.split(['/', '\\']) {
        validate_component(part)?;
        result.push(part);
    }
    Ok(result)
}

pub fn validate_component(part: &str) -> Result<(), String> {
    if part.is_empty()
        || part == "."
        || part == ".."
        || part.ends_with(['.', ' '])
        || part.chars().any(|c| {
            c.is_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*' | '/' | '\\')
        })
    {
        return Err(format!("Недопустимый компонент пути: {part:?}"));
    }
    let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || (base.len() == 4
        && (base.starts_with("COM") || base.starts_with("LPT"))
        && matches!(base.as_bytes()[3], b'1'..=b'9'))
        || ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"].contains(&base.as_str())
    {
        return Err(format!("Зарезервированное имя Windows: {part}"));
    }
    Ok(())
}

pub fn validate_absolute(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Требуется абсолютный путь".into());
    }
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                validate_component(value.to_str().ok_or("Некорректная кодировка пути")?)?
            }
            Component::ParentDir | Component::CurDir => {
                return Err("Родительские компоненты пути запрещены".into())
            }
            _ => {}
        }
    }
    // Component скрывает внутренние /./; проверяем исходную строку отдельно.
    if path
        .to_string_lossy()
        .split(['/', '\\'])
        .any(|s| s == "." || s == "..")
    {
        return Err("Точки в абсолютном пути запрещены".into());
    }
    Ok(())
}

pub fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// Корень выбирается доверенным кодом (Known Folder или диалогом), его редирект разрешён.
pub fn root(path: &Path) -> Result<PathBuf, String> {
    validate_absolute(path)?;
    fs::canonicalize(path)
        .map_err(|e| format!("Недоступен корневой каталог {}: {e}", path.display()))
}

/// Разрешённый корень может ещё не существовать на новом компьютере.
pub fn resolve_root(path: &Path) -> Result<PathBuf, String> {
    validate_absolute(path)?;
    if path.exists() {
        return root(path);
    }
    let mut ancestor = path;
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        suffix.push(
            ancestor
                .file_name()
                .ok_or("Не найден существующий родитель")?
                .to_os_string(),
        );
        ancestor = ancestor.parent().ok_or("Не найден родитель корня")?;
    }
    let mut resolved = root(ancestor)?;
    for part in suffix.iter().rev() {
        validate_component(&part.to_string_lossy())?;
        resolved.push(part);
        if let Ok(meta) = fs::symlink_metadata(&resolved) {
            if is_link(&meta) {
                return Err("Ссылка в новом корне".into());
            }
        }
    }
    Ok(resolved)
}

/// Каждый существующий дочерний компонент проверяется без следования ссылкам/junction.
pub fn join(base: &Path, name: &str) -> Result<PathBuf, String> {
    let relative = relative(name)?;
    let base = resolve_root(base)?;
    let mut current = base.clone();
    for part in relative.components() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if is_link(&metadata) => {
                return Err(format!(
                    "Ссылка или junction запрещена: {}",
                    current.display()
                ))
            }
            Ok(_) => {
                let resolved = fs::canonicalize(&current).map_err(|e| e.to_string())?;
                if !resolved.starts_with(&base) {
                    return Err("Путь выходит из разрешённой папки".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "Не удалось проверить путь {}: {e}",
                    current.display()
                ))
            }
        }
    }
    Ok(current)
}

pub fn within(path: &Path, base: &Path) -> bool {
    if validate_absolute(path).is_err() {
        return false;
    }
    let Ok(base_resolved) = resolve_root(base) else {
        return false;
    };
    let relative = path
        .strip_prefix(base)
        .or_else(|_| path.strip_prefix(&base_resolved));
    let Ok(relative) = relative else {
        return false;
    };
    if relative.as_os_str().is_empty() {
        return true;
    }
    join(&base_resolved, &relative.to_string_lossy()).is_ok()
}

pub fn child(base: &Path, path: &Path) -> Result<PathBuf, String> {
    let rel = path
        .strip_prefix(base)
        .map_err(|_| "Путь находится вне разрешённой папки")?;
    join(base, &rel.to_string_lossy())
}

/// Для системных путей не разрешаются даже ссылки в родительских каталогах.
pub fn no_links(path: &Path) -> Result<(), String> {
    validate_absolute(path)?;
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if is_link(&meta) => {
                return Err(format!("Ссылка в системном пути: {}", current.display()))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_windows_traversal_and_devices_on_every_platform() {
        for name in [
            "../a",
            "a/../b",
            "a\\..\\b",
            "C:\\Windows\\x",
            "\\\\server\\share",
            "/x",
            "x:stream",
            "CON.txt",
            "nul",
            "LPT1",
            "x.",
            "x ",
            "a//b",
            "./x",
            "COM¹.txt",
        ] {
            assert!(relative(name).is_err(), "{name}");
        }
        assert_eq!(
            relative("game\\slot 1.sav").unwrap(),
            PathBuf::from("game").join("slot 1.sav")
        );
    }
    #[test]
    fn rejects_sibling_prefix_and_absolute_parent() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        assert!(!within(&temp.path().join("allowed-other/x"), &root));
        assert!(!within(&root.join("../escape"), &root));
        assert!(join(&root, "new/slot.sav").is_ok());
    }
    #[test]
    fn accepts_missing_allowed_root_but_not_sibling() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("Documents/My Games");
        assert!(within(&base.join("Example/slot.sav"), &base));
        assert!(!within(
            &temp.path().join("Documents/My Games-other/slot.sav"),
            &base
        ));
    }
    #[cfg(unix)]
    #[test]
    fn rejects_linked_child() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("link")).unwrap();
        assert!(join(temp.path(), "link/save.dat").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn rejects_junction_child() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = temp.path().join("junction");
        assert!(std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .status()
            .unwrap()
            .success());
        assert!(join(temp.path(), "junction/save.dat").is_err());
        fs::remove_dir(link).unwrap();
    }
}
