//! Ядро обновления внутри программы без зависимостей от Tauri.
//! Разбор релиза GitHub с контрольными суммами, проверка нового EXE и помощник замены:
//! копия текущей программы запускается из папки этапа, дожидается закрытия окна,
//! заменяет EXE на месте и проверяет запуск новой версии, иначе возвращает прежнюю.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Режим помощника: `--eclipse-update-helper <папка этапа> <SHA-256 plan.json>`
pub const HELPER_ARG: &str = "--eclipse-update-helper";
/// Проверочный запуск новой версии: `--eclipse-update-probe <папка этапа> <nonce>`
pub const PROBE_ARG: &str = "--eclipse-update-probe";
/// Запуск восстановленной версии после отката: `--eclipse-update-failed <папка этапа> <nonce>`
pub const FAILED_ARG: &str = "--eclipse-update-failed";
/// Префикс папки этапа и временных EXE рядом с программой
pub const STAGE_PREFIX: &str = ".eclipse-update-";
pub const PAYLOAD: &str = "payload.exe";
pub const UPDATER: &str = "updater.exe";
pub const PLAN: &str = "plan.json";
pub const OWNER: &str = "owner";
pub const READY: &str = "ready";
pub const GO: &str = "go";
pub const ABORT: &str = "abort";
pub const HEALTHY: &str = "healthy";
pub const RESULT: &str = "result.json";
pub const LOG: &str = "helper.log";
pub const PLAN_SCHEMA: u32 = 1;
pub const CANCELLED: &str = "Обновление отменено.";

// ---------------------------------------------------------------------------
// Версии
// ---------------------------------------------------------------------------

pub fn version_parts(version: &str) -> Option<Vec<u64>> {
    let trimmed = version.trim().trim_start_matches(['v', 'V']);
    let clean = trimmed
        .split_once('-')
        .map(|(base, _)| base)
        .unwrap_or(trimmed);
    let parts = clean
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (!parts.is_empty()).then_some(parts)
}

fn padded(version: &str, length: usize) -> Option<Vec<u64>> {
    let mut parts = version_parts(version)?;
    if parts.len() > length {
        return None;
    }
    parts.resize(length, 0);
    Some(parts)
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    let (Some(mut latest), Some(mut current)) = (version_parts(latest), version_parts(current))
    else {
        return false;
    };
    let length = latest.len().max(current.len());
    latest.resize(length, 0);
    current.resize(length, 0);
    latest > current
}

pub fn same_version(left: &str, right: &str) -> bool {
    match (padded(left, 4), padded(right, 4)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Файлы релиза и их SHA-256 со страницы expanded_assets
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    /// Контрольная сумма, опубликованная GitHub для файла релиза
    pub sha256: Option<String>,
}

fn unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
}

/// Первая SHA-256 вида `sha256:<64 hex>` в фрагменте HTML
fn find_digest(segment: &str) -> Option<String> {
    for (position, _) in segment.match_indices("sha256:") {
        let start = position + "sha256:".len();
        let Some(candidate) = segment.get(start..start + 64) else {
            continue;
        };
        let bounded = segment[start + 64..]
            .bytes()
            .next()
            .is_none_or(|byte| !byte.is_ascii_hexdigit());
        if bounded && candidate.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Some(candidate.to_ascii_lowercase());
        }
    }
    None
}

/// Ссылки на файлы релиза и контрольные суммы, которые GitHub выводит рядом с каждой ссылкой
pub fn parse_release_assets(html: &str, repo: &str, tag: &str) -> Vec<ReleaseAsset> {
    let prefix = format!("/{repo}/releases/download/{tag}/");
    let needle = format!("href=\"{prefix}");
    let starts: Vec<usize> = html
        .match_indices(&needle)
        .map(|(index, _)| index)
        .collect();
    let mut assets: Vec<ReleaseAsset> = Vec::new();
    for (index, start) in starts.iter().enumerate() {
        let rest = &html[start + needle.len()..];
        let Some(end) = rest.find('"') else {
            continue;
        };
        let raw = unescape(rest[..end].split('?').next().unwrap_or_default().trim());
        if raw.is_empty() || raw.contains('/') || assets.iter().any(|asset| asset.name == raw) {
            continue;
        }
        let segment_end = starts.get(index + 1).copied().unwrap_or(html.len());
        assets.push(ReleaseAsset {
            url: format!("https://github.com{prefix}{raw}"),
            sha256: find_digest(&html[*start..segment_end]),
            name: raw,
        });
    }
    assets
}

/// Портативный EXE релиза: сначала каноническое имя Eclipse-Studio-v<версия>.exe
pub fn update_asset<'a>(assets: &'a [ReleaseAsset], version: &str) -> Option<&'a ReleaseAsset> {
    let portable = |asset: &&ReleaseAsset| {
        let name = asset.name.to_ascii_lowercase();
        name.ends_with(".exe") && !name.contains("setup") && !name.contains("installer")
    };
    let canonical = format!(
        "eclipse-studio-v{}.exe",
        version.trim_start_matches(['v', 'V'])
    );
    assets
        .iter()
        .filter(portable)
        .find(|asset| asset.name.eq_ignore_ascii_case(&canonical))
        .or_else(|| {
            assets
                .iter()
                .filter(portable)
                .find(|asset| asset.name.to_ascii_lowercase().contains("eclipse"))
        })
}

// ---------------------------------------------------------------------------
// Проверка нового EXE: 64-битная оконная программа Windows с нужной версией
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeInfo {
    pub x64: bool,
    pub executable: bool,
    pub gui: bool,
    /// FILEVERSION из VS_FIXEDFILEINFO ресурса версии
    pub file_version: Option<[u16; 4]>,
}

fn u16_at(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
    ))
}

fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

const NOT_PE: &str = "Файл обновления не является программой Windows.";

pub fn inspect_pe(bytes: &[u8]) -> Result<PeInfo, String> {
    let header = || NOT_PE.to_string();
    if bytes.get(..2) != Some(b"MZ".as_slice()) {
        return Err(header());
    }
    let pe = u32_at(bytes, 0x3c).ok_or_else(header)? as usize;
    if bytes.get(pe..pe.saturating_add(4)) != Some(b"PE\0\0".as_slice()) {
        return Err(header());
    }
    let coff = pe + 4;
    let machine = u16_at(bytes, coff).ok_or_else(header)?;
    let sections = u16_at(bytes, coff + 2).ok_or_else(header)? as usize;
    let optional_size = u16_at(bytes, coff + 16).ok_or_else(header)? as usize;
    let characteristics = u16_at(bytes, coff + 18).ok_or_else(header)?;
    let optional = coff + 20;
    let pe32_plus = u16_at(bytes, optional).ok_or_else(header)? == 0x20b;
    let subsystem = u16_at(bytes, optional + 68).ok_or_else(header)?;
    let (count_at, directories) = if pe32_plus { (108, 112) } else { (92, 96) };
    let directory_count = u32_at(bytes, optional + count_at).unwrap_or(0);
    let resources = if directory_count > 2 {
        u32_at(bytes, optional + directories + 16).unwrap_or(0)
    } else {
        0
    };
    let table = optional + optional_size;
    let to_offset = |rva: u32| -> Option<usize> {
        for index in 0..sections.min(96) {
            let section = table + index * 40;
            let virtual_size = u32_at(bytes, section + 8)?;
            let address = u32_at(bytes, section + 12)?;
            let raw_size = u32_at(bytes, section + 16)?;
            let raw = u32_at(bytes, section + 20)?;
            let span = virtual_size.max(raw_size);
            if rva >= address && rva - address < span {
                let offset = raw as usize + (rva - address) as usize;
                return (offset < bytes.len()).then_some(offset);
            }
        }
        None
    };
    let file_version = (resources != 0)
        .then(|| version_resource(bytes, resources, &to_offset))
        .flatten();
    Ok(PeInfo {
        x64: machine == 0x8664 && pe32_plus,
        // IMAGE_FILE_EXECUTABLE_IMAGE без IMAGE_FILE_DLL
        executable: characteristics & 0x0002 != 0 && characteristics & 0x2000 == 0,
        gui: subsystem == 2,
        file_version,
    })
}

/// RT_VERSION → первое имя → первый язык → VS_FIXEDFILEINFO
fn version_resource(
    bytes: &[u8],
    resources: u32,
    to_offset: &dyn Fn(u32) -> Option<usize>,
) -> Option<[u16; 4]> {
    let base = to_offset(resources)?;
    let entry = |directory: usize, id: Option<u32>| -> Option<u32> {
        let named = u16_at(bytes, directory + 12)? as usize;
        let ids = u16_at(bytes, directory + 14)? as usize;
        for index in 0..(named + ids).min(4096) {
            let item = directory + 16 + index * 8;
            let name = u32_at(bytes, item)?;
            let data = u32_at(bytes, item + 4)?;
            match id {
                Some(id) if name & 0x8000_0000 == 0 && name == id => return Some(data),
                Some(_) => {}
                None => return Some(data),
            }
        }
        None
    };
    let subdirectory = |data: u32| -> Option<usize> {
        (data & 0x8000_0000 != 0).then(|| base + (data & 0x7fff_ffff) as usize)
    };
    let names = subdirectory(entry(base, Some(16))?)?;
    let languages = subdirectory(entry(names, None)?)?;
    let leaf = entry(languages, None)?;
    if leaf & 0x8000_0000 != 0 {
        return None;
    }
    let data_entry = base + leaf as usize;
    let start = to_offset(u32_at(bytes, data_entry)?)?;
    let size = u32_at(bytes, data_entry + 4)? as usize;
    let block = bytes.get(start..start.checked_add(size)?.min(bytes.len()))?;
    let at = block
        .windows(4)
        .position(|window| window == [0xBD, 0x04, 0xEF, 0xFE])?;
    let high = u32_at(block, at + 8)?;
    let low = u32_at(block, at + 12)?;
    Some([
        (high >> 16) as u16,
        high as u16,
        (low >> 16) as u16,
        low as u16,
    ])
}

/// Новый EXE должен быть 64-битной оконной программой с версией из релиза
pub fn verify_payload(bytes: &[u8], version: &str) -> Result<(), String> {
    let info = inspect_pe(bytes)?;
    if !info.x64 || !info.executable {
        return Err("Файл обновления не является 64-битной программой Windows.".into());
    }
    if !info.gui {
        return Err("Файл обновления не является оконной программой Windows.".into());
    }
    let found = info
        .file_version
        .ok_or("В файле обновления нет сведений о версии.")?;
    let found_text = found.map(|part| part.to_string()).join(".");
    if !same_version(&found_text, version) {
        return Err(format!(
            "Версия файла обновления {found_text} не совпадает с ожидаемой {version}."
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Этап обновления: план, сигналы и итог
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Plan {
    pub schema: u32,
    pub nonce: String,
    /// Заменяемый EXE: путь и имя сохраняются, поэтому ярлыки продолжают работать
    pub target: String,
    pub parent_pid: u32,
    pub old_hash: String,
    pub new_hash: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Outcome {
    pub nonce: String,
    pub success: bool,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub message: String,
}

pub fn new_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub fn valid_nonce(nonce: &str) -> bool {
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn stage_name(nonce: &str) -> String {
    format!("{STAGE_PREFIX}{nonce}")
}

/// Резервная копия прежнего EXE на время проверки новой версии
pub fn backup_path(target: &Path, nonce: &str) -> PathBuf {
    target.with_file_name(format!("{STAGE_PREFIX}{nonce}.old.exe"))
}

fn staged_path(target: &Path, nonce: &str) -> PathBuf {
    target.with_file_name(format!("{STAGE_PREFIX}{nonce}.new.exe"))
}

fn failed_path(target: &Path, nonce: &str) -> PathBuf {
    target.with_file_name(format!("{STAGE_PREFIX}{nonce}.failed.exe"))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

/// Папка этапа рядом с программой: запись туда подтверждает права на замену EXE
pub fn create_stage(directory: &Path) -> Result<(PathBuf, String), String> {
    let nonce = new_nonce();
    let stage = directory.join(stage_name(&nonce));
    fs::create_dir(&stage).map_err(|error| {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            format!(
                "Нет прав на запись в папку программы {}. Запустите Eclipse Studio от имени администратора или переместите программу в папку пользователя.",
                directory.display()
            )
        } else {
            format!("Не удалось подготовить папку обновления: {error}")
        }
    })?;
    crate::durable::write(&stage.join(OWNER), nonce.as_bytes())?;
    Ok((stage, nonce))
}

/// План записывается один раз; помощник получает его SHA-256 в аргументах запуска
pub fn write_plan(stage: &Path, plan: &Plan) -> Result<String, String> {
    let bytes = serde_json::to_vec_pretty(plan).map_err(|error| error.to_string())?;
    crate::durable::write(&stage.join(PLAN), &bytes)?;
    Ok(sha256_bytes(&bytes))
}

pub fn signal(stage: &Path, name: &str, nonce: &str) -> Result<(), String> {
    crate::durable::write(&stage.join(name), nonce.as_bytes())
}

pub fn has_signal(stage: &Path, name: &str, nonce: &str) -> bool {
    fs::read(stage.join(name)).is_ok_and(|bytes| bytes == nonce.as_bytes())
}

fn check_stage(stage: &Path, nonce: &str) -> Result<(), String> {
    if !valid_nonce(nonce)
        || stage.file_name().and_then(|name| name.to_str()) != Some(stage_name(nonce).as_str())
    {
        return Err("Неверная папка обновления.".into());
    }
    if !has_signal(stage, OWNER, nonce) {
        return Err("Папка обновления принадлежит другому запуску.".into());
    }
    Ok(())
}

/// Новая версия подтверждает, что окно запустилось и интерфейс загружен
pub fn confirm_probe(stage: &Path, nonce: &str) -> Result<(), String> {
    check_stage(stage, nonce)?;
    signal(stage, HEALTHY, nonce)
}

pub fn read_outcome(stage: &Path, nonce: &str) -> Option<Outcome> {
    check_stage(stage, nonce).ok()?;
    let outcome: Outcome = serde_json::from_slice(&fs::read(stage.join(RESULT)).ok()?).ok()?;
    (outcome.nonce == nonce).then_some(outcome)
}

/// Удаление папки этапа после выхода помощника (его EXE лежит в этой папке)
pub fn remove_stage_when_done(stage: &Path, nonce: &str, timeout: Duration) -> bool {
    if check_stage(stage, nonce).is_err() {
        return false;
    }
    let started = Instant::now();
    while started.elapsed() < timeout {
        if stage.join(RESULT).exists() && fs::remove_dir_all(stage).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

/// Остатки прерванных обновлений рядом с программой; активный этап не трогается
pub fn cleanup_stale(
    directory: &Path,
    keep_nonce: Option<&str>,
    current_exe: Option<&Path>,
) -> u32 {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix(STAGE_PREFIX) else {
            continue;
        };
        let nonce: String = rest.chars().take(32).collect();
        if !valid_nonce(&nonce) || keep_nonce == Some(nonce.as_str()) {
            continue;
        }
        let path = entry.path();
        if current_exe.is_some_and(|exe| exe == path) {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let done = if kind.is_dir() && rest.len() == 32 {
            // Папку без итога удаляем только через 10 минут: помощник ещё может работать
            let finished = path.join(RESULT).exists();
            let old = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.elapsed().ok())
                .is_some_and(|age| age > Duration::from_secs(600));
            (finished || old) && fs::remove_dir_all(&path).is_ok()
        } else if kind.is_file()
            && [".old.exe", ".new.exe", ".failed.exe"]
                .iter()
                .any(|suffix| rest[32..].eq_ignore_ascii_case(suffix))
        {
            fs::remove_file(&path).is_ok()
        } else {
            false
        };
        if done {
            removed += 1;
        }
    }
    removed
}

// ---------------------------------------------------------------------------
// Процессы
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    use windows::Win32::{
        Foundation::{CloseHandle, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
            return false;
        };
        let alive = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        let _ = CloseHandle(handle);
        alive
    }
}

#[cfg(not(windows))]
pub fn process_alive(pid: u32) -> bool {
    // Завершённый, но не прочитанный родителем процесс (Z) считается закрытым
    fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| {
            stat.rsplit_once(')')
                .map(|(_, rest)| rest.trim_start().starts_with('Z'))
        })
        .is_some_and(|zombie| !zombie)
}

fn launch(exe: &Path, args: &[&str]) -> Result<Child, String> {
    let mut command = Command::new(exe);
    command.args(args);
    if let Some(parent) = exe.parent() {
        command.current_dir(parent);
    }
    command
        .spawn()
        .map_err(|error| format!("Не удалось запустить {}: {error}", exe.display()))
}

fn retry<T>(mut action: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    // Антивирус и индексатор могут ненадолго держать только что закрытый EXE
    let mut attempt = 0;
    loop {
        match action() {
            Ok(value) => return Ok(value),
            Err(error) if attempt >= 40 => return Err(error),
            Err(_) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Помощник замены EXE
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct HelperOptions {
    /// Ожидание команды go/abort от программы
    pub decision_timeout: Duration,
    /// Ожидание закрытия программы после go
    pub parent_timeout: Duration,
    /// Ожидание подтверждения от новой версии
    pub health_timeout: Duration,
    pub poll: Duration,
}

impl Default for HelperOptions {
    fn default() -> Self {
        Self {
            decision_timeout: Duration::from_secs(600),
            parent_timeout: Duration::from_secs(120),
            health_timeout: Duration::from_secs(90),
            poll: Duration::from_millis(200),
        }
    }
}

struct Log(PathBuf);

impl Log {
    fn line(&self, message: &str) {
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.0)
        {
            let _ = writeln!(file, "[{}] {message}", now_unix());
        }
    }
}

/// Аргументы режима помощника, если программа запущена как помощник
pub fn helper_request(args: &[String]) -> Option<(PathBuf, String)> {
    match args {
        [_, flag, stage, hash, ..] if flag == HELPER_ARG => {
            Some((PathBuf::from(stage), hash.clone()))
        }
        _ => None,
    }
}

fn load_plan(stage: &Path, plan_hash: &str) -> Result<Plan, String> {
    let bytes = fs::read(stage.join(PLAN))
        .map_err(|error| format!("План обновления не прочитан: {error}"))?;
    if !valid_hash(plan_hash) || !sha256_bytes(&bytes).eq_ignore_ascii_case(plan_hash) {
        return Err("План обновления изменён после подготовки.".into());
    }
    let plan: Plan = serde_json::from_slice(&bytes)
        .map_err(|error| format!("План обновления повреждён: {error}"))?;
    if plan.schema != PLAN_SCHEMA || !valid_hash(&plan.old_hash) || !valid_hash(&plan.new_hash) {
        return Err("План обновления повреждён.".into());
    }
    check_stage(stage, &plan.nonce)?;
    let target = PathBuf::from(&plan.target);
    let same_folder = match (
        target.parent().map(fs::canonicalize),
        stage.parent().map(fs::canonicalize),
    ) {
        (Some(Ok(left)), Some(Ok(right))) => left == right,
        _ => false,
    };
    if !target.is_absolute() || !same_folder {
        return Err("Папка обновления должна находиться рядом с программой.".into());
    }
    if version_parts(&plan.version).is_none() {
        return Err("План обновления содержит неверную версию.".into());
    }
    Ok(plan)
}

enum Relaunch {
    None,
    /// Запуск восстановленной прежней версии с сообщением об откате
    Previous,
}

/// Точка входа помощника: итог всегда записывается в result.json папки этапа
pub fn run_helper(stage: &Path, plan_hash: &str, options: &HelperOptions) -> Outcome {
    let log = Log(stage.join(LOG));
    log.line("Помощник обновления запущен");
    let plan = match load_plan(stage, plan_hash) {
        Ok(plan) => plan,
        Err(error) => {
            log.line(&error);
            return Outcome {
                nonce: String::new(),
                success: false,
                version: String::new(),
                message: error,
            };
        }
    };
    let (outcome, relaunch) = replace_flow(stage, &plan, options, &log);
    log.line(&format!(
        "Итог: success={}, {}",
        outcome.success, outcome.message
    ));
    if let Ok(bytes) = serde_json::to_vec_pretty(&outcome) {
        if let Err(error) = crate::durable::write(&stage.join(RESULT), &bytes) {
            log.line(&format!("Итог не записан: {error}"));
        }
    }
    if let Relaunch::Previous = relaunch {
        let target = PathBuf::from(&plan.target);
        let stage_text = stage.to_string_lossy();
        if let Err(error) = launch(&target, &[FAILED_ARG, &stage_text, &plan.nonce]) {
            log.line(&error);
        }
    }
    outcome
}

fn replace_flow(
    stage: &Path,
    plan: &Plan,
    options: &HelperOptions,
    log: &Log,
) -> (Outcome, Relaunch) {
    let fail = |message: String, relaunch: Relaunch| {
        (
            Outcome {
                nonce: plan.nonce.clone(),
                success: false,
                version: plan.version.clone(),
                message,
            },
            relaunch,
        )
    };
    let target = PathBuf::from(&plan.target);
    let payload = stage.join(PAYLOAD);
    let hashes_match = || -> Result<(), String> {
        if crate::durable::hash_file(&payload)? != plan.new_hash {
            return Err("SHA-256 нового EXE не совпадает с планом обновления.".into());
        }
        if crate::durable::hash_file(&target)? != plan.old_hash {
            return Err("Файл программы изменился во время обновления; замена отменена.".into());
        }
        Ok(())
    };
    if let Err(error) = hashes_match() {
        return fail(error, Relaunch::None);
    }
    if let Err(error) = signal(stage, READY, &plan.nonce) {
        return fail(error, Relaunch::None);
    }
    log.line("Готов к замене, ожидаю подтверждения программы");
    let started = Instant::now();
    loop {
        if has_signal(stage, ABORT, &plan.nonce) {
            return fail(CANCELLED.into(), Relaunch::None);
        }
        if has_signal(stage, GO, &plan.nonce) {
            break;
        }
        if !process_alive(plan.parent_pid) {
            return fail(
                "Программа закрылась до подтверждения обновления.".into(),
                Relaunch::None,
            );
        }
        if started.elapsed() > options.decision_timeout {
            return fail(
                "Программа не подтвердила обновление.".into(),
                Relaunch::None,
            );
        }
        std::thread::sleep(options.poll);
    }
    log.line("Подтверждение получено, жду закрытия программы");
    let started = Instant::now();
    while process_alive(plan.parent_pid) {
        if started.elapsed() > options.parent_timeout {
            return fail(
                format!(
                    "Программа не закрылась за {} секунд; файл не заменён.",
                    options.parent_timeout.as_secs()
                ),
                Relaunch::None,
            );
        }
        std::thread::sleep(options.poll);
    }
    if let Err(error) = hashes_match() {
        return fail(error, Relaunch::None);
    }
    // Новый EXE копируется рядом с программой, затем занимает её место переименованием
    let staged = staged_path(&target, &plan.nonce);
    let backup = backup_path(&target, &plan.nonce);
    if let Err(error) = crate::durable::copy(&payload, &staged) {
        let _ = fs::remove_file(&staged);
        return fail(
            format!("Не удалось подготовить новый EXE: {error}"),
            Relaunch::None,
        );
    }
    if let Err(error) = retry(|| fs::rename(&target, &backup)) {
        let _ = fs::remove_file(&staged);
        return fail(
            format!("Не удалось освободить файл программы: {error}"),
            Relaunch::None,
        );
    }
    if let Err(error) = retry(|| fs::rename(&staged, &target)) {
        let restored = retry(|| fs::rename(&backup, &target)).is_ok();
        let _ = fs::remove_file(&staged);
        return fail(
            format!("Не удалось записать новый EXE: {error}"),
            if restored {
                Relaunch::Previous
            } else {
                Relaunch::None
            },
        );
    }
    log.line("EXE заменён, проверяю запуск новой версии");
    let stage_text = stage.to_string_lossy();
    let probe = match launch(&target, &[PROBE_ARG, &stage_text, &plan.nonce]) {
        Ok(child) => wait_healthy(child, stage, &plan.nonce, options),
        Err(error) => Err(error),
    };
    match probe {
        Ok(()) => {
            let _ = retry(|| match fs::remove_file(&backup) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                other => other,
            });
            (
                Outcome {
                    nonce: plan.nonce.clone(),
                    success: true,
                    version: plan.version.clone(),
                    message: format!("Eclipse Studio обновлён до версии {}.", plan.version),
                },
                Relaunch::None,
            )
        }
        Err(error) => {
            log.line(&format!("Новая версия не подтвердила запуск: {error}"));
            let failed = failed_path(&target, &plan.nonce);
            let restored = retry(|| fs::rename(&target, &failed))
                .and_then(|_| retry(|| fs::rename(&backup, &target)))
                .is_ok();
            let _ = fs::remove_file(&failed);
            if restored {
                fail(
                    format!("{error} Восстановлена прежняя версия."),
                    Relaunch::Previous,
                )
            } else {
                fail(
                    format!(
                        "{error} Прежнюю версию вернуть не удалось: она сохранена как {}.",
                        backup.display()
                    ),
                    Relaunch::None,
                )
            }
        }
    }
}

fn wait_healthy(
    mut child: Child,
    stage: &Path,
    nonce: &str,
    options: &HelperOptions,
) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if has_signal(stage, HEALTHY, nonce) {
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            if has_signal(stage, HEALTHY, nonce) {
                return Ok(());
            }
            return Err(format!("Новая версия завершилась при запуске ({status})."));
        }
        if started.elapsed() > options.health_timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Новая версия не запустилась за {} секунд.",
                options.health_timeout.as_secs()
            ));
        }
        std::thread::sleep(options.poll);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASSETS_HTML: &str = r#"
      <a href="/Sparki1337/eclipse-studio/releases/download/9.1.0/Eclipse-Studio-v9.1.0.exe" rel="nofollow" data-turbo="false" class="wb-break-all">
        <span class="text-bold">Eclipse-Studio-v9.1.0.exe</span></a>
      <span class="Truncate-text">sha256:F33418C39B8FE49D02098BCA969F51DEE133D60A05DE4016C24E4E4B1B5115F2</span>
      <clipboard-copy aria-label="Copy to clipboard digest for Eclipse-Studio-v9.1.0.exe" value="sha256:f33418c39b8fe49d02098bca969f51dee133d60a05de4016c24e4e4b1b5115f2"></clipboard-copy>
      <a href="/Sparki1337/eclipse-studio/releases/download/9.1.0/notes.txt" rel="nofollow">notes.txt</a>
      <a href="/Sparki1337/eclipse-studio/archive/refs/tags/9.1.0.zip" rel="nofollow">Source code (zip)</a>
    "#;

    #[test]
    fn compares_versions() {
        assert!(is_newer("9.1.0", "9.0.0"));
        assert!(is_newer("v10.0", "9.9.9"));
        assert!(!is_newer("9.0.0", "9.0.0"));
        assert!(!is_newer("v9.0.0-beta.1", "9.0.0"));
        assert!(same_version("9.1.0.0", "9.1.0"));
        assert!(same_version("v9.1", "9.1.0"));
        assert!(!same_version("9.1.1", "9.1.0"));
        assert!(!same_version("garbage", "9.1.0"));
    }

    #[test]
    fn parses_assets_with_their_own_digest() {
        let assets = parse_release_assets(ASSETS_HTML, "Sparki1337/eclipse-studio", "9.1.0");
        assert_eq!(assets.len(), 2);
        assert_eq!(assets[0].name, "Eclipse-Studio-v9.1.0.exe");
        assert_eq!(
            assets[0].url,
            "https://github.com/Sparki1337/eclipse-studio/releases/download/9.1.0/Eclipse-Studio-v9.1.0.exe"
        );
        assert_eq!(
            assets[0].sha256.as_deref(),
            Some("f33418c39b8fe49d02098bca969f51dee133d60a05de4016c24e4e4b1b5115f2")
        );
        // Контрольная сумма соседнего файла не приписывается файлу без своей суммы
        assert_eq!(assets[1].sha256, None);
        assert_eq!(
            update_asset(&assets, "9.1.0").unwrap().name,
            "Eclipse-Studio-v9.1.0.exe"
        );
        assert!(update_asset(&assets[1..], "9.1.0").is_none());
    }

    /// Минимальный PE x64 с ресурсом версии
    fn fake_pe(machine: u16, subsystem: u16, characteristics: u16, version: [u16; 4]) -> Vec<u8> {
        let mut pe = vec![0u8; 0x400];
        pe[..2].copy_from_slice(b"MZ");
        pe[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        pe[0x80..0x84].copy_from_slice(b"PE\0\0");
        let coff = 0x84;
        pe[coff..coff + 2].copy_from_slice(&machine.to_le_bytes());
        pe[coff + 2..coff + 4].copy_from_slice(&1u16.to_le_bytes());
        pe[coff + 16..coff + 18].copy_from_slice(&240u16.to_le_bytes());
        pe[coff + 18..coff + 20].copy_from_slice(&characteristics.to_le_bytes());
        let optional = coff + 20;
        pe[optional..optional + 2].copy_from_slice(&0x20bu16.to_le_bytes());
        pe[optional + 68..optional + 70].copy_from_slice(&subsystem.to_le_bytes());
        pe[optional + 108..optional + 112].copy_from_slice(&16u32.to_le_bytes());
        pe[optional + 112 + 16..optional + 112 + 20].copy_from_slice(&0x1000u32.to_le_bytes());
        pe[optional + 112 + 20..optional + 112 + 24].copy_from_slice(&0x200u32.to_le_bytes());
        let section = optional + 240;
        pe[section..section + 5].copy_from_slice(b".rsrc");
        pe[section + 8..section + 12].copy_from_slice(&0x200u32.to_le_bytes());
        pe[section + 12..section + 16].copy_from_slice(&0x1000u32.to_le_bytes());
        pe[section + 16..section + 20].copy_from_slice(&0x200u32.to_le_bytes());
        pe[section + 20..section + 24].copy_from_slice(&0x200u32.to_le_bytes());
        // Каталоги ресурсов: тип 16 → имя 1 → язык 0x409 → данные
        let rsrc = 0x200;
        let mut put_dir = |at: usize, id: u32, data: u32| {
            pe[at + 14..at + 16].copy_from_slice(&1u16.to_le_bytes());
            pe[at + 16..at + 20].copy_from_slice(&id.to_le_bytes());
            pe[at + 20..at + 24].copy_from_slice(&data.to_le_bytes());
        };
        put_dir(rsrc, 16, 0x8000_0018);
        put_dir(rsrc + 0x18, 1, 0x8000_0030);
        put_dir(rsrc + 0x30, 0x409, 0x48);
        let data_entry = rsrc + 0x48;
        pe[data_entry..data_entry + 4].copy_from_slice(&(0x1000u32 + 0x60).to_le_bytes());
        pe[data_entry + 4..data_entry + 8].copy_from_slice(&0x60u32.to_le_bytes());
        let info = rsrc + 0x60 + 40;
        pe[info..info + 4].copy_from_slice(&[0xBD, 0x04, 0xEF, 0xFE]);
        let high = (u32::from(version[0]) << 16) | u32::from(version[1]);
        let low = (u32::from(version[2]) << 16) | u32::from(version[3]);
        pe[info + 8..info + 12].copy_from_slice(&high.to_le_bytes());
        pe[info + 12..info + 16].copy_from_slice(&low.to_le_bytes());
        pe
    }

    #[test]
    fn verifies_windows_exe_and_version() {
        let good = fake_pe(0x8664, 2, 0x0022, [9, 1, 0, 0]);
        assert_eq!(inspect_pe(&good).unwrap().file_version, Some([9, 1, 0, 0]));
        assert!(verify_payload(&good, "9.1.0").is_ok());
        assert!(verify_payload(&good, "9.2.0")
            .unwrap_err()
            .contains("не совпадает"));
        assert!(verify_payload(&fake_pe(0x14c, 2, 0x0022, [9, 1, 0, 0]), "9.1.0").is_err());
        assert!(verify_payload(&fake_pe(0x8664, 3, 0x0022, [9, 1, 0, 0]), "9.1.0").is_err());
        assert!(verify_payload(&fake_pe(0x8664, 2, 0x2022, [9, 1, 0, 0]), "9.1.0").is_err());
        assert_eq!(
            verify_payload(b"<html>not found</html>", "9.1.0").unwrap_err(),
            NOT_PE
        );
        assert!(verify_payload(&good[..0x90], "9.1.0").is_err());
    }

    #[test]
    fn helper_arguments_and_nonce() {
        let nonce = new_nonce();
        assert!(valid_nonce(&nonce));
        assert!(!valid_nonce("../../etc"));
        let args = vec![
            "app.exe".to_string(),
            HELPER_ARG.into(),
            "C:\\stage".into(),
            "ab".into(),
        ];
        assert_eq!(
            helper_request(&args),
            Some((PathBuf::from("C:\\stage"), "ab".to_string()))
        );
        assert_eq!(helper_request(&args[..2]), None);
    }

    #[cfg(unix)]
    mod helper {
        use super::super::*;
        use std::os::unix::fs::PermissionsExt;

        /// Тестовая «программа»: отвечает на проверочный запуск и запуск после отката
        const FAKE_EXE: &str = r#"#!/bin/sh
dir=$(dirname "$0")
case "$1" in
  --eclipse-update-probe)
    [ -f "$dir/fail-new" ] && exit 17
    printf '%s' "$3" > "$2/healthy"; echo yes > "$dir/new-started"; exit 0 ;;
  --eclipse-update-failed)
    echo yes > "$dir/rollback-restarted"; exit 0 ;;
esac
exit 0
"#;

        struct Setup {
            _temp: tempfile::TempDir,
            dir: PathBuf,
            target: PathBuf,
            stage: PathBuf,
            hash: String,
            plan: Plan,
            parent: Child,
            _serial: std::sync::MutexGuard<'static, ()>,
        }

        impl Drop for Setup {
            fn drop(&mut self) {
                let _ = self.parent.kill();
                let _ = self.parent.wait();
            }
        }

        /// Тесты с запуском скриптов идут по очереди: параллельный fork держит открытые файлы
        static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

        fn script(path: &Path, marker: &str) {
            fs::write(path, format!("{FAKE_EXE}# {marker}\n")).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }

        fn setup() -> Setup {
            let serial = SERIAL
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let temp = tempfile::tempdir().unwrap();
            let dir = temp.path().join("Программа с пробелами");
            fs::create_dir_all(&dir).unwrap();
            let dir = fs::canonicalize(dir).unwrap();
            let target = dir.join("Eclipse Studio.exe");
            script(&target, "old");
            let (stage, nonce) = create_stage(&dir).unwrap();
            script(&stage.join(PAYLOAD), "new");
            let parent = Command::new("sleep").arg("30").spawn().unwrap();
            let plan = Plan {
                schema: PLAN_SCHEMA,
                nonce,
                target: target.display().to_string(),
                parent_pid: parent.id(),
                old_hash: crate::durable::hash_file(&target).unwrap(),
                new_hash: crate::durable::hash_file(&stage.join(PAYLOAD)).unwrap(),
                version: "9.1.0".into(),
            };
            let hash = write_plan(&stage, &plan).unwrap();
            Setup {
                _temp: temp,
                dir,
                target,
                stage,
                hash,
                plan,
                parent,
                _serial: serial,
            }
        }

        fn options() -> HelperOptions {
            HelperOptions {
                decision_timeout: Duration::from_secs(20),
                parent_timeout: Duration::from_secs(20),
                health_timeout: Duration::from_secs(20),
                poll: Duration::from_millis(20),
            }
        }

        fn wait_for(path: &Path) {
            let started = Instant::now();
            while !path.exists() {
                assert!(
                    started.elapsed() < Duration::from_secs(20),
                    "нет {}",
                    path.display()
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        fn start(setup: &Setup) -> std::thread::JoinHandle<Outcome> {
            let (stage, hash) = (setup.stage.clone(), setup.hash.clone());
            std::thread::spawn(move || run_helper(&stage, &hash, &options()))
        }

        fn close_parent(setup: &mut Setup) {
            signal(&setup.stage, GO, &setup.plan.nonce).unwrap();
            setup.parent.kill().unwrap();
            setup.parent.wait().unwrap();
        }

        #[test]
        fn replaces_exe_in_place_and_confirms_new_version() {
            let mut setup = setup();
            let helper = start(&setup);
            wait_for(&setup.stage.join(READY));
            assert_eq!(
                crate::durable::hash_file(&setup.target).unwrap(),
                setup.plan.old_hash
            );
            close_parent(&mut setup);
            let outcome = helper.join().unwrap();
            assert!(outcome.success, "{outcome:?}");
            assert_eq!(
                crate::durable::hash_file(&setup.target).unwrap(),
                setup.plan.new_hash
            );
            assert!(setup.dir.join("new-started").exists());
            assert!(!backup_path(&setup.target, &setup.plan.nonce).exists());
            assert_eq!(
                read_outcome(&setup.stage, &setup.plan.nonce).unwrap(),
                outcome
            );
            assert!(remove_stage_when_done(
                &setup.stage,
                &setup.plan.nonce,
                Duration::from_secs(5)
            ));
            assert!(!setup.stage.exists());
        }

        #[test]
        fn rolls_back_when_new_version_does_not_start() {
            let mut setup = setup();
            fs::write(setup.dir.join("fail-new"), "yes").unwrap();
            let helper = start(&setup);
            wait_for(&setup.stage.join(READY));
            close_parent(&mut setup);
            let outcome = helper.join().unwrap();
            assert!(!outcome.success);
            assert!(
                outcome.message.contains("Восстановлена прежняя версия"),
                "{}",
                outcome.message
            );
            assert_eq!(
                crate::durable::hash_file(&setup.target).unwrap(),
                setup.plan.old_hash
            );
            wait_for(&setup.dir.join("rollback-restarted"));
            assert!(!backup_path(&setup.target, &setup.plan.nonce).exists());
            assert_eq!(
                read_outcome(&setup.stage, &setup.plan.nonce)
                    .unwrap()
                    .success,
                false
            );
        }

        #[test]
        fn abort_keeps_current_exe() {
            let mut setup = setup();
            let helper = start(&setup);
            wait_for(&setup.stage.join(READY));
            signal(&setup.stage, ABORT, &setup.plan.nonce).unwrap();
            let outcome = helper.join().unwrap();
            assert_eq!(outcome.message, CANCELLED);
            assert_eq!(
                crate::durable::hash_file(&setup.target).unwrap(),
                setup.plan.old_hash
            );
            setup.parent.kill().unwrap();
            setup.parent.wait().unwrap();
        }

        #[test]
        fn rejects_tampered_plan_and_changed_target() {
            let mut setup = setup();
            let outcome = run_helper(&setup.stage, &"0".repeat(64), &options());
            assert!(!outcome.success);
            assert!(!setup.stage.join(READY).exists());
            // Программа изменилась после подготовки плана: замена не выполняется
            script(&setup.target, "changed");
            let outcome = run_helper(&setup.stage, &setup.hash, &options());
            assert!(outcome.message.contains("изменился"), "{}", outcome.message);
            assert!(fs::read_to_string(&setup.target)
                .unwrap()
                .contains("changed"));
            setup.parent.kill().unwrap();
            setup.parent.wait().unwrap();
        }

        #[test]
        fn helper_stops_when_app_closes_without_confirmation() {
            let mut setup = setup();
            let helper = start(&setup);
            wait_for(&setup.stage.join(READY));
            setup.parent.kill().unwrap();
            setup.parent.wait().unwrap();
            let outcome = helper.join().unwrap();
            assert!(!outcome.success);
            assert_eq!(
                crate::durable::hash_file(&setup.target).unwrap(),
                setup.plan.old_hash
            );
        }

        #[test]
        fn cleanup_keeps_active_stage_and_removes_leftovers() {
            let setup = setup();
            let other = new_nonce();
            let leftover = setup.dir.join(stage_name(&other));
            fs::create_dir(&leftover).unwrap();
            fs::write(leftover.join(RESULT), "{}").unwrap();
            fs::write(backup_path(&setup.target, &other), "old").unwrap();
            fs::write(setup.dir.join(".eclipse-update-notes.txt"), "keep").unwrap();
            let removed = cleanup_stale(&setup.dir, Some(&setup.plan.nonce), Some(&setup.target));
            assert_eq!(removed, 2);
            assert!(setup.stage.exists());
            assert!(!leftover.exists());
            assert!(setup.dir.join(".eclipse-update-notes.txt").exists());
            assert!(confirm_probe(&setup.stage, &setup.plan.nonce).is_ok());
            assert!(confirm_probe(&setup.stage, &other).is_err());
        }
    }
}
