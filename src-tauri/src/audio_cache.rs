//! Модуль управления кэшем пользовательских звуковых файлов Eclipse Studio (.mp3, .ogg, .wav и др.)
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Получение пути к папке кэша пользовательских звуков программы
pub fn custom_sounds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Не удалось получить путь к директории данных приложения: {e}"))?;
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let dir = crate::safe_path::join(&base, "custom_sounds")?;

    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Не удалось создать директорию кэша звуков: {e}"))?;
    }
    Ok(dir)
}

fn validate_sound_name(name: &str) -> Result<(), String> {
    crate::safe_path::validate_component(name)?;
    let extension = PathBuf::from(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "mp3" | "ogg" | "wav" | "m4a" | "aac" | "flac" | "webm"
    ) {
        return Err("Неподдерживаемый формат звука".into());
    }
    Ok(())
}

fn sound_name_from_id(id: &str) -> Result<&str, String> {
    let name = id
        .strip_prefix("custom_")
        .ok_or("Некорректный идентификатор звука")?;
    validate_sound_name(name)?;
    Ok(name)
}

/// Метаданные сохраненного звукового файла
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomSoundMeta {
    pub id: String,
    pub name: String,
    pub size_bytes: u64,
}

/// Сохранение пользовательского аудиофайла в кэш программы
#[tauri::command]
pub async fn audio_save_custom_sound(
    app: AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<CustomSoundMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = custom_sounds_dir(&app)?;

        // Очищаем имя файла от опасных символов путей
        let clean_name: String = name
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ' ' {
                    c
                } else {
                    '_'
                }
            })
            .collect();

        let clean_name = clean_name.trim();
        let safe_name = if clean_name.is_empty() {
            "custom_sound.mp3".to_string()
        } else {
            clean_name.to_string()
        };

        if bytes.len() > 64 * 1024 * 1024 {
            return Err("Звук превышает допустимый размер 64 МБ".into());
        }
        validate_sound_name(&safe_name)?;
        let file_path = crate::safe_path::join(&dir, &safe_name)?;
        crate::durable::write(&file_path, &bytes)
            .map_err(|e| format!("Не удалось записать аудиофайл в кэш: {e}"))?;

        let size = bytes.len() as u64;
        let id = format!("custom_{safe_name}");

        Ok(CustomSoundMeta {
            id,
            name: safe_name,
            size_bytes: size,
        })
    })
    .await
    .map_err(|e| format!("Ошибка фонового потока: {e}"))?
}

/// Получение списка всех сохраненных звуков из кэша программы
#[tauri::command]
pub async fn audio_list_custom_sounds(app: AppHandle) -> Result<Vec<CustomSoundMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = custom_sounds_dir(&app)?;
        let mut list = Vec::new();

        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file()
                    && fs::symlink_metadata(&path)
                        .map(|m| !crate::safe_path::is_link(&m))
                        .unwrap_or(false)
                {
                    let ext = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();

                    if matches!(
                        ext.as_str(),
                        "mp3" | "ogg" | "wav" | "m4a" | "aac" | "flac" | "webm"
                    ) {
                        if let Some(file_name) = path.file_name().and_then(|f| f.to_str()) {
                            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                            list.push(CustomSoundMeta {
                                id: format!("custom_{file_name}"),
                                name: file_name.to_string(),
                                size_bytes: size,
                            });
                        }
                    }
                }
            }
        }

        // Сортировка по имени для аккуратного отображения
        list.sort_by_key(|a| a.name.to_lowercase());
        Ok(list)
    })
    .await
    .map_err(|e| format!("Ошибка фонового потока: {e}"))?
}

/// Удаление пользовательского звука из кэша программы
#[tauri::command]
pub async fn audio_delete_custom_sound(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = custom_sounds_dir(&app)?;
        let raw_name = sound_name_from_id(&id)?;
        let path = crate::safe_path::join(&dir, raw_name)?;

        if path.exists() && path.is_file() {
            fs::remove_file(&path)
                .map_err(|e| format!("Не удалось удалить файл звука из кэша: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Ошибка фонового потока: {e}"))?
}

/// Чтение файла звука в виде байтов для воспроизведения во фронтенде
#[tauri::command]
pub async fn audio_read_custom_sound(app: AppHandle, id: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = custom_sounds_dir(&app)?;
        let raw_name = sound_name_from_id(&id)?;
        let path = crate::safe_path::join(&dir, raw_name)?;

        if !path.exists() || !path.is_file() {
            return Err("Файл звука не найден в кэше программы".into());
        }

        fs::read(&path).map_err(|e| format!("Не удалось прочитать аудиофайл из кэша: {e}"))
    })
    .await
    .map_err(|e| format!("Ошибка фонового потока: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_sound_filename_preserves_audio_extensions() {
        let raw = "My Super Sound #1!.mp3";
        let clean: String = raw
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ' ' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        assert_eq!(clean, "My Super Sound _1_.mp3");
    }

    #[test]
    fn sound_ids_never_accept_paths_or_streams() {
        for id in [
            "custom_../secret.wav",
            "custom_..\\secret.wav",
            "custom_C:\\secret.wav",
            "custom_a.wav:stream",
            "custom_CON.wav",
            "sound.wav",
            "custom_..",
        ] {
            assert!(sound_name_from_id(id).is_err(), "{id}");
        }
        assert_eq!(sound_name_from_id("custom_click.wav").unwrap(), "click.wav");
    }

    #[test]
    fn custom_sound_meta_serialization() {
        let meta = CustomSoundMeta {
            id: "custom_click.ogg".into(),
            name: "click.ogg".into(),
            size_bytes: 4096,
        };
        let json = serde_json::to_string(&meta).expect("Serialization failed");
        assert!(json.contains("\"sizeBytes\":4096"));
        assert!(json.contains("\"id\":\"custom_click.ogg\""));
    }
}
