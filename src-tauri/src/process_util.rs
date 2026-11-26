//! Общие утилиты запуска скрытых процессов и проверки запущенных программ.
use std::{path::Path, process::Command};

#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Настраивает скрытый запуск дочернего процесса без консольного окна на Windows.
pub(crate) fn configure_hidden(mut command: Command) -> Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Создаёт команду без всплывающего консольного окна на Windows по имени программы.
pub(crate) fn hidden_command(program: &str) -> Command {
    configure_hidden(Command::new(program))
}

/// Создаёт команду без всплывающего консольного окна на Windows по полному пути.
pub(crate) fn hidden_path_command(program: &Path) -> Command {
    configure_hidden(Command::new(program))
}

/// Проверяет, запущен ли процесс с указанным именем образа (например, `steam.exe`).
#[cfg(target_os = "windows")]
pub(crate) fn process_is_running(image_name: &str) -> bool {
    let Ok(output) = hidden_command("tasklist.exe")
        .args(["/FI", &format!("IMAGENAME eq {image_name}"), "/NH"])
        .output()
    else {
        return false;
    };
    let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
    stdout.contains(&image_name.to_lowercase())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn process_is_running(image_name: &str) -> bool {
    Command::new("pgrep")
        .args(["-x", image_name])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
