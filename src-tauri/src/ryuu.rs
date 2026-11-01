use crate::luatools::{self, LuaInstallResult};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager};

const HOST: &str = "generator.ryuu.lol";
const ORIGIN: &str = "https://generator.ryuu.lol";
// Базовый адрес реверс-прокси
const PROXY_BASE: &str = "";

const CATALOG_URL: &str = "https://generator.ryuu.lol/api/games";
const DOWNLOAD_BASE: &str = "https://generator.ryuu.lol/api/download/";
const CATALOG_TTL: Duration = Duration::from_secs(24 * 3600);
// User-Agent браузера Chrome
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

#[derive(Deserialize)]
struct RawGame {
    appid: String,
    name: String,
    #[serde(default)]
    header_image: Option<String>,
    #[serde(rename = "type", default)]
    kind: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RyuuGame {
    pub appid: String,
    pub name: String,
    pub header_image: Option<String>,
    pub kind: Option<String>,
}

// Статистика использования и суточный лимит загрузок Ryuu
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RyuuUsage {
    #[serde(alias = "daily_usage")]
    pub daily_usage: u64,
    #[serde(alias = "daily_limit")]
    pub daily_limit: u64,
    #[serde(default)]
    pub remaining: u64,
}

// Локальная структура суточного счетчика в ryuu-usage.json
#[derive(Debug, Clone, Deserialize, Serialize)]
struct StoredUsage {
    day: u64,
    daily_usage: u64,
    daily_limit: u64,
}

// Текущий день в секундах / 86400 (Unix-эпоха)
fn current_epoch_day() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86400
}

// Путь к файлу локального суточного счетчика
fn usage_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("ryuu-usage.json"))
}

// Чтение суточного счетчика с автосбросом в новый день
fn read_stored_usage(app: &AppHandle) -> StoredUsage {
    let today = current_epoch_day();
    let default = StoredUsage {
        day: today,
        daily_usage: 0,
        daily_limit: 50,
    };
    let Some(path) = usage_path(app) else {
        return default;
    };
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(stored) = serde_json::from_slice::<StoredUsage>(&bytes) {
            if stored.day == today {
                return stored;
            }
        }
    }
    default
}

// Сохранение суточного счетчика
fn write_stored_usage(app: &AppHandle, usage: &StoredUsage) {
    if let Some(path) = usage_path(app) {
        if let Ok(json) = serde_json::to_vec_pretty(usage) {
            let _ = fs::write(path, json);
        }
    }
}

// Фиксация успешного скачивания через Ryuu
pub fn record_ryuu_download(app: &AppHandle) {
    let mut stored = read_stored_usage(app);
    stored.day = current_epoch_day();
    stored.daily_usage = stored.daily_usage.saturating_add(1);
    write_stored_usage(app, &stored);
}

fn catalog_cache() -> &'static Mutex<Option<Vec<RyuuGame>>> {
    static CACHE: OnceLock<Mutex<Option<Vec<RyuuGame>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

// Блокировка параллельной загрузки каталога
fn download_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn catalog_loaded() -> bool {
    catalog_cache()
        .lock()
        .map(|cache| cache.is_some())
        .unwrap_or(false)
}

fn base_headers() -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderValue};
    let mut headers = HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    headers.insert(
        reqwest::header::ACCEPT_LANGUAGE,
        HeaderValue::from_static("en-US,en;q=0.9"),
    );
    headers.insert(
        reqwest::header::REFERER,
        HeaderValue::from_static("https://generator.ryuu.lol/"),
    );
    headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
    headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
    headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
    headers
}

// Создание HTTP-клиента с поддержкой DoH
fn build_client(resolve_to: Option<IpAddr>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent(USER_AGENT)
        .default_headers(base_headers())
        .timeout(Duration::from_secs(90));
    if let Some(ip) = resolve_to {
        builder = builder.resolve(HOST, SocketAddr::new(ip, 443));
    }
    builder
        .build()
        .map_err(|error| format!("Не удалось подготовить сетевой клиент: {error}"))
}

fn client() -> Result<Client, String> {
    build_client(None)
}

fn doh_cache() -> &'static Mutex<Option<IpAddr>> {
    static CACHE: OnceLock<Mutex<Option<IpAddr>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

// DoH-запрос адреса домена
fn query_doh(url: &str) -> Option<IpAddr> {
    let response = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?
        .get(url)
        .header(reqwest::header::ACCEPT, "application/dns-json")
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: Value = serde_json::from_str(&response.text().ok()?).ok()?;
    json.get("Answer")?
        .as_array()?
        .iter()
        .filter(|answer| answer.get("type").and_then(Value::as_u64) == Some(1))
        .find_map(|answer| answer.get("data").and_then(Value::as_str))
        .and_then(|address| address.parse::<IpAddr>().ok())
}

// Резолв домена через DoH-серверы
fn doh_resolve() -> Option<IpAddr> {
    if let Some(ip) = doh_cache().lock().ok().and_then(|cache| *cache) {
        return Some(ip);
    }
    let providers = [
        "https://1.1.1.1/dns-query?name=generator.ryuu.lol&type=A",
        "https://1.0.0.1/dns-query?name=generator.ryuu.lol&type=A",
        "https://8.8.8.8/resolve?name=generator.ryuu.lol&type=A",
    ];
    for url in providers {
        if let Some(ip) = query_doh(url) {
            if let Ok(mut cache) = doh_cache().lock() {
                *cache = Some(ip);
            }
            return Some(ip);
        }
    }
    None
}

enum GetError {
    // Ошибка сети
    Network(String),
    // Ошибка HTTP
    Http(String),
}

fn map_status(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "Доступ к генератору запрещён (проверьте ключ)".to_string(),
        404 => "Для этой игры нет манифестов в генераторе".to_string(),
        429 => "Слишком много запросов, попробуйте позже".to_string(),
        other => format!("Сервер вернул ошибку {other}"),
    }
}

fn http_get_once(
    client: &Client,
    url: &str,
    auth: Option<&str>,
    identity: bool,
) -> Result<Vec<u8>, GetError> {
    let mut request = client.get(url);
    if let Some(key) = auth {
        request = request.header("X-Auth-Key", key);
    }
    if identity {
        // Запрос без авто-распаковки gzip/deflate
        request = request.header(reqwest::header::ACCEPT_ENCODING, "identity");
    }
    let response = request
        .send()
        .map_err(|error| GetError::Network(format!("Сеть недоступна: {error}")))?;
    if !response.status().is_success() {
        return Err(GetError::Http(map_status(response.status())));
    }
    response
        .bytes()
        .map(|data| data.to_vec())
        .map_err(|error| GetError::Network(format!("Не удалось получить файл: {error}")))
}

// Подстановка адреса прокси
fn proxy_url(url: &str) -> Option<String> {
    if PROXY_BASE.is_empty() {
        return None;
    }
    url.strip_prefix(ORIGIN)
        .map(|path| format!("{PROXY_BASE}{path}"))
}

// HTTP-запрос с цепочкой обхода блокировок
fn http_get(url: &str, auth: Option<&str>, identity: bool) -> Result<Vec<u8>, String> {
    // Прямой запрос
    let network_error = match http_get_once(&client()?, url, auth, identity) {
        Ok(bytes) => return Ok(bytes),
        Err(GetError::Http(message)) => return Err(message),
        Err(GetError::Network(message)) => message,
    };

    // Запрос через DoH
    if let Some(ip) = doh_resolve() {
        match http_get_once(&build_client(Some(ip))?, url, auth, identity) {
            Ok(bytes) => return Ok(bytes),
            Err(GetError::Http(message)) => return Err(message),
            Err(GetError::Network(_)) => {}
        }
    }

    // Запрос через реверс-прокси
    if let Some(proxied) = proxy_url(url) {
        match http_get_once(&client()?, &proxied, auth, identity) {
            Ok(bytes) => return Ok(bytes),
            Err(GetError::Http(message)) => return Err(message),
            Err(GetError::Network(second)) => {
                return Err(format!("{network_error}. Прокси тоже недоступен: {second}"))
            }
        }
    }

    let lower = network_error.to_lowercase();
    let is_antivirus_or_ssl = lower.contains("access denied")
        || lower.contains("access_denied")
        || lower.contains("sec_e_logon_denied")
        || lower.contains("0x8009030c")
        || lower.contains("tlsv1_alert")
        || lower.contains("blocked by eset")
        || lower.contains("certificate");

    if is_antivirus_or_ssl {
        Err(
            "Генератор недоступен: соединение отклонено защитой антивируса (ESET/NOD32/веб-фильтр). \
            Добавьте generator.ryuu.lol в список разрешённых адресов антивируса или переключитесь на сервис HubCap."
                .to_string(),
        )
    } else {
        Err(format!(
            "Генератор недоступен: {network_error}. Добавьте домен в исключения антивируса, используйте VPN/Zapret2 или переключитесь на HubCap."
        ))
    }
}

fn catalog_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("ryuu-games.json"))
}

fn parse_catalog(bytes: &[u8]) -> Vec<RyuuGame> {
    serde_json::from_slice::<Vec<RawGame>>(bytes)
        .map(|list| {
            list.into_iter()
                .map(|game| RyuuGame {
                    appid: game.appid,
                    name: game.name,
                    header_image: game.header_image,
                    kind: game.kind,
                })
                .collect()
        })
        .unwrap_or_default()
}

// Чтение кэшированного каталога с диска
fn fresh_disk_catalog(app: &AppHandle) -> Option<Vec<u8>> {
    let path = catalog_path(app)?;
    let age = fs::metadata(&path).ok()?.modified().ok()?.elapsed().ok()?;
    (age < CATALOG_TTL).then(|| fs::read(&path).ok()).flatten()
}

// Загрузка каталога в память с авторизацией по ключу
fn ensure_catalog(app: &AppHandle, auth: Option<&str>) -> Result<(), String> {
    if catalog_loaded() {
        return Ok(());
    }
    // Ожидание завершения текущей загрузки
    let _guard = download_lock()
        .lock()
        .map_err(|_| "Загрузка каталога занята".to_string())?;
    if catalog_loaded() {
        return Ok(());
    }
    let bytes = match fresh_disk_catalog(app) {
        Some(bytes) => bytes,
        None => {
            let bytes = http_get(CATALOG_URL, auth, false)
                .map_err(|error| format!("Каталог игр недоступен: {error}"))?;
            if let Some(path) = catalog_path(app) {
                let _ = fs::write(path, &bytes);
            }
            bytes
        }
    };
    let games = parse_catalog(&bytes);
    if games.is_empty() {
        return Err("Каталог игр пуст или в неизвестном формате".into());
    }
    if let Ok(mut cache) = catalog_cache().lock() {
        *cache = Some(games);
    }
    Ok(())
}

// Поиск игр в каталоге
#[tauri::command]
pub async fn ryuu_search(app: AppHandle, query: String) -> Result<Vec<RyuuGame>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api_key = crate::secure_state::secret(&app, "ryuu")?;
        ryuu_search_blocking(app, query, api_key)
    })
    .await
    .map_err(|error| format!("Поиск прервался: {error}"))?
}

fn ryuu_search_blocking(
    app: AppHandle,
    query: String,
    api_key: String,
) -> Result<Vec<RyuuGame>, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Укажите API-ключ Ryuu в настройках".into());
    }
    let query = query.trim().to_lowercase();
    if query.len() < 2 {
        return Ok(Vec::new());
    }
    let numeric = query.chars().all(|c| c.is_ascii_digit());
    // Поиск по числовому AppID при недоступности каталога
    if let Err(error) = ensure_catalog(&app, Some(key)) {
        if numeric {
            return Ok(vec![RyuuGame {
                appid: query.clone(),
                name: format!("AppID {query}"),
                header_image: None,
                kind: None,
            }]);
        }
        return Err(error);
    }
    let guard = catalog_cache()
        .lock()
        .map_err(|_| "Каталог занят".to_string())?;
    let games = guard.as_ref().ok_or("Каталог не загружен")?;

    // Сортировка по релевантности совпадения
    let mut scored: Vec<(u8, &RyuuGame)> = Vec::new();
    for game in games {
        let rank = if numeric {
            if game.appid == query {
                Some(0)
            } else if game.appid.starts_with(&query) {
                Some(1)
            } else {
                None
            }
        } else {
            let name = game.name.to_lowercase();
            if name == query {
                Some(0)
            } else if name.starts_with(&query) {
                Some(1)
            } else if name.contains(&query) {
                Some(2)
            } else if game.appid == query {
                Some(1)
            } else {
                None
            }
        };
        if let Some(rank) = rank {
            scored.push((rank, game));
        }
    }
    scored.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.name.len().cmp(&right.1.name.len()))
            .then_with(|| left.1.name.cmp(&right.1.name))
    });
    Ok(scored
        .into_iter()
        .take(24)
        .map(|(_, game)| game.clone())
        .collect())
}

// Загрузка и установка архива игры по AppID
#[tauri::command]
pub async fn ryuu_get(
    app: AppHandle,
    appid: String,
    steam_path: Option<String>,
    auto_update: bool,
) -> LuaInstallResult {
    match tauri::async_runtime::spawn_blocking(move || {
        match crate::secure_state::secret(&app, "ryuu") {
            Ok(api_key) => ryuu_get_blocking(app, appid, api_key, steam_path, auto_update),
            Err(error) => LuaInstallResult {
                success: false,
                message: error,
                logs: vec![],
                added_appids: vec![],
            },
        }
    })
    .await
    {
        Ok(result) => result,
        Err(error) => LuaInstallResult {
            success: false,
            message: format!("Загрузка прервалась: {error}"),
            logs: vec![],
            added_appids: vec![],
        },
    }
}

fn ryuu_get_blocking(
    app: AppHandle,
    appid: String,
    api_key: String,
    steam_path: Option<String>,
    auto_update: bool,
) -> LuaInstallResult {
    let key = api_key.trim();
    if key.is_empty() {
        return LuaInstallResult {
            success: false,
            message: "Укажите API-ключ Ryuu в настройках".into(),
            logs: vec![],
            added_appids: vec![],
        };
    }
    let clean: String = appid.chars().filter(char::is_ascii_digit).collect();
    if clean.is_empty() {
        return LuaInstallResult {
            success: false,
            message: "Некорректный AppID".into(),
            logs: vec![],
            added_appids: vec![],
        };
    }

    // Загрузка zip-архива манифестов с авторизацией по ключу X-Auth-Key
    let bytes = http_get(&format!("{DOWNLOAD_BASE}{clean}"), Some(key), true);

    match bytes {
        Ok(bytes) => {
            let result = luatools::install_zip_bytes(&app, &bytes, steam_path, auto_update);
            if result.success {
                record_ryuu_download(&app);
            }
            result
        }
        Err(message) => LuaInstallResult {
            success: false,
            message,
            logs: vec![],
            added_appids: vec![],
        },
    }
}

// Запрос статистики использования и лимитов Ryuu
#[tauri::command]
pub async fn ryuu_usage(app: AppHandle) -> Result<RyuuUsage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api_key = crate::secure_state::secret(&app, "ryuu")?;
        ryuu_usage_blocking(app, api_key)
    })
    .await
    .map_err(|error| format!("Ошибка получения квоты Ryuu: {error}"))?
}

fn ryuu_usage_blocking(app: AppHandle, api_key: String) -> Result<RyuuUsage, String> {
    let key = api_key.trim();
    let mut stored = read_stored_usage(&app);

    // Если указан API-ключ, пробуем запросить актуальные серверные квоты
    if !key.is_empty() {
        for endpoint in [
            "https://generator.ryuu.lol/api/user/stats",
            "https://generator.ryuu.lol/api/stats",
            "https://generator.ryuu.lol/api/user",
        ] {
            if let Ok(bytes) = http_get(endpoint, Some(key), false) {
                if let Ok(json) = serde_json::from_slice::<Value>(&bytes) {
                    let remaining_opt = json
                        .get("remaining")
                        .or_else(|| json.get("downloads_left"))
                        .or_else(|| json.get("downloadsLeft"))
                        .or_else(|| json.get("downloadsLeftToday"))
                        .and_then(|v| v.as_u64());

                    let limit_opt = json
                        .get("daily_limit")
                        .or_else(|| json.get("dailyLimit"))
                        .or_else(|| json.get("limit"))
                        .and_then(|v| v.as_u64());

                    let usage_opt = json
                        .get("daily_usage")
                        .or_else(|| json.get("dailyUsage"))
                        .or_else(|| json.get("used"))
                        .and_then(|v| v.as_u64());

                    if remaining_opt.is_some() || limit_opt.is_some() || usage_opt.is_some() {
                        let daily_limit = limit_opt.unwrap_or(stored.daily_limit);
                        let daily_usage = usage_opt.unwrap_or_else(|| {
                            if let Some(rem) = remaining_opt {
                                daily_limit.saturating_sub(rem)
                            } else {
                                stored.daily_usage
                            }
                        });
                        let remaining = remaining_opt
                            .unwrap_or_else(|| daily_limit.saturating_sub(daily_usage));

                        stored.daily_limit = daily_limit;
                        stored.daily_usage = daily_usage;
                        write_stored_usage(&app, &stored);

                        return Ok(RyuuUsage {
                            daily_usage,
                            daily_limit,
                            remaining,
                        });
                    }
                }
            }
        }
    }

    // Возврат надежного локального суточного счетчика
    let remaining = stored.daily_limit.saturating_sub(stored.daily_usage);
    Ok(RyuuUsage {
        daily_usage: stored.daily_usage,
        daily_limit: stored.daily_limit,
        remaining,
    })
}
