mod anticheat;
mod archive_policy;
mod audio_cache;
mod backup;
mod dlc;
mod dlc_catalog;
mod download;
mod durable;
mod engine;
mod files;
mod game_artwork;
mod hubcap;
mod hypervisor;
mod jobs;
mod loader_github;
mod lua_loader;
mod luatools;
mod millennium;
mod models;
mod native_dialog;
mod native_drop;
mod operation_outcome;
mod resource_lock;
mod ryuu;
mod safe_path;
mod saves;
mod secure_state;
mod smaki;
mod steam;
mod steam_library;
mod updates;
mod vbs;

use std::process::Command;
use tauri::{AppHandle, Manager, WebviewWindow};

const EMBEDDED_CORE_COMPONENTS: &[(&str, &[u8])] = &[
    (
        "SteamFix64.dll",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/core_engine/SteamFix64.dll"
        )),
    ),
    (
        "winmm_unity.dll",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/core_engine/winmm_unity.dll"
        )),
    ),
    (
        "EpicFix64.dll",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/core_engine/EpicFix64.dll"
        )),
    ),
    (
        "EpicFix.ini",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/core_engine/EpicFix.ini"
        )),
    ),
    (
        "EOSSDK-Win64-Shipping.dll",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/core_engine/EOSSDK-Win64-Shipping.dll"
        )),
    ),
];

const EMBEDDED_DLC_COMPONENTS: &[(&str, &[u8])] = &[
    (
        "steam_api.dll",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/creamapi/steam_api.dll"
        )),
    ),
    (
        "steam_api64.dll",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/creamapi/steam_api64.dll"
        )),
    ),
];

#[tauri::command]
async fn pick_game_directory(window: WebviewWindow) -> Result<Option<String>, String> {
    #[cfg(windows)]
    let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    #[cfg(not(windows))]
    let owner = {
        let _ = window;
        0
    };
    tauri::async_runtime::spawn_blocking(move || {
        native_dialog::pick_folder("Выберите папку с игрой", owner)
    })
    .await
    .map_err(|error| format!("Диалог выбора прерван: {error}"))?
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(path.trim());
    #[cfg(target_os = "windows")]
    {
        if target.is_file() {
            Command::new("explorer.exe")
                .arg(format!("/select,{}", target.to_string_lossy()))
                .spawn()
                .map(|_| ())
                .map_err(|error| format!("Не удалось открыть в проводнике: {error}"))
        } else if target.is_dir() {
            Command::new("explorer.exe")
                .arg(&target)
                .spawn()
                .map(|_| ())
                .map_err(|error| format!("Не удалось открыть в проводнике: {error}"))
        } else {
            if let Some(parent) = target.parent().filter(|p| p.is_dir()) {
                return Command::new("explorer.exe")
                    .arg(parent)
                    .spawn()
                    .map(|_| ())
                    .map_err(|error| format!("Не удалось открыть в проводнике: {error}"));
            }
            Err("Указанный путь не найден".into())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Err("Поддерживается только в Windows".into())
    }
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        #[cfg(target_os = "windows")]
        {
            Command::new("explorer.exe")
                .arg(trimmed)
                .spawn()
                .map(|_| ())
                .map_err(|error| format!("Не удалось открыть ссылку: {error}"))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err("Открытие ссылок поддерживается только в Windows".into())
        }
    } else {
        open_path(trimmed.to_string())
    }
}

#[tauri::command]
fn minimize_window(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_maximize_window(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn start_dragging_window(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn show_window(window: WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: &'static str,
    windows: bool,
    windows_only_modules: Vec<&'static str>,
}

#[tauri::command]
fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        windows: cfg!(target_os = "windows"),
        windows_only_modules: if cfg!(target_os = "windows") {
            Vec::new()
        } else {
            vec!["hypervisor"]
        },
    }
}

#[tauri::command]
fn process_is_elevated() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("fltmc.exe")
            .creation_flags(0x08000000)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn relaunch_as_admin(app: AppHandle) -> Result<(), String> {
    let handoff = crate::resource_lock::begin_handoff()?;
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };
    let executable = std::env::current_exe()
        .map_err(|error| format!("Не удалось определить путь программы: {error}"))?;
    let executable: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();
    let arguments: Vec<u16> = "--elevated-handoff"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(executable.as_ptr()),
            PCWSTR(arguments.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        return Err(if result.0 as isize == 5 {
            "Запрос прав администратора отменён".into()
        } else {
            format!(
                "Не удалось запустить программу с правами администратора (код {})",
                result.0 as isize
            )
        });
    }
    // До завершения процесса блокируем новые изменения. Новый экземпляр ждёт
    // освобождения файловой блокировки; отмена UAC оставляет текущую копию живой.
    std::mem::forget(handoff);
    app.exit(0);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn relaunch_as_admin() -> Result<(), String> {
    Err("Повышение прав через UAC доступно только в Windows".into())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pick_game_directory,
            native_drop::enable_file_drop,
            open_path,
            open_external,
            platform_info,
            process_is_elevated,
            relaunch_as_admin,
            minimize_window,
            toggle_maximize_window,
            close_window,
            start_dragging_window,
            show_window,
            secure_state::state_bootstrap,
            secure_state::state_apply,
            secure_state::state_set_secret,
            jobs::jobs_list,
            audio_cache::audio_save_custom_sound,
            audio_cache::audio_list_custom_sounds,
            audio_cache::audio_delete_custom_sound,
            audio_cache::audio_read_custom_sound,
            game_artwork::game_artwork,
            game_artwork::game_artwork_store_url,
            saves::scan_save_locations,
            saves::save_add_location,
            saves::save_exclude_location,
            saves::preview_save_backup,
            saves::inspect_save_archive,
            saves::save_undo_restore,
            saves::save_discard_restore_backup,
            saves::pick_save_archive,
            saves::create_save_archive,
            saves::pick_save_restore_archive,
            saves::restore_save_archive,
            engine::scan_game_directory,
            engine::install_fix,
            engine::uninstall_fix,
            engine::install_epicfix_only,
            engine::restore_eos_only,
            dlc::scan_dlc_target,
            dlc::fetch_dlc_catalog,
            steam_library::scan_installed_steam_games,
            steam_library::steam_library_cover,
            smaki::install_smaki,
            smaki::uninstall_smaki,
            dlc_catalog::scan_dlc_catalog,
            dlc::install_dlc_unlocker,
            dlc::uninstall_dlc_unlocker,
            luatools::luatools_status,
            luatools::luatools_restore_manifests,
            luatools::luatools_detect_steam,
            luatools::luatools_pick_files,
            luatools::luatools_install,
            luatools::luatools_toggle,
            luatools::luatools_remove,
            luatools::luatools_restart_steam,
            luatools::luatools_game_detail,
            luatools::luatools_names,
            luatools::luatools_headers,
            luatools::luatools_get_loader_info,
            luatools::luatools_set_loader_source,
            luatools::luatools_apply_loader,
            luatools::luatools_update_loader,
            luatools::luatools_is_steam_running,
            luatools::luatools_close_steam,
            loader_github::luatools_check_loader_updates,
            lua_loader::luatools_loader_info,
            millennium::millennium_plugin_status,
            millennium::millennium_install_plugin,
            millennium::millennium_remove_plugin,
            millennium::millennium_migrate_from_croclua,
            millennium::millennium_remove_legacy_croclua,
            millennium::millennium_install_bundled,
            ryuu::ryuu_search,
            ryuu::ryuu_get,
            ryuu::ryuu_usage,
            hubcap::hubcap_search,
            hubcap::hubcap_get,
            hubcap::hubcap_usage,
            hypervisor::get_app_status,
            hypervisor::check_asset_updates,
            hypervisor::list_games,
            hypervisor::select_game_exe,
            hypervisor::add_game,
            hypervisor::set_game_launcher,
            hypervisor::set_selected_game,
            hypervisor::remove_game,
            hypervisor::verify_game,
            hypervisor::launch_selected_game,
            hypervisor::is_selected_game_running,
            hypervisor::eclipse_hv_status,
            hypervisor::eclipse_hv_check_update,
            hypervisor::eclipse_hv_download,
            anticheat::anticheat_scan,
            anticheat::anticheat_restore,
            anticheat::anticheat_pick_backup_directory,
            anticheat::anticheat_remove,
            anticheat::anticheat_remove_all,
            vbs::vbs_scan,
            vbs::vbs_get_protections,
            vbs::vbs_set_protection,
            vbs::vbs_disable,
            vbs::vbs_restore,
            vbs::vbs_enable_all,
            vbs::vbs_set_test_mode,
            vbs::vbs_restart,
            vbs::vbs_prepare_uefi_optout,
            vbs::vbs_disable_faceit,
            vbs::vbs_troubleshoot,
            files::files_catalog,
            files::files_download,
            files::files_install_crack,
            files::files_cancel_download,
            files::files_pause_download,
            files::files_discard_download,
            files::files_reveal,
            files::files_default_download_dir,
            files::files_pick_download_dir,
            files::files_open_download_dir,
            steam::search_game,
            steam::get_app_details,
            steam::steam_drm_info,
            updates::check_for_update,
            updates::updates_page_url,
            updates::download_app_update,
            updates::launch_app_update,
            updates::cleanup_old_app_versions,
        ])
        .setup(|app| {
            jobs::init(app.handle()).map_err(std::io::Error::other)?;
            // Окно создано скрытым (visible: false), чтобы исключить показ пустого синего/темного экрана до рендеринга страницы.
            // Приложение отобразит окно сразу после отрисовки первого кадра заставки через команду show_window.
            // Добавляем страховочный таймер на случай непредвиденных задержек в WebView2:
            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    let _ = win.show();
                    let _ = win.set_focus();
                });
            }

            // Фоновая автоматическая очистка старых версий программы и временных файлов обновлений
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(800));
                let _ = updates::cleanup_old_versions();
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running CrocodileGena Studio");
}

fn extract_embedded(
    app: &AppHandle,
    folder: &str,
    components: &[(&str, &[u8])],
) -> Option<std::path::PathBuf> {
    let directory = app.path().app_local_data_dir().ok()?.join(folder);
    std::fs::create_dir_all(&directory).ok()?;

    for (name, contents) in components {
        let target = directory.join(name);
        let is_current = std::fs::metadata(&target)
            .map(|metadata| {
                metadata.is_file()
                    && crate::durable::hash_file(&target).ok().as_deref()
                        == Some(&format!(
                            "{:x}",
                            <sha2::Sha256 as sha2::Digest>::digest(contents)
                        ))
            })
            .unwrap_or(false);
        if !is_current {
            crate::durable::write(&target, contents).ok()?;
        }
    }

    Some(directory)
}

fn extract_embedded_core(app: &AppHandle) -> Option<std::path::PathBuf> {
    extract_embedded(app, "core_engine", EMBEDDED_CORE_COMPONENTS)
}

pub(crate) fn core_engine_path(app: &AppHandle) -> std::path::PathBuf {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.extend([
            resource_dir.join("backend").join("core_engine"),
            resource_dir
                .join("_up_")
                .join("backend")
                .join("core_engine"),
        ]);
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("backend").join("core_engine"));
        }
    }
    for candidate in candidates {
        if candidate.join("SteamFix64.dll").is_file() {
            return candidate;
        }
    }

    if let Some(directory) = extract_embedded_core(app) {
        return directory;
    }

    #[cfg(debug_assertions)]
    {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("core_engine")
    }

    #[cfg(not(debug_assertions))]
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("core_engine")
}

pub(crate) fn dlc_unlocker_path(app: &AppHandle) -> std::path::PathBuf {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.extend([
            resource_dir.join("CreamAPI"),
            resource_dir.join("DLCUnlocker"),
            resource_dir.join("_up_").join("CreamAPI"),
            resource_dir.join("_up_").join("DLCUnlocker"),
        ]);
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("CreamAPI"));
            candidates.push(directory.join("DLCUnlocker"));
        }
    }
    for candidate in candidates {
        if candidate.join("steam_api64.dll").is_file() {
            return candidate;
        }
    }

    if let Some(directory) = extract_embedded(app, "CreamAPI", EMBEDDED_DLC_COMPONENTS) {
        return directory;
    }

    #[cfg(debug_assertions)]
    {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("creamapi")
    }

    #[cfg(not(debug_assertions))]
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("CreamAPI")
}
