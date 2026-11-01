//! Журнал заданий переживает перезапуск: незавершённые операции не превращаются в успех.
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub label: String,
    pub resources: Vec<String>,
    pub status: String,
    pub started_unix: u64,
    pub finished_unix: Option<u64>,
}
#[derive(Default)]
struct Journal {
    path: Option<PathBuf>,
    jobs: Vec<Job>,
}
static JOURNAL: OnceLock<Mutex<Journal>> = OnceLock::new();
fn journal() -> &'static Mutex<Journal> {
    JOURNAL.get_or_init(|| Mutex::new(Journal::default()))
}
fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn persist(journal: &Journal) -> Result<(), String> {
    if let Some(path) = &journal.path {
        crate::durable::write(
            path,
            &serde_json::to_vec_pretty(&journal.jobs).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(())
}
static INSTANCE: OnceLock<std::fs::File> = OnceLock::new();
pub fn init(app: &AppHandle) -> Result<(), String> {
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    if INSTANCE.get().is_none() {
        let instance_path = crate::safe_path::join(&base, "instance.lock")?;
        let instance = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(instance_path)
            .map_err(|e| e.to_string())?;
        let handoff = std::env::args().any(|arg| arg == "--elevated-handoff");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            match instance.try_lock() {
                Ok(()) => break,
                Err(_) if handoff && std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(error) => return Err(format!("Eclipse Studio уже запущен или блокировка недоступна: {error}. Закройте вторую копию перед изменением файлов.")),
            }
        }
        INSTANCE
            .set(instance)
            .map_err(|_| "Ошибка блокировки экземпляра")?;
    }
    let path = crate::safe_path::join(&base, "jobs.json")?;
    let jobs = match std::fs::read(&path) {
        Ok(data) => serde_json::from_slice::<Vec<Job>>(&data)
            .map_err(|e| format!("Журнал заданий повреждён: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.to_string()),
    };
    let mut journal = journal().lock().map_err(|_| "Журнал занят")?;
    journal.path = Some(path);
    journal.jobs = jobs;
    for job in &mut journal.jobs {
        if job.status == "running" {
            job.status = "interrupted".into();
            job.finished_unix = Some(stamp());
        }
    }
    persist(&journal)
}
fn outcome(value: &serde_json::Value) -> &'static str {
    if let Some(error) = value.get("Err").and_then(|v| v.as_str()) {
        if error.contains("приостановлена") {
            return "paused";
        }
        if error.contains("отменена") {
            return "cancelled";
        }
        return "failed";
    }
    if let Some(value) = value.get("Ok") {
        return outcome(value);
    }
    if let Some(status) = value.get("status").and_then(|v| v.as_str()) {
        if status == "partial" {
            return "partial";
        }
    }
    if value.get("success").and_then(|v| v.as_bool()) == Some(false) {
        if ["changed", "removed", "copiedFiles"]
            .iter()
            .any(|k| value.get(k).and_then(|v| v.as_u64()).unwrap_or(0) > 0)
            || value
                .get("addedAppids")
                .and_then(|v| v.as_array())
                .is_some_and(|v| !v.is_empty())
            || value
                .get("installedFiles")
                .and_then(|v| v.as_array())
                .is_some_and(|v| !v.is_empty())
        {
            return "partial";
        }
        return "failed";
    }
    "success"
}
pub fn run<T: Serialize>(
    resources: &[PathBuf],
    label: &str,
    action: impl FnOnce() -> T,
) -> Result<T, String> {
    let guard = crate::resource_lock::Guard::scope(resources)?;
    {
        let mut journal = journal().lock().map_err(|_| "Журнал занят")?;
        journal.jobs.push(Job {
            id: guard.id.clone(),
            label: label.into(),
            resources: resources.iter().map(|p| p.display().to_string()).collect(),
            status: "running".into(),
            started_unix: stamp(),
            finished_unix: None,
        });
        persist(&journal)?;
    }
    let result = action();
    {
        let mut journal = journal().lock().map_err(|_| "Журнал занят")?;
        if let Some(job) = journal.jobs.iter_mut().find(|j| j.id == guard.id) {
            job.status = outcome(&serde_json::to_value(&result).map_err(|e| e.to_string())?).into();
            job.finished_unix = Some(stamp());
        }
        if journal.jobs.len() > 500 {
            let excess = journal.jobs.len() - 500;
            journal.jobs.drain(..excess);
        }
        persist(&journal)
            .map_err(|e| format!("Операция завершилась, но журнал не сохранён: {e}"))?;
    }
    Ok(result)
}
pub fn system_resource(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("windows-system.lock")
}
#[tauri::command]
pub fn jobs_list() -> Result<Vec<Job>, String> {
    Ok(journal()
        .lock()
        .map_err(|_| "Журнал занят")?
        .jobs
        .iter()
        .rev()
        .cloned()
        .collect())
}
