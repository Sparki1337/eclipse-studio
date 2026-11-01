// Модуль обнаружения, проверки и загрузки актуальных версий библиотек OpenSteamTool с GitHub.
// Выполняет проверку удалённых коммитов, валидацию PE-заголовков DLL и гибридный фоллбэк на встроенные ресурсы.
use crate::{lua_loader, models::OperationResult};
use reqwest::blocking::Client;
#[cfg(test)]
use serde::Deserialize;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::{
    collections::BTreeMap,
    io::Read,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

// Репозиторий источника библиотек OpenSteamTool
// Работа с репозиторием ведется через Git Smart HTTP и raw.githubusercontent.com без использования GitHub API
const RAW: &str = "https://raw.githubusercontent.com/LeoBanned/pirate-station-hv";

// Максимальный допустимый размер DLL-библиотеки (16 МБ)
pub(crate) const MAX_DLL: usize = 16 * 1024 * 1024;

// Структуры GitHub REST API удалены: теперь используется прямое взаимодействие через Git и raw

#[cfg(test)]
#[derive(Clone, Debug, Deserialize)]
struct Tree {
    tree: Vec<Entry>,
    truncated: bool,
}

#[cfg(test)]
#[derive(Clone, Debug, Deserialize)]
struct Entry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    mode: String,
    sha: String,
    size: Option<usize>,
}

#[derive(Clone, Debug)]
struct Snapshot {
    commit: String,
    variants: BTreeMap<String, Vec<RemoteFile>>,
}

#[derive(Clone, Debug)]
struct RemoteFile {
    path: String,
    target: String,
    sha: String,
    size: usize,
}

// Пакет бинарных файлов комплекта для установки
pub(crate) struct Bundle {
    pub variant: String,
    pub files: BTreeMap<String, Vec<u8>>,
}

// Информация о файле комплекта для фронтенда
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub bytes: usize,
    pub current_bytes: Option<usize>,
    pub status: String,
}

// Информация о статусе комплекта
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariantInfo {
    variant: String,
    available: bool,
    update_available: bool,
    status: String,
    files: Vec<FileInfo>,
}

// Общая сводка обновлений загрузчика
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    commit: String,
    selected_variant: String,
    update_available: bool,
    variants: Vec<VariantInfo>,
}

// Создание HTTP-клиента с таймаутами
fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent("Eclipse-Studio-LuaLoader")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

// Безопасное скачивание с ограничением размера и проверкой HTTP-статусов
fn download(client: &Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let response = client.get(url).send().map_err(|_| {
        "Не удалось подключиться к GitHub. Установленные DLL не изменены.".to_string()
    })?;
    if matches!(response.status().as_u16(), 403 | 429) {
        return Err("GitHub временно ограничил частоту запросов. Повторите попытку позже.".into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "GitHub вернул HTTP {}. DLL не изменены.",
            response.status().as_u16()
        ));
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("Ответ GitHub превышает допустимый размер.".into());
    }
    let mut bytes = Vec::new();
    response
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("Ответ GitHub превышает допустимый размер.".into());
    }
    Ok(bytes)
}

// Проверка валидности 40-значного SHA-1 хеша Git
#[cfg(test)]
fn valid_id(id: &str) -> bool {
    id.len() == 40 && id.bytes().all(|c| c.is_ascii_hexdigit())
}

// Вычисление Git blob SHA-1 хеша для сравнения с деревом репозитория
pub(crate) fn blob_hash(bytes: &[u8]) -> String {
    let mut digest = Sha1::new();
    digest.update(format!("blob {}\0", bytes.len()).as_bytes());
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

#[cfg(test)]
// Построение слепка доступных на GitHub файлов из дерева Git
fn snapshot_from_tree(commit: &str, tree: Tree) -> Result<Snapshot, String> {
    if !valid_id(commit) || tree.truncated {
        return Err("GitHub вернул неполный или некорректный список файлов.".into());
    }
    let mut variants = BTreeMap::new();
    for variant in ["standard", "compatibility"] {
        let folder = if variant == "standard"
            && !tree.tree.iter().any(|e| e.path.starts_with("standard/"))
        {
            "standart"
        } else {
            variant
        };
        let mut files = Vec::new();
        for entry in tree.tree.iter().filter(|e| {
            e.path.starts_with(&format!("{folder}/"))
                && e.path.to_ascii_lowercase().ends_with(".dll")
        }) {
            let name = entry.path.strip_prefix(&format!("{folder}/")).unwrap();
            let canonical = [
                "OpenSteamTool.dll",
                "xinput1_4.dll",
                "dwmapi.dll",
                "version.dll",
            ]
            .into_iter()
            .find(|n| n.eq_ignore_ascii_case(name))
            .ok_or("В комплекте GitHub найдена неподдерживаемая DLL или подпапка")?;
            let target = if variant == "compatibility" && canonical == "dwmapi.dll" {
                "bin/dwmapi.dll".to_string()
            } else {
                canonical.into()
            };
            if entry.kind != "blob"
                || !matches!(entry.mode.as_str(), "100644" | "100755")
                || !valid_id(&entry.sha)
                || !entry.size.is_some_and(|n| (1024..=MAX_DLL).contains(&n))
                || files.iter().any(|f: &RemoteFile| f.target == target)
            {
                return Err(format!("Некорректный файл GitHub: {}", entry.path));
            }
            files.push(RemoteFile {
                path: entry.path.clone(),
                target,
                sha: entry.sha.clone(),
                size: entry.size.unwrap(),
            });
        }
        let paths = files
            .iter()
            .map(|f| (f.target.clone(), String::new()))
            .collect::<BTreeMap<_, _>>();
        lua_loader::validate_layout(variant, 2, &paths).map_err(|_| {
            format!("Комплект {folder} на GitHub неполон. Требуются OpenSteamTool.dll, xinput1_4.dll и прокси-DLL.")
        })?;
        files.sort_by(|a, b| a.target.cmp(&b.target));
        variants.insert(variant.into(), files);
    }
    Ok(Snapshot {
        commit: commit.into(),
        variants,
    })
}

// Получение SHA коммита ветки main через Git Smart HTTP без использования GitHub API
fn parse_head_revision(advertisement: &str) -> Option<&str> {
    let head = advertisement.find(" HEAD")?;
    if head < 40 {
        return None;
    }
    let revision = &advertisement[head - 40..head];
    (revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(revision)
}

fn fetch_commit_sha(client: &Client) -> Result<String, String> {
    let url =
        "https://github.com/LeoBanned/pirate-station-hv.git/info/refs?service=git-upload-pack";
    let resp = client
        .get(url)
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .map_err(|e| format!("Не удалось связаться с репозиторием Git: {e}"))?;
    let text = resp
        .text()
        .map_err(|e| format!("Ошибка чтения данных Git: {e}"))?;
    parse_head_revision(&text)
        .map(|s| s.to_string())
        .ok_or_else(|| "Не удалось определить ревизию репозитория GitHub".into())
}

// Запрос актуального слепка файлов репозитория через Git refs и raw.githubusercontent.com
// Полностью исключает использование GitHub REST API и ограничения частоты запросов (rate limit)
fn fetch_snapshot() -> Result<Snapshot, String> {
    let client = client()?;
    let commit = fetch_commit_sha(&client)?;

    let candidate_defs: [(&str, &[(&str, &str)]); 2] = [
        (
            "standard",
            &[
                ("standard/OpenSteamTool.dll", "OpenSteamTool.dll"),
                ("standard/xinput1_4.dll", "xinput1_4.dll"),
                ("standard/dwmapi.dll", "dwmapi.dll"),
                ("standard/version.dll", "version.dll"),
            ],
        ),
        (
            "compatibility",
            &[
                ("compatibility/OpenSteamTool.dll", "OpenSteamTool.dll"),
                ("compatibility/xinput1_4.dll", "xinput1_4.dll"),
                ("compatibility/dwmapi.dll", "bin/dwmapi.dll"),
                ("compatibility/version.dll", "version.dll"),
            ],
        ),
    ];

    let mut variants = BTreeMap::new();

    for (variant, candidates) in candidate_defs {
        let mut files = Vec::new();
        for &(rel_path, target) in candidates {
            let url = format!("{RAW}/{commit}/{rel_path}");
            if let Ok(bytes) = download(&client, &url, MAX_DLL) {
                if bytes.len() >= 1024 && bytes.starts_with(b"MZ") {
                    let sha = blob_hash(&bytes);
                    let size = bytes.len();
                    files.push(RemoteFile {
                        path: rel_path.to_string(),
                        target: target.to_string(),
                        sha,
                        size,
                    });
                }
            }
        }

        let paths = files
            .iter()
            .map(|f| (f.target.clone(), String::new()))
            .collect::<BTreeMap<_, _>>();

        lua_loader::validate_layout(variant, 2, &paths).map_err(|_| {
            format!("Комплект {variant} на GitHub неполон. Требуются OpenSteamTool.dll, xinput1_4.dll и прокси-DLL.")
        })?;

        files.sort_by(|a, b| a.target.cmp(&b.target));
        variants.insert(variant.to_string(), files);
    }

    Ok(Snapshot { commit, variants })
}

type Cached = Option<(Instant, Result<Snapshot, String>)>;

// Получение слепка с локальным кэшированием результатов в памяти
fn snapshot(force: bool) -> Result<Snapshot, String> {
    static CACHE: OnceLock<Mutex<Cached>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Не удалось заблокировать кэш проверки GitHub")?;
    if let Some((when, result)) = cache.as_ref() {
        let ttl = if result.is_ok() { 300 } else { 30 };
        if when.elapsed() < Duration::from_secs(if force { 3 } else { ttl }) {
            return result.clone();
        }
    }
    let result = fetch_snapshot();
    *cache = Some((Instant::now(), result.clone()));
    result
}

// Проверка совпадения локального файла в Steam с удалённым
fn file_current(steam: &Path, file: &RemoteFile) -> Result<bool, String> {
    Ok(lua_loader::read_optional(&steam.join(&file.target))?
        .is_some_and(|b| b.len() == file.size && blob_hash(&b) == file.sha))
}

// Скачивание и сборка комплекта DLL с GitHub
pub(crate) fn fetch_bundle(variant: &str, steam: &Path) -> Result<Bundle, String> {
    let canonical_variant = match variant {
        "v2" | "desktop" => "compatibility",
        "v1" => "standard",
        other => other,
    };
    if !matches!(canonical_variant, "standard" | "compatibility") {
        return Err("Неизвестный комплект DLL".into());
    }
    let snapshot = snapshot(true)?;
    let remote = snapshot
        .variants
        .get(canonical_variant)
        .ok_or("Комплект не найден на GitHub")?;
    let client = client()?;
    let mut files = BTreeMap::new();
    for file in remote {
        let bytes = if file_current(steam, file)? {
            lua_loader::read_optional(&steam.join(&file.target))?
                .ok_or("Файл изменился во время проверки")?
        } else {
            download(
                &client,
                &format!("{RAW}/{}/{}", snapshot.commit, file.path),
                MAX_DLL,
            )?
        };
        if bytes.len() != file.size || blob_hash(&bytes) != file.sha {
            return Err(format!(
                "Проверка целостности {} не пройдена. DLL не изменены.",
                file.target
            ));
        }
        validate_dll(&bytes)?;
        files.insert(file.target.clone(), bytes);
    }
    Ok(Bundle {
        variant: canonical_variant.into(),
        files,
    })
}

// Валидация заголовка Windows Portable Executable (PE DLL)
pub(crate) fn validate_dll(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 1024 || bytes.len() > MAX_DLL || !bytes.starts_with(b"MZ") {
        return Err("Вместо DLL получен некорректный файл. Установка отменена.".into());
    }
    let offset = u32::from_le_bytes(bytes[60..64].try_into().unwrap()) as usize;
    if offset.checked_add(24).is_none_or(|end| end > bytes.len())
        || &bytes[offset..offset + 4] != b"PE\0\0"
        || u16::from_le_bytes(bytes[offset + 22..offset + 24].try_into().unwrap()) & 0x2000 == 0
    {
        return Err("Файл не является корректной PE DLL. Установка отменена.".into());
    }
    Ok(())
}

// Сравнение локальных файлов Steam со слепком GitHub
fn check_snapshot(steam: &Path, snapshot: &Snapshot) -> Result<UpdateInfo, String> {
    let selected = lua_loader::selected_variant(steam).unwrap_or_else(|_| "standard".into());
    let mut variants = Vec::new();
    for (variant, files) in &snapshot.variants {
        let mut info = Vec::new();
        let mut current = true;
        for file in files {
            // version.dll намеренно исключается из проверки обновлений,
            // поскольку Steam может переименовывать или удалять её при запуске.
            let (state, local_size) = if file.target == "version.dll" {
                ("ignored", None)
            } else if *variant != selected {
                // Если комплект не активен, пытаемся определить размер локального файла, если он существует
                let size = lua_loader::read_optional(&steam.join(&file.target))
                    .ok()
                    .flatten()
                    .map(|b| b.len());
                ("available", size)
            } else {
                match lua_loader::read_optional(&steam.join(&file.target))? {
                    Some(bytes) if bytes.len() == file.size && blob_hash(&bytes) == file.sha => {
                        ("current", Some(bytes.len()))
                    }
                    Some(bytes) => {
                        current = false;
                        ("changed", Some(bytes.len()))
                    }
                    None => {
                        current = false;
                        ("missing", None)
                    }
                }
            };
            info.push(FileInfo {
                path: file.target.clone(),
                bytes: file.size,
                current_bytes: local_size,
                status: state.into(),
            });
        }
        let state = if *variant != selected {
            "not_installed"
        } else if current {
            "current"
        } else {
            "update"
        };
        variants.push(VariantInfo {
            variant: variant.clone(),
            available: true,
            update_available: state == "update",
            status: state.into(),
            files: info,
        });
    }
    let update_available = variants
        .iter()
        .any(|v| v.variant == selected && v.update_available);
    Ok(UpdateInfo {
        commit: snapshot.commit.clone(),
        selected_variant: selected,
        update_available,
        variants,
    })
}

// Внутренняя проверка обновлений с обработкой пути Steam
fn check(steam_path: Option<String>, force: bool) -> Result<UpdateInfo, String> {
    let steam = lua_loader::resolve(steam_path)?;
    check_snapshot(&steam, &snapshot(force)?)
}

// Tauri-команда асинхронной проверки доступности обновлений DLL
#[tauri::command]
pub async fn luatools_check_loader_updates(
    steam_path: Option<String>,
    force: Option<bool>,
) -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || check(steam_path, force.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())?
}

// Загрузка или офлайн-установка комплекта DLL с гибридным фоллбэком
pub(crate) fn update(steam: &Path, variant: &str) -> OperationResult {
    let canonical = match variant {
        "v2" | "desktop" => "compatibility",
        "v1" => "standard",
        other => other,
    };
    // Попытка получить свежий комплект из GitHub
    match fetch_bundle(canonical, steam) {
        Ok(bundle) => lua_loader::install_downloaded(steam, bundle),
        Err(error) => {
            // Гибридный офлайн-фоллбэк: если GitHub недоступен, устанавливаем встроенную версию
            let fallback_result = lua_loader::update_embedded(steam, Some(canonical));
            if fallback_result.success {
                OperationResult::ok(
                    format!(
                        "GitHub недоступен ({error}). Комплект успешно установлен из встроенных ресурсов Eclipse Studio.",
                    ),
                    vec![
                        "Использован резервный встроенный комплект".into(),
                        "Предыдущие файлы сохранены в config/cgs-luatools-backups".into(),
                    ],
                )
            } else {
                OperationResult::error(
                    format!("Не удалось обновить DLL ни с GitHub ({error}), ни из встроенных ресурсов: {}", fallback_result.message),
                    vec![],
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str) -> Entry {
        Entry {
            path: path.into(),
            kind: "blob".into(),
            mode: "100644".into(),
            sha: "a".repeat(40),
            size: Some(2000),
        }
    }

    fn tree() -> Tree {
        Tree {
            truncated: false,
            tree: vec![
                entry("standard/OpenSteamTool.dll"),
                entry("standard/xinput1_4.dll"),
                entry("standard/version.dll"),
                entry("compatibility/OpenSteamTool.dll"),
                entry("compatibility/xinput1_4.dll"),
                entry("compatibility/dwmapi.dll"),
            ],
        }
    }

    #[test]
    fn derives_only_allowlisted_destinations() {
        let s = snapshot_from_tree(&"a".repeat(40), tree()).unwrap();
        assert!(s.variants["standard"]
            .iter()
            .any(|f| f.target == "version.dll"));
        assert!(s.variants["compatibility"]
            .iter()
            .any(|f| f.target == "bin/dwmapi.dll"));
    }

    #[test]
    fn rejects_incomplete_links_and_unexpected_dlls() {
        let mut t = tree();
        t.tree.pop();
        assert!(snapshot_from_tree(&"a".repeat(40), t).is_err());
        let mut t = tree();
        t.tree[0].mode = "120000".into();
        assert!(snapshot_from_tree(&"a".repeat(40), t).is_err());
        let mut t = tree();
        t.tree.push(entry("standard/sub/other.dll"));
        assert!(snapshot_from_tree(&"a".repeat(40), t).is_err());
    }

    #[test]
    fn rejects_html_and_corrupt_pe() {
        assert!(validate_dll(b"<html>failure</html>").is_err());
        assert!(validate_dll(&vec![77; 2000]).is_err());
    }

    #[test]
    fn git_blob_hash_matches_known_empty_blob() {
        assert_eq!(blob_hash(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    }

    #[test]
    fn detects_unchanged_bytes_without_a_version_file() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"same contents";
        std::fs::write(dir.path().join("version.dll"), bytes).unwrap();
        let file = RemoteFile {
            path: "standard/version.dll".into(),
            target: "version.dll".into(),
            sha: blob_hash(bytes),
            size: bytes.len(),
        };
        assert!(file_current(dir.path(), &file).unwrap());
    }
}
