//! Журнал Eclipse-HV: файл (всегда), консоль отладки (`--debug`) и кольцевой буфер для отчёта.

use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::sys;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Trace => "TRACE",
            Level::Debug => "DEBUG",
            Level::Info => "INFO ",
            Level::Warn => "WARN ",
            Level::Error => "ERROR",
        }
    }
}

/// Количество записей, удерживаемых в кольцевом буфере памяти.
const RING_CAPACITY: usize = 512;

/// Размер файла журнала, при превышении которого выполняется ротация.
const ROTATE_SIZE: u64 = 512 * 1024;

struct LoggerState {
    file: Option<File>,
    path: Option<PathBuf>,
    console: bool,
    ring: VecDeque<String>,
}

/// Глобальное состояние журнала. Инициализируется один раз при старте.
static LOGGER: Mutex<Option<LoggerState>> = Mutex::new(None);

fn open_log(path: &Path) -> Option<File> {
    // Ротация: старый журнал переименовывается в .old, новый начинается с нуля
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > ROTATE_SIZE {
            let old = path.with_extension("log.old");
            let _ = fs::remove_file(&old);
            let _ = fs::rename(path, &old);
        }
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

/// При недоступности каталога — во временную папку; повторный вызов игнорируется.
pub fn init(directory: &Path) {
    let mut guard = LOGGER.lock().expect("журнал: повреждён мьютекс инициализации");
    if guard.is_some() {
        return;
    }

    let primary = directory.join("Eclipse-HV.log");
    let (file, path) = match open_log(&primary) {
        Some(file) => (Some(file), primary),
        None => {
            // Резервный вариант: %TEMP%\Eclipse-HV\Eclipse-HV.log
            let fallback_dir = std::env::temp_dir().join("Eclipse-HV");
            let _ = fs::create_dir_all(&fallback_dir);
            let fallback = fallback_dir.join("Eclipse-HV.log");
            (open_log(&fallback), fallback)
        }
    };

    let state = LoggerState {
        file,
        path: Some(path),
        console: false,
        ring: VecDeque::new(),
    };
    *guard = Some(state);
    drop(guard);

    // Заголовок сессии: версия, дата запуска
    log(
        Level::Info,
        "журнал",
        &format!(
            "============================================================\n\
             Eclipse-HV v{} — запуск сессии {}\n\
             ============================================================",
            env!("CARGO_PKG_VERSION"),
            sys::timestamp()
        ),
    );
}

pub fn enable_console() {
    if let Some(state) = LOGGER.lock().expect("журнал: повреждён мьютекс консоли").as_mut() {
        state.console = true;
    }
}

/// Записывает событие во все активные приёмники.
pub fn log(level: Level, category: &str, message: &str) {
    let line = format!(
        "[{}] [{}] [{}] {}",
        sys::timestamp(),
        level.label(),
        category,
        message
    );

    let mut guard = LOGGER.lock().expect("журнал: повреждён мьютекс записи");
    if let Some(state) = guard.as_mut() {
        if let Some(file) = state.file.as_mut() {
            let _ = writeln!(file, "{line}");
            let _ = file.flush();
        }
        state.ring.push_back(line.clone());
        while state.ring.len() > RING_CAPACITY {
            state.ring.pop_front();
        }
        if state.console && level != Level::Trace {
            println!("{line}");
        }
    }
}

pub fn snapshot() -> Vec<String> {
    LOGGER
        .lock()
        .expect("журнал: повреждён мьютекс снимка")
        .as_ref()
        .map(|state| state.ring.iter().cloned().collect())
        .unwrap_or_default()
}

pub fn path() -> Option<PathBuf> {
    LOGGER
        .lock()
        .expect("журнал: повреждён мьютекс пути")
        .as_ref()
        .and_then(|state| state.path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn журнал_пишет_записи_ограничивает_буфер_и_отдаёт_путь() {
        // Каталог внутри target/ crate: запись гарантированно разрешена
        let dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("target")
            .join("eclipse-hv-tests")
            .join("logging");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Инициализация, первая запись и заголовок сессии
        init(&dir);
        log(Level::Info, "тест", "пробная строка журнала");
        enable_console();

        let records = snapshot();
        assert!(records.iter().any(|line| line.contains("пробная строка журнала")));
        assert!(records.iter().any(|line| line.contains("запуск сессии")));

        let path = path().expect("путь журнала должен быть определён");
        let content = fs::read_to_string(&path).unwrap_or_default();
        assert!(content.contains("пробная строка журнала"));

        // Кольцевой буфер не превышает лимит при массовом записи
        for index in 0..(RING_CAPACITY + 64) {
            log(Level::Trace, "тест", &format!("запись {index}"));
        }
        assert!(snapshot().len() <= RING_CAPACITY);

        let _ = fs::remove_dir_all(&dir);
    }
}
