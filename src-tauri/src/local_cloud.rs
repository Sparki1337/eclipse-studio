//! Команды локального облака: CloudRedirect хранит Steam Cloud игр с Lua и манифестами
//! в выбранной папке. Steam закрывается штатно, настройки пишутся с резервной копией и откатом.
use crate::local_cloud_core as core;
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Модифицированная сборка CloudRedirect из официального релиза (исходники — third_party/cloudredirect)
const EMBEDDED_DLL: &[u8] = include_bytes!("../resources/local-cloud/cgs_cloud_redirect.dll");
/// Сколько ждать штатного завершения Steam
const STEAM_STOP_TIMEOUT: Duration = Duration::from_secs(30);

fn embedded_sha256() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| core::sha256_hex(EMBEDDED_DLL))
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn steam_root(steam_path: Option<String>) -> Result<PathBuf, String> {
    crate::luatools::resolve_steam_path(steam_path).ok_or_else(|| {
        "Папка Steam не найдена. Укажите путь к Steam в поле выше и нажмите «Проверить»."
            .to_string()
    })
}

fn current_status(steam: &Path) -> Result<core::Status, String> {
    let snap = core::snapshot(steam)?;
    Ok(core::status(steam, &snap, embedded_sha256()))
}

/// Состояние локального облака для выбранной папки Steam
#[tauri::command]
pub async fn local_cloud_status(steam_path: Option<String>) -> Result<core::Status, String> {
    tauri::async_runtime::spawn_blocking(move || current_status(&steam_root(steam_path)?))
        .await
        .map_err(|error| format!("Проверка локального облака прервана: {error}"))?
}

/// Выбор папки хранения в системном диалоге с понятным заголовком
#[tauri::command]
pub async fn local_cloud_pick_folder(
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    #[cfg(not(windows))]
    let owner = {
        let _ = window;
        0
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::native_dialog::pick_folder("Выберите папку для локального облака", owner)
    })
    .await
    .map_err(|error| format!("Диалог выбора прерван: {error}"))?
}

/// Включение, смена папки или выключение локального облака
#[tauri::command]
pub async fn local_cloud_set(
    steam_path: Option<String>,
    enabled: bool,
    folder: Option<String>,
) -> Result<core::Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let steam = steam_root(steam_path)?;
        crate::jobs::run(
            &[steam.clone()],
            "Настройка локального облака",
            || set_blocking(&steam, enabled, folder),
        )?
    })
    .await
    .map_err(|error| format!("Настройка локального облака прервана: {error}"))?
}

#[cfg(not(target_os = "windows"))]
fn set_blocking(
    _steam: &Path,
    _enabled: bool,
    _folder: Option<String>,
) -> Result<core::Status, String> {
    Err("Локальное облако доступно только в Windows.".into())
}

#[cfg(target_os = "windows")]
fn set_blocking(
    steam: &Path,
    enabled: bool,
    folder: Option<String>,
) -> Result<core::Status, String> {
    let now = now_unix();
    let snap = core::snapshot(steam)?;
    let previous = core::parse_state(snap.state.as_deref()).ok();
    let previous_folder = previous
        .as_ref()
        .and_then(|state| state.folder.clone())
        .or_else(|| snap.provider.as_deref().and_then(core::provider_folder));
    // Все проверки выполняются до закрытия Steam: при ошибке клиент не трогаем
    let target = match enabled {
        true => {
            let folder = folder
                .or_else(|| previous_folder.clone())
                .ok_or("Сначала выберите папку локального облака.")?;
            let path = core::normalize_folder(&folder, steam)?;
            ensure_local_drive(&path)?;
            core::ensure_writable(&path)?;
            Some(path)
        }
        false => None,
    };
    let plan = match &target {
        Some(path) => {
            core::plan_enable(steam, &snap, &path.display().to_string(), EMBEDDED_DLL, now)?
        }
        None => core::plan_disable(steam, &snap, embedded_sha256(), now)?,
    };
    if is_noop(&plan, previous.as_ref()) {
        return current_status(steam);
    }
    ensure_no_game_running()?;
    let was_running = crate::luatools::process_is_running("steam.exe");
    if was_running {
        stop_steam(steam)?;
    }
    let result = apply_stopped(
        steam,
        &snap,
        &plan,
        previous_folder.as_deref(),
        target.as_deref(),
        now,
    );
    if was_running {
        start_steam(steam);
    }
    result?;
    current_status(steam)
}

/// Изменения нет: тот же режим, та же папка и та же DLL — Steam не перезапускается
#[cfg(target_os = "windows")]
fn is_noop(plan: &core::EnablePlan, previous: Option<&core::State>) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    let same_state = core::State {
        updated_unix: previous.updated_unix,
        ..plan.state.clone()
    } == *previous;
    same_state
        && plan
            .changes
            .iter()
            .all(|(name, _)| *name == core::STATE_FILE)
}

#[cfg(target_os = "windows")]
fn apply_stopped(
    steam: &Path,
    snap: &core::Snapshot,
    plan: &core::EnablePlan,
    previous_folder: Option<&str>,
    target: Option<&Path>,
    now: u64,
) -> Result<(), String> {
    // Пока Steam закрывался, файлы могла изменить другая программа
    if core::snapshot(steam)? != *snap {
        return Err("Конфигурация Steam изменилась во время настройки. Повторите операцию.".into());
    }
    if let (Some(old), Some(new)) = (previous_folder, target) {
        core::migrate_folder(Path::new(old), new)?;
    }
    core::backup(steam, snap, now)?;
    core::apply(steam, snap, &plan.changes)
}

/// Облако принимает только локальные и съёмные диски: сетевые папки и RAM-диски не подходят
#[cfg(target_os = "windows")]
fn ensure_local_drive(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let root: Vec<u16> = path
        .components()
        .take(2)
        .collect::<PathBuf>()
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // DRIVE_REMOVABLE = 2, DRIVE_FIXED = 3
    let kind = unsafe {
        windows::Win32::Storage::FileSystem::GetDriveTypeW(windows::core::PCWSTR(root.as_ptr()))
    };
    match kind {
        2 | 3 => Ok(()),
        _ => Err("Выберите локальный или съёмный диск.".into()),
    }
}

/// Пока идёт игра, Steam держит её облачные файлы — менять режим нельзя
#[cfg(target_os = "windows")]
fn ensure_no_game_running() -> Result<(), String> {
    let running = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(r"Software\Valve\Steam")
        .and_then(|key| key.get_value::<u32, _>("RunningAppID"))
        .unwrap_or(0);
    if running != 0 {
        return Err("Закройте игры перед изменением локального облака.".into());
    }
    Ok(())
}

/// Штатное завершение Steam: без принудительного снятия процесса, чтобы клиент успел записать облако
#[cfg(target_os = "windows")]
fn stop_steam(steam: &Path) -> Result<(), String> {
    let exe = steam.join("steam.exe");
    crate::luatools::hidden_command(exe.to_string_lossy().as_ref())
        .arg("-shutdown")
        .spawn()
        .map_err(|error| format!("Не удалось закрыть Steam: {error}"))?;
    let started = Instant::now();
    while started.elapsed() < STEAM_STOP_TIMEOUT {
        std::thread::sleep(Duration::from_millis(500));
        if !crate::luatools::process_is_running("steam.exe") {
            // Небольшая пауза: процесс снят, но файлы DLL освобождаются не мгновенно
            std::thread::sleep(Duration::from_millis(500));
            return Ok(());
        }
    }
    Err("Steam не завершился за 30 секунд; настройки не изменены.".into())
}

#[cfg(target_os = "windows")]
fn start_steam(steam: &Path) {
    let exe = steam.join("steam.exe");
    let _ = crate::luatools::hidden_command(exe.to_string_lossy().as_ref())
        .current_dir(steam)
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_dll_is_cloud_redirect() {
        // Встроенная DLL — PE-файл с экспортом инициализации облака
        assert!(EMBEDDED_DLL.starts_with(b"MZ"));
        assert!(EMBEDDED_DLL
            .windows(core::CLOUD_EXPORT.len())
            .any(|window| window == core::CLOUD_EXPORT));
        assert_eq!(embedded_sha256().len(), 64);
    }
}
