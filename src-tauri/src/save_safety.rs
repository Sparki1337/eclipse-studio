//! Общие проверки источников и неизменяемая история перед откатом сохранений.
use std::{
    fs,
    path::{Path, PathBuf},
};

fn path_key(path: &Path) -> String {
    crate::safe_path::strip_verbatim(path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn overlaps(left: &str, right: &str) -> bool {
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

/// Проверяется до обхода файлов и до создания архива. Ссылки корня разрешаются
/// так же, как в safe_path::root, поэтому алиасы одной папки не обходят проверку.
pub fn validate_sources(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() || paths.len() > 256 {
        return Err("Выберите от 1 до 256 папок".into());
    }
    let mut sources: Vec<(PathBuf, String)> = Vec::with_capacity(paths.len());
    for raw in paths {
        let source = crate::safe_path::root(Path::new(raw))?;
        if !source.is_dir() {
            return Err(format!("Источник не является папкой: {}", source.display()));
        }
        let key = path_key(&source);
        if let Some((other, _)) = sources
            .iter()
            .find(|(_, previous)| overlaps(&key, previous))
        {
            return Err(format!(
                "Выбраны пересекающиеся папки: {} и {}. Оставьте только родительскую папку.",
                other.display(),
                source.display()
            ));
        }
        sources.push((source, key));
    }
    Ok(())
}

/// Каждая различающаяся версия получает собственное имя. Ни первая попытка,
/// ни повтор частичного отката не перезаписывают прежнюю защитную копию.
/// Старые `before-undo/<index>` также остаются нетронутыми.
pub fn capture_before_undo(backup: &Path, index: usize, target: &Path) -> Result<(), String> {
    if !target.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let expected = crate::durable::hash_file(target)?;
    let safety = crate::safe_path::join(backup, &format!("before-undo/{index}-{expected}"))?;
    match fs::symlink_metadata(&safety) {
        Ok(metadata) => {
            if !metadata.is_file()
                || crate::safe_path::is_link(&metadata)
                || crate::durable::hash_file(&safety)? != expected
            {
                return Err("Защитная копия перед откатом повреждена; перезапись запрещена".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            crate::durable::copy(target, &safety)?;
            if crate::durable::hash_file(&safety)? != expected {
                return Err(
                    "Сохранение изменилось во время создания защитной копии; откат остановлен"
                        .into(),
                );
            }
        }
        Err(error) => return Err(error.to_string()),
    }
    if crate::durable::hash_file(target)? != expected {
        return Err(
            "Сохранение изменилось во время подготовки отката. Закройте игру и повторите".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_and_duplicate_sources_are_rejected_in_both_orders() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("Game");
        let child = parent.join("Slot1");
        fs::create_dir_all(&child).unwrap();
        let p = parent.to_string_lossy().into_owned();
        let c = child.to_string_lossy().into_owned();
        assert!(validate_sources(&[p.clone(), c.clone()]).is_err());
        assert!(validate_sources(&[c, p.clone()]).is_err());
        assert!(validate_sources(&[p.clone(), p]).is_err());
    }

    #[test]
    fn sibling_prefix_is_not_treated_as_a_nested_folder() {
        let temp = tempfile::tempdir().unwrap();
        let paths: Vec<String> = ["Game", "Game2"]
            .iter()
            .map(|name| {
                let path = temp.path().join(name);
                fs::create_dir_all(&path).unwrap();
                path.to_string_lossy().into_owned()
            })
            .collect();
        validate_sources(&paths).unwrap();
    }

    #[test]
    fn retries_keep_every_distinct_version_and_legacy_safety_copy() {
        let temp = tempfile::tempdir().unwrap();
        let backup = temp.path().join("rollback");
        let target = temp.path().join("slot.sav");
        fs::create_dir_all(backup.join("before-undo")).unwrap();
        fs::write(backup.join("before-undo/0"), b"legacy-progress").unwrap();
        for version in [
            b"new-progress".as_slice(),
            b"old-progress",
            b"later-progress",
            b"new-progress",
        ] {
            fs::write(&target, version).unwrap();
            capture_before_undo(&backup, 0, &target).unwrap();
            let hash = crate::durable::hash_file(&target).unwrap();
            let file = backup.join(format!("before-undo/0-{hash}"));
            assert_eq!(fs::read(file).unwrap(), version);
        }
        let history: Vec<Vec<u8>> = fs::read_dir(backup.join("before-undo"))
            .unwrap()
            .map(|entry| fs::read(entry.unwrap().path()).unwrap())
            .collect();
        assert_eq!(history.len(), 4);
        for version in [
            b"legacy-progress".as_slice(),
            b"new-progress",
            b"old-progress",
            b"later-progress",
        ] {
            assert!(history.iter().any(|saved| saved.as_slice() == version));
        }
    }

    #[test]
    fn damaged_existing_history_is_not_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let backup = temp.path().join("rollback");
        let target = temp.path().join("slot.sav");
        fs::create_dir_all(&backup).unwrap();
        fs::write(&target, b"new-progress").unwrap();
        capture_before_undo(&backup, 3, &target).unwrap();
        let hash = crate::durable::hash_file(&target).unwrap();
        let safety = backup.join(format!("before-undo/3-{hash}"));
        fs::write(&safety, b"damaged").unwrap();
        assert!(capture_before_undo(&backup, 3, &target).is_err());
        assert_eq!(fs::read(&safety).unwrap(), b"damaged");
        assert_eq!(fs::read(&target).unwrap(), b"new-progress");
    }

    #[cfg(unix)]
    #[test]
    fn redirected_history_folder_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let backup = temp.path().join("rollback");
        let outside = temp.path().join("outside");
        let target = temp.path().join("slot.sav");
        fs::create_dir_all(&backup).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(&target, b"progress").unwrap();
        std::os::unix::fs::symlink(&outside, backup.join("before-undo")).unwrap();
        assert!(capture_before_undo(&backup, 0, &target).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }
}
