//! Режим `--status`: снимок защит, конфликтов, сертификата и антивируса в JSON, журнал и диалог.
//! Только чтение; система не изменяется.

use std::path::PathBuf;

use serde::Serialize;

use crate::{avcheck, avguard, cert, dse, hvlog, preflight, process, sys};

const CONFLICT_SERVICES: [&str; 4] = ["vgc", "vgk", "RTCore64", "RTCoreMini64"];

#[derive(Debug, Clone, Serialize)]
pub struct ServiceState {
    pub name: String,
    pub installed: bool,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub operating_system: String,
    pub is_administrator: bool,
    pub xcr0: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProtectionsInfo {
    pub hvci_running: bool,
    pub hvci_configured: bool,
    pub vbs_running: bool,
    pub vbs_configured: bool,
    pub runtime_known: bool,
    pub hvci_locked: bool,
    pub policy_managed: bool,
    pub testsigning_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictsInfo {
    pub vanguard_processes: Vec<String>,
    pub services: Vec<ServiceState>,
    pub msi_afterburner_running: bool,
    pub rtss_running: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestCertificateInfo {
    pub installed: bool,
    pub thumbprint: Option<String>,
    pub stores: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DseStateInfo {
    pub original_callback: Option<String>,
    pub patched: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemStatus {
    pub timestamp: String,
    pub version: String,
    pub application: String,
    pub mode: String,
    pub system: SystemInfo,
    pub protections: ProtectionsInfo,
    pub conflicts: ConflictsInfo,
    pub test_certificate: TestCertificateInfo,
    pub dse_state: DseStateInfo,
    pub antivirus: avcheck::DefenderState,
}

pub fn collect() -> SystemStatus {
    let preflight_summary = preflight::inspect();
    let cert_state = cert::status();
    let dse_original = dse::patch_state();
    // Каталог лаунчера: по нему определяется, покрыт ли он исключениями защиты
    let launcher_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|path| path.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let defender = {
        let mut state = avcheck::inspect(&launcher_dir);
        // Следы прерванной сессии показываются, настройки не меняются
        state.pending_cleanup = avguard::stale_paths();
        state
    };

    let vanguard_processes = ["vgtray.exe", "vgc.exe", "vgk.exe"]
        .iter()
        .filter(|name| process::process_is_running(name))
        .map(|name| name.to_string())
        .collect::<Vec<_>>();

    let services = CONFLICT_SERVICES.iter().map(|name| service_state(name)).collect();

    SystemStatus {
        timestamp: sys::timestamp(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        application: sys::APP_TITLE.to_string(),
        mode: "status".to_string(),
        system: SystemInfo {
            operating_system: sys::os_description(),
            is_administrator: sys::is_elevated().unwrap_or(false),
            xcr0: preflight_summary.xcr0,
        },
        protections: ProtectionsInfo {
            hvci_running: preflight_summary.hvci_running,
            hvci_configured: preflight_summary.hvci_configured,
            vbs_running: preflight_summary.vbs_running,
            vbs_configured: preflight_summary.vbs_configured,
            runtime_known: preflight_summary.runtime_known,
            hvci_locked: preflight_summary.hvci_locked,
            policy_managed: preflight_summary.policy_managed,
            testsigning_enabled: detect_testsigning(),
        },
        conflicts: ConflictsInfo {
            vanguard_processes,
            services,
            msi_afterburner_running: process::process_is_running("MSIAfterburner.exe"),
            rtss_running: process::process_is_running("RTSS.exe"),
        },
        test_certificate: TestCertificateInfo {
            installed: cert_state.installed(),
            thumbprint: cert_state.thumbprint.clone(),
            stores: cert_state.stores.clone(),
        },
        dse_state: DseStateInfo {
            original_callback: dse_original.map(|value| format!("0x{value:X}")),
            patched: dse_original.is_some(),
        },
        antivirus: defender,
    }
}

pub fn summary(status: &SystemStatus) -> Vec<String> {
    let mut lines = Vec::new();

    lines.push(format!("Операционная система: {}", status.system.operating_system));
    lines.push(format!(
        "Права администратора: {}",
        if status.system.is_administrator { "есть" } else { "нет" }
    ));

    lines.push(format!(
        "Изоляция ядра (HVCI): {}",
        preflight::describe_pair(
            status.protections.hvci_running,
            status.protections.hvci_configured
        )
    ));
    lines.push(format!(
        "Виртуальная защита (VBS): {}",
        preflight::describe_pair(
            status.protections.vbs_running,
            status.protections.vbs_configured
        )
    ));
    if !status.protections.runtime_known {
        lines.push("Фактическое состояние защит: не определено (только параметры реестра)".to_string());
    }
    if status.protections.hvci_locked {
        lines.push("Параметры HVCI: заблокированы в UEFI".to_string());
    }
    if status.protections.policy_managed {
        lines.push("Параметры защит: заданы групповой политикой".to_string());
    }
    let testsigning = match status.protections.testsigning_enabled {
        Some(true) => "включён".to_string(),
        Some(false) => "выключен".to_string(),
        None => "не определён (требуются права администратора)".to_string(),
    };
    lines.push(format!("Режим тестовой подписи: {testsigning}"));
    lines.push(format!("Регистр XCR0: {}", status.system.xcr0));

    if status.conflicts.vanguard_processes.is_empty() {
        lines.push("Vanguard: не обнаружен".to_string());
    } else {
        lines.push(format!(
            "Vanguard: процессы [{}]",
            status.conflicts.vanguard_processes.join(", ")
        ));
    }

    let running_services = status
        .conflicts
        .services
        .iter()
        .filter(|service| service.running)
        .map(|service| service.name.as_str())
        .collect::<Vec<_>>();
    if running_services.is_empty() {
        lines.push("Конфликтующие службы: не запущены".to_string());
    } else {
        lines.push(format!("Конфликтующие службы: [{}]", running_services.join(", ")));
    }

    lines.push(format!(
        "MSI Afterburner: {}",
        if status.conflicts.msi_afterburner_running { "работает" } else { "не работает" }
    ));
    lines.push(format!(
        "RTSS: {}",
        if status.conflicts.rtss_running { "работает" } else { "не работает" }
    ));

    if status.test_certificate.installed {
        lines.push(format!(
            "Тестовый сертификат: установлен (отпечаток {}, хранилища: {})",
            status.test_certificate.thumbprint.as_deref().unwrap_or("?"),
            status.test_certificate.stores.join(", ")
        ));
    } else {
        lines.push("Тестовый сертификат: не установлен".to_string());
    }

    if status.dse_state.patched {
        lines.push(format!(
            "Временный обход DSE: АКТИВЕН (исходный указатель {}), требуется восстановление",
            status.dse_state.original_callback.as_deref().unwrap_or("?")
        ));
    } else {
        lines.push("Временный обход DSE: не активен".to_string());
    }

    lines.extend(avcheck::summary_lines(&status.antivirus));
    if status.antivirus.should_warn() {
        lines.push(
            "Вывод: защита активна, загрузка драйвера может быть заблокирована (0x80070005)"
                .to_string(),
        );
    }

    lines
}

/// При недоступности каталога — во временную папку.
pub fn write_report(status: &SystemStatus, base_dir: &std::path::Path) -> Option<PathBuf> {
    let json = serde_json::to_string_pretty(status).ok()?;
    let primary = base_dir.join("Eclipse-HV-status.json");

    if std::fs::write(&primary, &json).is_ok() {
        return Some(primary);
    }

    let fallback_dir = std::env::temp_dir().join("Eclipse-HV");
    let _ = std::fs::create_dir_all(&fallback_dir);
    let fallback = fallback_dir.join("Eclipse-HV-status.json");
    std::fs::write(&fallback, &json).is_ok().then_some(fallback)
}

pub fn log_summary(status: &SystemStatus) {
    for line in summary(status) {
        hvlog!(Info, "диагностика", "{line}");
    }
}

/// Определяет состояние режима тестовой подписи через bcdedit.
fn detect_testsigning() -> Option<bool> {
    // bcdedit работает только с правами администратора
    if !sys::is_elevated().unwrap_or(false) {
        hvlog!(Debug, "диагностика", "bcdedit недоступен без прав администратора");
        return None;
    }

    let output = process::run_capture("bcdedit.exe", &["/enum", "{current}"]).ok()?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let result = parse_testsigning(&text);
    if result.is_none() {
        hvlog!(Warn, "диагностика", "режим тестовой подписи не найден в выводе bcdedit");
    }
    result
}

/// Разбирает строку testsigning: Yes/No и Да/Нет.
pub fn parse_testsigning(text: &str) -> Option<bool> {
    for line in text.lines() {
        let lower = line.to_lowercase();
        if !lower.contains("testsigning") {
            continue;
        }
        if lower.contains("yes") || lower.contains("да") {
            return Some(true);
        }
        if lower.contains("no") || lower.contains("нет") {
            return Some(false);
        }
    }
    None
}

fn service_state(name: &str) -> ServiceState {
    match process::run_capture("sc.exe", &["query", name]) {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
            // Локализованные варианты имени состояния (RUNNING / РАБОТАЕТ)
            let running = text.contains("running") || text.contains("работает");
            ServiceState {
                name: name.to_string(),
                installed: true,
                running,
            }
        }
        Ok(out) => {
            // Код 1060 — служба не установлена
            let not_installed = out.status.code() == Some(1060);
            ServiceState {
                name: name.to_string(),
                installed: !not_installed,
                running: false,
            }
        }
        Err(err) => {
            hvlog!(Debug, "диагностика", "служба {name} не опрошена: {err}");
            ServiceState {
                name: name.to_string(),
                installed: false,
                running: false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn разбор_режима_тестовой_подписи() {
        // Английский вывод bcdedit
        let english = "Windows Boot Manager\r\n...\r\ntestsigning             Yes\r\n";
        assert_eq!(parse_testsigning(english), Some(true));

        let english_off = "testsigning             No\r\n";
        assert_eq!(parse_testsigning(english_off), Some(false));

        // Русский вывод bcdedit
        let russian = "testsigning             Да\r\n";
        assert_eq!(parse_testsigning(russian), Some(true));

        // Отсутствие параметра
        assert_eq!(parse_testsigning("hypervisorlaunchtype    Off\r\n"), None);
        assert_eq!(parse_testsigning(""), None);
    }

    #[test]
    fn сводка_содержит_ключевые_поля() {
        let status = SystemStatus {
            timestamp: "2026-11-09 08:40:00.000".into(),
            version: "test".into(),
            application: sys::APP_TITLE.into(),
            mode: "status".into(),
            system: SystemInfo {
                operating_system: "Windows 11 (сборка 26100)".into(),
                is_administrator: false,
                xcr0: 7,
            },
            protections: ProtectionsInfo {
                hvci_running: true,
                hvci_configured: true,
                vbs_running: false,
                vbs_configured: false,
                runtime_known: true,
                hvci_locked: false,
                policy_managed: false,
                testsigning_enabled: None,
            },
            conflicts: ConflictsInfo {
                vanguard_processes: vec![],
                services: vec![ServiceState {
                    name: "vgc".into(),
                    installed: false,
                    running: false,
                }],
                msi_afterburner_running: false,
                rtss_running: false,
            },
            test_certificate: TestCertificateInfo {
                installed: false,
                thumbprint: None,
                stores: vec![],
            },
            dse_state: DseStateInfo {
                original_callback: None,
                patched: false,
            },
            antivirus: avcheck::DefenderState::default(),
        };

        let lines = summary(&status);
        let text = lines.join("\n");
        assert!(text.contains("Windows 11"));
        assert!(text.contains("HVCI"));
        assert!(text.contains("VBS"));
        assert!(text.contains("XCR0"));
        assert!(text.contains("Тестовый сертификат: не установлен"));
        assert!(text.contains("Vanguard: не обнаружен"));
        assert!(text.contains("Временный обход DSE: не активен"));

        // Отчёт сериализуется в JSON без ошибок
        let json = serde_json::to_string_pretty(&status).unwrap();
        assert!(json.contains("\"testsigning_enabled\": null"));
        assert!(json.contains("\"dse_state\""));
    }

    #[test]
    fn отчёт_записывается_в_указанный_каталог() {
        let dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("target")
            .join("eclipse-hv-tests")
            .join("status");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let status = SystemStatus {
            timestamp: "test".into(),
            version: "test".into(),
            application: sys::APP_TITLE.into(),
            mode: "status".into(),
            system: SystemInfo {
                operating_system: "test".into(),
                is_administrator: false,
                xcr0: 0,
            },
            protections: ProtectionsInfo {
                hvci_running: false,
                hvci_configured: false,
                vbs_running: false,
                vbs_configured: false,
                runtime_known: true,
                hvci_locked: false,
                policy_managed: false,
                testsigning_enabled: Some(false),
            },
            conflicts: ConflictsInfo {
                vanguard_processes: vec![],
                services: vec![],
                msi_afterburner_running: false,
                rtss_running: false,
            },
            test_certificate: TestCertificateInfo {
                installed: false,
                thumbprint: None,
                stores: vec![],
            },
            dse_state: DseStateInfo {
                original_callback: None,
                patched: false,
            },
            antivirus: avcheck::DefenderState::default(),
        };

        let report = write_report(&status, &dir).expect("отчёт должен записаться");
        assert!(report.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
