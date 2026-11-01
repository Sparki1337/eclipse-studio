//! Всё состояние WebView переносится в пользовательское хранилище DPAPI, ключи не возвращаются UI.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager};
static STATE_LOCK: Mutex<()> = Mutex::new(());
const SECRET_KEYS: &[&str] = &["hubcapKey", "ryuuKey"];
const MAX_STATE: usize = 16 * 1024 * 1024;
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    schema_version: u32,
    migrated: bool,
    values: BTreeMap<String, String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    values: BTreeMap<String, String>,
    secret_configured: BTreeMap<String, bool>,
    migration_verified: bool,
}
fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    crate::safe_path::join(&root, "state-v1.dpapi")
}
#[cfg(windows)]
pub(crate) fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB},
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| "Слишком много данных")?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // Только текущая учётная запись Windows; без CRYPTPROTECT_LOCAL_MACHINE.
    unsafe {
        let result = if encrypt {
            CryptProtectData(&input, PCWSTR::null(), None, None, None, 1, &mut output)
        } else {
            CryptUnprotectData(&input, None, None, None, None, 1, &mut output)
        };
        result.map_err(|e| format!("Ошибка пользовательского хранилища Windows: {e}"))?;
        let data = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(data)
    }
}
#[cfg(not(windows))]
pub(crate) fn crypt(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("Защищённое хранилище доступно только в Windows; открытая копия не создаётся".into())
}
fn load(app: &AppHandle) -> Result<State, String> {
    let data = match fs::read(path(app)?) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(State {
                schema_version: 1,
                ..State::default()
            })
        }
        Err(e) => return Err(e.to_string()),
    };
    if data.len() > MAX_STATE + 64 * 1024 {
        return Err("Файл состояния слишком большой".into());
    }
    let state: State = serde_json::from_slice(&crypt(&data, false)?)
        .map_err(|_| "Хранилище состояния повреждено")?;
    if state.schema_version != 1 {
        return Err("Неизвестная версия хранилища; автоматический сброс запрещён".into());
    }
    Ok(state)
}
fn save(app: &AppHandle, state: &State) -> Result<(), String> {
    let data = serde_json::to_vec(state).map_err(|e| e.to_string())?;
    if data.len() > MAX_STATE || state.values.len() > 10_000 {
        return Err("Превышен размер состояния".into());
    }
    let encrypted = crypt(&data, true)?;
    if crypt(&encrypted, false)? != data {
        return Err("Проверка шифрования состояния не пройдена".into());
    }
    crate::durable::write(&path(app)?, &encrypted)?;
    if crypt(&fs::read(path(app)?).map_err(|e| e.to_string())?, false)? != data {
        return Err("Проверка миграции после записи не пройдена".into());
    }
    Ok(())
}
fn view(state: State) -> StateView {
    let secret_configured = SECRET_KEYS
        .iter()
        .map(|key| {
            (
                key.to_string(),
                state.values.get(*key).is_some_and(|v| !v.trim().is_empty()),
            )
        })
        .collect();
    let values = state
        .values
        .into_iter()
        .filter(|(key, _)| !SECRET_KEYS.contains(&key.as_str()))
        .collect();
    StateView {
        values,
        secret_configured,
        migration_verified: state.migrated,
    }
}
#[tauri::command]
pub async fn state_bootstrap(
    app: AppHandle,
    legacy: BTreeMap<String, String>,
) -> Result<StateView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = STATE_LOCK.lock().map_err(|_| "Хранилище занято")?;
        let mut state = load(&app)?;
        if !state.migrated {
            for (key, value) in legacy {
                state.values.entry(key).or_insert(value);
            }
            state.migrated = true;
            save(&app, &state)?;
        }
        Ok(view(state))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn state_apply(
    app: AppHandle,
    changes: BTreeMap<String, Option<String>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = STATE_LOCK.lock().map_err(|_| "Хранилище занято")?;
        let mut state = load(&app)?;
        for (key, value) in changes {
            if SECRET_KEYS.contains(&key.as_str()) {
                return Err("API-ключи изменяются отдельной командой".into());
            }
            match value {
                Some(value) => {
                    state.values.insert(key, value);
                }
                None => {
                    state.values.remove(&key);
                }
            }
        }
        save(&app, &state)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn state_set_secret(
    app: AppHandle,
    service: String,
    value: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = match service.as_str() {
            "hubcap" => "hubcapKey",
            "ryuu" => "ryuuKey",
            _ => return Err("Неизвестный сервис".into()),
        };
        if value.len() > 16_384 {
            return Err("Слишком длинный API-ключ".into());
        }
        let _lock = STATE_LOCK.lock().map_err(|_| "Хранилище занято")?;
        let mut state = load(&app)?;
        let configured = !value.trim().is_empty();
        if configured {
            state.values.insert(key.into(), value.trim().into());
        } else {
            state.values.remove(key);
        }
        save(&app, &state)?;
        Ok(configured)
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn secret(app: &AppHandle, service: &str) -> Result<String, String> {
    let key = match service {
        "hubcap" => "hubcapKey",
        "ryuu" => "ryuuKey",
        _ => return Err("Неизвестный сервис".into()),
    };
    let _lock = STATE_LOCK.lock().map_err(|_| "Хранилище занято")?;
    load(app)?
        .values
        .get(key)
        .filter(|v| !v.is_empty())
        .cloned()
        .ok_or_else(|| "Укажите API-ключ в настройках".into())
}
pub fn get(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    if SECRET_KEYS.contains(&key) {
        return Err("Секрет недоступен через обычное чтение".into());
    }
    let _lock = STATE_LOCK.lock().map_err(|_| "Хранилище занято")?;
    Ok(load(app)?.values.get(key).cloned())
}
pub fn set(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    if SECRET_KEYS.contains(&key) {
        return Err("Секрет недоступен через обычную запись".into());
    }
    let _lock = STATE_LOCK.lock().map_err(|_| "Хранилище занято")?;
    let mut state = load(app)?;
    state.values.insert(key.into(), value.into());
    save(app, &state)
}
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn dpapi_roundtrip_and_corruption() {
        let data = b"settings-and-secret";
        let mut encrypted = crypt(data, true).unwrap();
        assert!(!encrypted.windows(data.len()).any(|part| part == data));
        assert_eq!(crypt(&encrypted, false).unwrap(), data);
        let index = encrypted.len() / 2;
        encrypted[index] ^= 1;
        assert!(crypt(&encrypted, false).is_err());
    }
    #[test]
    fn view_never_returns_api_keys() {
        let mut state = State::default();
        state.values.insert("hubcapKey".into(), "secret".into());
        state.values.insert("cgs-theme".into(), "oled".into());
        let view = view(state);
        assert!(!view.values.contains_key("hubcapKey"));
        assert!(view.secret_configured["hubcapKey"]);
    }
}
