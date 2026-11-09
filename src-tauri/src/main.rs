#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Точка входа бинарника приложения.

fn main() {
    // Помощник обновления работает до Tauri: окно и WebView не создаются
    if let Some(code) = eclipse_studio_lib::run_update_helper() {
        std::process::exit(code);
    }
    eclipse_studio_lib::run();
}
