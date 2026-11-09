//! Системные обёртки Windows: UAC, диалоги, консоль отладки, Ctrl+C, время.

use std::env;

use windows::{
    core::{w, HSTRING, PCWSTR},
    Win32::{
        Foundation::{CloseHandle, HANDLE, SYSTEMTIME},
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        Storage::FileSystem::{
            CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING,
        },
        System::{
            Console::{
                AllocConsole, AttachConsole, SetConsoleCtrlHandler, SetConsoleOutputCP,
                SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
            },
            SystemInformation::GetLocalTime,
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
        UI::{
            Shell::ShellExecuteW,
            WindowsAndMessaging::{
                MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONWARNING, MB_OK,
                MB_YESNO, SW_SHOWNORMAL,
            },
        },
    },
};

/// Кодовая страница UTF-8 для консоли отладки.
const CP_UTF8: u32 = 65001;

pub const APP_TITLE: &str = "Eclipse-HV";

/// Глобальный признак прерывания работы пользователем (Ctrl+C / закрытие консоли).
static INTERRUPTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Обработчик событий консоли: фиксирует прерывание, не выполняет опасных действий.
unsafe extern "system" fn console_ctrl_handler(_event: u32) -> windows::core::BOOL {
    INTERRUPTED.store(true, std::sync::atomic::Ordering::SeqCst);
    // Событие обработано: основной поток сам выполнит корректную очистку
    windows::core::BOOL(1)
}

pub fn install_interrupt_handler() {
    unsafe {
        if let Err(err) = SetConsoleCtrlHandler(Some(console_ctrl_handler), true) {
            crate::hvlog!(Warn, "система", "не удалось установить обработчик Ctrl+C: {err}");
        }
    }
}

pub fn interrupted() -> bool {
    INTERRUPTED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Проверяет, запущен ли процесс с повышенными привилегиями (UAC).
pub fn is_elevated() -> Result<bool, String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|err| format!("OpenProcessToken: {err}"))?;

        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let result = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );

        // Дескриптор закрывается независимо от результата чтения
        let _ = CloseHandle(token);
        result.map_err(|err| format!("GetTokenInformation: {err}"))?;

        Ok(elevation.TokenIsElevated != 0)
    }
}

/// Перезапускает текущий исполняемый файл с правами администратора (runas).
pub fn elevate_self(args: &[String]) -> Result<(), String> {
    unsafe {
        let exe_path = env::current_exe()
            .map_err(|err| format!("не удалось определить путь к исполняемому файлу: {err}"))?;
        let base_dir = exe_path
            .parent()
            .map(|path| path.to_path_buf())
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")));

        // Аргументы с пробелами экранируются кавычками
        let forward_args: Vec<String> = args
            .iter()
            .skip(1)
            .map(|arg| {
                if arg.contains(' ') {
                    format!("\"{arg}\"")
                } else {
                    arg.clone()
                }
            })
            .collect();
        let args_str = forward_args.join(" ");

        let exe_handle = HSTRING::from(exe_path.to_string_lossy().as_ref());
        let dir_handle = HSTRING::from(base_dir.to_string_lossy().as_ref());
        let args_handle = HSTRING::from(args_str);

        let result = ShellExecuteW(
            None,
            w!("runas"),
            &exe_handle,
            if forward_args.is_empty() {
                PCWSTR::null()
            } else {
                PCWSTR(args_handle.as_ptr())
            },
            &dir_handle,
            SW_SHOWNORMAL,
        );

        if result.0 as usize > 32 {
            Ok(())
        } else {
            Err(format!(
                "ShellExecuteW вернул код ошибки: {}",
                result.0 as usize
            ))
        }
    }
}

pub fn ask_user_yes_no(title: &str, message: &str) -> bool {
    unsafe {
        let title_handle = HSTRING::from(title);
        let message_handle = HSTRING::from(message);
        let result = MessageBoxW(
            None,
            PCWSTR(message_handle.as_ptr()),
            PCWSTR(title_handle.as_ptr()),
            MB_YESNO | MB_ICONWARNING,
        );
        result == IDYES
    }
}

pub fn show_info_box(title: &str, message: &str) {
    unsafe {
        let title_handle = HSTRING::from(title);
        let message_handle = HSTRING::from(message);
        MessageBoxW(
            None,
            PCWSTR(message_handle.as_ptr()),
            PCWSTR(title_handle.as_ptr()),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}

pub fn show_error_box(title: &str, message: &str) {
    unsafe {
        let title_handle = HSTRING::from(title);
        let message_handle = HSTRING::from(message);
        MessageBoxW(
            None,
            PCWSTR(message_handle.as_ptr()),
            PCWSTR(title_handle.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
}

/// Инициализирует консоль отладки: подключение к родительской консоли либо
/// создание новой с кодовой страницей UTF-8.
pub fn init_debug_console() {
    unsafe {
        let attached = AttachConsole(ATTACH_PARENT_PROCESS).is_ok();
        if !attached {
            let _ = AllocConsole();
        }

        // Дескрипторы на CONOUT$: вывод println! работает даже после GUI-подсистемы
        if let Ok(handle) = CreateFileW(
            w!("CONOUT$"),
            FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        ) {
            let _ = SetStdHandle(STD_OUTPUT_HANDLE, handle);
            let _ = SetStdHandle(STD_ERROR_HANDLE, handle);
        }

        // UTF-8 для корректного отображения кириллицы в консоли
        let _ = SetConsoleOutputCP(CP_UTF8);
    }
}

pub fn open_path(path: &std::path::Path) {
    unsafe {
        let path_handle = HSTRING::from(path.to_string_lossy().as_ref());
        let _ = ShellExecuteW(
            None,
            w!("open"),
            &path_handle,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    }
}

/// Только по явному выбору пользователя в диалоге.
pub fn open_uri(uri: &str) {
    unsafe {
        let uri_handle = HSTRING::from(uri);
        let _ = ShellExecuteW(
            None,
            w!("open"),
            &uri_handle,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    }
}

/// Возвращает текущее локальное время в формате `ГГГГ-ММ-ДД ЧЧ:ММ:СС.мсмс`.
pub fn timestamp() -> String {
    unsafe {
        let time: SYSTEMTIME = GetLocalTime();
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond,
            time.wMilliseconds
        )
    }
}

/// Значение больше 7 — расширенные состояния процессора (AVX-512, Zen 4+),
/// требующие ограничение размера контекста в BCD.
pub fn read_xcr0() -> u32 {
    // KUSER_SHARED_DATA отображается в пользовательский режим по фиксированному адресу
    let pointer = 0x7FFE03D8 as *const u32;
    unsafe { *pointer }
}

pub fn os_description() -> String {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let version_key = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(version_key) else {
        return "Windows (сведения недоступны)".to_string();
    };

    let product: String = key.get_value("ProductName").unwrap_or_else(|_| "Windows".into());
    let display: String = key.get_value("DisplayVersion").unwrap_or_default();
    let build: String = key
        .get_value("CurrentBuildNumber")
        .unwrap_or_else(|_| "?".into());

    if display.is_empty() {
        format!("{product} (сборка {build})")
    } else {
        format!("{product} {display} (сборка {build})")
    }
}

pub fn app_name_with_version() -> String {
    format!("{APP_TITLE} v{}", env!("CARGO_PKG_VERSION"))
}
