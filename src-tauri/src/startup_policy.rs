//! Политика elevation при старте. Ничего не изменяет: ни UAC, ни реестр, ни токен.
use std::sync::atomic::{AtomicBool, Ordering};

pub fn enabled(value: Option<&str>) -> Result<bool, String> {
    match value {
        None | Some("1") => Ok(true),
        Some("0") => Ok(false),
        Some(_) => Err(
            "Некорректная настройка запуска от администратора; автоматический перезапуск пропущен"
                .into(),
        ),
    }
}

pub fn first_check(checked: &AtomicBool) -> bool {
    checked
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

pub fn needs_elevation(enabled: bool, elevated: bool, handoff: bool, update_launch: bool) -> bool {
    enabled && !elevated && !handoff && !update_launch
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enabled_by_default_and_explicitly_disableable() {
        assert_eq!(enabled(None), Ok(true));
        assert_eq!(enabled(Some("1")), Ok(true));
        assert_eq!(enabled(Some("0")), Ok(false));
        for value in ["", "true", "false", "2", "runas"] {
            assert!(enabled(Some(value)).is_err());
        }
    }
    #[test]
    fn once_per_process_even_after_cancel_or_reload() {
        let checked = AtomicBool::new(false);
        assert!(first_check(&checked));
        assert!(!first_check(&checked));
        assert!(!first_check(&checked));
    }
    #[test]
    fn exactly_one_concurrent_startup_check() {
        let checked = std::sync::Arc::new(AtomicBool::new(false));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let checked = checked.clone();
                std::thread::spawn(move || first_check(&checked))
            })
            .collect();
        let count = workers
            .into_iter()
            .filter_map(|w| w.join().ok())
            .filter(|v| *v)
            .count();
        assert_eq!(count, 1);
    }
    #[test]
    fn elevated_handoff_and_update_probe_never_relaunch() {
        assert!(needs_elevation(true, false, false, false));
        assert!(!needs_elevation(false, false, false, false));
        assert!(!needs_elevation(true, true, false, false));
        assert!(!needs_elevation(true, false, true, false));
        assert!(!needs_elevation(true, false, false, true));
    }
}
