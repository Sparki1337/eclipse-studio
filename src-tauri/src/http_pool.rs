//! Общий пул HTTP-клиентов и многопоточный планировщик задач.
use reqwest::blocking::Client;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        OnceLock,
    },
    time::Duration,
};

const DEFAULT_UA: &str = concat!("Eclipse-Studio/", env!("CARGO_PKG_VERSION"));

static SHARED_CLIENT: OnceLock<Client> = OnceLock::new();
static NO_REDIRECT_CLIENT: OnceLock<Client> = OnceLock::new();
static BROWSER_UA_CLIENT: OnceLock<Client> = OnceLock::new();

fn build_client(
    follow_redirects: bool,
    user_agent: &str,
    timeout_secs: u64,
) -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(timeout_secs));
    if !follow_redirects {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    } else {
        builder = builder.redirect(reqwest::redirect::Policy::limited(8));
    }
    builder
        .build()
        .map_err(|e| format!("Ошибка инициализации HTTP-клиента: {e}"))
}

/// Возвращает переиспользуемый HTTP-клиент с общим пулом соединений и TLS-сессий.
pub(crate) fn client() -> Result<&'static Client, String> {
    if let Some(c) = SHARED_CLIENT.get() {
        return Ok(c);
    }
    let created = build_client(true, DEFAULT_UA, 25)?;
    let _ = SHARED_CLIENT.set(created);
    Ok(SHARED_CLIENT.get().expect("SHARED_CLIENT инициализирован"))
}

/// Возвращает общий HTTP-клиент без автоматических редиректов.
pub(crate) fn no_redirect_client() -> Result<&'static Client, String> {
    if let Some(c) = NO_REDIRECT_CLIENT.get() {
        return Ok(c);
    }
    let created = build_client(false, DEFAULT_UA, 25)?;
    let _ = NO_REDIRECT_CLIENT.set(created);
    Ok(NO_REDIRECT_CLIENT
        .get()
        .expect("NO_REDIRECT_CLIENT инициализирован"))
}

/// Возвращает общий HTTP-клиент с браузерным User-Agent (для CDN/Steam/генераторов).
pub(crate) fn browser_client() -> Result<&'static Client, String> {
    if let Some(c) = BROWSER_UA_CLIENT.get() {
        return Ok(c);
    }
    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    let created = build_client(true, ua, 25)?;
    let _ = BROWSER_UA_CLIENT.set(created);
    Ok(BROWSER_UA_CLIENT
        .get()
        .expect("BROWSER_UA_CLIENT инициализирован"))
}

/// Определяет оптимальное число потоков для параллельной работы.
pub(crate) fn worker_count(items_len: usize, cap: usize) -> usize {
    if items_len <= 1 {
        return items_len;
    }
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    items_len.min(cpus.max(2)).min(cap.max(1))
}

/// Выполняет отображение среза в многопоточном режиме с сохранением исходного порядка элементов.
pub(crate) fn parallel_map<T, R, F>(items: &[T], max_workers: usize, op: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync,
{
    if items.is_empty() {
        return Vec::new();
    }
    let workers = worker_count(items.len(), max_workers);
    if workers <= 1 {
        return items.iter().map(&op).collect();
    }

    let next = AtomicUsize::new(0);
    let mut slots: Vec<Option<R>> = (0..items.len()).map(|_| None).collect();
    let slot_ptrs: Vec<std::sync::Mutex<Option<R>>> =
        slots.drain(..).map(std::sync::Mutex::new).collect();

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let idx = next.fetch_add(1, Ordering::Relaxed);
                if idx >= items.len() {
                    break;
                }
                let value = op(&items[idx]);
                if let Ok(mut guard) = slot_ptrs[idx].lock() {
                    *guard = Some(value);
                }
            });
        }
    });

    slot_ptrs
        .into_iter()
        .map(|slot| {
            slot.into_inner()
                .expect("слот результата")
                .expect("результат")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parallel_map_preserves_order_and_computes_all() {
        let input: Vec<usize> = (0..64).collect();
        let output = parallel_map(&input, 8, |v| v * 3 + 1);
        let expected: Vec<usize> = input.iter().map(|v| v * 3 + 1).collect();
        assert_eq!(output, expected);
    }

    #[test]
    fn shared_clients_initialize_without_error() {
        assert!(client().is_ok());
        assert!(no_redirect_client().is_ok());
        assert!(browser_client().is_ok());
    }
}
