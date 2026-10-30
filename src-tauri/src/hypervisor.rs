// Модуль гипервизора для изолированного запуска игр в Eclipse Studio.
// Использует исключительно авторский метод: автономный высокопроизводительный лаунчер Eclipse-HV.
// Все устаревшие механизмы (KVC, батники, сторонние скрипты) полностью вырезаны.

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
const CREATE_NO_WINDOW: u32 = 0x08000000;

const VERSION: &str = "8.0.0";
const ECLIPSE_HV_LAUNCHER_ID: &str = "eclipse_hv";

// Встроенный исполняемый файл автономного лаунчера Eclipse-HV
const EMBEDDED_ECLIPSE_HV: &[u8] = include_bytes!("../resources/hypervisor/Eclipse-HV.exe");

// Профиль гипервизорного лаунчера Eclipse-HV
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
    description: "Автономный высокопроизводительный лаунчер с обходом DSE в памяти и поддержкой Secure Boot.",
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
    pub batch_found: bool,
    #[serde(default)]
    pub kvc_found: bool,
    pub ready: bool,
    pub last_message: String,
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
    pub root_kvc_found: bool,
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

// Получение общего статуса гипервизора и выбранной игры
#[tauri::command]
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
        root_kvc_found: true,
    })
}

// Проверка процесса выбранной игры на активность
#[tauri::command]
pub(crate) fn is_selected_game_running() -> Result<bool, String> {
    let library = refresh_library(load_library()?);
    let Some(game) = selected_game(&library) else {
        return Ok(false);
    };
    process_name_running(&game.loader_name)
}

// Получение списка всех добавленных игр
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

    library
        .games
        .retain(|game| game.exe_path != exe.display().to_string());
    let name = exe
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "Game".to_string());

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
        batch_found: true,
        kvc_found: true,
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

// Выбор активной игры
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

// Удаление игры из библиотеки гипервизора
#[tauri::command]
pub(crate) fn remove_game(id: String) -> Result<LibraryView, String> {
    let mut library = load_library()?;
    library.games.retain(|game| game.id != id);
    if library.selected_id.as_deref() == Some(id.as_str()) {
        library.selected_id = library.games.first().map(|game| game.id.clone());
    }
    let library = refresh_library(library);
    save_library(&library)?;
    Ok(library_view(library))
}

// Проверка и восстановление файлов Eclipse-HV в папке игры
#[tauri::command]
pub(crate) fn verify_game(app: tauri::AppHandle, id: String) -> Result<LibraryView, String> {
    let mut library = load_library()?;
    let game = library
        .games
        .iter()
        .find(|game| game.id == id)
        .cloned()
        .ok_or_else(|| "Игра не найдена в библиотеке.".to_string())?;
    let dir = PathBuf::from(&game.dir_path);

    prepare_game_files(&app, &game.id, &dir)?;
    library = refresh_library(library);
    save_library(&library)?;
    Ok(library_view(library))
}

// Запуск выбранной игры напрямую через автономный лаунчер Eclipse-HV
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

    // Запуск автономного лаунчера с правами администратора (runas)
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

// Запуск Eclipse-HV с гарантированным запросом прав администратора через ShellExecuteW (runas)
#[cfg(target_os = "windows")]
fn spawn_eclipse_hv(hv_exe: &Path, game_exe: &str, dir: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };

    let executable: Vec<u16> = hv_exe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let parameters: Vec<u16> = format!("\"{}\"", game_exe).encode_utf16().chain(std::iter::once(0)).collect();
    let directory: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
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
    cmd.spawn().map_err(|e| format!("Не удалось запустить Eclipse-HV: {e}"))?;
    Ok(())
}

// Размещение встроенного Eclipse-HV.exe в папке игры и очистка мусора
fn prepare_game_files(app: &tauri::AppHandle, game_id: &str, dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Err(format!("Папка игры не найдена: {}", dir.display()));
    }

    let target = dir.join("Eclipse-HV.exe");
    let needs_write = match fs::metadata(&target) {
        Ok(m) => m.len() != EMBEDDED_ECLIPSE_HV.len() as u64,
        Err(_) => true,
    };

    if needs_write {
        fs::write(&target, EMBEDDED_ECLIPSE_HV)
            .map_err(|e| format!("Не удалось записать Eclipse-HV.exe в {}: {e}", target.display()))?;
        emit(
            app,
            "success",
            "Лаунчер Eclipse-HV.exe успешно развернут в папке игры.".to_string(),
            Some(3),
            Some(game_id.to_string()),
        );
    }

    // Удаление остатков старых батников и сторонних загрузчиков, если они были ранее скопированы
    cleanup_legacy_hypervisor_files(dir);

    Ok(())
}

// Полная очистка устаревших файлов прежних версий (старые bat-файлы, kvc.exe и папки)
fn cleanup_legacy_hypervisor_files(dir: &Path) {
    let legacy_files = [
        "HV-Launcher.bat",
        "HV-PlugNPlay.bat",
        "kvc.exe",
        "kvc.7z",
        "7zr.exe",
    ];

    for file in &legacy_files {
        let p = dir.join(file);
        if p.exists() {
            let _ = fs::remove_file(p);
        }
    }

    let legacy_dirs = ["KVC Installing", "DenuvOwO"];
    for folder in &legacy_dirs {
        let p = dir.join(folder);
        if p.exists() {
            let _ = fs::remove_dir_all(p);
        }
    }
}

// Валидация пути к исполняемому файлу
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

// Генерация уникального ID для игры по её пути
fn make_game_id(path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().to_lowercase().hash(&mut hasher);
    format!("game_{:016x}", hasher.finish())
}

// Путь к файлу базы данных библиотеки гипервизора
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
        game.kvc_found = hv_present;
        game.ready = exe.exists();

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

// Отправка сообщений и прогресса в графический интерфейс
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


// Проверка наличия прав администратора
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

// Проверка процесса в списке запущенных задач Windows
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

// ============================================================
// Модуль интеграции автономного лаунчера Eclipse-HV
// ============================================================

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
pub(crate) async fn eclipse_hv_status(target_dir: Option<String>) -> Result<EclipseHvStatus, String> {
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
            path: if installed { Some(exe_path.to_string_lossy().to_string()) } else { None },
            size_bytes,
            version: if installed { "1.1.0".to_string() } else { "не установлен".to_string() },
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
pub(crate) async fn eclipse_hv_check_update(target_dir: Option<String>) -> Result<EclipseHvStatus, String> {
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
            .user_agent("Eclipse-Studio/8.0.0")
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

        // Обновление доступно, только если файл не установлен или его размер отличается от актуального
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

        // 1. Устанавливаем из встроенных ресурсов лаунчера (100% надёжность без внешних запросов)
        if !EMBEDDED_ECLIPSE_HV.is_empty() {
            fs::write(&target_exe, EMBEDDED_ECLIPSE_HV)
                .map_err(|e| format!("Не удалось записать Eclipse-HV.exe в {}: {e}", target_exe.display()))?;
            return Ok(format!("Eclipse-HV.exe успешно развернут в {}", dest.display()));
        }

        // 2. Резервный поиск в локальной папке Hypervisor
        let local_path = PathBuf::from(r"C:\Users\Sparki\Desktop\Programms\Hypervisor\Eclipse-HV.exe");
        if local_path.is_file() {
            fs::copy(&local_path, &target_exe)
                .map_err(|e| format!("Не удалось скопировать Eclipse-HV.exe: {e}"))?;
            return Ok(format!("Eclipse-HV.exe успешно скопирован в {}", dest.display()));
        }

        // 3. Прямая загрузка с GitHub при отсутствии локальных бинарников
        let download_url = "https://github.com/Sparki1337/eclipse-studio/releases/latest/download/Eclipse-HV.exe";
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("Eclipse-Studio/8.0.0")
            .build()
            .map_err(|e| format!("Ошибка создания HTTP клиента: {e}"))?;

        let response = client.get(download_url).send();
        match response {
            Ok(resp) if resp.status().is_success() => {
                let bytes = resp.bytes().map_err(|e| format!("Ошибка загрузки данных: {e}"))?;
                fs::write(&target_exe, bytes)
                    .map_err(|e| format!("Не удалось записать файл: {e}"))?;
                Ok(format!("Eclipse-HV.exe успешно загружен с GitHub в {}", dest.display()))
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
