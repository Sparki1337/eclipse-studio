// Eclipse-HV: автономный высокопроизводительный лаунчер игр с обходом Driver Signature Enforcement (DSE)
// и поддержкой Secure Boot на базе встроенного модуля drvloader.
// Разработано для экосистемы Eclipse Studio.

#![windows_subsystem = "windows"]

use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    thread,
    time::Duration,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use windows::{
    core::{w, HSTRING, PCWSTR},
    Win32::{
        Storage::FileSystem::{
            CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING,
        },
        System::Console::{
            AllocConsole, AttachConsole, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE,
            STD_OUTPUT_HANDLE,
        },
        UI::{
            Shell::ShellExecuteW,
            WindowsAndMessaging::{
                MessageBoxW, IDYES, MB_ICONERROR, MB_ICONWARNING, MB_OK, MB_YESNO, SW_SHOWNORMAL,
            },
        },
    },
};

// Флаг создания процесса без создания отдельного окна консоли
const CREATE_NO_WINDOW: u32 = 0x08000000;

// Вшитый в тело лаунчера исполняемый файл drvloader.exe (KernelResearchKit)
const DRVLOADER_BYTES: &[u8] = include_bytes!("../resources/drvloader.exe");

// Приоритетные имена исполняемых файлов гипервизорных загрузчиков
const PRIORITY_LAUNCHER_NAMES: &[&str] = &[
    "hv-startgame.exe",
    "hypervisor-launcher.exe",
    "steamclient_loader_x64.exe",
    "launcher.exe",
    "hypervisorlauncher.exe",
];

// Исключаемые из автопоиска служебные утилиты, краш-репортеры и установщики
const EXCLUDED_EXE_PATTERNS: &[&str] = &[
    "eclipse-hv",
    "hv-launcher",
    "hv-plugnplay",
    "drvloader",
    "kvc",
    "7zr",
    "7z",
    "unitycrashhandler",
    "crashreport",
    "crash_report",
    "crashreporter",
    "werfault",
    "unins",
    "uninstall",
    "setup.exe",
    "installer.exe",
    "vc_redist",
    "dxsetup",
    "epicgames",
    "epicwebhelper",
    "battleye",
    "easyanticheat",
];

// Структура отчёта об ошибке для сериализации в JSON
#[derive(Debug, Serialize)]
struct JsonErrorReport {
    timestamp: String,
    version: String,
    application: String,
    status: String,
    error_step: String,
    error_message: String,
    environment: EnvironmentInfo,
    diagnostic_details: DiagnosticDetails,
}

#[derive(Debug, Serialize)]
struct EnvironmentInfo {
    working_directory: String,
    executable_path: String,
    command_line_args: Vec<String>,
    is_administrator: bool,
    core_isolation_hvci_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
struct DiagnosticDetails {
    target_executable: Option<String>,
    candidate_count: usize,
    vanguard_detected: bool,
    msi_afterburner_detected: bool,
    msi_relaunch_path: Option<String>,
    drvloader_temp_path: Option<String>,
    drvloader_bypass_exit_code: Option<i32>,
    drvloader_restore_exit_code: Option<i32>,
}

// Состояние нейтрализованных конфликтов для последующего перезапуска
#[derive(Debug, Clone, Default)]
struct ConflictState {
    vanguard_detected: bool,
    msi_detected: bool,
    msi_path: Option<PathBuf>,
}

fn main() {
    let args: Vec<String> = env::args().collect();

    // Проверка аргументов отладки: поддерживаем варианты --debug, -debug, /debug, -d, /d
    let debug_mode = args.iter().any(|arg| {
        let lower = arg.trim().to_lowercase();
        lower == "--debug" || lower == "-debug" || lower == "/debug" || lower == "-d" || lower == "/d"
    });

    // Проверка прав администратора: при их отсутствии сразу запрашиваем UAC
    // без инициализации консоли в не-админском процессе (чтобы не двоились окна)
    if !is_admin() {
        if let Err(err) = elevate_self(&args) {
            let details = DiagnosticDetails {
                target_executable: None,
                candidate_count: 0,
                vanguard_detected: false,
                msi_afterburner_detected: false,
                msi_relaunch_path: None,
                drvloader_temp_path: None,
                drvloader_bypass_exit_code: None,
                drvloader_restore_exit_code: None,
            };
            write_and_show_error(
                "UAC_ELEVATION",
                &format!("Не удалось запросить повышение прав администратора: {err}"),
                details,
            );
        }
        return;
    }

    // Если запрошен режим отладки, инициализируем консольный вывод только в повышенном процессе
    if debug_mode {
        init_debug_console();
        println!("============================================================");
        println!("       Eclipse-HV v1.1.0 (Диагностический режим Debug)       ");
        println!("============================================================");
        println!("[OK] Права администратора подтверждены.");
    }

    // Проверка, передан ли прямой путь к исполняемому файлу через аргументы (например, Drag-and-Drop на exe)
    let explicit_target = args.iter().skip(1).find_map(|arg| {
        if arg.starts_with('-') || arg.starts_with('/') {
            return None;
        }
        let p = PathBuf::from(arg);
        if p.is_file() && p.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
            Some(p)
        } else {
            None
        }
    });

    // Определение базовой рабочей папки (каталог, где находится сам Eclipse-HV.exe)
    let base_dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let _ = env::set_current_dir(&base_dir);

    // 1. Проверка изоляции ядра (HVCI), строго по логике эталонного HV-PlugNPlay.bat
    if check_core_isolation() {
        let ask_msg = "В вашей системе Windows включена изоляция ядра (Memory Integrity / HVCI).\n\n\
            Для работы гипервизора и запуска игр с обходом проверки цифровой подписи (DSE) эту защиту необходимо выключить.\n\n\
            Отключить изоляцию ядра в реестре и перезагрузить компьютер прямо сейчас?";

        #[cfg(target_os = "windows")]
        if ask_user_yes_no("Eclipse-HV — Требуется отключение HVCI", ask_msg) {
            if let Err(err) = disable_hvci_and_reboot() {
                let details = DiagnosticDetails {
                    target_executable: None,
                    candidate_count: 0,
                    vanguard_detected: false,
                    msi_afterburner_detected: false,
                    msi_relaunch_path: None,
                    drvloader_temp_path: None,
                    drvloader_bypass_exit_code: None,
                    drvloader_restore_exit_code: None,
                };
                write_and_show_error(
                    "HVCI_DISABLE_FAILED",
                    &format!("Не удалось применить параметры отключения изоляции ядра: {err}"),
                    details,
                );
            }
            return;
        }

        let details = DiagnosticDetails {
            target_executable: None,
            candidate_count: 0,
            vanguard_detected: false,
            msi_afterburner_detected: false,
            msi_relaunch_path: None,
            drvloader_temp_path: None,
            drvloader_bypass_exit_code: None,
            drvloader_restore_exit_code: None,
        };

        let msg = "Изоляция ядра (Memory Integrity / HVCI) осталась включённой в системе Windows.\n\n\
            Для работы гипервизора отключите изоляцию ядра:\n\
            1. В приложении Eclipse Studio (раздел «Гипервизор» -> «VBS 2.0» -> «Выключить визор»)\n\
            2. Либо в «Безопасность Windows» -> «Безопасность устройства» -> «Изоляция ядра».\n\n\
            После выключения перезагрузите компьютер и запустите игру повторно.";

        write_and_show_error("CORE_ISOLATION_CHECK", msg, details);
        return;
    }

    if debug_mode {
        println!("[OK] Изоляция ядра (HVCI) отключена. Система готова.");
    }

    // 2. Проверка совместимости XSAVE/XCR0 для современных процессоров (AVX-512 / Zen 4 / Intel 12+)
    let xcr0 = read_xcr0();
    if xcr0 > 7 {
        if debug_mode {
            println!("[WARN] Обнаружен XCR0 = {xcr0} (> 7). Требуется маскирование xsaveremovefeature.");
        }

        let ask_msg = "Обнаружен современный процессор с расширенными инструкциями (XCR0 > 7: AVX-512 / Zen 4 / Intel 12+).\n\n\
            Для совместимости с гипервизорными играми и токенами Denuvo (Star Wars Galactic Racer, Planet Zoo, Phantom Blade и др.) \
            требуется ограничить размер контекста процессора в BCD (xsaveremovefeature).\n\n\
            Применить оптимизацию BCD и перезагрузить компьютер прямо сейчас?";

        #[cfg(target_os = "windows")]
        if ask_user_yes_no("Eclipse-HV — Оптимизация процессора для Denuvo", ask_msg) {
            if let Err(err) = configure_xsave_and_reboot() {
                let details = DiagnosticDetails {
                    target_executable: None,
                    candidate_count: 0,
                    vanguard_detected: false,
                    msi_afterburner_detected: false,
                    msi_relaunch_path: None,
                    drvloader_temp_path: None,
                    drvloader_bypass_exit_code: None,
                    drvloader_restore_exit_code: None,
                };
                write_and_show_error(
                    "XCR0_OPTIMIZATION_FAILED",
                    &format!("Не удалось применить оптимизацию BCD xsaveremovefeature: {err}"),
                    details,
                );
            }
            return;
        }

        if debug_mode {
            println!("[WARN] Пользователь отклонил перезагрузку BCD. Продолжаем запуск на свой страх и риск.");
        }
    } else if debug_mode {
        println!("[OK] Процессор совместим с гипервизором (XCR0 = {xcr0} <= 7).");
    }

    // 3. Временная нейтрализация конфликтующих процессов (MSI Afterburner, RTSS, Vanguard) и очистка служб
    let conflict_state = stop_conflicts(debug_mode);

    // 4. Извлечение встроенного drvloader.exe во временный каталог
    let temp_dir = env::temp_dir().join(format!("Eclipse-HV-{}", std::process::id()));
    if let Err(err) = fs::create_dir_all(&temp_dir) {
        let details = DiagnosticDetails {
            target_executable: None,
            candidate_count: 0,
            vanguard_detected: conflict_state.vanguard_detected,
            msi_afterburner_detected: conflict_state.msi_detected,
            msi_relaunch_path: conflict_state.msi_path.as_ref().map(|p| p.to_string_lossy().to_string()),
            drvloader_temp_path: None,
            drvloader_bypass_exit_code: None,
            drvloader_restore_exit_code: None,
        };
        write_and_show_error(
            "TEMP_DIR_CREATION",
            &format!("Не удалось создать временный каталог для drvloader: {err}"),
            details,
        );
        return;
    }

    let drvloader_path = temp_dir.join("drvloader.exe");
    if let Err(err) = fs::write(&drvloader_path, DRVLOADER_BYTES) {
        let _ = fs::remove_dir_all(&temp_dir);
        let details = DiagnosticDetails {
            target_executable: None,
            candidate_count: 0,
            vanguard_detected: conflict_state.vanguard_detected,
            msi_afterburner_detected: conflict_state.msi_detected,
            msi_relaunch_path: conflict_state.msi_path.as_ref().map(|p| p.to_string_lossy().to_string()),
            drvloader_temp_path: None,
            drvloader_bypass_exit_code: None,
            drvloader_restore_exit_code: None,
        };
        write_and_show_error(
            "DRVLOADER_EXTRACTION",
            &format!("Не удалось извлечь drvloader.exe: {err}"),
            details,
        );
        return;
    }

    if debug_mode {
        println!("[OK] drvloader.exe подготовлен: {}", drvloader_path.display());
        println!("[1/3] Driver Signature Enforcement: Временный BYPASS...");
    }

    // 4. Выполнение обхода проверки цифровой подписи (drvloader bypass)
    let bypass_output = run_command(&drvloader_path, &["bypass"]);
    let bypass_code = bypass_output.as_ref().map(|o| o.status.code().unwrap_or(-1)).ok();

    if let Ok(ref out) = bypass_output {
        if debug_mode {
            let out_str = String::from_utf8_lossy(&out.stdout);
            let err_str = String::from_utf8_lossy(&out.stderr);
            if !out_str.trim().is_empty() {
                println!("{out_str}");
            }
            if !err_str.trim().is_empty() {
                eprintln!("{err_str}");
            }
        }
    }

    if bypass_output.is_err() || bypass_code != Some(0) {
        let err_text = match &bypass_output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                let combined = if stderr.trim().is_empty() {
                    stdout.to_string()
                } else if stdout.trim().is_empty() {
                    stderr.to_string()
                } else {
                    format!("{}\n[Диагностика stderr]:\n{}", stdout.trim(), stderr.trim())
                };
                format!(
                    "drvloader завершился с кодом {}. Вывод:\n{}",
                    out.status.code().unwrap_or(-1),
                    combined.trim()
                )
            }
            Err(e) => format!("Не удалось выполнить drvloader bypass: {e}"),
        };

        let _ = fs::remove_dir_all(&temp_dir);

        let details = DiagnosticDetails {
            target_executable: None,
            candidate_count: 0,
            vanguard_detected: conflict_state.vanguard_detected,
            msi_afterburner_detected: conflict_state.msi_detected,
            msi_relaunch_path: conflict_state.msi_path.as_ref().map(|p| p.to_string_lossy().to_string()),
            drvloader_temp_path: Some(drvloader_path.to_string_lossy().to_string()),
            drvloader_bypass_exit_code: bypass_code,
            drvloader_restore_exit_code: None,
        };

        write_and_show_error("DSE_BYPASS", &err_text, details);
        return;
    }

    if debug_mode {
        println!("[OK] DSE успешно отключён в оперативной памяти.");
        println!("[2/3] Поиск целевого исполняемого файла игры...");
    }

    // 5. Интеллектуальный поиск исполняемого файла игры
    let (target_game, candidate_count) = find_game_executable(&base_dir, explicit_target.as_ref(), debug_mode);
    let (game_exe, game_dir) = match target_game {
        Some(path) => {
            let parent = path.parent().unwrap_or(&base_dir).to_path_buf();
            (path, parent)
        }
        None => {
            // Восстанавливаем DSE перед выходом при ошибке
            let restore_res = run_command(&drvloader_path, &["restore"]);
            let restore_code = restore_res.as_ref().map(|o| o.status.code().unwrap_or(-1)).ok();
            cleanup_driver_services();
            let _ = fs::remove_dir_all(&temp_dir);

            let details = DiagnosticDetails {
                target_executable: None,
                candidate_count,
                vanguard_detected: conflict_state.vanguard_detected,
                msi_afterburner_detected: conflict_state.msi_detected,
                msi_relaunch_path: conflict_state.msi_path.as_ref().map(|p| p.to_string_lossy().to_string()),
                drvloader_temp_path: Some(drvloader_path.to_string_lossy().to_string()),
                drvloader_bypass_exit_code: bypass_code,
                drvloader_restore_exit_code: restore_code,
            };

            write_and_show_error(
                "GAME_NOT_FOUND",
                &format!(
                    "Не удалось обнаружить исполняемый файл игры в каталоге:\n{}\n\n\
                    Поместите Eclipse-HV.exe в корневую директорию игры.",
                    base_dir.display()
                ),
                details,
            );
            return;
        }
    };

    if debug_mode {
        println!("[OK] Найден исполняемый файл игры: {}", game_exe.display());
        println!("[OK] Рабочая директория: {}", game_dir.display());
        println!("[INFO] Запуск игрового процесса...");
    }

    // 6. Запуск целевой игры в её рабочей директории
    let launch_result = Command::new(&game_exe).current_dir(&game_dir).spawn();

    if let Err(err) = launch_result {
        let restore_res = run_command(&drvloader_path, &["restore"]);
        let restore_code = restore_res.as_ref().map(|o| o.status.code().unwrap_or(-1)).ok();
        cleanup_driver_services();
        let _ = fs::remove_dir_all(&temp_dir);

        let details = DiagnosticDetails {
            target_executable: Some(game_exe.to_string_lossy().to_string()),
            candidate_count,
            vanguard_detected: conflict_state.vanguard_detected,
            msi_afterburner_detected: conflict_state.msi_detected,
            msi_relaunch_path: conflict_state.msi_path.as_ref().map(|p| p.to_string_lossy().to_string()),
            drvloader_temp_path: Some(drvloader_path.to_string_lossy().to_string()),
            drvloader_bypass_exit_code: bypass_code,
            drvloader_restore_exit_code: restore_code,
        };

        write_and_show_error(
            "GAME_LAUNCH",
            &format!("Ошибка при запуске {}: {err}", game_exe.display()),
            details,
        );
        return;
    }

    if debug_mode {
        println!("[OK] Процесс игры запущен. Ожидание 5 сек для загрузки гипервизорного хука...");
    }

    // 7. Ожидание инициализации гипервизорного драйвера игры
    thread::sleep(Duration::from_secs(5));

    if debug_mode {
        println!("[3/3] Driver Signature Enforcement: Восстановление защиты (RESTORE)...");
    }

    // 8. Восстановление исходного состояния проверки цифровых подписей (DSE Restore)
    let restore_output = run_command(&drvloader_path, &["restore"]);
    let restore_code = restore_output.as_ref().map(|o| o.status.code().unwrap_or(-1)).ok();

    if debug_mode {
        if restore_code == Some(0) {
            println!("[OK] Безопасность DSE успешно восстановлена.");
        } else {
            println!("[WARN] Предупреждение при восстановлении DSE: {:?}", restore_code);
        }
    }

    // 9. Очистка временных служб драйвера RTCore64
    cleanup_driver_services();

    // 10. Перезапуск MSI Afterburner, если он был предварительно закрыт
    if let Some(path) = conflict_state.msi_path {
        if debug_mode {
            println!("[INFO] Перезапуск MSI Afterburner: {}", path.display());
        }
        let _ = Command::new(path).spawn();
    }

    // 11. Очистка временных файлов
    let _ = fs::remove_dir_all(&temp_dir);

    if debug_mode {
        println!("============================================================");
        println!("[ГОТОВО] Игра успешно запущена. Eclipse-HV завершает работу.");
        println!("============================================================");
        thread::sleep(Duration::from_secs(3));
    }
}

// Инициализация консоли в режиме отладки (--debug) с перенаправлением CONOUT$
#[cfg(target_os = "windows")]
fn init_debug_console() {
    unsafe {
        let attached = AttachConsole(ATTACH_PARENT_PROCESS).is_ok();
        if !attached {
            let _ = AllocConsole();
        }

        // Перенаправляем дескрипторы CONOUT$ для гарантированного вывода println! / eprintln!
        let conout = CreateFileW(
            w!("CONOUT$"),
            FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        );
        if let Ok(handle) = conout {
            let _ = SetStdHandle(STD_OUTPUT_HANDLE, handle);
            let _ = SetStdHandle(STD_ERROR_HANDLE, handle);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn init_debug_console() {}

// Проверка прав администратора через членство в группе Builtin Administrators
fn is_admin() -> bool {
    let output = run_command("net.exe", &["session"]);
    output.is_ok_and(|o| o.status.success())
}

// Запрос прав администратора через ShellExecuteW с глаголом runas
fn elevate_self(args: &[String]) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let exe_path = env::current_exe()
            .map_err(|e| format!("Не удалось определить путь к исполняемому файлу: {e}"))?;
        let base_dir = exe_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        let exe_hstring = HSTRING::from(exe_path.to_string_lossy().as_ref());
        let dir_hstring = HSTRING::from(base_dir.to_string_lossy().as_ref());

        // Передаём аргументы (включая --debug и переданные пути к играм)
        let forward_args: Vec<String> = args
            .iter()
            .skip(1)
            .map(|a| {
                if a.contains(' ') {
                    format!("\"{a}\"")
                } else {
                    a.clone()
                }
            })
            .collect();
        let args_str = forward_args.join(" ");
        let args_hstring = HSTRING::from(args_str);

        let result = ShellExecuteW(
            None,
            w!("runas"),
            &exe_hstring,
            if forward_args.is_empty() {
                PCWSTR::null()
            } else {
                PCWSTR(args_hstring.as_ptr())
            },
            &dir_hstring,
            SW_SHOWNORMAL,
        );

        if result.0 as usize > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecuteW вернул код ошибки: {}", result.0 as usize))
        }
    }
    #[cfg(not(target_os = "windows"))]
    Err("Повышение привилегий поддерживается только на Windows".into())
}

// Проверка изоляции ядра (HVCI) по аналогии с эталонным HV-PlugNPlay.bat
fn check_core_isolation() -> bool {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let hvci_path = r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity";
    if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(hvci_path) {
        if let Ok(enabled) = key.get_value::<u32, _>("Enabled") {
            return enabled == 1;
        }
    }
    false
}

// Диалоговое окно подтверждения действия пользователя (Да / Нет)
#[cfg(target_os = "windows")]
fn ask_user_yes_no(title: &str, message: &str) -> bool {
    unsafe {
        let title_h = HSTRING::from(title);
        let msg_h = HSTRING::from(message);
        let result = MessageBoxW(
            None,
            PCWSTR(msg_h.as_ptr()),
            PCWSTR(title_h.as_ptr()),
            MB_YESNO | MB_ICONWARNING,
        );
        result == IDYES
    }
}

// Отключение изоляции ядра (HVCI) и VBS в реестре с последующей перезагрузкой системы
fn disable_hvci_and_reboot() -> Result<(), String> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);

    // 1. Отключение HVCI (HypervisorEnforcedCodeIntegrity)
    let hvci_path = r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity";
    if let Ok((key, _)) = hklm.create_subkey(hvci_path) {
        let _ = key.set_value("Enabled", &0u32);
        let _ = key.set_value("WasEnabledBy", &0u32);
    }

    // 2. Отключение базового VBS (DeviceGuard)
    let dg_path = r"SYSTEM\CurrentControlSet\Control\DeviceGuard";
    if let Ok((key, _)) = hklm.create_subkey(dg_path) {
        let _ = key.set_value("EnableVirtualizationBasedSecurity", &0u32);
    }

    // 3. Отключение гипервизора в загрузчике Windows
    let _ = run_command("bcdedit.exe", &["/set", "hypervisorlaunchtype", "off"]);

    // 4. Инициирование перезагрузки Windows через 5 секунд с системным уведомлением
    run_command(
        "shutdown.exe",
        &[
            "/r",
            "/t",
            "5",
            "/c",
            "Eclipse-HV: Перезагрузка компьютера для применения параметров отключения изоляции ядра (HVCI)...",
        ],
    )?;

    Ok(())
}

// Чтение младших 32 бит маски расширенных состояний процессора (XCR0)
// из фиксированной системной структуры KUSER_SHARED_DATA (0x7FFE03D8).
// Значение > 7 указывает на активность расширенных наборов инструкций (AVX-512, PKRU и др.),
// требующих применения параметра xsaveremovefeature в BCD для исключения сбоев гипервизора Denuvo.
#[cfg(all(windows, target_arch = "x86_64"))]
fn read_xcr0() -> u32 {
    unsafe {
        let ptr = 0x7FFE03D8 as *const u32;
        *ptr
    }
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
fn read_xcr0() -> u32 {
    0
}

// Применение параметра xsaveremovefeature в BCD и перезагрузка для защиты от сбоев Denuvo
fn configure_xsave_and_reboot() -> Result<(), String> {
    // 1. Установка BCD-параметра xsaveremovefeature
    run_command(
        "bcdedit.exe",
        &["/set", "{current}", "xsaveremovefeature", "0xFFFFFFFFFFFFFFF8"],
    )?;

    // 2. Инициирование перезагрузки Windows через 5 секунд с системным уведомлением
    run_command(
        "shutdown.exe",
        &[
            "/r",
            "/t",
            "5",
            "/c",
            "Eclipse-HV: Перезагрузка компьютера для применения оптимизации процессора (xsaveremovefeature)...",
        ],
    )?;

    Ok(())
}

// Остановка и удаление зависших или старых служб RTCore
fn cleanup_driver_services() {
    let _ = run_command("sc.exe", &["stop", "RTCore64"]);
    let _ = run_command("sc.exe", &["delete", "RTCore64"]);
    let _ = run_command("sc.exe", &["stop", "RTCoreMini64"]);
}

// Нейтрализация сторонних конфликтов (Vanguard, MSI Afterburner, RTSS)
fn stop_conflicts(debug_mode: bool) -> ConflictState {
    let mut state = ConflictState::default();

    // 1. Остановка Vanguard во избежание BSOD
    let _ = run_command("net.exe", &["stop", "vgc", "/y"]);
    let _ = run_command("net.exe", &["stop", "vgk", "/y"]);
    let kill_vg = run_command("taskkill.exe", &["/IM", "vgtray.exe", "/F"]);
    if kill_vg.is_ok_and(|o| o.status.success()) {
        state.vanguard_detected = true;
        if debug_mode {
            println!("[INFO] Трей Vanguard остановлен во избежание системного сбоя.");
        }
    }

    // 2. Проверка и завершение MSI Afterburner
    let msi_running = process_is_running("MSIAfterburner.exe");
    if msi_running {
        state.msi_detected = true;
        if debug_mode {
            println!("[INFO] Обнаружен работающий MSI Afterburner. Определение пути и остановка...");
        }

        // Пытаемся динамически определить реальный путь к MSIAfterburner.exe
        state.msi_path = detect_msi_afterburner_path();

        // Завершаем процесс и ожидаем его полной выгрузки из оперативной памяти
        terminate_process_and_wait("MSIAfterburner.exe", 3000);

        if debug_mode {
            if let Some(ref p) = state.msi_path {
                println!("[OK] Путь MSI Afterburner сохранён для автоперезапуска: {}", p.display());
            } else {
                println!("[WARN] Путь к MSI Afterburner не удалось определить автоматически.");
            }
        }
    }

    // 3. Завершение RivaTuner Statistics Server (RTSS) и связанных перехватчиков
    terminate_process_and_wait("RTSS.exe", 2000);
    terminate_process_and_wait("EncoderServer.exe", 1000);
    terminate_process_and_wait("RTSSHooksLoader64.exe", 1000);

    // 4. Очистка служб драйверов для предотвращения конфликта блокировки RTCore64
    cleanup_driver_services();

    // 5. Небольшая задержка, позволяющая ядру Windows окончательно освободить дескрипторы драйверов
    thread::sleep(Duration::from_millis(500));

    state
}

// Поиск пути к исполняемому файлу MSI Afterburner через процесс, реестр или стандартные пути
fn detect_msi_afterburner_path() -> Option<PathBuf> {
    // 1. Попытка получить путь из активного процесса через PowerShell
    let ps_cmd = "(Get-Process -Name 'MSIAfterburner' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)";
    if let Ok(out) = run_command("powershell.exe", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_cmd]) {
        let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path_str.is_empty() {
            let p = PathBuf::from(&path_str);
            if p.is_file() {
                return Some(p);
            }
        }
    }

    // 2. Попытка прочесть путь установки из реестра Windows
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let reg_paths = [
        r"SOFTWARE\WOW6432Node\MSI\Afterburner",
        r"SOFTWARE\MSI\Afterburner",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\MSI Afterburner",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MSI Afterburner",
    ];

    for rpath in reg_paths {
        if let Ok(key) = hklm.open_subkey(rpath) {
            if let Ok(val) = key.get_value::<String, _>("InstallPath") {
                let p = PathBuf::from(val).join("MSIAfterburner.exe");
                if p.is_file() {
                    return Some(p);
                }
            }
            if let Ok(val) = key.get_value::<String, _>("InstallLocation") {
                let p = PathBuf::from(val).join("MSIAfterburner.exe");
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }

    // 3. Стандартные пути установки на дисках C:, D:, E:
    let candidates = [
        r"C:\Program Files (x86)\MSI Afterburner\MSIAfterburner.exe",
        r"C:\Program Files\MSI Afterburner\MSIAfterburner.exe",
        r"D:\Program Files (x86)\MSI Afterburner\MSIAfterburner.exe",
        r"D:\MSI Afterburner\MSIAfterburner.exe",
        r"E:\Program Files (x86)\MSI Afterburner\MSIAfterburner.exe",
        r"E:\MSI Afterburner\MSIAfterburner.exe",
    ];

    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }

    None
}

// Принудительное завершение процесса с ожиданием исчезновения из таблицы процессов
fn terminate_process_and_wait(image_name: &str, max_wait_ms: u64) {
    let _ = run_command("taskkill.exe", &["/IM", image_name, "/F"]);
    let start = std::time::Instant::now();
    while start.elapsed().as_millis() < max_wait_ms as u128 {
        if !process_is_running(image_name) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

// Проверка активности процесса по имени
fn process_is_running(image_name: &str) -> bool {
    let target = image_name.to_lowercase();
    let output = run_command("tasklist.exe", &["/FI", &format!("IMAGENAME eq {image_name}"), "/NH"]);
    output.is_ok_and(|o| {
        let stdout = String::from_utf8_lossy(&o.stdout);
        stdout.lines().any(|line| {
            let line_lower = line.trim().to_lowercase();
            line_lower.starts_with(&target)
        })
    })
}

// Интеллектуальный поиск исполняемого файла игры без искусственных ограничений по размеру
fn find_game_executable(
    root: &Path,
    explicit_target: Option<&PathBuf>,
    debug_mode: bool,
) -> (Option<PathBuf>, usize) {
    // 0. Если передан прямой путь (через аргументы или перетаскивание на файл)
    if let Some(target) = explicit_target {
        if target.is_file() {
            if debug_mode {
                println!("[FIND] Использован явно переданный исполняемый файл: {}", target.display());
            }
            return (Some(target.clone()), 1);
        }
    }

    // 1. Поиск приоритетных названий в корневом каталоге игры
    for name in PRIORITY_LAUNCHER_NAMES {
        let candidate = root.join(name);
        if candidate.is_file() && !is_excluded_exe(&candidate) {
            if debug_mode {
                println!("[FIND] Найден приоритетный лаунчер в корне: {}", candidate.display());
            }
            return (Some(candidate), 1);
        }
    }

    // 2. Сканирование корневой папки и подпапок на глубину до 4 уровней
    let mut all_exes = Vec::new();
    scan_directory_recursive(root, 0, 4, &mut all_exes);

    // 3. Поиск приоритетных названий в подпапках
    for path in &all_exes {
        if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
            let lower = file_name.to_lowercase();
            if PRIORITY_LAUNCHER_NAMES.contains(&lower.as_str()) && !is_excluded_exe(path) {
                if debug_mode {
                    println!("[FIND] Найден приоритетный лаунчер в подпапке: {}", path.display());
                }
                return (Some(path.clone()), all_exes.len());
            }
        }
    }

    // 4. Фильтрация валидных файлов игр
    let mut valid_candidates: Vec<(PathBuf, u64)> = Vec::new();

    for path in all_exes {
        if is_excluded_exe(&path) {
            continue;
        }

        if let Ok(meta) = fs::metadata(&path) {
            let size = meta.len();
            if size > 0 {
                valid_candidates.push((path, size));
            }
        }
    }

    let candidate_count = valid_candidates.len();

    // Сортируем по убыванию размера
    valid_candidates.sort_by(|a, b| b.1.cmp(&a.1));

    if let Some((best_path, best_size)) = valid_candidates.into_iter().next() {
        if debug_mode {
            println!(
                "[FIND] Выбран исполняемый файл игры по наибольшему размеру ({:.2} МБ): {}",
                best_size as f64 / (1024.0 * 1024.0),
                best_path.display()
            );
        }
        return (Some(best_path), candidate_count);
    }

    (None, candidate_count)
}

// Рекурсивный обход директории с ограничением максимальной глубины
fn scan_directory_recursive(dir: &Path, current_depth: usize, max_depth: usize, results: &mut Vec<PathBuf>) {
    if current_depth > max_depth {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
                results.push(path);
            }
        } else if path.is_dir() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_lowercase();
            // Пропускаем служебные папки, бэкапы и системные каталоги
            if !name.starts_with('.')
                && name != "windows"
                && name != "temp"
                && name != "$recycle.bin"
                && name != "_commonredist"
                && name != "redist"
                && name != "support"
                && name != "installers"
            {
                scan_directory_recursive(&path, current_depth + 1, max_depth, results);
            }
        }
    }
}

// Проверка, является ли файл исключаемой служебной утилитой
fn is_excluded_exe(path: &Path) -> bool {
    // Исключаем сам запущенный процесс Eclipse-HV вне зависимости от его имени
    if let Ok(current_exe) = env::current_exe() {
        if path == current_exe {
            return true;
        }
    }

    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();

    for pattern in EXCLUDED_EXE_PATTERNS {
        if name.contains(pattern) {
            return true;
        }
    }
    false
}

// Вспомогательный запуск процесса без создания окна
fn run_command(program: impl AsRef<Path>, args: &[&str]) -> Result<Output, String> {
    let mut cmd = Command::new(program.as_ref());
    cmd.args(args);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.output()
        .map_err(|e| format!("Не удалось запустить {}: {e}", program.as_ref().display()))
}

// Запись отчёта об ошибке в JSON и его открытие в системном редакторе
fn write_and_show_error(step: &str, message: &str, details: DiagnosticDetails) {
    let base_dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let exe_path = env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let report = JsonErrorReport {
        timestamp: current_timestamp(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        application: "Eclipse-HV".to_string(),
        status: "ERROR".to_string(),
        error_step: step.to_string(),
        error_message: message.to_string(),
        environment: EnvironmentInfo {
            working_directory: base_dir.to_string_lossy().to_string(),
            executable_path: exe_path,
            command_line_args: env::args().collect(),
            is_administrator: is_admin(),
            core_isolation_hvci_enabled: check_core_isolation(),
        },
        diagnostic_details: details,
    };

    // Запись отчёта в Eclipse-HV-error.json рядом с лаунчером или во временной папке
    let json_content = serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_string());
    let log_path = base_dir.join("Eclipse-HV-error.json");

    let final_log_path = if fs::write(&log_path, &json_content).is_ok() {
        log_path
    } else {
        let temp_log = env::temp_dir().join("Eclipse-HV-error.json");
        let _ = fs::write(&temp_log, &json_content);
        temp_log
    };

    // Отображение диалогового окна с ошибкой
    #[cfg(target_os = "windows")]
    unsafe {
        let title = w!("Ошибка запуска Eclipse-HV");
        let text_hstring = HSTRING::from(format!(
            "{message}\n\nПодробный отчёт записан в файл:\n{}",
            final_log_path.display()
        ));

        MessageBoxW(
            None,
            PCWSTR(text_hstring.as_ptr()),
            title,
            MB_ICONERROR | MB_OK,
        );

        // Открытие файла JSON в программе по умолчанию
        let log_hstring = HSTRING::from(final_log_path.to_string_lossy().as_ref());
        let _ = ShellExecuteW(
            None,
            w!("open"),
            &log_hstring,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    }
}

// Получение форматированного штампа времени
fn current_timestamp() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now();
    let duration = now.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    format!("{}.{:03}Z", duration.as_secs(), duration.subsec_millis())
}
