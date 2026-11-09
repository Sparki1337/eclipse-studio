//! Рабочее пространство Hypervisor: профили игр, развёртывание Eclipse-HV, ярлыки и запуск.

use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri::Emitter;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            FOLDERID_Desktop, ILCreateFromPathW, ILFree, IShellLinkW, SHGetKnownFolderPath,
            ShellLink, KF_FLAG_DEFAULT,
        },
    },
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const ECLIPSE_HV_LAUNCHER_ID: &str = "eclipse_hv";

const EMBEDDED_ECLIPSE_HV: &[u8] = include_bytes!("../resources/hypervisor/Eclipse-HV.exe");
const HELPER_NAME: &str = "Eclipse-HV.exe";

// Проверка, что Steam закрыт перед операцией настройки параметров запуска
pub(crate) fn require_steam_closed() -> Result<(), String> {
    if process_name_running("steam.exe")? {
        return Err("Полностью закройте Steam через «Steam → Выход», затем повторите. Окно Steam, свёрнутое в трей, всё ещё работает.".into());
    }
    Ok(())
}

fn steam_target(id: &str) -> Result<(PathBuf, u64, PathBuf), String> {
    let library = load_library()?;
    let game = library
        .games
        .iter()
        .find(|g| g.id == id)
        .ok_or("Игра не найдена")?;
    let exe = validate_exe_path(&game.exe_path)?;
    let installed = exe.parent().into_iter().flat_map(Path::ancestors)
        .find_map(crate::steam_library::installed_game_for_path)
        .ok_or("Игра не найдена среди установленных игр Steam. Установите её через Steam и выберите EXE из её папки.")?;
    let steam = crate::luatools::resolve_steam_path(None).ok_or("Папка Steam не найдена")?;
    Ok((
        steam,
        installed.appid,
        exe.parent().unwrap().join(HELPER_NAME),
    ))
}

fn ensure_helper(dir: &Path) -> Result<(), String> {
    let target = dir.join(HELPER_NAME);
    if target.is_file() {
        return Ok(());
    }
    fs::write(&target, EMBEDDED_ECLIPSE_HV)
        .map_err(|e| format!("Не удалось разместить {HELPER_NAME}: {e}"))?;
    Ok(())
}

// Чтение аккаунтов Steam вне главного потока
#[tauri::command(async)]
pub(crate) fn steam_launch_accounts() -> Result<Vec<crate::steam_hv::Account>, String> {
    let steam = crate::luatools::resolve_steam_path(None).ok_or("Папка Steam не найдена")?;
    crate::steam_hv::accounts(&steam)
}

// Проверка интеграции выбранной игры вне главного потока
#[tauri::command(async)]
pub(crate) fn steam_launch_status(
    id: String,
    account: Option<String>,
) -> Result<crate::steam_hv::Status, String> {
    let (steam, appid, helper) = steam_target(&id)?;
    crate::steam_hv::status_for(&steam, appid, &helper, account.as_deref())
}

// Включение или возврат запуска игры через гипервизор в Steam
#[tauri::command]
pub(crate) async fn set_steam_launch(
    id: String,
    enabled: bool,
    account: Option<String>,
) -> Result<crate::steam_hv::Status, String> {
    tauri::async_runtime::spawn_blocking(move || set_steam_launch_inner(id, enabled, account))
        .await
        .map_err(|error| format!("Настройка Steam прервана: {error}"))?
}

fn set_steam_launch_inner(
    id: String,
    enabled: bool,
    account: Option<String>,
) -> Result<crate::steam_hv::Status, String> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(|_| "Настройка Steam прервана")?;
    let (steam, appid, helper) = steam_target(&id)?;
    let before = crate::steam_hv::status_for(&steam, appid, &helper, account.as_deref())?;
    if enabled {
        ensure_helper(helper.parent().unwrap())?;
    }
    let client = steam.join("steam.exe");
    if !client.is_file() {
        return Err("Не найден steam.exe".into());
    }
    let was_running = process_name_running("steam.exe")?;
    crate::steam_hv::restart_around(
        was_running,
        || {
            let mut cmd = Command::new(&client);
            cmd.arg("-shutdown").current_dir(&steam);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.spawn()
                .map_err(|error| format!("Не удалось завершить Steam: {error}"))?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            loop {
                if !process_name_running("steam.exe")? {
                    return Ok(());
                }
                if std::time::Instant::now() >= deadline {
                    return Err("Steam не завершился за 30 секунд. Параметры не изменены; проверьте, не ожидает ли Steam завершения игры.".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        },
        || crate::steam_hv::set(&steam, appid, &helper, enabled, Some(&before.account)),
        || {
            Command::new(&client)
                .current_dir(&steam)
                .spawn()
                .map(|_| ())
                .map_err(|error| error.to_string())
        },
    )
}

#[derive(Clone, Copy)]
struct LauncherProfile {
    id: &'static str,
    name: &'static str,
    badge: &'static str,
    batch_name: &'static str,
    helper_label: &'static str,
    description: &'static str,
}

const LAUNCHER_PROFILE: LauncherProfile = LauncherProfile {
    id: ECLIPSE_HV_LAUNCHER_ID,
    name: "Eclipse-HV",
    badge: "HV",
    batch_name: "Eclipse-HV.exe",
    helper_label: "Eclipse-HV.exe",
    description:
        "Автономный высокопроизводительный лаунчер с обходом DSE в памяти и поддержкой Secure Boot.",
};

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct GameEntry {
    pub id: String,
    pub name: String,
    pub exe_path: String,
    pub dir_path: String,
    pub loader_name: String,
    #[serde(default = "default_launcher_id")]
    pub launcher_id: String,
    #[serde(default = "default_launcher_name")]
    pub launcher_name: String,
    #[serde(default = "default_batch_name")]
    pub batch_name: String,
    #[serde(default = "default_helper_label")]
    pub helper_label: String,
    #[serde(default)]
    pub shortcut_path: String,
    #[serde(default)]
    pub batch_found: bool,
    pub ready: bool,
    pub last_message: String,
}

#[cfg(target_os = "windows")]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    shell_path(path)
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect()
}

#[cfg(target_os = "windows")]
fn wide_text(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

#[cfg(target_os = "windows")]
fn wide_quoted_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let mut result = vec![b'"' as u16];
    result.extend(shell_path(path).as_os_str().encode_wide());
    result.extend([b'"' as u16, 0]);
    result
}

// Нормализация расширенного пути Windows (снятие префикса \\?\)
#[cfg(target_os = "windows")]
fn shell_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

#[cfg(target_os = "windows")]
fn safe_shortcut_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            other => other,
        })
        .collect();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        "Игра".to_string()
    } else {
        trimmed.to_string()
    }
}

// Получение пути к рабочему столу текущего пользователя через Known Folders API
#[cfg(target_os = "windows")]
fn desktop_dir() -> Result<PathBuf, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let desktop_pointer = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None)
            .map_err(|error| format!("Не удалось найти рабочий стол: {error}"))?;
        let desktop_text = desktop_pointer.to_string();
        CoTaskMemFree(Some(desktop_pointer.0.cast()));
        let desktop = PathBuf::from(
            desktop_text
                .map_err(|error| format!("Не удалось прочитать путь рабочего стола: {error}"))?,
        );
        if !desktop.is_dir() {
            return Err(format!("Рабочий стол не найден: {}", desktop.display()));
        }
        Ok(desktop)
    }
}

// Запись файла ярлыка .lnk через COM-интерфейсы IShellLinkW и IPersistFile
#[cfg(target_os = "windows")]
fn write_shortcut_initialized(
    exe: &Path,
    dir: &Path,
    name: &str,
    shortcut: &Path,
) -> Result<(), String> {
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
        .map_err(|error| format!("Не удалось создать Windows-ярлык: {error}"))?;
    let helper_exe = dir.join("Eclipse-HV.exe");
    let target = wide(&helper_exe);
    let argument = wide_quoted_path(exe);
    let working_dir = wide(dir);
    let icon = wide(exe);
    let description = wide_text(&format!("Eclipse-HV: запуск игры {name}"));

    let target_pidl = unsafe { ILCreateFromPathW(PCWSTR(target.as_ptr())) };
    let pidl_result = if target_pidl.is_null() {
        Err("Windows Shell не смог определить файл лаунчера.".to_string())
    } else {
        let result = unsafe { link.SetIDList(target_pidl) }
            .map_err(|error| format!("Не удалось задать цель через Windows Shell: {error}"));
        unsafe { ILFree(Some(target_pidl)) };
        result
    };
    if let Err(pidl_error) = pidl_result {
        unsafe { link.SetPath(PCWSTR(target.as_ptr())) }.map_err(|error| {
            format!(
                "Не удалось задать цель ярлыка {}: {pidl_error}; резервный способ: {error}",
                helper_exe.display()
            )
        })?;
    }
    unsafe {
        link.SetArguments(PCWSTR(argument.as_ptr()))
            .map_err(|error| format!("Не удалось задать игру для ярлыка: {error}"))?;
        link.SetWorkingDirectory(PCWSTR(working_dir.as_ptr()))
            .map_err(|error| format!("Не удалось задать папку игры: {error}"))?;
        link.SetIconLocation(PCWSTR(icon.as_ptr()), 0)
            .map_err(|error| format!("Не удалось задать значок игры: {error}"))?;
        link.SetDescription(PCWSTR(description.as_ptr()))
            .map_err(|error| format!("Не удалось задать описание ярлыка: {error}"))?;
    }
    let persist: IPersistFile = link
        .cast()
        .map_err(|error| format!("Не удалось сохранить ярлык: {error}"))?;
    let output = wide(shortcut);
    unsafe { persist.Save(PCWSTR(output.as_ptr()), true) }
        .map_err(|error| format!("Не удалось записать {}: {error}", shortcut.display()))?;
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn create_desktop_shortcut(
    exe: &Path,
    dir: &Path,
    name: &str,
    preferred_shortcut: Option<&Path>,
) -> Result<PathBuf, String> {
    let desktop = desktop_dir()?;
    let safe_name = safe_shortcut_name(name);
    let shortcut = if let Some(pref) = preferred_shortcut {
        if pref.parent() == Some(&desktop) && pref.is_file() {
            pref.to_path_buf()
        } else {
            desktop.join(format!("{safe_name} (Eclipse HV).lnk"))
        }
    } else {
        desktop.join(format!("{safe_name} (Eclipse HV).lnk"))
    };

    let exe_clone = exe.to_path_buf();
    let dir_clone = dir.to_path_buf();
    let name_clone = name.to_string();
    let shortcut_clone = shortcut.clone();

    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let res = write_shortcut_initialized(&exe_clone, &dir_clone, &name_clone, &shortcut_clone);
        unsafe {
            CoUninitialize();
        }
        res
    })
    .join()
    .map_err(|_| "Сбой потока создания ярлыка COM".to_string())??;

    Ok(shortcut)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn create_desktop_shortcut(
    _exe: &Path,
    _dir: &Path,
    _name: &str,
    _preferred_shortcut: Option<&Path>,
) -> Result<PathBuf, String> {
    Err("Создание ярлыков рабочего стола доступно только в Windows".into())
}

fn default_launcher_id() -> String {
    ECLIPSE_HV_LAUNCHER_ID.to_string()
}

fn default_launcher_name() -> String {
    "Eclipse-HV".to_string()
}

fn default_batch_name() -> String {
    "Eclipse-HV.exe".to_string()
}

fn default_helper_label() -> String {
    "Eclipse-HV.exe".to_string()
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Library {
    pub selected_id: Option<String>,
    #[serde(default = "default_launcher_id")]
    pub selected_launcher_id: String,
    pub games: Vec<GameEntry>,
}

impl Default for Library {
    fn default() -> Self {
        Self {
            selected_id: None,
            selected_launcher_id: default_launcher_id(),
            games: Vec::new(),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct LibraryView {
    pub selected_id: Option<String>,
    pub selected_launcher_id: String,
    pub launchers: Vec<LauncherProfileView>,
    pub games: Vec<GameEntry>,
}

#[derive(Serialize)]
pub(crate) struct AppStatus {
    pub version: String,
    pub admin: bool,
    pub games_count: usize,
    pub game_running: bool,
    pub selected_game: Option<GameEntry>,
    pub selected_launcher: LauncherProfileView,
    pub root_batch_found: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct LauncherProfileView {
    pub id: String,
    pub name: String,
    pub badge: String,
    pub batch_name: String,
    pub helper_label: String,
    pub description: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct UiEvent {
    pub kind: String,
    pub message: String,
    pub step: Option<u8>,
    pub game_id: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct RunReport {
    pub success: bool,
    pub code: Option<i32>,
    pub message: String,
}

// Проверка гипервизора и выбранной игры вне главного потока
#[tauri::command(async)]
pub(crate) fn get_app_status() -> Result<AppStatus, String> {
    let library = refresh_library(load_library()?);
    let selected_game = selected_game(&library).cloned();
    let game_running = selected_game
        .as_ref()
        .is_some_and(|game| process_name_running(&game.loader_name).unwrap_or(false));
    let selected_launcher = launcher_profile_view();
    let admin = is_admin();

    Ok(AppStatus {
        version: VERSION.to_string(),
        admin,
        games_count: library.games.len(),
        game_running,
        selected_game,
        selected_launcher,
        root_batch_found: true,
    })
}

// Проверка процесса игры вне главного потока
#[tauri::command(async)]
pub(crate) fn is_selected_game_running() -> Result<bool, String> {
    let library = refresh_library(load_library()?);
    let Some(game) = selected_game(&library) else {
        return Ok(false);
    };
    process_name_running(&game.loader_name)
}

#[tauri::command]
pub(crate) fn list_games() -> Result<LibraryView, String> {
    let library = refresh_library(load_library()?);
    save_library(&library)?;
    Ok(library_view(library))
}

// Проверка обновлений (совместимость API: Eclipse-HV встроен и автономен)
#[tauri::command]
pub(crate) async fn check_asset_updates(app: tauri::AppHandle) -> Result<(), String> {
    emit(
        &app,
        "success",
        "Лаунчер Eclipse-HV встроен и готов к работе.".to_string(),
        None,
        None,
    );
    Ok(())
}

// Диалог выбора исполняемого файла игры через нативный проводник Windows (IFileOpenDialog)
#[tauri::command]
pub(crate) async fn select_game_exe(window: tauri::Window) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(target_os = "windows"))]
    let owner = 0;

    tauri::async_runtime::spawn_blocking(move || {
        crate::native_dialog::pick_exe_file("Выберите исполняемый файл игры (.exe)", owner)
    })
    .await
    .map_err(|error| format!("Диалог выбора файла прерван: {error}"))?
}

// Добавление игры в библиотеку и размещение в ней Eclipse-HV.exe
#[tauri::command]
pub(crate) fn add_game(
    app: tauri::AppHandle,
    exe_path: String,
    create_shortcut: Option<bool>,
    _launcher_id: Option<String>,
) -> Result<LibraryView, String> {
    let exe = validate_exe_path(&exe_path)?;
    let dir = exe
        .parent()
        .ok_or_else(|| "Не удалось определить папку игры.".to_string())?
        .to_path_buf();
    let loader_name = exe
        .file_name()
        .ok_or_else(|| "Не удалось определить имя exe.".to_string())?
        .to_string_lossy()
        .to_string();
    let game_id = make_game_id(&exe);
    let mut library = load_library()?;

    emit(
        &app,
        "info",
        format!("Добавляю игру: {}", exe.display()),
        Some(1),
        Some(game_id.clone()),
    );

    // Установка автономного лаунчера Eclipse-HV и очистка устаревших файлов
    prepare_game_files(&app, &game_id, &dir)?;

    let name = exe
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "Game".to_string());

    let mut shortcut_path = String::new();
    if create_shortcut.unwrap_or(true) {
        #[cfg(target_os = "windows")]
        match create_desktop_shortcut(&exe, &dir, &name, None) {
            Ok(sc) => {
                shortcut_path = sc.display().to_string();
                emit(
                    &app,
                    "info",
                    format!("Создан ярлык на рабочем столе: {}", sc.display()),
                    Some(2),
                    Some(game_id.clone()),
                );
            }
            Err(e) => {
                emit(
                    &app,
                    "warning",
                    format!("Не удалось создать ярлык на рабочем столе: {e}"),
                    Some(2),
                    Some(game_id.clone()),
                );
            }
        }
    }

    library
        .games
        .retain(|game| game.exe_path != exe.display().to_string());

    library.games.push(GameEntry {
        id: game_id.clone(),
        name,
        exe_path: exe.display().to_string(),
        dir_path: dir.display().to_string(),
        loader_name,
        launcher_id: ECLIPSE_HV_LAUNCHER_ID.to_string(),
        launcher_name: "Eclipse-HV".to_string(),
        batch_name: "Eclipse-HV.exe".to_string(),
        helper_label: "Eclipse-HV.exe".to_string(),
        shortcut_path,
        batch_found: true,
        ready: true,
        last_message: "Игра добавлена и подготовлена с лаунчером Eclipse-HV.".to_string(),
    });
    library.selected_id = Some(game_id);
    library.selected_launcher_id = ECLIPSE_HV_LAUNCHER_ID.to_string();

    let library = refresh_library(library);
    save_library(&library)?;
    Ok(library_view(library))
}

// Заглушка смены профиля (в системе используется исключительно единый метод Eclipse-HV)
#[tauri::command]
pub(crate) fn set_game_launcher(
    _app: tauri::AppHandle,
    _id: String,
    _launcher_id: String,
) -> Result<LibraryView, String> {
    let library = refresh_library(load_library()?);
    Ok(library_view(library))
}

#[tauri::command]
pub(crate) fn set_selected_game(id: String) -> Result<LibraryView, String> {
    let mut library = load_library()?;
    if library.games.iter().any(|game| game.id == id) {
        library.selected_id = Some(id);
    }
    let library = refresh_library(library);
    save_library(&library)?;
    Ok(library_view(library))
}

#[tauri::command]
pub(crate) fn remove_game(id: String) -> Result<LibraryView, String> {
    if steam_launch_accounts()
        .unwrap_or_default()
        .into_iter()
        .any(|account| {
            steam_launch_status(id.clone(), Some(account.id)).is_ok_and(|status| status.managed)
        })
    {
        return Err("Сначала нажмите «Вернуть обычный запуск» для этой игры, затем удалите её из библиотеки.".into());
    }
    let mut library = load_library()?;
    if let Some(pos) = library.games.iter().position(|game| game.id == id) {
        let game = library.games.remove(pos);
        if !game.shortcut_path.is_empty() {
            let p = PathBuf::from(&game.shortcut_path);
            if p.is_file() {
                let _ = fs::remove_file(p);
            }
        }
    }
    if library.selected_id.as_deref() == Some(id.as_str()) {
        library.selected_id = library.games.first().map(|game| game.id.clone());
    }
    let library = refresh_library(library);
    save_library(&library)?;
    Ok(library_view(library))
}

#[tauri::command]
pub(crate) fn verify_game(
    app: tauri::AppHandle,
    id: String,
    create_shortcut: Option<bool>,
) -> Result<LibraryView, String> {
    let mut library = load_library()?;
    let game_index = library
        .games
        .iter()
        .position(|game| game.id == id)
        .ok_or_else(|| "Игра не найдена в библиотеке.".to_string())?;

    let dir = PathBuf::from(&library.games[game_index].dir_path);
    let exe = PathBuf::from(&library.games[game_index].exe_path);
    let name = library.games[game_index].name.clone();

    prepare_game_files(&app, &id, &dir)?;

    if create_shortcut.unwrap_or(true) && library.games[game_index].shortcut_path.is_empty() {
        #[cfg(target_os = "windows")]
        if let Ok(sc) = create_desktop_shortcut(&exe, &dir, &name, None) {
            library.games[game_index].shortcut_path = sc.display().to_string();
        }
    }

    let library = refresh_library(library);
    save_library(&library)?;
    Ok(library_view(library))
}

#[tauri::command]
pub(crate) fn create_game_shortcut(
    _app: tauri::AppHandle,
    id: String,
) -> Result<LibraryView, String> {
    let mut library = load_library()?;
    let game = library
        .games
        .iter_mut()
        .find(|g| g.id == id)
        .ok_or_else(|| "Игра не найдена в библиотеке.".to_string())?;
    let exe = PathBuf::from(&game.exe_path);
    let dir = PathBuf::from(&game.dir_path);
    if !exe.is_file() {
        return Err("Исполняемый файл игры не найден.".to_string());
    }
    let shortcut = create_desktop_shortcut(&exe, &dir, &game.name, None)?;
    game.shortcut_path = shortcut.display().to_string();
    game.last_message = "Ярлык игры успешно создан на рабочем столе.".to_string();
    let library = refresh_library(library);
    save_library(&library)?;
    Ok(library_view(library))
}

#[tauri::command]
pub(crate) fn remove_game_shortcut(id: String) -> Result<LibraryView, String> {
    let mut library = load_library()?;
    let game = library
        .games
        .iter_mut()
        .find(|g| g.id == id)
        .ok_or_else(|| "Игра не найдена в библиотеке.".to_string())?;
    if !game.shortcut_path.is_empty() {
        let path = PathBuf::from(&game.shortcut_path);
        if path.is_file() {
            let _ = fs::remove_file(path);
        }
        game.shortcut_path.clear();
        game.last_message = "Ярлык игры удалён с рабочего стола.".to_string();
    }
    let library = refresh_library(library);
    save_library(&library)?;
    Ok(library_view(library))
}

#[tauri::command]
pub(crate) async fn launch_selected_game(app: tauri::AppHandle) -> Result<RunReport, String> {
    tauri::async_runtime::spawn_blocking(move || launch_selected_game_inner(app))
        .await
        .map_err(|error| format!("Задача запуска завершилась ошибкой: {error}"))?
}

fn launch_selected_game_inner(app: tauri::AppHandle) -> Result<RunReport, String> {
    let library = refresh_library(load_library()?);
    let game = selected_game(&library)
        .cloned()
        .ok_or_else(|| "Сначала добавьте и выберите игру во вкладке Игры.".to_string())?;
    let dir = PathBuf::from(&game.dir_path);

    emit(
        &app,
        "info",
        "Проверка файлов лаунчера Eclipse-HV...".to_string(),
        Some(1),
        Some(game.id.clone()),
    );

    // Убеждаемся, что Eclipse-HV.exe присутствует в папке с игрой
    prepare_game_files(&app, &game.id, &dir)?;

    let target_hv = dir.join("Eclipse-HV.exe");
    if !target_hv.is_file() {
        return Err("Файл Eclipse-HV.exe не найден в директории игры.".to_string());
    }

    emit(
        &app,
        "info",
        format!("Запуск {} через Eclipse-HV...", game.name),
        Some(4),
        Some(game.id.clone()),
    );

    match spawn_eclipse_hv(&target_hv, &game.exe_path, &dir) {
        Ok(_) => {
            emit(
                &app,
                "success",
                format!("Лаунчер Eclipse-HV запущен для {}.", game.name),
                Some(5),
                Some(game.id.clone()),
            );
            Ok(RunReport {
                success: true,
                code: Some(0),
                message: format!("Лаунчер Eclipse-HV запущен для {}.", game.name),
            })
        }
        Err(err) => {
            emit(&app, "error", err.clone(), None, Some(game.id.clone()));
            Err(err)
        }
    }
}

#[cfg(target_os = "windows")]
fn spawn_eclipse_hv(hv_exe: &Path, game_exe: &str, dir: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };

    let executable: Vec<u16> = hv_exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let parameters: Vec<u16> = format!("\"{}\"", game_exe)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let directory: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();

    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(executable.as_ptr()),
            PCWSTR(parameters.as_ptr()),
            PCWSTR(directory.as_ptr()),
            SW_SHOWNORMAL,
        )
    };

    if result.0 as isize <= 32 {
        if result.0 as isize == 5 {
            return Err("Запрос прав администратора (UAC) был отклонён пользователем.".to_string());
        }
        return Err(format!(
            "Не удалось запустить Eclipse-HV.exe с правами администратора (код ошибки Windows: {})",
            result.0 as isize
        ));
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn spawn_eclipse_hv(hv_exe: &Path, game_exe: &str, dir: &Path) -> Result<(), String> {
    let mut cmd = Command::new(hv_exe);
    cmd.arg(game_exe);
    cmd.current_dir(dir);
    cmd.spawn()
        .map_err(|e| format!("Не удалось запустить Eclipse-HV: {e}"))?;
    Ok(())
}

// Размещение встроенного Eclipse-HV.exe в папке игры и очистка мусора
fn prepare_game_files(app: &tauri::AppHandle, game_id: &str, dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Err(format!("Папка игры не найдена: {}", dir.display()));
    }

    crate::jobs::run(
        &[dir.to_path_buf()],
        "Проверить встроенный лаунчер",
        || -> Result<(), String> {
            use sha2::{Digest, Sha256};
            let target = crate::safe_path::join(dir, "Eclipse-HV.exe")?;
            let hash = format!("{:x}", Sha256::digest(EMBEDDED_ECLIPSE_HV));
            if crate::durable::hash_file(&target).ok().as_deref() != Some(hash.as_str()) {
                crate::backup::protect(dir, "Eclipse-HV.exe", "embedded-launcher")?;
                crate::durable::write(&target, EMBEDDED_ECLIPSE_HV)?;
                if crate::durable::hash_file(&target)? != hash {
                    return Err("Проверка лаунчера после записи не пройдена".into());
                }
                emit(
                    app,
                    "success",
                    "Встроенный лаунчер записан и проверен SHA-256.".into(),
                    Some(3),
                    Some(game_id.into()),
                );
            }
            // Не удаляем сторонние исполняемые файлы и папки по одному лишь имени
            Ok(())
        },
    )?
}

fn validate_exe_path(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim().trim_matches('"'));
    if !path.is_file() {
        return Err(format!("Файл не существует: {}", path.display()));
    }
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase());
    if ext.as_deref() != Some("exe") {
        return Err("Выбранный файл должен иметь расширение .exe.".to_string());
    }
    Ok(path)
}

fn make_game_id(path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().to_lowercase().hash(&mut hasher);
    format!("game_{:016x}", hasher.finish())
}

fn library_path() -> Result<PathBuf, String> {
    let local = env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .map_err(|_| "Переменная LOCALAPPDATA не определена.".to_string())?;
    let dir = local.join("Eclipse Studio").join("Hypervisor");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Не удалось создать папку библиотеки: {error}"))?;
    Ok(dir.join("library.json"))
}

pub(crate) fn load_library() -> Result<Library, String> {
    let path = library_path()?;
    if !path.exists() {
        return Ok(Library::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
    serde_json::from_str(&content).or_else(|_| Ok(Library::default()))
}

fn save_library(library: &Library) -> Result<(), String> {
    let path = library_path()?;
    let content = serde_json::to_string_pretty(library)
        .map_err(|error| format!("Не удалось сериализовать библиотеку: {error}"))?;
    fs::write(&path, content)
        .map_err(|error| format!("Не удалось сохранить {}: {error}", path.display()))?;
    Ok(())
}

fn selected_game(library: &Library) -> Option<&GameEntry> {
    let selected_id = library.selected_id.as_deref()?;
    library.games.iter().find(|game| game.id == selected_id)
}

fn refresh_library(mut library: Library) -> Library {
    for game in &mut library.games {
        let exe = PathBuf::from(&game.exe_path);
        let dir = PathBuf::from(&game.dir_path);
        let hv_present = dir.join("Eclipse-HV.exe").exists();

        game.launcher_id = ECLIPSE_HV_LAUNCHER_ID.to_string();
        game.launcher_name = "Eclipse-HV".to_string();
        game.batch_name = "Eclipse-HV.exe".to_string();
        game.helper_label = "Eclipse-HV.exe".to_string();
        game.batch_found = hv_present;
        game.ready = exe.exists();

        if !game.shortcut_path.is_empty() && !Path::new(&game.shortcut_path).is_file() {
            game.shortcut_path.clear();
        }
        #[cfg(target_os = "windows")]
        if game.shortcut_path.is_empty() {
            if let Ok(desktop) = desktop_dir() {
                let candidate = desktop.join(format!(
                    "{} (Eclipse HV).lnk",
                    safe_shortcut_name(&game.name)
                ));
                if candidate.is_file() {
                    game.shortcut_path = candidate.display().to_string();
                }
            }
        }

        if !exe.exists() {
            game.last_message = "EXE игры не найден.".to_string();
        } else if !hv_present {
            game.last_message = "Требуется разместить Eclipse-HV.exe.".to_string();
        } else {
            game.last_message = "Готова к запуску через Eclipse-HV.".to_string();
        }
    }
    library
}

fn library_view(library: Library) -> LibraryView {
    LibraryView {
        selected_id: library.selected_id,
        selected_launcher_id: ECLIPSE_HV_LAUNCHER_ID.to_string(),
        launchers: vec![launcher_profile_view()],
        games: library.games,
    }
}

fn launcher_profile_view() -> LauncherProfileView {
    LauncherProfileView {
        id: LAUNCHER_PROFILE.id.to_string(),
        name: LAUNCHER_PROFILE.name.to_string(),
        badge: LAUNCHER_PROFILE.badge.to_string(),
        batch_name: LAUNCHER_PROFILE.batch_name.to_string(),
        helper_label: LAUNCHER_PROFILE.helper_label.to_string(),
        description: LAUNCHER_PROFILE.description.to_string(),
    }
}

fn emit(
    app: &tauri::AppHandle,
    kind: &str,
    message: String,
    step: Option<u8>,
    game_id: Option<String>,
) {
    let _ = app.emit(
        "station-event",
        UiEvent {
            kind: kind.to_string(),
            message,
            step,
            game_id,
        },
    );
}

fn is_admin() -> bool {
    let mut command = Command::new("net.exe");
    command.arg("session");

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn process_name_running(name: &str) -> Result<bool, String> {
    let mut command = Command::new("tasklist.exe");
    command.arg("/FO").arg("CSV").arg("/NH");

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|error| format!("Не удалось запустить tasklist: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(tasklist_contains_process(&stdout, name))
}

pub(crate) fn tasklist_contains_process(output: &str, process_name: &str) -> bool {
    let needle = process_name.trim().to_lowercase();
    output.lines().any(|line| {
        let lower = line.to_lowercase();
        lower
            .split(',')
            .next()
            .map(|chunk| chunk.trim().trim_matches('"'))
            .is_some_and(|name| name == needle)
    })
}

// ── Интеграция автономного лаунчера Eclipse-HV

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EclipseHvStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub size_bytes: Option<u64>,
    pub version: String,
    pub remote_version: Option<String>,
    pub update_available: bool,
    pub destination_dir: String,
}

#[tauri::command]
pub(crate) async fn eclipse_hv_status(
    target_dir: Option<String>,
) -> Result<EclipseHvStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = resolve_eclipse_hv_dest(target_dir.as_deref());
        let exe_path = dest.join("Eclipse-HV.exe");
        let installed = exe_path.is_file();
        let size_bytes = if installed {
            fs::metadata(&exe_path).ok().map(|m| m.len())
        } else {
            None
        };

        let embedded_size = EMBEDDED_ECLIPSE_HV.len() as u64;
        // Обновление требуется только если файл не установлен или его размер отличается от встроенного актуального лаунчера
        let update_available = if !installed {
            true
        } else if let Some(local_size) = size_bytes {
            local_size != embedded_size
        } else {
            true
        };

        Ok(EclipseHvStatus {
            installed,
            path: if installed {
                Some(exe_path.to_string_lossy().to_string())
            } else {
                None
            },
            size_bytes,
            version: if installed {
                "1.1.0".to_string()
            } else {
                "не установлен".to_string()
            },
            remote_version: Some("1.1.0".to_string()),
            update_available,
            destination_dir: dest.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| format!("Операция проверки прервана: {e}"))?
}

/// Проверка обновлений автономного лаунчера Eclipse-HV через сеть и встроенные ресурсы
#[tauri::command]
pub(crate) async fn eclipse_hv_check_update(
    target_dir: Option<String>,
) -> Result<EclipseHvStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = resolve_eclipse_hv_dest(target_dir.as_deref());
        let exe_path = dest.join("Eclipse-HV.exe");
        let installed = exe_path.is_file();
        let size_bytes = if installed {
            fs::metadata(&exe_path).ok().map(|m| m.len())
        } else {
            None
        };

        let embedded_size = EMBEDDED_ECLIPSE_HV.len() as u64;

        // Сетевая проверка актуальности лаунчера с переходом по редиректам
        let mut remote_size: Option<u64> = None;
        let remote_version = "1.1.0".to_string();

        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(4))
            .user_agent(concat!("Eclipse-Studio/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build();

        if let Ok(client) = client {
            let download_url = "https://github.com/Sparki1337/eclipse-studio/releases/latest/download/Eclipse-HV.exe";
            if let Ok(resp) = client.head(download_url).send() {
                if resp.status().is_success() {
                    if let Some(cl) = resp.content_length() {
                        // Отсекаем некорректные пустые заголовки промежуточных редиректов
                        if cl > 100_000 {
                            remote_size = Some(cl);
                        }
                    }
                }
            }
        }

        let update_available = if !installed {
            true
        } else if let Some(local_size) = size_bytes {
            if let Some(r_size) = remote_size {
                local_size != r_size
            } else {
                local_size != embedded_size
            }
        } else {
            true
        };

        Ok(EclipseHvStatus {
            installed,
            path: if installed { Some(exe_path.to_string_lossy().to_string()) } else { None },
            size_bytes,
            version: if installed { "1.1.0".to_string() } else { "не установлен".to_string() },
            remote_version: Some(remote_version),
            update_available,
            destination_dir: dest.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| format!("Операция проверки прервана: {e}"))?
}

#[tauri::command]
pub(crate) async fn eclipse_hv_download(target_dir: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = resolve_eclipse_hv_dest(target_dir.as_deref());
        if !dest.exists() {
            let _ = fs::create_dir_all(&dest);
        }
        let target_exe = dest.join("Eclipse-HV.exe");

        // Встроенные ресурсы надёжнее сети: внешних запросов не требуется
        if !EMBEDDED_ECLIPSE_HV.is_empty() {
            fs::write(&target_exe, EMBEDDED_ECLIPSE_HV).map_err(|e| {
                format!(
                    "Не удалось записать Eclipse-HV.exe в {}: {e}",
                    target_exe.display()
                )
            })?;
            return Ok(format!(
                "Eclipse-HV.exe успешно развернут в {}",
                dest.display()
            ));
        }

        // Резервный поиск в локальной папке Hypervisor
        let local_path =
            PathBuf::from(r"C:\Users\Sparki\Desktop\Programms\Hypervisor\Eclipse-HV.exe");
        if local_path.is_file() {
            fs::copy(&local_path, &target_exe)
                .map_err(|e| format!("Не удалось скопировать Eclipse-HV.exe: {e}"))?;
            return Ok(format!(
                "Eclipse-HV.exe успешно скопирован в {}",
                dest.display()
            ));
        }

        // Прямая загрузка с GitHub при отсутствии локальных бинарников
        let download_url =
            "https://github.com/Sparki1337/eclipse-studio/releases/latest/download/Eclipse-HV.exe";
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("Eclipse-Studio/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("Ошибка создания HTTP клиента: {e}"))?;

        let response = client.get(download_url).send();
        match response {
            Ok(resp) if resp.status().is_success() => {
                let bytes = resp
                    .bytes()
                    .map_err(|e| format!("Ошибка загрузки данных: {e}"))?;
                fs::write(&target_exe, bytes)
                    .map_err(|e| format!("Не удалось записать файл: {e}"))?;
                Ok(format!(
                    "Eclipse-HV.exe успешно загружен с GitHub в {}",
                    dest.display()
                ))
            }
            _ => Err("Не удалось скачать Eclipse-HV.exe с GitHub.".into()),
        }
    })
    .await
    .map_err(|e| format!("Ошибка загрузки: {e}"))?
}

fn resolve_eclipse_hv_dest(target_dir: Option<&str>) -> PathBuf {
    if let Some(dir) = target_dir {
        let p = PathBuf::from(dir.trim_matches('"'));
        if p.exists() {
            return p;
        }
    }

    if let Ok(library) = load_library() {
        if let Some(game) = selected_game(&library) {
            let p = PathBuf::from(&game.dir_path);
            if p.exists() {
                return p;
            }
        }
        if let Some(first) = library.games.first() {
            let p = PathBuf::from(&first.dir_path);
            if p.exists() {
                return p;
            }
        }
    }

    PathBuf::from(r"C:\Users\Sparki\Desktop\Programms\Hypervisor")
}

#[cfg(test)]
mod tests {
    use super::tasklist_contains_process;

    #[test]
    fn tasklist_detects_selected_executable_case_insensitively() {
        let output = "\"BBQ-Win64-Shipping.exe\",\"14840\",\"Console\",\"1\",\"512,000 K\"\r\n";
        assert!(tasklist_contains_process(output, "bbq-win64-shipping.exe"));
    }

    #[test]
    fn embedded_binaries_are_present() {
        assert!(
            !super::EMBEDDED_ECLIPSE_HV.is_empty(),
            "EMBEDDED_ECLIPSE_HV must not be empty"
        );
    }
}
