//! Модуль управления кэшем пользовательских звуковых файлов Eclipse Studio (.mp3, .ogg, .wav и др.)
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Получение пути к папке кэша пользовательских звуков программы
pub fn custom_sounds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Не удалось получить путь к директории данных приложения: {e}"))?
        .join("custom_sounds");

    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Не удалось создать директорию кэша звуков: {e}"))?;
    }
    Ok(dir)
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

        let file_path = dir.join(&safe_name);
        fs::write(&file_path, &bytes)
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
                if path.is_file() {
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
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
        let raw_name = id.strip_prefix("custom_").unwrap_or(&id);
        let path = dir.join(raw_name);

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
        let raw_name = id.strip_prefix("custom_").unwrap_or(&id);
        let path = dir.join(raw_name);

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
