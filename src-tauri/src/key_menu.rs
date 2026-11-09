//! Подавление пустого SC_KEYMENU от Alt/F10; Alt+Пробел, Alt+F4 и буквенные сочетания сохраняются.

#[cfg_attr(not(windows), allow(dead_code))]
const WM_SYSCOMMAND: u32 = 0x0112;
#[cfg_attr(not(windows), allow(dead_code))]
const SC_KEYMENU: usize = 0xF100;

#[cfg_attr(not(windows), allow(dead_code))]
fn is_bare_key_menu(message: u32, wparam: usize, lparam: isize) -> bool {
    // Младшие четыре бита wParam система использует сама, поэтому сравнивается маска 0xFFF0
    message == WM_SYSCOMMAND && (wparam & 0xFFF0) == SC_KEYMENU && lparam == 0
}

// Подключение к главному окну. Подкласс ставится в потоке окна, как требует Windows
pub(crate) fn install(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || windows_menu::install(&target));
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod windows_menu {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::WM_NCDESTROY,
        },
    };

    // Свой идентификатор подкласса, отдельный от подкласса перетаскивания файлов
    const SUBCLASS_ID: usize = 0x43474B4D;

    pub(super) fn install(window: &tauri::WebviewWindow) {
        let Ok(handle) = window.hwnd() else {
            return;
        };
        unsafe {
            let _ = SetWindowSubclass(HWND(handle.0), Some(key_menu_proc), SUBCLASS_ID, 0);
        }
    }

    unsafe extern "system" fn key_menu_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        subclass_id: usize,
        _data: usize,
    ) -> LRESULT {
        if super::is_bare_key_menu(message, wparam.0, lparam.0) {
            return LRESULT(0);
        }
        if message == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(key_menu_proc), subclass_id);
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::is_bare_key_menu;

    #[test]
    fn only_bare_keyboard_menu_request_is_suppressed() {
        // Одиночный Alt или F10, в том числе с флагами в младших битах
        assert!(is_bare_key_menu(0x0112, 0xF100, 0));
        assert!(is_bare_key_menu(0x0112, 0xF100 | 0x0002, 0));
        // Alt+Пробел открывает системное меню окна
        assert!(!is_bare_key_menu(0x0112, 0xF100, 0x20));
        // Alt с буквой
        assert!(!is_bare_key_menu(0x0112, 0xF100, 0x71));
        // Alt+F4 (SC_CLOSE), сворачивание (SC_MINIMIZE) и само отпускание клавиши (WM_SYSKEYUP)
        assert!(!is_bare_key_menu(0x0112, 0xF060, 0));
        assert!(!is_bare_key_menu(0x0112, 0xF020, 0));
        assert!(!is_bare_key_menu(0x0105, 0x12, 0));
    }
}
