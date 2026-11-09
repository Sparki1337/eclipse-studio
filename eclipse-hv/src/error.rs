//! Структурированные ошибки с JSON-отчётом и журналом сессии.

use std::{env, fs, path::PathBuf};

use serde::Serialize;

use crate::{logging, sys};

/// Накапливается по шагам и включается в отчёт об ошибке.
#[derive(Debug, Clone, Default)]
pub struct Diagnostics {
    pub target_executable: Option<String>,
    pub candidate_count: usize,
    pub vanguard_detected: bool,
    pub msi_afterburner_detected: bool,
    pub msi_relaunch_path: Option<String>,
    pub driver_temp_path: Option<String>,
    pub dse_offsets_source: Option<String>,
    pub dse_kernel_base: Option<String>,
    pub dse_patched: Option<bool>,
    pub dse_restored: Option<bool>,
    pub xcr0_value: Option<u32>,
    pub hvci_enabled: Option<bool>,
    pub hvci_running: Option<bool>,
    pub vbs_running: Option<bool>,
    pub defender_exclusions: Vec<String>,
    pub steps_completed: Vec<String>,
}

/// Структурированная ошибка выполнения.
pub struct HvError {
    pub step: &'static str,
    pub code: &'static str,
    pub message: String,
    pub causes: Vec<String>,
    pub diagnostics: Diagnostics,
    pub exit_code: i32,
}

impl HvError {
    pub fn new(step: &'static str, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            step,
            code,
            message: message.into(),
            causes: Vec::new(),
            diagnostics: Diagnostics::default(),
            exit_code: 1,
        }
    }

    pub fn with_cause(mut self, cause: impl Into<String>) -> Self {
        self.causes.push(cause.into());
        self
    }

    pub fn with_diagnostics(mut self, diagnostics: Diagnostics) -> Self {
        self.diagnostics = diagnostics;
        self
    }

    pub fn with_exit_code(mut self, exit_code: i32) -> Self {
        self.exit_code = exit_code;
        self
    }

    /// Формирует отчёт, показывает ошибку пользователю и возвращает код завершения.
    pub fn report(&self) -> i32 {
        crate::hvlog!(Error, self.code, "шаг «{}» прерван: {}", self.step, self.message);

        let diagnostics = &self.diagnostics;
        let base_dir = env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|path| path.to_path_buf()))
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let executable_path = env::current_exe()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default();

        let report = JsonErrorReport {
            timestamp: sys::timestamp(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            application: sys::APP_TITLE.to_string(),
            status: "ERROR".to_string(),
            error_step: self.step.to_string(),
            error_code: self.code.to_string(),
            error_message: self.message.clone(),
            causes: self.causes.clone(),
            log: logging::snapshot(),
            environment: JsonEnvironment {
                working_directory: base_dir.to_string_lossy().to_string(),
                executable_path,
                command_line_args: env::args().collect(),
                is_administrator: sys::is_elevated().unwrap_or(false),
                core_isolation_hvci_enabled: diagnostics.hvci_enabled.unwrap_or(false),
                operating_system: sys::os_description(),
            },
            diagnostic_details: JsonDiagnostics {
                target_executable: diagnostics.target_executable.clone(),
                candidate_count: diagnostics.candidate_count,
                vanguard_detected: diagnostics.vanguard_detected,
                msi_afterburner_detected: diagnostics.msi_afterburner_detected,
                msi_relaunch_path: diagnostics.msi_relaunch_path.clone(),
                driver_temp_path: diagnostics.driver_temp_path.clone(),
                dse_offsets_source: diagnostics.dse_offsets_source.clone(),
                dse_kernel_base: diagnostics.dse_kernel_base.clone(),
                dse_patched: diagnostics.dse_patched,
                dse_restored: diagnostics.dse_restored,
                xcr0_value: diagnostics.xcr0_value,
                hvci_enabled: diagnostics.hvci_enabled,
                hvci_running: diagnostics.hvci_running,
                vbs_running: diagnostics.vbs_running,
                defender_exclusions: diagnostics.defender_exclusions.clone(),
                steps_completed: diagnostics.steps_completed.clone(),
            },
        };

        // Отчёт пишется рядом с лаунчером, при невозможности — во временную папку
        let json = serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_string());
        let primary = base_dir.join("Eclipse-HV-error.json");
        let report_path = match fs::write(&primary, &json) {
            Ok(()) => primary,
            Err(_) => {
                let fallback_dir = env::temp_dir().join("Eclipse-HV");
                let _ = fs::create_dir_all(&fallback_dir);
                let fallback = fallback_dir.join("Eclipse-HV-error.json");
                let _ = fs::write(&fallback, &json);
                fallback
            }
        };

        // Текст диалога: сообщение, причины и расположение артефактов
        let mut dialog_text = self.message.clone();
        if !self.causes.is_empty() {
            dialog_text.push_str("\n\nТехнические подробности:\n");
            for cause in self.causes.iter().take(4) {
                dialog_text.push_str(&format!("• {}\n", cause));
            }
        }
        dialog_text.push_str(&format!(
            "\nПодробный отчёт записан в файл:\n{}\nЖурнал сессии:\n{}",
            report_path.display(),
            logging::path().unwrap_or_else(|| PathBuf::from("недоступен")).display()
        ));

        sys::show_error_box(&format!("{} — ошибка запуска", sys::APP_TITLE), &dialog_text);

        // Открываем отчёт в приложении по умолчанию для самостоятельного изучения
        sys::open_path(&report_path);

        self.exit_code
    }
}

/// Внешняя структура JSON-отчёта (совместима с прежним форматом).
#[derive(Debug, Serialize)]
struct JsonErrorReport {
    timestamp: String,
    version: String,
    application: String,
    status: String,
    error_step: String,
    error_code: String,
    error_message: String,
    causes: Vec<String>,
    log: Vec<String>,
    environment: JsonEnvironment,
    diagnostic_details: JsonDiagnostics,
}

#[derive(Debug, Serialize)]
struct JsonEnvironment {
    working_directory: String,
    executable_path: String,
    command_line_args: Vec<String>,
    is_administrator: bool,
    core_isolation_hvci_enabled: bool,
    operating_system: String,
}

#[derive(Debug, Serialize)]
struct JsonDiagnostics {
    target_executable: Option<String>,
    candidate_count: usize,
    vanguard_detected: bool,
    msi_afterburner_detected: bool,
    msi_relaunch_path: Option<String>,
    driver_temp_path: Option<String>,
    dse_offsets_source: Option<String>,
    dse_kernel_base: Option<String>,
    dse_patched: Option<bool>,
    dse_restored: Option<bool>,
    xcr0_value: Option<u32>,
    hvci_enabled: Option<bool>,
    hvci_running: Option<bool>,
    vbs_running: Option<bool>,
    defender_exclusions: Vec<String>,
    steps_completed: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ошибка_накапливает_причины_и_диагностику() {
        let mut diagnostics = Diagnostics::default();
        diagnostics.candidate_count = 3;
        diagnostics.hvci_enabled = Some(false);
        diagnostics.steps_completed.push("Шаг 1/7: права администратора".into());

        let error = HvError::new("Шаг 4/7", "DSE_BYPASS", "тестовое сообщение")
            .with_cause("техническая причина 1")
            .with_cause("техническая причина 2")
            .with_diagnostics(diagnostics)
            .with_exit_code(130);

        assert_eq!(error.code, "DSE_BYPASS");
        assert_eq!(error.step, "Шаг 4/7");
        assert_eq!(error.message, "тестовое сообщение");
        assert_eq!(error.causes.len(), 2);
        assert_eq!(error.diagnostics.candidate_count, 3);
        assert_eq!(error.diagnostics.hvci_enabled, Some(false));
        assert_eq!(error.diagnostics.steps_completed.len(), 1);
        assert_eq!(error.exit_code, 130);
    }
}
