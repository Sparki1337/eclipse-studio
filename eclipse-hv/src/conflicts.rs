//! Нейтрализация конфликтующих программ (Vanguard, MSI Afterburner, RTSS) и их восстановление.

use std::path::PathBuf;

use crate::{hvlog, process};

/// Состояние нейтрализованных конфликтов для последующего восстановления.
#[derive(Debug, Clone, Default)]
pub struct ConflictState {
    pub vanguard_detected: bool,
    pub msi_detected: bool,
    pub msi_path: Option<PathBuf>,
    pub rtss_stopped: bool,
}

/// Остаточные службы блокируют загрузку драйвера мониторинга.
pub fn cleanup_driver_services() {
    hvlog!(Debug, "конфликты", "очистка остаточных служб RTCore64 / RTCoreMini64");
    let _ = process::run_capture("sc.exe", &["stop", "RTCore64"]);
    let _ = process::run_capture("sc.exe", &["delete", "RTCore64"]);
    let _ = process::run_capture("sc.exe", &["stop", "RTCoreMini64"]);
}

pub fn neutralize() -> ConflictState {
    let mut state = ConflictState::default();

    // Vanguard: остановка служб и трея во избежание системного сбоя
    let _ = process::run_capture("net.exe", &["stop", "vgc", "/y"]);
    let _ = process::run_capture("net.exe", &["stop", "vgk", "/y"]);
    let vanguard_killed = process::run_capture("taskkill.exe", &["/IM", "vgtray.exe", "/F"]);
    if vanguard_killed.is_ok_and(|out| out.status.success()) {
        state.vanguard_detected = true;
        hvlog!(Info, "конфликты", "трей Vanguard остановлен во избежание системного сбоя");
    }

    // MSI Afterburner: определение пути, остановка, автоперезапуск после игры
    if process::process_is_running("MSIAfterburner.exe") {
        state.msi_detected = true;
        hvlog!(Info, "конфликты", "обнаружен работающий MSI Afterburner, определение пути и остановка");

        state.msi_path = detect_msi_afterburner_path();
        process::terminate_process_and_wait("MSIAfterburner.exe", 3000);

        match state.msi_path.as_ref() {
            Some(path) => {
                hvlog!(Info, "конфликты", "путь MSI Afterburner сохранён для автоперезапуска: {}", path.display());
            }
            None => {
                hvlog!(Warn, "конфликты", "путь к MSI Afterburner не удалось определить автоматически");
            }
        }
    }

    // RivaTuner Statistics Server и связанные перехватчики
    let rtss_running = process::process_is_running("RTSS.exe");
    process::terminate_process_and_wait("RTSS.exe", 2000);
    process::terminate_process_and_wait("EncoderServer.exe", 1000);
    process::terminate_process_and_wait("RTSSHooksLoader64.exe", 1000);
    state.rtss_stopped = rtss_running;
    if rtss_running {
        hvlog!(Info, "конфликты", "RivaTuner Statistics Server остановлен");
    }

    // Очистка служб драйверов до захвата ресурсов
    cleanup_driver_services();

    // Пауза для окончательного освобождения дескрипторов драйверов ядром
    std::thread::sleep(std::time::Duration::from_millis(500));

    state
}

pub fn restart_msi(state: &ConflictState) {
    if let Some(path) = state.msi_path.as_ref() {
        hvlog!(Info, "конфликты", "перезапуск MSI Afterburner: {}", path.display());
        if let Err(err) = process::spawn_detached(path) {
            hvlog!(Warn, "конфликты", "не удалось перезапустить MSI Afterburner: {err}");
        }
    }
}

/// Путь ищется в активном процессе, реестре и стандартных каталогах установки.
fn detect_msi_afterburner_path() -> Option<PathBuf> {
    // Путь из запущенного процесса
    let ps_command =
        "(Get-Process -Name 'MSIAfterburner' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)";
    if let Ok(out) = process::run_capture(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_command],
    ) {
        let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path_str.is_empty() {
            let path = PathBuf::from(&path_str);
            if path.is_file() {
                return Some(path);
            }
        }
    }

    // Путь установки из реестра
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let registry_paths = [
        r"SOFTWARE\WOW6432Node\MSI\Afterburner",
        r"SOFTWARE\MSI\Afterburner",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\MSI Afterburner",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MSI Afterburner",
    ];

    for registry_path in registry_paths {
        if let Ok(key) = hklm.open_subkey(registry_path) {
            for value_name in ["InstallPath", "InstallLocation"] {
                if let Ok(value) = key.get_value::<String, _>(value_name) {
                    let path = PathBuf::from(&value).join("MSIAfterburner.exe");
                    if path.is_file() {
                        return Some(path);
                    }
                }
            }
        }
    }

    // Стандартные каталоги установки на типичных дисках
    let candidates = [
        r"C:\Program Files (x86)\MSI Afterburner\MSIAfterburner.exe",
        r"C:\Program Files\MSI Afterburner\MSIAfterburner.exe",
        r"D:\Program Files (x86)\MSI Afterburner\MSIAfterburner.exe",
        r"D:\MSI Afterburner\MSIAfterburner.exe",
        r"E:\Program Files (x86)\MSI Afterburner\MSIAfterburner.exe",
        r"E:\MSI Afterburner\MSIAfterburner.exe",
    ];

    candidates.iter().map(PathBuf::from).find(|path| path.is_file())
}
