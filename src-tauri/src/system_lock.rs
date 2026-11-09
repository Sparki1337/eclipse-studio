//! Один мьютекс ядра для системных заданий Windows во всех процессах и сессиях.
//! Ожидание другой копии не допускается: отказ до первого изменения.
use std::{marker::PhantomData, path::PathBuf, rc::Rc};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
    },
};

const NAME: &str = r"Global\EclipseStudioWindowsSystem-v1";

// ReleaseMutex обязан выполняться в захватившем потоке; Rc-фантом намеренно запрещает Send/Sync.
pub struct Guard {
    handle: HANDLE,
    _thread: PhantomData<Rc<()>>,
}
impl Guard {
    pub fn for_resources(resources: &[PathBuf]) -> Result<Option<Self>, String> {
        if resources.iter().any(|p| {
            p.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("windows-system.lock"))
        }) {
            Self::named(NAME).map(Some)
        } else {
            Ok(None)
        }
    }

    fn named(name: &str) -> Result<Self, String> {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(wide.as_ptr())) }
            .map_err(|e| format!("Не удалось открыть общую блокировку Windows: {e}"))?;
        let result = unsafe { WaitForSingleObject(handle, 0) };
        if result == WAIT_OBJECT_0 || result == WAIT_ABANDONED {
            return Ok(Self {
                handle,
                _thread: PhantomData,
            });
        }
        let error = if result == WAIT_TIMEOUT {
            "Параметры Windows уже меняются другой копией Eclipse. Дождитесь завершения операции."
                .to_string()
        } else {
            format!(
                "Не удалось получить общую блокировку Windows: {}",
                std::io::Error::last_os_error()
            )
        };
        let _ = unsafe { CloseHandle(handle) };
        Err(error)
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = unsafe { ReleaseMutex(self.handle) };
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn name() -> String {
        format!(
            r"Global\EclipseStudioSystemFixture-{}",
            uuid::Uuid::new_v4()
        )
    }
    #[test]
    fn kernel_mutex_is_reentrant_but_excludes_other_threads() {
        let name = name();
        let outer = Guard::named(&name).unwrap();
        let inner = Guard::named(&name).unwrap();
        let probe = name.clone();
        assert!(std::thread::spawn(move || Guard::named(&probe).is_err())
            .join()
            .unwrap());
        drop(inner);
        let probe = name.clone();
        assert!(std::thread::spawn(move || Guard::named(&probe).is_err())
            .join()
            .unwrap());
        drop(outer);
        assert!(std::thread::spawn(move || Guard::named(&name).is_ok())
            .join()
            .unwrap());
    }
    #[test]
    fn unrelated_file_jobs_do_not_acquire_the_system_mutex() {
        assert!(Guard::for_resources(&[PathBuf::from(r"C:\fixture\game")])
            .unwrap()
            .is_none());
    }
    #[test]
    fn subprocess_probe() {
        let Ok(name) = std::env::var("ECLIPSE_SYSTEM_LOCK_TEST_NAME") else {
            return;
        };
        let acquired = Guard::named(&name).is_ok();
        assert_eq!(
            acquired,
            std::env::var("ECLIPSE_SYSTEM_LOCK_TEST_EXPECT").unwrap() == "allowed"
        );
    }
    #[test]
    fn kernel_mutex_excludes_another_process_and_releases_after_drop() {
        let name = name();
        let guard = Guard::named(&name).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "system_lock::tests::subprocess_probe"])
            .env("ECLIPSE_SYSTEM_LOCK_TEST_NAME", &name)
            .env("ECLIPSE_SYSTEM_LOCK_TEST_EXPECT", "blocked")
            .status()
            .unwrap();
        assert!(status.success());
        drop(guard);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "system_lock::tests::subprocess_probe"])
            .env("ECLIPSE_SYSTEM_LOCK_TEST_NAME", name)
            .env("ECLIPSE_SYSTEM_LOCK_TEST_EXPECT", "allowed")
            .status()
            .unwrap();
        assert!(status.success());
    }
}
