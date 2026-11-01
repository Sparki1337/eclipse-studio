use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs::{self, File},
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use walkdir::{DirEntry, WalkDir};

const SAVE_MANIFEST_NAME: &str = "cgs-save-manifest.json";
const MAX_RESTORE_FILES: usize = 250_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveManifest {
    schema_version: u32,
    created_unix: u64,
    items: Vec<SaveManifestItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveManifestItem {
    folder: String,
    target: String,
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Clone)]
struct SaveCandidate {
    label: String,
    category: String,
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLocation {
    pub id: String,
    pub label: String,
    pub category: String,
    pub path: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub modified_unix: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveArchiveResult {
    pub success: bool,
    pub status: String,
    pub skipped: Vec<String>,
    pub copied_files: u64,
    pub backup_path: Option<String>,
    pub message: String,
    pub logs: Vec<String>,
    pub archive_path: Option<String>,
}

impl SaveArchiveResult {
    fn error(message: impl Into<String>, logs: Vec<String>) -> Self {
        Self {
            success: false,
            status: "failed".into(),
            skipped: logs.clone(),
            copied_files: 0,
            backup_path: None,
            message: message.into(),
            logs,
            archive_path: None,
        }
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn add_candidate(
    candidates: &mut BTreeMap<String, SaveCandidate>,
    path: PathBuf,
    label: impl Into<String>,
    category: impl Into<String>,
) {
    if !path.is_dir() {
        return;
    }
    let key = path.to_string_lossy().replace('/', "\\").to_lowercase();
    candidates.entry(key).or_insert_with(|| SaveCandidate {
        label: label.into(),
        category: category.into(),
        path,
    });
}

fn add_named_roots(candidates: &mut BTreeMap<String, SaveCandidate>, base: &Path, category: &str) {
    let names = [
        ("Goldberg SteamEmu Saves", "Goldberg SteamEmu"),
        ("GSE Saves", "Goldberg / GSE"),
        ("SmartSteamEmu", "SmartSteamEmu"),
        ("SteamEmu", "SteamEmu"),
        ("CODEX", "CODEX"),
        ("EMPRESS", "EMPRESS"),
        ("RUNE", "RUNE"),
        ("FLT", "FLT"),
        ("TENOKE", "TENOKE"),
        ("SKIDROW", "SKIDROW"),
        ("OnlineFix", "OnlineFix"),
        ("0xdeadc0de", "0xdeadc0de"),
    ];
    for (directory, label) in names {
        add_candidate(candidates, base.join(directory), label, category);
    }
}

fn ignored_save_directory_name(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_lowercase();
    matches!(
        name.as_str(),
        "cache"
            | "caches"
            | "cache_data"
            | "code cache"
            | "component_crx_cache"
            | "gpucache"
            | "dawncache"
            | "shadercache"
            | "webcache"
            | "platformprocess"
            | "crashpad"
            | "temp"
            | "tmp"
            | "logs"
            | "log"
            | "telemetry"
    ) || name.ends_with("_cache")
}

fn ignored_save_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return false;
    }
    if entry.file_type().is_dir() {
        return ignored_save_directory_name(entry.file_name());
    }
    let name = entry.file_name().to_string_lossy().to_lowercase();
    name == "lockfile"
        || name.starts_with("singleton")
        || name.ends_with(".lock")
        || name.ends_with(".tmp")
        || name.ends_with(".dmp")
        || name.ends_with(".log")
}

fn add_local_low_games(candidates: &mut BTreeMap<String, SaveCandidate>, local_low: &Path) {
    let Ok(companies) = fs::read_dir(local_low) else {
        return;
    };
    for company in companies.flatten().filter(|item| item.path().is_dir()) {
        if ignored_save_directory_name(&company.file_name()) {
            continue;
        }
        let company_path = company.path();
        let company_name = company.file_name().to_string_lossy().into_owned();
        let has_direct_files = fs::read_dir(&company_path)
            .map(|items| items.flatten().any(|item| item.path().is_file()))
            .unwrap_or(false);
        if has_direct_files {
            add_candidate(
                candidates,
                company_path,
                format!("Unity · {company_name}"),
                "Unity / LocalLow",
            );
            continue;
        }

        let mut games_added = 0usize;
        if let Ok(games) = fs::read_dir(&company_path) {
            for game in games.flatten().filter(|item| item.path().is_dir()) {
                if ignored_save_directory_name(&game.file_name()) {
                    continue;
                }
                let game_name = game.file_name().to_string_lossy().into_owned();
                add_candidate(
                    candidates,
                    game.path(),
                    format!("Unity · {company_name} / {game_name}"),
                    "Unity / LocalLow",
                );
                games_added += 1;
            }
        }
        if games_added == 0 {
            add_candidate(
                candidates,
                company_path,
                format!("Unity · {company_name}"),
                "Unity / LocalLow",
            );
        }
    }
}

fn collect_candidates() -> BTreeMap<String, SaveCandidate> {
    let mut candidates = BTreeMap::new();

    if let Some(user) = env_path("USERPROFILE") {
        add_candidate(
            &mut candidates,
            user.join("Saved Games"),
            "Сохранённые игры Windows",
            "Стандартные папки",
        );
        add_candidate(
            &mut candidates,
            user.join("Documents").join("My Games"),
            "Documents / My Games",
            "Стандартные папки",
        );
        add_candidate(
            &mut candidates,
            user.join("Documents").join("SavedGames"),
            "Documents / SavedGames",
            "Стандартные папки",
        );
    }
    if let Some(one_drive) = env_path("OneDrive") {
        add_candidate(
            &mut candidates,
            one_drive.join("Documents").join("My Games"),
            "OneDrive / My Games",
            "Стандартные папки",
        );
    }

    if let Some(roaming) = env_path("APPDATA") {
        add_named_roots(&mut candidates, &roaming, "Эмуляторы и репаки");
        add_candidate(
            &mut candidates,
            roaming.join("Godot").join("app_userdata"),
            "Godot / app_userdata",
            "Игровые движки",
        );
    }

    if let Some(local) = env_path("LOCALAPPDATA") {
        add_named_roots(&mut candidates, &local, "Эмуляторы и репаки");
        if let Some(app_data) = local.parent() {
            add_local_low_games(&mut candidates, &app_data.join("LocalLow"));
        }
        if let Ok(items) = fs::read_dir(&local) {
            for item in items.flatten().filter(|item| item.path().is_dir()) {
                let root = item.path();
                for suffix in [
                    ["Saved", "SaveGames"],
                    ["Saved", "SaveGame"],
                    ["Saved", "Saves"],
                ] {
                    let path = root.join(suffix[0]).join(suffix[1]);
                    if path.is_dir() {
                        let game = item.file_name().to_string_lossy().into_owned();
                        add_candidate(
                            &mut candidates,
                            path,
                            format!("{game} / {}", suffix[1]),
                            "Unreal Engine и локальные игры",
                        );
                    }
                }
            }
        }
    }

    if let Some(public) = env_path("PUBLIC") {
        let documents = public.join("Documents");
        for (path, label) in [
            (documents.join("Steam").join("CODEX"), "Steam / CODEX"),
            (documents.join("Steam").join("RUNE"), "Steam / RUNE"),
            (documents.join("Steam").join("FLT"), "Steam / FLT"),
            (documents.join("Steam").join("TENOKE"), "Steam / TENOKE"),
            (documents.join("EMPRESS"), "EMPRESS"),
            (documents.join("OnlineFix"), "OnlineFix"),
        ] {
            add_candidate(&mut candidates, path, label, "Общие сохранения");
        }
    }

    if let Some(program_data) = env_path("PROGRAMDATA") {
        for (directory, label) in [
            ("RLD!", "Steam / RLD!"),
            ("Player", "Steam / Player"),
            ("CODEX", "Steam / CODEX"),
        ] {
            add_candidate(
                &mut candidates,
                program_data.join("Steam").join(directory),
                label,
                "Общие сохранения",
            );
        }
    }

    if let Some(steam) = crate::luatools::resolve_steam_path(None) {
        add_candidate(
            &mut candidates,
            steam.join("userdata"),
            "Steam / userdata",
            "Официальные клиенты",
        );
    }
    for (name, root) in known_roots() {
        if name == "SavedGames" {
            add_candidate(
                &mut candidates,
                root,
                "Сохранённые игры Windows",
                "Перенаправленные папки Windows",
            );
        } else {
            for suffix in ["My Games", "SavedGames"] {
                add_candidate(
                    &mut candidates,
                    root.join(suffix),
                    format!("Documents / {suffix}"),
                    "Перенаправленные папки Windows",
                );
            }
        }
    }

    candidates
}

fn directory_stats(path: &Path) -> (u64, u64, Option<u64>) {
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut modified = None;
    for entry in WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !ignored_save_entry(entry))
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        if let Ok(metadata) = entry.metadata() {
            files += 1;
            bytes = bytes.saturating_add(metadata.len());
            if let Ok(time) = metadata.modified() {
                if let Ok(value) = time.duration_since(UNIX_EPOCH) {
                    modified = Some(modified.unwrap_or(0).max(value.as_secs()));
                }
            }
        }
    }
    (files, bytes, modified)
}

#[tauri::command]
pub async fn scan_save_locations(app: tauri::AppHandle) -> Result<Vec<SaveLocation>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_save_locations_with_options(&app))
        .await
        .map_err(|error| format!("Сканирование прервано: {error}"))?
}

fn stable_hash(path: &Path) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in path.to_string_lossy().to_lowercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[tauri::command]
pub async fn pick_save_archive(format: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || pick_save_archive_blocking(format))
        .await
        .map_err(|error| format!("Диалог выбора прерван: {error}"))?
}

fn pick_save_archive_blocking(format: String) -> Result<Option<String>, String> {
    let format = if format.eq_ignore_ascii_case("rar") {
        "rar"
    } else {
        "zip"
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let default_name = format!("CrocodileGena-Saves-{stamp}.{format}");
    let script = r#"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.SaveFileDialog; $d.Title = 'Сохранить архив игровых сохранений'; $d.FileName = $env:CGS_ARCHIVE_NAME; if ($env:CGS_ARCHIVE_FORMAT -eq 'rar') { $d.Filter = 'RAR archive (*.rar)|*.rar' } else { $d.Filter = 'ZIP archive (*.zip)|*.zip' }; $d.DefaultExt = $env:CGS_ARCHIVE_FORMAT; $d.AddExtension = $true; $d.OverwritePrompt = $true; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.FileName }"#;
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-STA", "-Command", script])
        .env("CGS_ARCHIVE_NAME", default_name)
        .env("CGS_ARCHIVE_FORMAT", format);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .map_err(|error| format!("Не удалось открыть выбор файла: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!path.is_empty()).then_some(path))
}

#[tauri::command]
pub async fn pick_save_restore_archive() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(pick_save_restore_archive_blocking)
        .await
        .map_err(|error| format!("Диалог выбора прерван: {error}"))?
}

fn pick_save_restore_archive_blocking() -> Result<Option<String>, String> {
    let script = r#"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Выберите архив сохранений Crocodile Gena Studio'; $d.Filter = 'Архивы сохранений (*.zip;*.rar)|*.zip;*.rar|ZIP archive (*.zip)|*.zip|RAR archive (*.rar)|*.rar'; $d.Multiselect = $false; $d.CheckFileExists = $true; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.FileName }"#;
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-STA", "-Command", script]);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .map_err(|error| format!("Не удалось открыть выбор файла: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!path.is_empty()).then_some(path))
}

fn known_roots() -> Vec<(&'static str, PathBuf)> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    {
        use windows::Win32::{
            System::Com::CoTaskMemFree,
            UI::Shell::{
                FOLDERID_Documents, FOLDERID_SavedGames, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
            },
        };
        for (name, id) in [
            ("Documents", FOLDERID_Documents),
            ("SavedGames", FOLDERID_SavedGames),
        ] {
            unsafe {
                if let Ok(value) = SHGetKnownFolderPath(&id, KF_FLAG_DEFAULT, None) {
                    if let Ok(text) = value.to_string() {
                        roots.push((name, PathBuf::from(text)));
                    }
                    CoTaskMemFree(Some(value.0 as *const _));
                }
            }
        }
    }
    roots
}
fn portable_roots() -> Vec<(&'static str, PathBuf)> {
    let mut roots = [
        "LOCALAPPDATA",
        "APPDATA",
        "USERPROFILE",
        "OneDrive",
        "PUBLIC",
        "PROGRAMDATA",
        "ProgramFiles(x86)",
    ]
    .into_iter()
    .filter_map(|name| env_path(name).map(|root| (name, root)))
    .collect::<Vec<_>>();
    roots.extend(known_roots());
    if let Some(steam) = crate::luatools::resolve_steam_path(None) {
        roots.push(("SteamUserdata", steam.join("userdata")));
    }
    roots.sort_by_key(|(_, root)| std::cmp::Reverse(root.as_os_str().len()));
    roots
}
fn portable_path(path: &Path) -> String {
    for (name, root) in portable_roots() {
        if let Ok(relative) = path.strip_prefix(&root) {
            return if relative.as_os_str().is_empty() {
                format!("{{{name}}}")
            } else {
                format!(
                    "{{{name}}}/{}",
                    relative.to_string_lossy().replace('\\', "/")
                )
            };
        }
    }
    path.display().to_string()
}

fn expand_portable_path(value: &str) -> Option<PathBuf> {
    if let Some(rest) = value.strip_prefix('{') {
        let (name, suffix) = rest.split_once('}')?;
        let root = portable_roots()
            .into_iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))?
            .1;
        let relative = suffix
            .strip_prefix('/')
            .or_else(|| suffix.strip_prefix('\\'))
            .unwrap_or(suffix);
        let path = if relative.is_empty() {
            crate::safe_path::resolve_root(&root).ok()?
        } else {
            crate::safe_path::join(&root, relative).ok()?
        };
        return Some(crate::safe_path::strip_verbatim(path));
    }
    let absolute = PathBuf::from(value);
    crate::safe_path::validate_absolute(&absolute).ok()?;
    Some(absolute)
}
fn normalized_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}
fn path_is_within(path: &Path, root: &Path) -> bool {
    crate::safe_path::within(path, root)
}

fn known_emulator_name(name: &str) -> bool {
    [
        "Goldberg SteamEmu Saves",
        "GSE Saves",
        "SmartSteamEmu",
        "SteamEmu",
        "CODEX",
        "EMPRESS",
        "RUNE",
        "FLT",
        "TENOKE",
        "SKIDROW",
        "OnlineFix",
        "0xdeadc0de",
    ]
    .iter()
    .any(|known| known.eq_ignore_ascii_case(name))
}

fn allowed_save_destination(path: &Path) -> bool {
    if crate::safe_path::validate_absolute(path).is_err() {
        return false;
    }
    for (name, root) in known_roots() {
        if name == "SavedGames" && path_is_within(path, &root) {
            return true;
        }
        if name == "Documents"
            && ["My Games", "SavedGames"]
                .iter()
                .any(|suffix| path_is_within(path, &root.join(suffix)))
        {
            return true;
        }
    }
    if crate::luatools::resolve_steam_path(None)
        .is_some_and(|root| path_is_within(path, &root.join("userdata")))
    {
        return true;
    }

    if let Some(user) = env_path("USERPROFILE") {
        for root in [
            user.join("Saved Games"),
            user.join("Documents").join("My Games"),
            user.join("Documents").join("SavedGames"),
        ] {
            if path_is_within(path, &root) {
                return true;
            }
        }
    }
    if let Some(one_drive) = env_path("OneDrive") {
        if path_is_within(path, &one_drive.join("Documents").join("My Games")) {
            return true;
        }
    }
    if let Some(roaming) = env_path("APPDATA") {
        if let Ok(relative) = path.strip_prefix(&roaming) {
            let first = relative
                .components()
                .next()
                .and_then(|part| part.as_os_str().to_str());
            if first.is_some_and(known_emulator_name)
                || path_is_within(path, &roaming.join("Godot").join("app_userdata"))
            {
                return true;
            }
        }
    }
    if let Some(local) = env_path("LOCALAPPDATA") {
        if let Ok(relative) = path.strip_prefix(&local) {
            let first = relative
                .components()
                .next()
                .and_then(|part| part.as_os_str().to_str());
            if first.is_some_and(known_emulator_name) {
                return true;
            }
            let parts = relative
                .components()
                .filter_map(|part| part.as_os_str().to_str())
                .collect::<Vec<_>>();
            if parts.windows(2).any(|pair| {
                pair[0].eq_ignore_ascii_case("Saved")
                    && ["SaveGames", "SaveGame", "Saves"]
                        .iter()
                        .any(|name| name.eq_ignore_ascii_case(pair[1]))
            }) {
                return true;
            }
        }
        if let Some(app_data) = local.parent() {
            if path_is_within(path, &app_data.join("LocalLow")) {
                return true;
            }
        }
    }
    if let Some(public) = env_path("PUBLIC") {
        if path_is_within(path, &public.join("Documents")) {
            return true;
        }
    }
    if let Some(program_data) = env_path("PROGRAMDATA") {
        if path_is_within(path, &program_data.join("Steam")) {
            return true;
        }
    }
    if let Some(program_files) = env_path("ProgramFiles(x86)") {
        if path_is_within(path, &program_files.join("Steam").join("userdata")) {
            return true;
        }
    }
    false
}

fn safe_folder_name(value: &OsStr, index: usize) -> String {
    let cleaned = value
        .to_string_lossy()
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            other => other,
        })
        .collect::<String>();
    let cleaned = cleaned.trim().trim_matches('.');
    format!(
        "{:02}_{}",
        index + 1,
        if cleaned.is_empty() { "Saves" } else { cleaned }
    )
}

#[cfg(test)]
fn copy_save_directory(source: &Path, target: &Path, logs: &mut Vec<String>) -> (u64, u64) {
    let mut copied = 0u64;
    let mut skipped = 0u64;
    let mut detailed_errors = 0usize;
    for entry in WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !ignored_save_entry(entry))
        .filter_map(Result::ok)
    {
        let Ok(relative) = entry.path().strip_prefix(source) else {
            continue;
        };
        let destination = target.join(relative);
        if entry.file_type().is_dir() {
            if fs::create_dir_all(&destination).is_err() {
                skipped += 1;
            }
        } else if entry.file_type().is_file() {
            if let Some(parent) = destination.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match fs::copy(entry.path(), &destination) {
                Ok(_) => copied += 1,
                Err(error) => {
                    skipped += 1;
                    if error.kind() != std::io::ErrorKind::PermissionDenied && detailed_errors < 3 {
                        logs.push(format!("Файл пропущен {}: {error}", entry.path().display()));
                        detailed_errors += 1;
                    }
                }
            }
        }
    }
    (copied, skipped)
}

fn find_winrar() -> Option<PathBuf> {
    [env_path("ProgramFiles"), env_path("ProgramFiles(x86)")]
        .into_iter()
        .flatten()
        .map(|root| root.join("WinRAR").join("WinRAR.exe"))
        .find(|path| path.is_file())
}

fn create_zip(stage: &Path, destination: &Path) -> Result<(), String> {
    let file = File::create(destination)
        .map_err(|error| format!("Не удалось создать ZIP-архив: {error}"))?;
    let mut archive = zip::ZipWriter::new(file);
    let file_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let directory_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o755);
    for entry in WalkDir::new(stage).follow_links(false).into_iter() {
        let entry = entry.map_err(|e| format!("Не удалось прочитать состав архива: {e}"))?;
        let Ok(relative) = entry.path().strip_prefix(stage) else {
            continue;
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let name = relative.to_string_lossy().replace('\\', "/");
        if entry.file_type().is_dir() {
            archive
                .add_directory(
                    format!("{}/", name.trim_end_matches('/')),
                    directory_options,
                )
                .map_err(|error| format!("Не удалось добавить папку в ZIP: {error}"))?;
        } else if entry.file_type().is_file() {
            archive
                .start_file(name, file_options)
                .map_err(|error| format!("Не удалось добавить файл в ZIP: {error}"))?;
            let mut source = File::open(entry.path()).map_err(|error| {
                format!("Не удалось прочитать {}: {error}", entry.path().display())
            })?;
            std::io::copy(&mut source, &mut archive)
                .map_err(|error| format!("Не удалось записать файл в ZIP: {error}"))?;
        }
    }
    archive
        .finish()
        .map(|_| ())
        .map_err(|error| format!("Не удалось завершить ZIP-архив: {error}"))
}

fn create_rar(stage: &Path, destination: &Path) -> Result<(), String> {
    let executable = find_winrar().ok_or_else(|| {
        "WinRAR не найден. Установите WinRAR или выберите формат ZIP.".to_string()
    })?;
    let source = stage.join("*");
    let mut command = Command::new(executable);
    command.args([
        OsStr::new("a"),
        OsStr::new("-r"),
        OsStr::new("-ep1"),
        OsStr::new("-idq"),
        destination.as_os_str(),
        source.as_os_str(),
    ]);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .map_err(|error| format!("Не удалось запустить WinRAR: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveOptions {
    #[serde(default)]
    manual: Vec<String>,
    #[serde(default)]
    excluded: Vec<String>,
}
fn save_options(app: &tauri::AppHandle) -> Result<SaveOptions, String> {
    crate::secure_state::get(app, "saveSources")?
        .map(|s| {
            serde_json::from_str(&s).map_err(|e| format!("Некорректные настройки сохранений: {e}"))
        })
        .unwrap_or_else(|| Ok(SaveOptions::default()))
}
fn allowed_with_options(path: &Path, options: &SaveOptions) -> bool {
    allowed_save_destination(path)
        || options
            .manual
            .iter()
            .any(|root| path_is_within(path, Path::new(root)))
}
fn scan_save_locations_with_options(app: &tauri::AppHandle) -> Result<Vec<SaveLocation>, String> {
    let options = save_options(app)?;
    let mut candidates = collect_candidates();
    for path in &options.manual {
        let path = PathBuf::from(path);
        add_candidate(
            &mut candidates,
            path.clone(),
            path.file_name().unwrap_or_default().to_string_lossy(),
            "Добавлено вручную",
        );
    }
    let mut locations = Vec::new();
    for candidate in candidates.values() {
        if options
            .excluded
            .iter()
            .any(|p| normalized_path(Path::new(p)) == normalized_path(&candidate.path))
        {
            continue;
        }
        let (file_count, total_bytes, modified_unix) = directory_stats(&candidate.path);
        locations.push(SaveLocation {
            id: format!("save-{:x}", stable_hash(&candidate.path)),
            label: candidate.label.clone(),
            category: candidate.category.clone(),
            path: candidate.path.display().to_string(),
            file_count,
            total_bytes,
            modified_unix,
        });
    }
    Ok(locations)
}
#[tauri::command]
pub async fn save_add_location(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = crate::native_dialog::pick_folder("Добавить папку сохранений", 0)?
        else {
            return Ok(None);
        };
        let canonical = crate::safe_path::root(Path::new(&path))?;
        if canonical.parent().is_none() {
            return Err("Нельзя добавлять весь диск".into());
        }
        let mut options = save_options(&app)?;
        let path = canonical.display().to_string();
        if !options.manual.contains(&path) {
            options.manual.push(path.clone());
        }
        options
            .excluded
            .retain(|p| normalized_path(Path::new(p)) != normalized_path(&canonical));
        crate::secure_state::set(
            &app,
            "saveSources",
            &serde_json::to_string(&options).map_err(|e| e.to_string())?,
        )?;
        Ok(Some(path))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn save_exclude_location(
    app: tauri::AppHandle,
    path: String,
    reset: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut options = save_options(&app)?;
        if reset {
            options.excluded.clear();
        } else {
            crate::safe_path::validate_absolute(Path::new(&path))?;
            if !options.excluded.contains(&path) {
                options.excluded.push(path);
            }
        }
        crate::secure_state::set(
            &app,
            "saveSources",
            &serde_json::to_string(&options).map_err(|e| e.to_string())?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePreview {
    files: Vec<String>,
    file_count: u64,
    total_bytes: u64,
    skipped: Vec<String>,
    truncated: bool,
}
fn source_preview(paths: &[String]) -> SavePreview {
    let mut preview = SavePreview {
        files: vec![],
        file_count: 0,
        total_bytes: 0,
        skipped: vec![],
        truncated: false,
    };
    for source in paths {
        let source = Path::new(source);
        for entry in WalkDir::new(source)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !ignored_save_entry(e))
        {
            match entry {
                Ok(entry) if entry.file_type().is_file() => {
                    if let Err(e) = crate::safe_path::child(source, entry.path()) {
                        preview.skipped.push(e);
                        continue;
                    }
                    match entry.metadata() {
                        Ok(meta) => {
                            preview.file_count += 1;
                            preview.total_bytes += meta.len();
                            if preview.files.len() < 5000 {
                                preview.files.push(entry.path().display().to_string());
                            } else {
                                preview.truncated = true;
                            }
                        }
                        Err(e) => preview.skipped.push(e.to_string()),
                    }
                }
                Ok(entry) if entry.file_type().is_symlink() => preview
                    .skipped
                    .push(format!("Ссылка пропущена: {}", entry.path().display())),
                Err(e) => preview.skipped.push(e.to_string()),
                _ => {}
            }
        }
    }
    preview
}
#[tauri::command]
pub async fn preview_save_backup(paths: Vec<String>) -> Result<SavePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if paths.is_empty() || paths.len() > 256 {
            return Err("Выберите от 1 до 256 папок".into());
        }
        Ok(source_preview(&paths))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn create_save_archive(
    app: tauri::AppHandle,
    paths: Vec<String>,
    destination: String,
    format: String,
) -> SaveArchiveResult {
    let mut resources = paths.iter().map(PathBuf::from).collect::<Vec<_>>();
    resources.push(PathBuf::from(&destination));
    match tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(&resources, "Архив сохранений", || {
            create_save_archive_blocking(&app, paths, destination, format)
        })
    })
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => SaveArchiveResult::error(e, vec![]),
        Err(e) => SaveArchiveResult::error(e.to_string(), vec![]),
    }
}
fn create_save_archive_blocking(
    app: &tauri::AppHandle,
    paths: Vec<String>,
    destination: String,
    format: String,
) -> SaveArchiveResult {
    let result = (|| -> Result<SaveArchiveResult, String> {
        if paths.is_empty() || paths.len() > 256 {
            return Err("Выберите от 1 до 256 папок".into());
        }
        let options = save_options(app)?;
        let format = match format.as_str() {
            "zip" => "zip",
            "rar" => "rar",
            _ => return Err("Неизвестный формат архива".into()),
        };
        let mut destination = PathBuf::from(destination);
        destination.set_extension(format);
        crate::safe_path::validate_absolute(&destination)?;
        let parent = destination.parent().ok_or("Некорректный путь архива")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let destination = crate::safe_path::child(parent, &destination)?;
        let stage = tempfile::tempdir().map_err(|e| e.to_string())?;
        let mut manifest = SaveManifest {
            schema_version: 1,
            created_unix: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            items: vec![],
        };
        let mut logs = Vec::new();
        let mut copied = 0;
        for (index, raw) in paths.iter().enumerate() {
            let source = PathBuf::from(raw);
            if !allowed_with_options(&source, &options) {
                return Err(format!(
                    "Папка не разрешена. Добавьте её вручную: {}",
                    source.display()
                ));
            }
            crate::safe_path::root(&source)?;
            if path_is_within(&destination, &source) {
                return Err("Нельзя сохранять архив внутри его источника".into());
            }
            let folder = safe_folder_name(
                source.file_name().unwrap_or_else(|| OsStr::new("Saves")),
                index,
            );
            let target = stage.path().join(&folder);
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            for entry in WalkDir::new(&source)
                .follow_links(false)
                .into_iter()
                .filter_entry(|e| !ignored_save_entry(e))
            {
                let entry = entry.map_err(|e| format!("Архив не заменён: {e}"))?;
                if entry.path() == source {
                    continue;
                }
                let rel = entry
                    .path()
                    .strip_prefix(&source)
                    .map_err(|e| e.to_string())?;
                crate::safe_path::child(&source, entry.path())?;
                let dest = crate::safe_path::join(&target, &rel.to_string_lossy())?;
                let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
                if crate::safe_path::is_link(&metadata) {
                    return Err(format!("Ссылка в источнике: {}", entry.path().display()));
                }
                if metadata.is_dir() {
                    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
                } else if metadata.is_file() {
                    crate::durable::copy(entry.path(), &dest)?;
                    copied += 1;
                } else {
                    return Err("Специальный файл в папке сохранений".into());
                }
            }
            manifest.items.push(SaveManifestItem {
                folder,
                target: portable_path(&source),
            });
        }
        if copied == 0 {
            return Err("Файлы сохранений не найдены".into());
        }
        fs::write(
            stage.path().join(SAVE_MANIFEST_NAME),
            serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let output = tempfile::Builder::new()
            .prefix(".eclipse-save-")
            .suffix(&format!(".{format}"))
            .tempfile_in(parent)
            .map_err(|e| e.to_string())?;
        // Закрываем временный дескриптор до WinRAR/DeleteFile и атомарного rename.
        // На Windows удалённое, но всё ещё открытое имя может оставаться delete-pending.
        let output_path = output.path().to_path_buf();
        let _output_cleanup = output.into_temp_path();
        if format == "rar" {
            fs::remove_file(&output_path).map_err(|e| e.to_string())?;
            create_rar(stage.path(), &output_path)?;
        } else {
            create_zip(stage.path(), &output_path)?;
        }
        let verify = tempfile::tempdir().map_err(|e| e.to_string())?;
        crate::archive_policy::extract(&output_path, verify.path(), None)?;
        for entry in WalkDir::new(stage.path()) {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().is_file() {
                let other = verify.path().join(
                    entry
                        .path()
                        .strip_prefix(stage.path())
                        .map_err(|e| e.to_string())?,
                );
                if crate::durable::hash_file(entry.path())? != crate::durable::hash_file(&other)? {
                    return Err(
                        "Архив не прошёл проверку содержимого; прежний архив сохранён".into(),
                    );
                }
            }
        }
        File::open(&output_path)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        crate::durable::replace(&output_path, &destination)?;
        logs.push(format!("Проверено файлов: {copied}"));
        logs.push("SHA-256 содержимого архива совпадает с подготовленной копией".into());
        Ok(SaveArchiveResult {
            success: true,
            status: "success".into(),
            skipped: vec![],
            copied_files: copied,
            backup_path: None,
            message: format!("Архив создан и проверен: {}", destination.display()),
            logs,
            archive_path: Some(destination.display().to_string()),
        })
    })();
    result.unwrap_or_else(|e| {
        SaveArchiveResult::error(
            e,
            vec!["Предыдущий архив не удалён; исходные сохранения не изменялись".into()],
        )
    })
}

fn remap_legacy_path(value: &str) -> Option<PathBuf> {
    let original = PathBuf::from(value);
    if allowed_save_destination(&original) {
        return Some(original);
    }
    let normalized = value.replace('/', "\\");
    let mappings = [
        ("\\AppData\\Roaming\\", "APPDATA"),
        ("\\AppData\\Local\\", "LOCALAPPDATA"),
        ("\\Documents\\My Games\\", "USERPROFILE"),
        ("\\Documents\\SavedGames\\", "USERPROFILE"),
        ("\\Saved Games\\", "USERPROFILE"),
    ];
    for (marker, env) in mappings {
        let lower = normalized.to_lowercase();
        let marker_lower = marker.to_lowercase();
        let Some(position) = lower.find(&marker_lower) else {
            continue;
        };
        let suffix = &normalized[position + marker.len()..];
        let base = env_path(env)?;
        let target = match marker {
            "\\Documents\\My Games\\" => base.join("Documents").join("My Games").join(suffix),
            "\\Documents\\SavedGames\\" => base.join("Documents").join("SavedGames").join(suffix),
            "\\Saved Games\\" => base.join("Saved Games").join(suffix),
            _ => base.join(suffix),
        };
        if allowed_save_destination(&target) {
            return Some(target);
        }
    }
    let local_low_marker = "\\AppData\\LocalLow\\";
    let lower = normalized.to_lowercase();
    if let Some(position) = lower.find(&local_low_marker.to_lowercase()) {
        let suffix = &normalized[position + local_low_marker.len()..];
        if let Some(local) = env_path("LOCALAPPDATA") {
            if let Some(app_data) = local.parent() {
                let target = app_data.join("LocalLow").join(suffix);
                if allowed_save_destination(&target) {
                    return Some(target);
                }
            }
        }
    }
    None
}

fn load_restore_manifest(stage: &Path) -> Result<Vec<SaveManifestItem>, String> {
    let json_path = stage.join(SAVE_MANIFEST_NAME);
    if json_path.is_file() {
        let data = fs::read(&json_path)
            .map_err(|error| format!("Не удалось прочитать карту сохранений: {error}"))?;
        let manifest: SaveManifest = serde_json::from_slice(&data)
            .map_err(|error| format!("Карта сохранений повреждена: {error}"))?;
        if manifest.schema_version != 1 || manifest.items.is_empty() || manifest.items.len() > 256 {
            return Err("Версия или содержимое карты сохранений не поддерживается".into());
        }
        validate_manifest_items(&manifest.items)?;
        return Ok(manifest.items);
    }

    let legacy = fs::read_to_string(stage.join("backup-info.txt")).map_err(|_| {
        "Это не архив Crocodile Gena Studio: карта исходных папок не найдена".to_string()
    })?;
    let items = legacy
        .lines()
        .filter_map(|line| line.split_once(" = "))
        .map(|(folder, target)| SaveManifestItem {
            folder: folder.trim().to_string(),
            target: target.trim().to_string(),
        })
        .collect::<Vec<_>>();
    if items.is_empty() || items.len() > 256 {
        Err("В старом архиве не найдены сведения об исходных папках".into())
    } else {
        validate_manifest_items(&items)?;
        Ok(items)
    }
}

fn valid_manifest_folder(value: &str) -> bool {
    crate::safe_path::validate_component(value).is_ok()
        && !value.eq_ignore_ascii_case(SAVE_MANIFEST_NAME)
        && !value.eq_ignore_ascii_case("backup-info.txt")
}
fn validate_manifest_items(items: &[SaveManifestItem]) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for item in items {
        if !valid_manifest_folder(&item.folder)
            || !seen.insert(item.folder.to_lowercase())
            || item.target.len() > 32_000
        {
            return Err("Небезопасная или повторяющаяся запись манифеста сохранений".into());
        }
    }
    Ok(())
}

struct RestorePlan {
    source: PathBuf,
    target: PathBuf,
    folder: String,
}
fn restore_plan(stage: &Path, options: &SaveOptions) -> Result<Vec<RestorePlan>, String> {
    let items = load_restore_manifest(stage)?;
    validate_manifest_items(&items)?;
    let mut plan: Vec<RestorePlan> = Vec::new();
    for item in items {
        let source = crate::safe_path::join(stage, &item.folder)?;
        if !source.is_dir() {
            return Err(format!("Папка отсутствует в архиве: {}", item.folder));
        }
        let target = expand_portable_path(&item.target)
            .filter(|p| allowed_with_options(p, options))
            .or_else(|| remap_legacy_path(&item.target))
            .ok_or_else(|| format!("Неразрешённый путь в манифесте: {}", item.target))?;
        if plan.iter().any(|p| {
            path_is_within(&target, &p.target)
                || path_is_within(&p.target, &target)
                || normalized_path(&target) == normalized_path(&p.target)
        }) {
            return Err("Пересекающиеся назначения в манифесте".into());
        }
        for entry in WalkDir::new(&source).follow_links(false) {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.path() != source {
                crate::safe_path::child(&source, entry.path())?;
            }
        }
        plan.push(RestorePlan {
            source,
            target,
            folder: item.folder,
        });
    }
    Ok(plan)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rollback {
    version: u32,
    applied: bool,
    files: Vec<RollbackFile>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RollbackFile {
    root: String,
    relative: String,
    backup: Option<String>,
    original_hash: Option<String>,
    installed_hash: String,
}
fn rollback_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    crate::safe_path::join(&base, "save-rollback")
}
fn make_target(root: &Path, relative: &str) -> Result<PathBuf, String> {
    crate::safe_path::relative(relative)?;
    crate::safe_path::validate_absolute(root)?;
    if !root.exists() {
        let mut existing = root;
        while !existing.exists() {
            existing = existing.parent().ok_or("Не найден корень назначения")?;
        }
        let path = crate::safe_path::child(existing, root)?;
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    crate::safe_path::join(root, relative)
}
#[tauri::command]
pub async fn inspect_save_archive(
    app: tauri::AppHandle,
    archive: String,
) -> Result<SavePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stage = tempfile::tempdir().map_err(|e| e.to_string())?;
        crate::archive_policy::extract(Path::new(&archive), stage.path(), None)?;
        let plan = restore_plan(stage.path(), &save_options(&app)?)?;
        let mut preview = source_preview(
            &plan
                .iter()
                .map(|p| p.source.display().to_string())
                .collect::<Vec<_>>(),
        );
        preview.files = plan
            .iter()
            .map(|p| format!("{} → {}", p.folder, p.target.display()))
            .collect();
        Ok(preview)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn restore_save_archive(app: tauri::AppHandle, archive: String) -> SaveArchiveResult {
    match tauri::async_runtime::spawn_blocking(move || restore_save_archive_blocking(&app, archive))
        .await
    {
        Ok(result) => result,
        Err(e) => SaveArchiveResult::error(e.to_string(), vec![]),
    }
}
fn restore_save_archive_blocking(app: &tauri::AppHandle, archive: String) -> SaveArchiveResult {
    let result = (|| -> Result<SaveArchiveResult, String> {
        let stage = tempfile::tempdir().map_err(|e| e.to_string())?;
        crate::archive_policy::extract(Path::new(&archive), stage.path(), None)?;
        let plan = restore_plan(stage.path(), &save_options(app)?)?;
        let backup = rollback_dir(app)?;
        let mut resources = plan.iter().map(|p| p.target.clone()).collect::<Vec<_>>();
        resources.push(backup.clone());
        resources.push(PathBuf::from(&archive));
        crate::jobs::run(
            &resources,
            "Восстановление сохранений",
            || -> Result<SaveArchiveResult, String> {
                if backup.exists() {
                    return Err("Есть резервная копия предыдущего восстановления. Сначала верните прежнее состояние или явно удалите резервную копию.".into());
                }
                let parent = backup.parent().ok_or("Не найдена папка данных")?;
                let backup_stage = tempfile::Builder::new()
                    .prefix(".save-rollback-")
                    .tempdir_in(parent)
                    .map_err(|e| e.to_string())?;
                let mut snapshot = Rollback {
                    version: 1,
                    applied: false,
                    files: vec![],
                };
                let mut copies = Vec::new();
                // Сначала защищаем все оригиналы. До фиксации снимка ни один файл не меняется.
                for item in &plan {
                    for entry in WalkDir::new(&item.source).follow_links(false) {
                        let entry = entry.map_err(|e| e.to_string())?;
                        if !entry.file_type().is_file() {
                            continue;
                        }
                        let relative = entry
                            .path()
                            .strip_prefix(&item.source)
                            .map_err(|e| e.to_string())?
                            .to_string_lossy()
                            .replace('\\', "/");
                        let target = make_target(&item.target, &relative)?;
                        let (saved, original_hash) = if target.exists() {
                            if !target.is_file() {
                                return Err("Файл назначения заменён каталогом".into());
                            }
                            let saved = format!("originals/{}/{}", item.folder, relative);
                            let saved_path = crate::safe_path::join(backup_stage.path(), &saved)?;
                            crate::durable::copy(&target, &saved_path)?;
                            (Some(saved), Some(crate::durable::hash_file(&saved_path)?))
                        } else {
                            (None, None)
                        };
                        snapshot.files.push(RollbackFile {
                            root: item.target.display().to_string(),
                            relative,
                            backup: saved,
                            original_hash,
                            installed_hash: crate::durable::hash_file(entry.path())?,
                        });
                        copies.push((entry.path().to_path_buf(), target));
                    }
                }
                if copies.is_empty() {
                    return Err("В архиве нет файлов сохранений".into());
                }
                crate::durable::write(
                    &backup_stage.path().join("rollback.dpapi"),
                    &crate::secure_state::crypt(
                        &serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?,
                        true,
                    )?,
                )?;
                fs::rename(backup_stage.path(), &backup)
                    .map_err(|e| format!("Не удалось зафиксировать резервную копию: {e}"))?;
                let mut copied = 0;
                let mut skipped = Vec::new();
                for (source, target) in copies {
                    let root = snapshot.files[copied as usize + skipped.len()].root.clone();
                    let checked = crate::safe_path::child(Path::new(&root), &target)
                        .and_then(|target| crate::durable::copy(&source, &target));
                    match checked {
                        Ok(()) => copied += 1,
                        Err(e) => skipped.push(format!("{}: {e}", target.display())),
                    }
                }
                let success = skipped.is_empty();
                let status = if success {
                    "success"
                } else if copied > 0 {
                    "partial"
                } else {
                    "failed"
                };
                Ok(SaveArchiveResult {
                    success,
                    status: status.into(),
                    skipped: skipped.clone(),
                    copied_files: copied,
                    backup_path: Some(backup.display().to_string()),
                    message: if success {
                        format!("Восстановлено и проверено файлов: {copied}")
                    } else {
                        format!("Выполнено частично: восстановлено {copied}, пропущено {}. Доступен возврат прежнего состояния.", skipped.len())
                    },
                    logs: skipped,
                    archive_path: Some(archive.clone()),
                })
            },
        )?
    })();
    result.unwrap_or_else(|e| SaveArchiveResult::error(e, vec![]))
}
#[tauri::command]
pub async fn save_undo_restore(app: tauri::AppHandle) -> SaveArchiveResult {
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<SaveArchiveResult, String> {
            let backup = rollback_dir(&app)?;
            let file = crate::safe_path::join(&backup, "rollback.dpapi")?;
            let mut snapshot: Rollback = serde_json::from_slice(&crate::secure_state::crypt(
                &fs::read(file).map_err(|e| e.to_string())?,
                false,
            )?)
            .map_err(|e| e.to_string())?;
            if snapshot.version != 1 || snapshot.applied || snapshot.files.len() > MAX_RESTORE_FILES
            {
                return Err("Снимок не поддерживается или уже применён".into());
            }
            let options = save_options(&app)?;
            let mut resources = vec![backup.clone()];
            // Проверяем все записи и хеши до первого изменения.
            for item in &snapshot.files {
                let root = Path::new(&item.root);
                if !allowed_with_options(root, &options) {
                    return Err("Неразрешённый путь в снимке отката".into());
                }
                crate::safe_path::relative(&item.relative)?;
                resources.push(root.to_path_buf());
                if let Some(saved) = &item.backup {
                    let path = crate::safe_path::join(&backup, saved)?;
                    if Some(crate::durable::hash_file(&path)?) != item.original_hash {
                        return Err("Повреждён оригинал в снимке отката".into());
                    }
                }
            }
            crate::jobs::run(
                &resources,
                "Вернуть сохранения как было",
                || -> Result<SaveArchiveResult, String> {
                    let mut skipped = Vec::new();
                    let mut copied = 0;
                    for (index, item) in snapshot.files.iter().enumerate() {
                        let result = (|| -> Result<(), String> {
                            let target = make_target(Path::new(&item.root), &item.relative)?;
                            if target.exists() {
                                let safety = backup.join("before-undo").join(index.to_string());
                                crate::durable::copy(&target, &safety)?;
                            }
                            if let Some(saved) = &item.backup {
                                crate::durable::copy(
                                    &crate::safe_path::join(&backup, saved)?,
                                    &target,
                                )
                            } else if target.exists() {
                                if crate::durable::hash_file(&target)? != item.installed_hash {
                                    Err("Файл изменился после восстановления; удаление пропущено"
                                        .into())
                                } else {
                                    fs::remove_file(&target).map_err(|e| e.to_string())
                                }
                            } else {
                                Ok(())
                            }
                        })();
                        match result {
                            Ok(()) => copied += 1,
                            Err(e) => skipped.push(format!("{}/{}: {e}", item.root, item.relative)),
                        }
                    }
                    let success = skipped.is_empty();
                    if success {
                        snapshot.applied = true;
                        crate::durable::write(
                            &backup.join("rollback.dpapi"),
                            &crate::secure_state::crypt(
                                &serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?,
                                true,
                            )?,
                        )?;
                    }
                    Ok(SaveArchiveResult {
                        success,
                        status: if success { "success" } else { "partial" }.into(),
                        skipped: skipped.clone(),
                        copied_files: copied,
                        backup_path: Some(backup.display().to_string()),
                        message: if success {
                            "Предыдущее состояние файлов возвращено и проверено".into()
                        } else {
                            "Возврат выполнен частично; резервная копия сохранена".into()
                        },
                        logs: skipped,
                        archive_path: None,
                    })
                },
            )?
        })
        .await;
    match result {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => SaveArchiveResult::error(e, vec![]),
        Err(e) => SaveArchiveResult::error(e.to_string(), vec![]),
    }
}
#[tauri::command]
pub async fn save_discard_restore_backup(
    app: tauri::AppHandle,
    confirmed: bool,
) -> Result<(), String> {
    if !confirmed {
        return Err("Требуется явное подтверждение удаления резервной копии".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let backup = rollback_dir(&app)?;
        crate::jobs::run(
            std::slice::from_ref(&backup),
            "Удалить резервную копию отката",
            || fs::remove_dir_all(&backup).map_err(|e| e.to_string()),
        )?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "cgs-save-test-{label}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn calculates_save_directory_stats() {
        let directory = test_directory("stats");
        fs::create_dir_all(directory.join("slot1")).unwrap();
        fs::write(directory.join("slot1").join("save.dat"), b"12345").unwrap();
        fs::write(directory.join("profile.json"), b"1234567").unwrap();

        let (files, bytes, modified) = directory_stats(&directory);
        assert_eq!(files, 2);
        assert_eq!(bytes, 12);
        assert!(modified.is_some());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn excludes_service_caches_from_stats_and_backup() {
        let directory = test_directory("cache-filter");
        let source = directory.join("Game");
        let target = directory.join("Backup");
        let cache = source.join("PlatformProcess").join("component_crx_cache");
        fs::create_dir_all(source.join("Saves")).unwrap();
        fs::create_dir_all(&cache).unwrap();
        fs::write(source.join("Saves").join("slot.sav"), b"progress").unwrap();
        fs::write(cache.join("service-cache.bin"), b"not a save").unwrap();

        let (files, bytes, _) = directory_stats(&source);
        assert_eq!(files, 1);
        assert_eq!(bytes, 8);
        let mut logs = Vec::new();
        let (copied, skipped) = copy_save_directory(&source, &target, &mut logs);
        assert_eq!(copied, 1);
        assert_eq!(skipped, 0);
        assert!(target.join("Saves").join("slot.sav").is_file());
        assert!(!target.join("PlatformProcess").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn creates_zip_archive_from_staging_directory() {
        let directory = test_directory("zip");
        let stage = directory.join("stage");
        let archive = directory.join("saves.zip");
        fs::create_dir_all(stage.join("Game")).unwrap();
        fs::write(stage.join("Game").join("save.dat"), b"game progress").unwrap();

        create_zip(&stage, &archive).unwrap();
        assert!(archive.is_file());
        assert!(fs::metadata(&archive).unwrap().len() > 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn portable_paths_follow_the_current_windows_profile() {
        let local = env_path("LOCALAPPDATA").unwrap();
        let original = local.join("ExampleGame").join("Saved").join("SaveGames");
        let encoded = portable_path(&original);
        assert!(encoded.starts_with("{LOCALAPPDATA}"));
        assert_eq!(expand_portable_path(&encoded).unwrap(), original);
    }

    #[test]
    fn restore_targets_are_checked_before_creation() {
        let directory = test_directory("restore-safe-target");
        let target = directory.join("New/Game");
        assert!(make_target(&target, "../outside.sav").is_err());
        assert!(!directory.join("outside.sav").exists());
        let path = make_target(&target, "slot/save.dat").unwrap();
        assert!(path.starts_with(fs::canonicalize(&directory).unwrap()));
        fs::remove_dir_all(directory).unwrap();
    }
}
