//! Вторая копия не получает доступ к общим файлам и пользовательскому состоянию.

use std::ffi::OsStr;

fn launch_timeout(args: impl IntoIterator<Item = impl AsRef<OsStr>>) -> u32 {
    if args
        .into_iter()
        .any(|arg| arg.as_ref() == "--elevated-handoff")
    {
        30_000
    } else {
        0
    }
}

#[cfg(windows)]
mod native {
    use std::{marker::PhantomData, rc::Rc};
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
        },
    };

    const NAME: &str = r"Global\EclipseStudioInstance-v1";

    pub struct Guard {
        handle: HANDLE,
        // Мьютекс освобождается в том же потоке, где был захвачен.
        _thread: PhantomData<Rc<()>>,
    }

    impl Guard {
        pub fn for_launch() -> Result<Self, String> {
            Self::named(NAME, super::launch_timeout(std::env::args_os()))
        }

        fn named(name: &str, timeout: u32) -> Result<Self, String> {
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            let handle =
                unsafe { CreateMutexW(None, false, PCWSTR(wide.as_ptr())) }.map_err(|error| {
                    format!("Не удалось проверить другую копию Eclipse Studio: {error}")
                })?;
            let result = unsafe { WaitForSingleObject(handle, timeout) };
            if result == WAIT_OBJECT_0 || result == WAIT_ABANDONED {
                return Ok(Self {
                    handle,
                    _thread: PhantomData,
                });
            }
            let error = if result == WAIT_TIMEOUT {
                "Eclipse Studio уже запущен. Используйте открытое окно или сначала закройте другую копию."
                    .to_string()
            } else {
                format!(
                    "Не удалось получить блокировку Eclipse Studio: {}",
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

        #[test]
        fn subprocess_probe() {
            let Ok(name) = std::env::var("ECLIPSE_INSTANCE_LOCK_TEST_NAME") else {
                return;
            };
            assert_eq!(
                Guard::named(&name, 0).is_ok(),
                std::env::var("ECLIPSE_INSTANCE_LOCK_TEST_EXPECT").unwrap() == "allowed"
            );
        }

        #[test]
        fn excludes_another_process_until_the_first_exits() {
            let name = format!(
                r"Global\EclipseStudioInstanceFixture-{}",
                uuid::Uuid::new_v4()
            );
            let guard = Guard::named(&name, 0).unwrap();
            let probe = |expected: &str| {
                assert!(std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "instance_lock::native::tests::subprocess_probe"])
                    .env("ECLIPSE_INSTANCE_LOCK_TEST_NAME", &name)
                    .env("ECLIPSE_INSTANCE_LOCK_TEST_EXPECT", expected)
                    .status()
                    .unwrap()
                    .success());
            };
            probe("blocked");
            drop(guard);
            probe("allowed");
        }

        #[test]
        fn handoff_waits_for_the_previous_owner() {
            let name = format!(
                r"Global\EclipseStudioHandoffFixture-{}",
                uuid::Uuid::new_v4()
            );
            let guard = Guard::named(&name, 0).unwrap();
            let (ready, started) = std::sync::mpsc::channel();
            let (acquired, received) = std::sync::mpsc::channel();
            let waiting = std::thread::spawn(move || {
                assert!(Guard::named(&name, 0).is_err());
                ready.send(()).unwrap();
                let guard = Guard::named(&name, 5_000).unwrap();
                acquired.send(()).unwrap();
                drop(guard);
            });
            started
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert!(matches!(
                received.recv_timeout(std::time::Duration::from_millis(50)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
            drop(guard);
            received
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            waiting.join().unwrap();
        }
    }
}

#[cfg(windows)]
pub use native::Guard;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_launch_never_waits_or_bypasses_the_lock() {
        assert_eq!(launch_timeout(["eclipse.exe"]), 0);
        assert_eq!(launch_timeout(["eclipse.exe", "--eclipse-update-probe"]), 0);
    }

    #[test]
    fn elevation_handoff_waits_without_bypassing_the_lock() {
        assert_eq!(
            launch_timeout(["eclipse.exe", "--elevated-handoff"]),
            30_000
        );
    }
}
