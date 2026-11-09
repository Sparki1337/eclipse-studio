//! Утилиты запуска внешних процессов; служебные запуски — без окна консоли.

use std::{
    path::Path,
    process::Command,
    thread,
    time::{Duration, Instant},
};

use std::os::windows::process::CommandExt;

use crate::hvlog;

/// Флаг создания процесса без отдельного окна консоли.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn run_capture(program: impl AsRef<Path>, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new(program.as_ref());
    command.args(args);
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .output()
        .map_err(|err| format!("не удалось запустить {}: {err}", program.as_ref().display()))
}

/// Зависший процесс не задержит лаунчер: по истечении срока — ошибка.
pub fn run_capture_timeout(
    program: impl AsRef<Path>,
    args: &[&str],
    timeout_ms: u64,
) -> Result<std::process::Output, String> {
    let program = program.as_ref().to_path_buf();
    let display = program.display().to_string();
    let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let (sender, receiver) = std::sync::mpsc::channel();

    // Запуск в отдельном потоке: основной поток ждёт результат не дольше срока
    let spawned = program.clone();
    thread::spawn(move || {
        let refs: Vec<&str> = owned.iter().map(|value| value.as_str()).collect();
        let _ = sender.send(run_capture(&spawned, &refs));
    });

    match receiver.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(result) => result,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("не дождались завершения {display} за {timeout_ms} мс"))
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("поток запуска процесса завершился без результата".to_string())
        }
    }
}

pub fn process_is_running(image_name: &str) -> bool {
    let filter = format!("IMAGENAME eq {image_name}");
    let output = run_capture("tasklist.exe", &["/FI", &filter, "/NH"]);
    output.is_ok_and(|out| {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let target = image_name.to_lowercase();
        stdout.lines().any(|line| line.trim().to_lowercase().starts_with(&target))
    })
}

pub fn terminate_process_and_wait(image_name: &str, max_wait_ms: u64) {
    hvlog!(Debug, "процессы", "завершение {image_name} (ожидание до {max_wait_ms} мс)");
    let _ = run_capture("taskkill.exe", &["/IM", image_name, "/F"]);

    let started = Instant::now();
    while started.elapsed().as_millis() < max_wait_ms as u128 {
        if !process_is_running(image_name) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    hvlog!(Warn, "процессы", "{image_name} не завершился за отведённое время");
}

pub fn spawn_detached(program: impl AsRef<Path>) -> Result<(), String> {
    let mut command = Command::new(program.as_ref());
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("не удалось запустить {}: {err}", program.as_ref().display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn проверка_отсутствия_несуществующего_процесса() {
        // Положительную проверку на живых процессах в изолированной среде не выполнить
        assert!(!process_is_running("eclipse-hv-test-несуществующий.exe"));
    }

    #[test]
    fn запуск_с_ограничением_времени_возвращает_вывод() {
        let output = run_capture_timeout("cmd.exe", &["/C", "echo ok"], 20_000)
            .expect("короткий процесс должен уложиться в срок");
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(text.contains("ok"));
    }
}
