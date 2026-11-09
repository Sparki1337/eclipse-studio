//! Предполётная проверка: HVCI/VBS (реестр + Win32_DeviceGuard) и регистр XCR0.
//! Реестр показывает, что применится после перезагрузки; WMI — что работает сейчас.

use std::time::Duration;

use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

use crate::{hvlog, process, sys};

const HVCI_KEY: &str =
    r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity";

const DEVICE_GUARD_KEY: &str = r"SYSTEM\CurrentControlSet\Control\DeviceGuard";

const POLICY_KEY: &str = r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard";

/// Предельное время ожидания запроса состояния Device Guard.
const RUNTIME_PROBE_TIMEOUT_MS: u64 = 30_000;

/// Сводка состояния защит и регистра XCR0.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PreflightSummary {
    pub hvci_configured: bool,
    pub hvci_running: bool,
    pub vbs_configured: bool,
    pub vbs_running: bool,
    pub runtime_known: bool,
    pub hvci_locked: bool,
    pub policy_managed: bool,
    pub xcr0: u32,
}

impl PreflightSummary {
    /// Учитываются и работающие защиты, и включённые в параметрах (вступят после перезагрузки).
    pub fn protections_require_action(&self) -> bool {
        self.hvci_running || self.hvci_configured || self.vbs_running || self.vbs_configured
    }

    /// Текстовая сводка состояния защит для журнала, отчёта и диалога.
    pub fn summary_lines(&self) -> Vec<String> {
        let mut lines = vec![
            format!("Изоляция ядра (HVCI): {}", describe_pair(self.hvci_running, self.hvci_configured)),
            format!("Виртуальная защита (VBS): {}", describe_pair(self.vbs_running, self.vbs_configured)),
        ];

        if !self.runtime_known {
            lines.push(
                "Фактическое состояние защит: не определено, используются параметры реестра"
                    .to_string(),
            );
        }
        if self.hvci_locked {
            lines.push("Параметры HVCI: заблокированы в UEFI (Locked=1)".to_string());
        }
        if self.policy_managed {
            lines.push("Параметры защит: заданы групповой политикой".to_string());
        }

        lines
    }
}

/// Описывает пару «работает сейчас / включена в параметрах».
pub fn describe_pair(running: bool, configured: bool) -> &'static str {
    match (running, configured) {
        (true, true) => "РАБОТАЕТ",
        (true, false) => "работает до перезагрузки (в параметрах уже выключена)",
        (false, true) => "включена в параметрах, применится после перезагрузки",
        (false, false) => "выключена",
    }
}

/// Фактическое состояние Device Guard, полученное из WMI.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct RuntimeState {
    hvci_running: bool,
    hvci_configured: bool,
    vbs_running: bool,
    vbs_configured: bool,
}

/// Читает состояние защит из реестра и фактическое состояние из WMI.
pub fn inspect() -> PreflightSummary {
    let mut summary = PreflightSummary {
        // Изоляция ядра считается включённой при Enabled == 1
        hvci_configured: read_u32(HVCI_KEY, "Enabled").is_some_and(|value| value == 1),
        vbs_configured: read_u32(DEVICE_GUARD_KEY, "EnableVirtualizationBasedSecurity")
            .is_some_and(|value| value == 1),
        hvci_locked: is_hvci_locked(),
        policy_managed: policy_enforces_protections(),
        xcr0: sys::read_xcr0(),
        ..Default::default()
    };

    match probe_runtime() {
        Ok(runtime) => {
            summary.runtime_known = true;
            summary.hvci_running = runtime.hvci_running;
            summary.vbs_running = runtime.vbs_running;
            // Защита, включённая хотя бы в одном источнике, должна быть отключена
            summary.hvci_configured |= runtime.hvci_configured;
            summary.vbs_configured |= runtime.vbs_configured;
        }
        Err(err) => {
            hvlog!(
                Debug,
                "среда",
                "фактическое состояние защит не опрошено, используются параметры реестра: {err}"
            );
        }
    }

    summary
}

fn is_hvci_locked() -> bool {
    read_u32(HVCI_KEY, "Locked").is_some_and(|value| value == 1)
        || read_u32(DEVICE_GUARD_KEY, "Locked").is_some_and(|value| value == 1)
        || read_u32(DEVICE_GUARD_KEY, "Mandatory").is_some_and(|value| value == 1)
}

fn policy_enforces_protections() -> bool {
    let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(POLICY_KEY) else {
        return false;
    };

    let enabled = |name: &str| key.get_value::<u32, _>(name).is_ok_and(|value| value == 1);
    enabled("HypervisorEnforcedCodeIntegrity") || enabled("EnableVirtualizationBasedSecurity")
}

fn probe_runtime() -> Result<RuntimeState, String> {
    // Win32_DeviceGuard отсутствует на старых сборках — состояние неизвестно
    const SCRIPT: &str = "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n\
        $ErrorActionPreference = 'SilentlyContinue'\n\
        $dg = Get-CimInstance -Namespace root\\Microsoft\\Windows\\DeviceGuard -ClassName Win32_DeviceGuard\n\
        if (-not $dg) { Write-Output 'DG_PRESENT=0' } else {\n\
          Write-Output 'DG_PRESENT=1'\n\
          Write-Output ('VBS_STATUS=' + [int]$dg.VirtualizationBasedSecurityStatus)\n\
          Write-Output ('RUNNING=' + ((@($dg.SecurityServicesRunning) | Where-Object { $null -ne $_ } | ForEach-Object { [int]$_ }) -join ','))\n\
          Write-Output ('CONFIGURED=' + ((@($dg.SecurityServicesConfigured) | Where-Object { $null -ne $_ } | ForEach-Object { [int]$_ }) -join ','))\n\
        }";

    let output = process::run_capture_timeout(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            SCRIPT,
        ],
        RUNTIME_PROBE_TIMEOUT_MS,
    )?;

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    parse_runtime_output(&text)
}

fn parse_runtime_output(text: &str) -> Result<RuntimeState, String> {
    let mut present = false;
    let mut vbs_status: Option<i32> = None;
    let mut running: Vec<i32> = Vec::new();
    let mut configured: Vec<i32> = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("DG_PRESENT=") {
            present = value.trim() == "1";
        } else if let Some(value) = line.strip_prefix("VBS_STATUS=") {
            vbs_status = value.trim().parse::<i32>().ok();
        } else if let Some(value) = line.strip_prefix("RUNNING=") {
            running = parse_service_ids(value);
        } else if let Some(value) = line.strip_prefix("CONFIGURED=") {
            configured = parse_service_ids(value);
        }
    }

    if !present {
        return Err("класс Win32_DeviceGuard недоступен".into());
    }
    let status = vbs_status.ok_or("WMI не вернул VirtualizationBasedSecurityStatus")?;

    Ok(RuntimeState {
        // Служба 2 в списках — Hypervisor-Enforced Code Integrity
        hvci_running: running.contains(&2),
        hvci_configured: configured.contains(&2),
        // 0 — выключена, 1 — включена без запуска, 2 — работает
        vbs_running: status == 2,
        vbs_configured: status > 0,
    })
}

fn parse_service_ids(value: &str) -> Vec<i32> {
    value
        .split(',')
        .filter_map(|item| item.trim().parse::<i32>().ok())
        .collect()
}

fn read_u32(subkey: &str, value: &str) -> Option<u32> {
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(subkey)
        .ok()
        .and_then(|key| key.get_value(value).ok())
}

fn set_u32(subkey: &str, value: &str, data: u32) -> Result<(), String> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let (key, _) = hklm
        .create_subkey(subkey)
        .map_err(|err| format!("не удалось открыть HKLM\\{subkey}: {err}"))?;
    key.set_value(value, &data)
        .map_err(|err| format!("не удалось записать HKLM\\{subkey}\\{value}: {err}"))
}

/// Запись проверяется чтением; перезагрузка — только после успешной проверки,
/// иначе цикл «перезагрузка без эффекта» повторялся бы при каждом запуске.
pub fn disable_hvci_and_reboot() -> Result<(), String> {
    hvlog!(Info, "среда", "отключение изоляции ядра (HVCI) и виртуальной защиты (VBS)");

    // Пары «ключ, значение», которые должны стать нулевыми
    let targets = [
        (HVCI_KEY, "Enabled"),
        (HVCI_KEY, "WasEnabledBy"),
        (DEVICE_GUARD_KEY, "HypervisorEnforcedCodeIntegrity"),
        (DEVICE_GUARD_KEY, "EnableVirtualizationBasedSecurity"),
    ];

    for (key, name) in targets {
        set_u32(key, name, 0)?;
    }

    // Проверка записи: без неё перезагрузка может не изменить состояние
    for (key, name) in targets {
        let actual = read_u32(key, name);
        if actual != Some(0) {
            return Err(format!(
                "параметр HKLM\\{key}\\{name} не изменился (значение: {actual:?}); \
                 защита управляется политикой или блокировкой"
            ));
        }
    }

    run_checked("bcdedit.exe", &["/set", "hypervisorlaunchtype", "off"]).map_err(|err| {
        format!("не удалось отключить гипервизор Windows в загрузчике: {err}")
    })?;

    run_checked(
        "shutdown.exe",
        &[
            "/r",
            "/t",
            "5",
            "/c",
            "Eclipse-HV: перезагрузка компьютера для отключения изоляции ядра (HVCI) и VBS...",
        ],
    )?;

    Ok(())
}

/// Ограничение размера контекста процессора нужно для совместимости гипервизора на новых CPU.
pub fn configure_xsave_and_reboot() -> Result<(), String> {
    hvlog!(Info, "среда", "применение BCD-параметра xsaveremovefeature");

    run_checked(
        "bcdedit.exe",
        &["/set", "{current}", "xsaveremovefeature", "0xFFFFFFFFFFFFFFF8"],
    )?;

    run_checked(
        "shutdown.exe",
        &[
            "/r",
            "/t",
            "5",
            "/c",
            "Eclipse-HV: перезагрузка компьютера для применения оптимизации процессора (xsaveremovefeature)...",
        ],
    )?;

    Ok(())
}

fn run_checked(program: &str, args: &[&str]) -> Result<(), String> {
    let output = process::run_capture(program, args)?;
    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let details = [stdout.trim(), stderr.trim()]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" | ");
    let code = output
        .status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "неизвестен".to_string());

    Err(format!("{program} завершился с кодом {code}: {details}"))
}

/// Возвращает false, если пользователь прервал ожидание.
pub fn wait_interruptible(seconds: u64) -> bool {
    for _ in 0..(seconds * 2) {
        if sys::interrupted() {
            return false;
        }
        thread_sleep_half_second();
    }
    !sys::interrupted()
}

fn thread_sleep_half_second() {
    std::thread::sleep(Duration::from_millis(500));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn осмотр_системы_читает_состояние_без_сбоев() {
        // Живая система: важна читаемость реестра и отсутствие паники
        let summary = inspect();
        let _ = summary.runtime_known;
        assert!(summary.summary_lines().len() >= 2);
    }

    #[test]
    fn чтение_реестра_возвращает_значение_или_отсутствие() {
        assert!(read_u32(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "InstallDate").is_some());
        assert!(read_u32(r"SOFTWARE\Eclipse\ЗаведомоНесуществующий", "Value").is_none());
    }

    #[test]
    fn разбор_фактического_состояния_wmi() {
        // HVCI и VBS работают
        let state = parse_runtime_output(
            "DG_PRESENT=1\nVBS_STATUS=2\nRUNNING=1,2\nCONFIGURED=1,2,5\n",
        )
        .expect("разбор должен проходить");
        assert!(state.hvci_running);
        assert!(state.hvci_configured);
        assert!(state.vbs_running);
        assert!(state.vbs_configured);

        // Защиты выключены
        let state = parse_runtime_output(
            "DG_PRESENT=1\nVBS_STATUS=0\nRUNNING=0\nCONFIGURED=1,5\n",
        )
        .expect("разбор должен проходить");
        assert!(!state.hvci_running);
        assert!(!state.hvci_configured);
        assert!(!state.vbs_running);
        assert!(!state.vbs_configured);

        // VBS включена, но ещё не применена до перезагрузки
        let state = parse_runtime_output("DG_PRESENT=1\nVBS_STATUS=1\nRUNNING=\nCONFIGURED=\n")
            .expect("разбор должен проходить");
        assert!(state.vbs_configured);
        assert!(!state.vbs_running);

        // Класс WMI отсутствует или ответ пустой
        assert!(parse_runtime_output("DG_PRESENT=0\n").is_err());
        assert!(parse_runtime_output("").is_err());
    }

    #[test]
    fn сводка_и_необходимость_действий() {
        let dirty = PreflightSummary {
            hvci_running: true,
            hvci_configured: true,
            vbs_running: true,
            vbs_configured: true,
            runtime_known: true,
            ..Default::default()
        };
        assert!(dirty.protections_require_action());
        let text = dirty.summary_lines().join("\n");
        assert!(text.contains("HVCI"));
        assert!(text.contains("VBS"));
        assert!(text.contains("РАБОТАЕТ"));

        // Одной включённой в параметрах VBS достаточно для действий
        let vbs_only = PreflightSummary {
            vbs_configured: true,
            runtime_known: true,
            ..Default::default()
        };
        assert!(vbs_only.protections_require_action());
        assert!(vbs_only
            .summary_lines()
            .join("\n")
            .contains("после перезагрузки"));

        let clean = PreflightSummary::default();
        assert!(!clean.protections_require_action());
        assert!(clean.summary_lines().join("\n").contains("выключена"));
    }
}
