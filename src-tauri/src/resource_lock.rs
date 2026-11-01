//! Блокировка пересекающихся ресурсов: родительская и дочерняя папки конфликтуют.
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
};
struct Entry {
    id: String,
    resources: Vec<PathBuf>,
    owner: std::thread::ThreadId,
}
static LOCKS: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();
static HANDOFF: AtomicBool = AtomicBool::new(false);
pub struct HandoffGuard;
impl Drop for HandoffGuard {
    fn drop(&mut self) {
        HANDOFF.store(false, Ordering::SeqCst);
    }
}
/// Между проверкой занятости и перезапуском новые изменения не допускаются.
pub fn begin_handoff() -> Result<HandoffGuard, String> {
    let locks = registry().lock().map_err(|_| "Ошибка блокировок")?;
    if !locks.is_empty() || HANDOFF.swap(true, Ordering::SeqCst) {
        return Err(
            "Дождитесь завершения текущих заданий перед перезапуском с правами администратора"
                .into(),
        );
    }
    Ok(HandoffGuard)
}
fn registry() -> &'static Mutex<Vec<Entry>> {
    LOCKS.get_or_init(|| Mutex::new(Vec::new()))
}
fn identity(path: &Path) -> Result<PathBuf, String> {
    crate::safe_path::validate_absolute(path)?;
    let mut existing = path;
    let mut suffix = Vec::new();
    while !existing.exists() {
        suffix.push(
            existing
                .file_name()
                .ok_or("Некорректный ресурс")?
                .to_os_string(),
        );
        existing = existing.parent().ok_or("Ресурс не существует")?;
    }
    let mut result = std::fs::canonicalize(existing).map_err(|e| e.to_string())?;
    for part in suffix.into_iter().rev() {
        result.push(part);
    }
    #[cfg(windows)]
    {
        result = PathBuf::from(result.to_string_lossy().to_lowercase());
    }
    Ok(result)
}
pub struct Guard {
    pub id: String,
    owned: bool,
}
impl Guard {
    pub fn scope(resources: &[PathBuf]) -> Result<Self, String> {
        let normalized = resources
            .iter()
            .map(|p| identity(p))
            .collect::<Result<Vec<_>, _>>()?;
        let thread = std::thread::current().id();
        {
            let locks = registry().lock().map_err(|_| "Ошибка блокировок")?;
            if !normalized.is_empty()
                && normalized.iter().all(|p| {
                    locks
                        .iter()
                        .any(|e| e.owner == thread && e.resources.iter().any(|a| p.starts_with(a)))
                })
            {
                return Ok(Self {
                    id: uuid::Uuid::new_v4().to_string(),
                    owned: false,
                });
            }
        }
        Self::acquire(resources)
    }
    pub fn acquire(resources: &[PathBuf]) -> Result<Self, String> {
        let resources = resources
            .iter()
            .map(|p| identity(p))
            .collect::<Result<Vec<_>, _>>()?;
        let mut locks = registry().lock().map_err(|_| "Ошибка блокировок")?;
        if HANDOFF.load(Ordering::SeqCst) {
            return Err("Приложение перезапускается; новое задание не запущено".into());
        }
        if let Some(conflict) = locks.iter().find(|active| {
            active.resources.iter().any(|a| {
                resources
                    .iter()
                    .any(|b| a.starts_with(b) || b.starts_with(a))
            })
        }) {
            return Err(format!(
                "Папка уже изменяется заданием {}. Дождитесь завершения.",
                conflict.id
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        locks.push(Entry {
            id: id.clone(),
            resources,
            owner: std::thread::current().id(),
        });
        Ok(Self { id, owned: true })
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        if !self.owned {
            return;
        }
        if let Ok(mut locks) = registry().lock() {
            locks.retain(|entry| entry.id != self.id);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_scopes_do_not_release_outer_lock() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("game");
        let outer = Guard::scope(std::slice::from_ref(&path)).unwrap();
        {
            let _inner = Guard::scope(&[path.join("config")]).unwrap();
        }
        let other = path.clone();
        assert!(
            std::thread::spawn(move || Guard::acquire(&[other]).is_err())
                .join()
                .unwrap()
        );
        assert!(
            Guard::scope(&[temp.path().to_path_buf()]).is_err(),
            "дочерняя блокировка не должна расширяться на родителя"
        );
        drop(outer);
        assert!(Guard::acquire(&[path]).is_ok());
    }
    #[test]
    fn locks_overlap_but_not_siblings_and_release_on_error() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        let guard = Guard::acquire(std::slice::from_ref(&a)).unwrap();
        assert!(Guard::acquire(&[a.join("nested")]).is_err());
        assert!(Guard::acquire(&[temp.path().to_path_buf()]).is_err());
        assert!(Guard::acquire(&[b]).is_ok());
        drop(guard);
        assert!(Guard::acquire(&[a]).is_ok());
    }
}
