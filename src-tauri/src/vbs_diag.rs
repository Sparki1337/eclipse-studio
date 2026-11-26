//! Системная диагностика, ремонт подсистем Windows (WMI/DISM/SFC), сканер VBS и низкоуровневый доступ к реестру/BCD.

use super::*;
use std::{path::PathBuf, process::Output};
use tauri::{AppHandle, Emitter, Manager};
use winreg::{
    enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY, KEY_WRITE},
    RegKey,
};

pub(crate) const LEGACY_UEFI_SNAPSHOT: &str = "Старый снимок UEFI не содержит полного журнала EFI/BCD. Он сохранён; безопасно восстановить недостающие исходные данные задним числом невозможно. Новый UEFI-сценарий доступен после разбора старого снимка.";

pub(crate) fn system_tool(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32")
        .join(name)
}

// Запуск системной утилиты с потоковой трансляцией строк вывода в реальном времени
pub(crate) fn stream_command_progress(
    app: &AppHandle,
    program: &str,
    args: &[&str],
) -> Result<(i32, String), String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    let sys = system_tool(program);
    let target = if sys.is_file() {
        sys
    } else {
        PathBuf::from(program)
    };
    let mut command = crate::process_util::hidden_path_command(&target);
    command.args(args);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| format!("{program}: {e}"))?;
    let mut full_output = Vec::new();

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app.emit("vbs-progress", &line);
            full_output.push(line);
        }
    }

    let status = child.wait().map_err(|e| format!("{program}: {e}"))?;
    Ok((status.code().unwrap_or(-1), full_output.join("\n")))
}

pub(crate) fn run_repair_inner(app: &AppHandle, kind: &str) -> Result<String, String> {
    if !is_admin() {
        return Err("Для восстановления системы требуются права администратора.".into());
    }
    match kind {
        "wmi" => fix_wmi_inner(app),
        "dism" => {
            let _ = app.emit("vbs-progress", "Запуск DISM RestoreHealth...");
            let (code, output) = stream_command_progress(
                app,
                "dism.exe",
                &["/Online", "/English", "/Cleanup-Image", "/RestoreHealth"],
            )?;
            let _ = app.emit("vbs-progress", format!("DISM завершён с кодом {code}"));
            Ok(output)
        }
        "sfc" => {
            let _ = app.emit("vbs-progress", "Запуск SFC Scannow...");
            let (code, output) = stream_command_progress(app, "sfc.exe", &["/scannow"])?;
            let _ = app.emit("vbs-progress", format!("SFC завершён с кодом {code}"));
            Ok(output)
        }
        other => Err(format!("Неизвестный тип восстановления: {other}")),
    }
}

// Безопасное восстановление WMI без повреждения Windows Server
pub(crate) fn fix_wmi_inner(app: &AppHandle) -> Result<String, String> {
    if let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
    {
        if let Ok(installation_type) = k.get_value::<String, _>("InstallationType") {
            if installation_type.to_lowercase().contains("server") {
                return Err("Fix WMI не выполняет перестройку WMI на Windows Server.".into());
            }
        }
    }
    let _ = app.emit(
        "vbs-progress",
        "Проверка работоспособности репозитория WMI...",
    );

    let verify = run_command("winmgmt.exe", &["/verifyrepository"]);
    if let Ok(out) = verify {
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        if text.contains("consistent") || text.contains("целостен") || text.contains("не поврежден")
        {
            let _ = app.emit(
                "vbs-progress",
                "Репозиторий WMI в норме, восстановление не требуется.",
            );
            return Ok("Репозиторий WMI целостен и не повреждён.".into());
        }
    }

    let _ = app.emit(
        "vbs-progress",
        "Остановка службы Winmgmt и зависимых служб...",
    );
    let _ =
        powershell_output("$ErrorActionPreference='SilentlyContinue'; Stop-Service Winmgmt -Force");

    let _ = app.emit(
        "vbs-progress",
        "Выполнение winmgmt.exe /salvagerepository...",
    );
    let salvage = run_command("winmgmt.exe", &["/salvagerepository"]);
    let salvage_msg = match salvage {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(e) => format!("Ошибка /salvagerepository: {e}"),
    };
    let _ = app.emit("vbs-progress", &salvage_msg);

    let _ = app.emit("vbs-progress", "Запуск службы Winmgmt...");
    let _ = run_command("sc.exe", &["start", "Winmgmt"]);

    let _ = app.emit("vbs-progress", "Восстановление WMI завершено.");
    Ok(format!("Восстановление WMI завершено:\n{salvage_msg}"))
}

pub(crate) fn run_troubleshoot_inner(app: &AppHandle, action: &str) -> Result<String, String> {
    match action {
        "wmi" => {
            let _ = app.emit(
                "vbs-progress",
                "Запуск диагностики репозитория WMI (/verifyrepository)...",
            );
            let (code, output) =
                stream_command_progress(app, "winmgmt.exe", &["/verifyrepository"])?;
            let _ = app.emit(
                "vbs-progress",
                format!("Проверка WMI завершена (код {code})"),
            );
            Ok(output)
        }
        "sfc" => {
            let _ = app.emit("vbs-progress", "Запуск диагностики SFC (/verifyonly)...");
            let (code, output) = stream_command_progress(app, "sfc.exe", &["/verifyonly"])?;
            let _ = app.emit(
                "vbs-progress",
                format!("Проверка SFC завершена (код {code})"),
            );
            Ok(output)
        }
        "dism" => {
            let _ = app.emit("vbs-progress", "Запуск диагностики DISM (/scanhealth)...");
            let (code, output) = stream_command_progress(
                app,
                "dism.exe",
                &["/Online", "/English", "/Cleanup-Image", "/ScanHealth"],
            )?;
            let _ = app.emit(
                "vbs-progress",
                format!("Проверка DISM завершена (код {code})"),
            );
            Ok(output)
        }
        other => Err(format!("Неизвестное действие диагностики: {other}")),
    }
}

pub(crate) fn scan_report(app: &AppHandle) -> Result<VbsReport, String> {
    // Выполняем независимые системные проверки (WMI, UEFI, BitLocker, KVA, конфликты, BCD) параллельно
    let (probe_res, uefi_lock, bitlocker, kva_shadow, conflicts, test_configured) =
        std::thread::scope(|scope| {
            let probe_task = scope.spawn(system_probe);
            let uefi_task = scope.spawn(check_uefi_lock);
            let bitlocker_task = scope.spawn(check_bitlocker);
            let kva_task = scope.spawn(check_kva_shadow);
            let conflicts_task = scope.spawn(check_conflicts);
            let bcd_task = scope.spawn(configured_test_signing);
            (
                probe_task
                    .join()
                    .unwrap_or_else(|_| Err("Поток WMI прерван".into())),
                uefi_task.join().unwrap_or(UefiLockInfo {
                    is_locked: false,
                    vbs_locked: false,
                    hvci_locked: false,
                    credential_locked: false,
                    sec_config_available: false,
                }),
                bitlocker_task.join().unwrap_or_else(|_| {
                    bitlocker_unknown(false, BITLOCKER_UNKNOWN_MESSAGE, vec![])
                }),
                kva_task.join().unwrap_or_else(|_| KvaShadowInfo {
                    needed: false,
                    disabled: false,
                    label: "Не удалось определить состояние KVA Shadow".into(),
                }),
                conflicts_task.join().unwrap_or_default(),
                bcd_task.join().ok().flatten(),
            )
        });
    let probe = probe_res?;
    let configured = parse_service_ids(&probe.configured_services);
    let running = parse_service_ids(&probe.running_services);

    let vbs_registry = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
        "EnableVirtualizationBasedSecurity",
    );
    let hvci_registry = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
        "Enabled",
    );
    let credential_registry = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\CredentialGuard",
        "Enabled",
    );
    let lsa_registry = registry_dword(r"SYSTEM\CurrentControlSet\Control\Lsa", "LsaCfgFlags");

    let vbs_enabled = probe.vbs_status > 0 || vbs_registry.is_some_and(|value| value > 0);
    let hvci_enabled = running.contains(&2) || hvci_registry.is_some_and(|value| value > 0);
    let credential_enabled = running.contains(&1)
        || credential_registry.is_some_and(|value| value > 0)
        || lsa_registry.is_some_and(|value| value > 0);

    let windows_hello_enabled = registry_enabled(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\WindowsHello",
        "Enabled",
    );

    let mut components = vec![
        component(
            "vbs",
            "Virtualization-based Security (VBS)",
            "Базовая изоляция ядра и системный гипервизор Windows",
            vbs_enabled,
            uefi_lock.vbs_locked,
        ),
        component(
            "hvci",
            "Memory Integrity (HVCI)",
            "Изоляция памяти ядра и проверка целостности кода",
            hvci_enabled,
            uefi_lock.hvci_locked,
        ),
        component(
            "credential-guard",
            "Credential Guard",
            "Изоляция процесса LSA и защита учетных данных",
            credential_enabled,
            uefi_lock.credential_locked,
        ),
        component(
            "kva-shadow",
            "KVA Shadow (Meltdown Mitigation)",
            "Теневое разделение адресных пространств ядра для CPU",
            !kva_shadow.disabled && kva_shadow.needed,
            false,
        ),
    ];

    if configured.contains(&2) && !components[1].enabled {
        components[1].state = "configured".into();
    }
    if configured.contains(&1) && !components[2].enabled {
        components[2].state = "configured".into();
    }

    let enabled_count = components.iter().filter(|item| item.enabled).count();
    let mut warnings = Vec::new();

    if !probe.virtualization_firmware_enabled && !probe.hypervisor_present {
        warnings.push("Аппаратная виртуализация VT-x/SVM отключена в BIOS/UEFI.".into());
    }
    if uefi_lock.is_locked {
        warnings.push("Обнаружена UEFI-блокировка параметров VBS/HVCI. Для полного отключения требуется использовать SecConfig.efi.".into());
    }
    // Без прав администратора причина и кнопка перезапуска уже показаны в карточке BitLocker
    if bitlocker.state == "unknown" && !bitlocker.needs_admin {
        warnings.push(
            "Изменения загрузки заблокированы, пока состояние BitLocker не подтверждено.".into(),
        );
    }
    if bitlocker.protected {
        warnings.push("BitLocker активен: при входе в параметры загрузки защита будет временно приостановлена на 1 перезагрузку, чтобы снизить риск запроса ключа. Это не гарантия: заранее обеспечьте доступ к 48-значному ключу восстановления.".into());
    }
    if windows_hello_enabled {
        warnings.push("Windows Hello защищён VBS. Убедитесь, что у вашей учётной записи настроен обычный пароль перед отключением изоляции ядра.".into());
    }
    let xcr0 = read_xcr0();
    if xcr0 > 0 && xcr0 < 7 {
        warnings.push("Процессор не поддерживает набор инструкций AVX (или AVX отключен). Запуск токенов Denuvo не поддерживается.".into());
    }
    // bcdedit доступен только администратору: без прав маска не проверяется
    if let Ok(Some(value)) = read_bcd(XSAVE_BCD) {
        warnings.push(xsave_mask_warning(&value).into());
    }

    let own_exists = snapshot_path(app)?.exists();
    let own_snapshot = if own_exists {
        match read_snapshot(app) {
            Ok(snapshot) => Some(snapshot),
            Err(error) => {
                warnings.push(error);
                None
            }
        }
    } else {
        None
    };
    let external = external::status(app, &probe.boot_id, own_exists);
    let uefi_optout = uefi::status(app, &probe.boot_id);
    if let Some(status) = &uefi_optout {
        warnings.push(status.detail.clone());
    }
    let enable_block_reason = if external.detected || external.pending_restart {
        Some(
            external.blocked_reason.clone().unwrap_or_else(|| {
                "Сначала выключите внешний режим VBS.cmd по его журналу.".into()
            }),
        )
    } else if let Some(reason) = uefi_optout
        .as_ref()
        .and_then(|status| status.blocked_reason.clone())
    {
        Some(reason)
    } else if uefi_lock.is_locked && !uefi_lock.sec_config_available {
        Some("Для UEFI Opt-Out недоступен системный SecConfig.efi".into())
    } else if own_exists && own_snapshot.is_none() {
        Some("Снимок Eclipse не прошёл проверку. Новые изменения заблокированы, чтобы не потерять исходные параметры.".into())
    } else {
        windows_hello_preflight().err()
    };
    if let Some(reason) = &enable_block_reason {
        warnings.push(reason.clone());
    }
    let pending_own = own_snapshot
        .as_ref()
        .is_some_and(|snapshot| !snapshot.boot_id.is_empty() && snapshot.boot_id == probe.boot_id);
    let preferred_boot_mode = if probe.secure_boot == "false" {
        "testsigning"
    } else {
        "advanced"
    }
    .into();
    Ok(VbsReport {
        admin: is_admin(),
        secure_boot: probe.secure_boot,
        virtualization_enabled: probe.virtualization_firmware_enabled || probe.hypervisor_present,
        hypervisor_present: probe.hypervisor_present,
        restart_required: uefi_optout
            .as_ref()
            .is_some_and(|status| status.pending_restart)
            || pending_own
            || external.pending_restart
            || test_configured.is_some_and(|configured| configured != (probe.dse_mode == 1)),
        can_restore: own_snapshot.is_some()
            || uefi_optout.as_ref().is_some_and(|status| status.active),
        external,
        preferred_boot_mode,
        enable_block_reason,
        test_signing_configured: test_configured,
        test_signing_active: probe.dse_mode == 1,
        dse: dse_status(probe.dse_mode),
        components,
        enabled_count,
        warnings,
        bitlocker,
        kva_shadow,
        uefi_lock,
        uefi_optout,
        conflicts,
    })
}

pub(crate) fn component(
    id: &str,
    name: &str,
    description: &str,
    enabled: bool,
    locked: bool,
) -> VbsComponent {
    VbsComponent {
        id: id.into(),
        name: name.into(),
        description: description.into(),
        state: if locked {
            "locked"
        } else if enabled {
            "enabled"
        } else {
            "disabled"
        }
        .into(),
        enabled,
        locked,
    }
}

pub(crate) fn dse_status(mode: i32) -> VbsDseStatus {
    match mode {
        0 => VbsDseStatus {
            state: "disabled".into(),
            label: "Отключена (DSE OFF)".into(),
            detail: "Windows разрешает загрузку неподписанных гипервизорных драйверов".into(),
        },
        1 => VbsDseStatus {
            state: "testsigning".into(),
            label: "Тестовый режим (Test Signing)".into(),
            detail: "Разрешена загрузка тестово подписанных драйверов (активен Test Mode)".into(),
        },
        2 => VbsDseStatus {
            state: "enabled".into(),
            label: "Включена (DSE ON)".into(),
            detail: "Проверка цифровой подписи драйверов активна в штатном режиме".into(),
        },
        _ => VbsDseStatus {
            state: "unknown".into(),
            label: "Не определено".into(),
            detail: "Система Code Integrity не вернула статус подписи драйверов".into(),
        },
    }
}

pub(crate) fn check_bitlocker() -> BitLockerInfo {
    match crate::windows_probe::bitlocker() {
        Ok(value) => parse_bitlocker(&value.to_string(), is_admin()),
        Err(error) => parse_bitlocker(
            &serde_json::json!({
                "error": "exception", "code": error,
            })
            .to_string(),
            is_admin(),
        ),
    }
}

pub(crate) const BITLOCKER_UNKNOWN_MESSAGE: &str = "Не удалось определить BitLocker. Это не означает отсутствие шифрования; изменения загрузки заблокированы.";
pub(crate) const BITLOCKER_ADMIN_MESSAGE: &str = "Windows сообщает состояние BitLocker только программам с правами администратора. Пока оно не подтверждено, изменения загрузки заблокированы.";

// Разбор типизированного ответа BitLocker (отдельно ради модульных тестов)
pub(crate) fn parse_bitlocker(text: &str, admin: bool) -> BitLockerInfo {
    let text = text.trim_start_matches('\u{feff}').trim();
    let value = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) if value.is_object() => value,
        _ => {
            return bitlocker_unknown(
                false,
                BITLOCKER_UNKNOWN_MESSAGE,
                vec![format!(
                    "Неожиданный ответ Windows: {}",
                    short_diagnostic(text)
                )],
            )
        }
    };
    let field = |name: &str| value[name].as_str().unwrap_or("").trim().to_string();
    if let Some(kind) = value["error"].as_str() {
        let (category, id, code) = (field("category"), field("id"), field("code"));
        let mut diagnostics: Vec<String> = Vec::new();
        for item in [&category, &id, &code] {
            let item = short_diagnostic(item);
            if !item.is_empty() && !diagnostics.contains(&item) {
                diagnostics.push(item);
            }
        }
        if kind == "exception" && bitlocker_access_denied(&category, &id, &code) {
            return if admin {
                bitlocker_unknown(
                    false,
                    "Windows отказала в доступе к состоянию BitLocker даже с правами администратора. Это не означает отсутствие шифрования; изменения загрузки заблокированы.",
                    diagnostics,
                )
            } else {
                bitlocker_unknown(true, BITLOCKER_ADMIN_MESSAGE, diagnostics)
            };
        }
        let message = match kind {
            "volume" => "Системный том не найден среди томов BitLocker. Это не означает отсутствие шифрования; изменения загрузки заблокированы.",
            "api" => "BitLocker API вернул ошибку. Это не означает отсутствие шифрования; изменения загрузки заблокированы.",
            _ => BITLOCKER_UNKNOWN_MESSAGE,
        };
        return bitlocker_unknown(false, message, diagnostics);
    }
    let state = match (value["protection"].as_u64(), value["encrypted"].as_u64()) {
        (Some(1), Some(_)) => "protected",
        (Some(0), Some(0)) => "off",
        (Some(0), Some(_)) => "suspended",
        _ => "unknown",
    };
    let message = match state {
        "protected" => "BitLocker активен. Перед изменением BCD защита будет проверяемо приостановлена на одну перезагрузку; сохраните доступ к ключу восстановления.",
        "suspended" => "Том зашифрован, защита BitLocker приостановлена.",
        "off" => "Системный том не зашифрован BitLocker.",
        _ => "Состояние BitLocker неизвестно. Изменения загрузки заблокированы.",
    };
    BitLockerInfo {
        protected: state == "protected",
        suspended: state == "suspended",
        state: state.into(),
        diagnostics: Vec::new(),
        message: message.into(),
        needs_admin: false,
    }
}

// Неизвестное состояние BitLocker: изменения загрузки остаются заблокированными
pub(crate) fn bitlocker_unknown(
    needs_admin: bool,
    message: &str,
    diagnostics: Vec<String>,
) -> BitLockerInfo {
    BitLockerInfo {
        protected: false,
        suspended: false,
        state: "unknown".into(),
        diagnostics,
        message: message.into(),
        needs_admin,
    }
}

// Отказ в доступе к WMI: PermissionDenied, WBEM_E_ACCESS_DENIED или E_ACCESSDENIED
pub(crate) fn bitlocker_access_denied(category: &str, id: &str, code: &str) -> bool {
    let codes = format!("{id} {code}").to_ascii_lowercase();
    category.eq_ignore_ascii_case("PermissionDenied")
        || codes.contains("0x80041003")
        || codes.contains("0x80070005")
        || codes.contains("unauthorizedaccess")
}

// Короткая однострочная диагностика для карточки (не длиннее 160 символов)
pub(crate) fn short_diagnostic(text: &str) -> String {
    let clean = text
        .split_whitespace()
        .filter(|part| !part.chars().all(|ch| ch == '\u{fffd}'))
        .collect::<Vec<_>>()
        .join(" ");
    if clean.chars().count() <= 160 {
        return clean;
    }
    let mut short: String = clean.chars().take(159).collect();
    short.push('…');
    short
}

pub(crate) fn check_kva_shadow() -> KvaShadowInfo {
    let override_val = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
        "FeatureSettingsOverride",
    );
    let mask_val = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
        "FeatureSettingsOverrideMask",
    );
    let is_disabled = override_val == Some(2) && mask_val == Some(3);

    let native = crate::windows_probe::kva_needed();
    let needed = native.as_ref().copied().unwrap_or(false);

    KvaShadowInfo {
        needed,
        disabled: is_disabled,
        label: if is_disabled {
            "Отключено (твик применён)".into()
        } else if native.is_err() {
            "Не удалось определить состояние KVA Shadow".into()
        } else if needed {
            "Активно (требуется отключение для старых CPU)".into()
        } else {
            "Не требуется (аппаратная изоляция CPU)".into()
        },
    }
}

pub(crate) fn check_uefi_lock() -> UefiLockInfo {
    let vbs_locked = registry_dword(r"SYSTEM\CurrentControlSet\Control\DeviceGuard", "Locked")
        == Some(1)
        || registry_dword(r"SYSTEM\CurrentControlSet\Control\DeviceGuard", "Mandatory") == Some(1);
    let hvci_locked = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
        "Locked",
    ) == Some(1);
    let credential_locked =
        registry_dword(r"SYSTEM\CurrentControlSet\Control\Lsa", "LsaCfgFlags") == Some(1);

    let sec_config_available = system_tool("SecConfig.efi").is_file();

    UefiLockInfo {
        is_locked: vbs_locked || hvci_locked || credential_locked,
        vbs_locked,
        hvci_locked,
        credential_locked,
        sec_config_available,
    }
}

pub(crate) fn check_conflicts() -> Vec<ConflictItem> {
    let mut items = Vec::new();

    // Проверка FACEIT Anti-Cheat
    let faceit_found = run_command("sc.exe", &["query", "FACEIT"])
        .map(|o| {
            let s = String::from_utf8_lossy(&o.stdout);
            s.contains("RUNNING") || s.contains("STOPPED")
        })
        .unwrap_or(false)
        || run_command("fltmc.exe", &[])
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .to_uppercase()
                    .contains("FACEIT")
            })
            .unwrap_or(false);

    if faceit_found {
        items.push(ConflictItem {
            id: "faceit".into(),
            name: "FACEIT Anti-Cheat".into(),
            severity: "critical".into(),
            description:
                "Служба FACEIT полностью блокирует запуск неподписанных гипервизорных драйверов."
                    .into(),
            can_fix: true,
            fix_action: Some("disable_faceit".into()),
        });
    }

    // Проверка MacType
    let mactype_found = run_command("sc.exe", &["query", "MacType"])
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("RUNNING"))
        .unwrap_or(false)
        || run_command("tasklist.exe", &["/FI", "IMAGENAME eq MacType.exe"])
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("MacType.exe"))
            .unwrap_or(false);

    if mactype_found {
        items.push(ConflictItem {
            id: "mactype".into(),
            name: "MacType (Рендеринг шрифтов)".into(),
            severity: "warning".into(),
            description:
                "Служба MacType перехватывает графический вывод и приводит к вылету игр на старте."
                    .into(),
            can_fix: false,
            fix_action: None,
        });
    }

    // Проверка Smart App Control в Windows 11
    if let Some(sac_val) = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\CI\Policy",
        "VerifiedAndReputablePolicyState",
    ) {
        if sac_val == 1 {
            items.push(ConflictItem {
                id: "smart_app_control".into(),
                name: "Smart App Control".into(),
                severity: "warning".into(),
                description: "Smart App Control может блокировать запуск компонентов гипервизора. Рекомендуется отключить в Безопасности Windows.".into(),
                can_fix: false,
                fix_action: None,
            });
        }
    }

    // Проверка Bitdefender ATD
    let bitdefender_found = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\Bitdefender", KEY_READ | KEY_WOW64_64KEY)
        .is_ok();
    if bitdefender_found {
        items.push(ConflictItem {
            id: "bitdefender".into(),
            name: "Bitdefender Advanced Threat Defense".into(),
            severity: "info".into(),
            description: "Может вызывать «Initialization error 5» в играх с VMProtect (Ubisoft/Capcom). Добавьте папку игры в исключения.".into(),
            can_fix: false,
            fix_action: None,
        });
    }

    items
}

// Отключение VBS с созданием снимка и безопасным BitLocker

pub(crate) fn registry_parameters() -> Vec<(&'static str, &'static str)> {
    let mut keys = REGISTRY_TARGETS
        .iter()
        .map(|r| (r.path, r.name))
        .chain(ALL_ENABLE_REGISTRY_TARGETS.iter().map(|r| (r.path, r.name)))
        .collect::<Vec<_>>();
    keys.extend([
        (MEMORY_PATH, "FeatureSettingsOverride"),
        (MEMORY_PATH, "FeatureSettingsOverrideMask"),
        (r"SYSTEM\CurrentControlSet\Services\FACEIT", "Start"),
        (r"SYSTEM\CurrentControlSet\Services\FACEITService", "Start"),
    ]);
    keys.sort();
    keys.dedup();
    keys
}
pub(crate) fn raw_registry(
    path: &str,
    name: &str,
) -> Result<(bool, Option<RawRegistrySnapshot>), String> {
    let key = match RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY)
    {
        Ok(key) => key,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((false, None)),
        Err(e) => return Err(e.to_string()),
    };
    match key.get_raw_value(name) {
        Ok(value) => Ok((
            true,
            Some(RawRegistrySnapshot {
                kind: value.vtype as u32,
                bytes: value.bytes,
            }),
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((true, None)),
        Err(e) => Err(e.to_string()),
    }
}
pub(crate) fn registry_type(kind: u32) -> Result<winreg::enums::RegType, String> {
    use winreg::enums::*;
    Ok(match kind {
        0 => REG_NONE,
        1 => REG_SZ,
        2 => REG_EXPAND_SZ,
        3 => REG_BINARY,
        4 => REG_DWORD,
        5 => REG_DWORD_BIG_ENDIAN,
        6 => REG_LINK,
        7 => REG_MULTI_SZ,
        8 => REG_RESOURCE_LIST,
        9 => REG_FULL_RESOURCE_DESCRIPTOR,
        10 => REG_RESOURCE_REQUIREMENTS_LIST,
        11 => REG_QWORD,
        _ => return Err("Неподдерживаемый тип реестра".into()),
    })
}
pub(crate) fn restore_registry(item: &RegistrySnapshot) -> Result<(), String> {
    if let Some(value) = &item.raw {
        let (key, _) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .create_subkey_with_flags(&item.path, KEY_WRITE | KEY_WOW64_64KEY)
            .map_err(|e| e.to_string())?;
        key.set_raw_value(
            &item.name,
            &winreg::RegValue {
                vtype: registry_type(value.kind)?,
                bytes: value.bytes.clone(),
            },
        )
        .map_err(|e| e.to_string())?;
    } else {
        delete_registry_value(&item.path, &item.name)?;
    }
    if raw_registry(&item.path, &item.name)?.1 != item.raw {
        return Err(format!(
            "Реестр не совпадает со снимком: {}\\{}",
            item.path, item.name
        ));
    }
    Ok(())
}
pub(crate) fn verify_dword(path: &str, name: &str, value: Option<u32>) -> Result<(), String> {
    let raw = raw_registry(path, name)?.1;
    match (raw, value) {
        (None, None) => Ok(()),
        (Some(raw), Some(value)) if raw.kind == 4 && raw.bytes == value.to_le_bytes() => Ok(()),
        _ => Err(format!("Не подтверждён параметр {path}\\{name}")),
    }
}
// Сопоставление имени параметра BCD с учётом внутренних шестнадцатеричных псевдонимов Windows (custom:25000129)
pub(crate) fn matches_bcd_key(key: &str, name: &str) -> bool {
    if key.eq_ignore_ascii_case(name) {
        return true;
    }
    if name.eq_ignore_ascii_case("xsaveremovefeature") {
        let clean = key.to_ascii_lowercase();
        return clean == "custom:25000129"
            || clean == "custom:0x25000129"
            || clean == "25000129"
            || clean == "0x25000129"
            || clean.ends_with("25000129");
    }
    false
}

// Сравнение значений параметров BCD с учётом логических и числовых представлений
pub(crate) fn bcd_values_match(name: &str, current: Option<&str>, expected: Option<&str>) -> bool {
    match (current, expected) {
        (None, None) => true,
        (Some(_), None) | (None, Some(_)) => false,
        (Some(c), Some(e)) => {
            if name == "xsaveremovefeature" {
                match (bcd_integer(c), bcd_integer(e)) {
                    (Some(ci), Some(ei)) => ci == ei,
                    _ => c.eq_ignore_ascii_case(e),
                }
            } else if ["testsigning", "onetimeadvancedoptions", "advancedoptions"].contains(&name) {
                match (bcd_boolean(c), bcd_boolean(e)) {
                    (Some(cb), Some(eb)) => cb == eb,
                    _ => c.eq_ignore_ascii_case(e),
                }
            } else {
                c.eq_ignore_ascii_case(e)
            }
        }
    }
}

pub(crate) fn permitted_bcd_target(entry: &str, name: &str) -> bool {
    (entry == "{current}" && BCD_NAMES.contains(&name))
        || (["{hypervisorsettings}", "{bootloadersettings}"].contains(&entry)
            && name == "hypervisorlaunchtype")
}
pub(crate) fn valid_bcd_value(name: &str, value: Option<&str>) -> bool {
    let Some(value) = value else {
        return true;
    };
    match name {
        "hypervisorlaunchtype" | "vsmlaunchtype" => {
            ["auto", "off"].contains(&value.to_ascii_lowercase().as_str())
        }
        "testsigning" | "onetimeadvancedoptions" | "advancedoptions" => {
            bcd_boolean(value).is_some()
        }
        "xsaveremovefeature" => bcd_integer(value).is_some(),
        _ => false,
    }
}
pub(crate) fn read_bcd(name: &str) -> Result<Option<String>, String> {
    read_bcd_at("{current}", name)
}
pub(crate) fn read_bcd_at(entry: &str, name: &str) -> Result<Option<String>, String> {
    if !permitted_bcd_target(entry, name) {
        return Err("Неразрешённая цель BCD".into());
    }
    let output = run_command("bcdedit.exe", &["/enum", entry])?;
    let text = decode_windows_output(&output.stdout);
    Ok(text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let key = parts.next()?;
        if !matches_bcd_key(key, name) {
            return None;
        }
        let value = parts.collect::<Vec<_>>().join(" ");
        Some(
            if ["testsigning", "onetimeadvancedoptions", "advancedoptions"].contains(&name) {
                bcd_boolean(&value)
                    .map(|v| if v { "on".into() } else { "off".into() })
                    .unwrap_or(value)
            } else if name == "xsaveremovefeature" {
                // Для маски XSAVE сохраняем нормализованное шестнадцатеричное число
                bcd_integer(&value)
                    .map(|num| format!("0x{num:x}"))
                    .unwrap_or_else(|| value.to_ascii_lowercase())
            } else {
                value.to_ascii_lowercase()
            },
        )
    }))
}

pub(crate) fn write_bcd(name: &str, value: Option<&str>) -> Result<(), String> {
    write_bcd_at("{current}", name, value)
}
pub(crate) fn write_bcd_at(entry: &str, name: &str, value: Option<&str>) -> Result<(), String> {
    if !permitted_bcd_target(entry, name) || !valid_bcd_value(name, value) {
        return Err("Неразрешённый параметр BCD".into());
    }
    let current = read_bcd_at(entry, name)?;
    let expected = value.map(|v| {
        if name == "xsaveremovefeature" {
            bcd_integer(v)
                .map(|num| format!("0x{num:x}"))
                .unwrap_or_else(|| v.to_ascii_lowercase())
        } else if ["testsigning", "onetimeadvancedoptions", "advancedoptions"].contains(&name) {
            bcd_boolean(v)
                .map(|b| if b { "on".into() } else { "off".into() })
                .unwrap_or_else(|| v.to_ascii_lowercase())
        } else {
            v.to_ascii_lowercase()
        }
    });

    if bcd_values_match(name, current.as_deref(), expected.as_deref()) {
        return Ok(());
    }

    if let Some(val) = value {
        if let Err(err) = run_command("bcdedit.exe", &["/set", entry, name, val]) {
            // Если по имени не удалось записать xsaveremovefeature, пробуем через идентификатор типа custom:25000129
            if name == "xsaveremovefeature" {
                run_command("bcdedit.exe", &["/set", entry, "custom:25000129", val])
                    .map_err(|_| err)?;
            } else {
                return Err(err);
            }
        }
    } else {
        if let Err(err) = run_command("bcdedit.exe", &["/deletevalue", entry, name]) {
            // Если по имени не удалось удалить xsaveremovefeature, пробуем через идентификатор типа custom:25000129
            if name == "xsaveremovefeature" {
                let _ = run_command("bcdedit.exe", &["/deletevalue", entry, "custom:25000129"]);
            } else {
                // Если элемент и так не существовал в хранилище BCD, bcdedit может возвращать ошибку отсутствия
                let lower = err.to_ascii_lowercase();
                if !lower.contains("не найден")
                    && !lower.contains("not found")
                    && !lower.contains("element not found")
                {
                    return Err(err);
                }
            }
        }
    }

    let updated = read_bcd_at(entry, name)?;
    if !bcd_values_match(name, updated.as_deref(), expected.as_deref()) {
        return Err(format!("BCD {name}: значение после записи не подтверждено"));
    }
    Ok(())
}
pub(crate) fn service_running(name: &str) -> Result<bool, String> {
    let output = run_command("sc.exe", &["query", name])?;
    let text = decode_windows_output(&output.stdout);
    for line in text.lines() {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if let Some(colon) = parts.iter().position(|p| *p == ":") {
            if let Some(code) = parts.get(colon + 1) {
                if *code == "4" {
                    return Ok(true);
                }
                if *code == "1" {
                    return Ok(false);
                }
            }
        }
    }
    Err(format!(
        "Служба {name} находится в переходном или неизвестном состоянии"
    ))
}
pub(crate) fn capture_snapshot() -> Result<VbsSnapshot, String> {
    let bitlocker = check_bitlocker();
    if bitlocker.state == "unknown" {
        return Err(
            "Состояние BitLocker не определено; создание снимка и изменения отменены".into(),
        );
    }
    let mut registry = Vec::new();
    for (path, name) in registry_parameters() {
        let (key_existed, raw) = raw_registry(path, name)?;
        registry.push(RegistrySnapshot {
            path: path.into(),
            name: name.into(),
            value: registry_dword(path, name),
            raw,
            key_existed,
        });
    }
    let mut bcd = Vec::new();
    for name in BCD_NAMES {
        bcd.push(BcdSnapshot {
            entry: "{current}".into(),
            name: (*name).into(),
            value: read_bcd(name)?,
        });
    }
    let mut services = Vec::new();
    for name in ["FACEIT", "FACEITService"] {
        if raw_registry(
            &format!(r"SYSTEM\CurrentControlSet\Services\{name}"),
            "Start",
        )?
        .1
        .is_some()
        {
            services.push(ServiceSnapshot {
                name: name.into(),
                running: service_running(name)?,
            });
        }
    }
    Ok(VbsSnapshot {
        schema_version: 3,
        boot_id: system_probe()?.boot_id,
        scoped_bcd: ["{hypervisorsettings}", "{bootloadersettings}"]
            .iter()
            .filter_map(|entry| {
                read_bcd_at(entry, "hypervisorlaunchtype")
                    .ok()
                    .map(|value| BcdSnapshot {
                        entry: (*entry).into(),
                        name: "hypervisorlaunchtype".into(),
                        value,
                    })
            })
            .collect(),
        registry,
        bcd,
        services,
        bitlocker_state: Some(bitlocker.state),
        hypervisor_launch_type: None,
        vsm_launch_type: None,
        test_signing: None,
        kva_shadow: None,
        faceit_disabled: None,
        uefi_optout_configured: false,
        efi_backup: None,
        efi_file_existed: false,
        bitlocker_was_suspended: false,
    })
}

pub(crate) fn system_probe() -> Result<SystemProbe, String> {
    let value = crate::windows_probe::probe()?;
    Ok(SystemProbe {
        vbs_status: value.vbs_status,
        configured_services: value.configured_services,
        running_services: value.running_services,
        hypervisor_present: value.hypervisor_present,
        virtualization_firmware_enabled: value.virtualization_firmware_enabled,
        secure_boot: value.secure_boot,
        dse_mode: value.dse_mode,
        boot_id: value.boot_id,
    })
}

pub(crate) fn parse_service_ids(value: &str) -> Vec<i32> {
    value
        .split(',')
        .filter_map(|item| item.trim().parse::<i32>().ok())
        .collect()
}

// Не отключаем изоляцию учётных данных, пока Windows Hello остаётся способом входа.
pub(crate) fn windows_hello_preflight() -> Result<(), String> {
    let (_, enabled) = raw_registry(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\WindowsHello",
        "Enabled",
    )?;
    let Some(enabled) = enabled else {
        return Ok(());
    };
    if enabled.kind != 4 || enabled.bytes.len() != 4 {
        return Err("Windows Hello: тип настройки не определён; изменения отменены".into());
    }
    if enabled.bytes != 1u32.to_le_bytes() {
        return Ok(());
    }
    let sid = crate::windows_token::current_sid()?;
    if !sid.starts_with("S-1-")
        || !sid
            .bytes()
            .all(|b| b == b'-' || b == b'S' || b.is_ascii_digit())
    {
        return Err("Не удалось проверить учётные данные Windows Hello; изменения отменены".into());
    }
    let path = format!(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\{{D6886603-9D2F-4EB2-B667-1971041FA96B}}\{sid}"
    );
    let (_, credential) = raw_registry(&path, "LogonCredsAvailable")?;
    if let Some(credential) = credential {
        if credential.kind != 4 || credential.bytes.len() != 4 {
            return Err(
                "Не удалось проверить учётные данные Windows Hello; изменения отменены".into(),
            );
        }
        if credential.bytes == 1u32.to_le_bytes() {
            return Err("Windows Hello используется для входа. Сначала настройте обычный пароль и вручную отключите Windows Hello в параметрах входа Windows; затем повторите проверку.".into());
        }
    }
    Ok(())
}

pub(crate) fn registry_dword(path: &str, name: &str) -> Option<u32> {
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY)
        .ok()?
        .get_value(name)
        .ok()
}

pub(crate) fn registry_enabled(path: &str, name: &str) -> bool {
    registry_dword(path, name).is_some_and(|value| value > 0)
}

pub(crate) fn set_registry_dword(path: &str, name: &str, value: u32) -> Result<(), String> {
    let (key, _) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .create_subkey_with_flags(path, KEY_WRITE | KEY_WOW64_64KEY)
        .map_err(|error| format!("HKLM\\{path}\\{name}: {error}"))?;
    key.set_value(name, &value)
        .map_err(|error| format!("HKLM\\{path}\\{name}: {error}"))
}

pub(crate) fn delete_registry_value(path: &str, name: &str) -> Result<(), String> {
    let key = match RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(path, KEY_WRITE | KEY_WOW64_64KEY)
    {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("HKLM\\{path}\\{name}: {error}")),
    };
    match key.delete_value(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("HKLM\\{path}\\{name}: {error}")),
    }
}

pub(crate) fn bcd_boolean(value: &str) -> Option<bool> {
    match value.trim().to_lowercase().as_str() {
        "yes" | "on" | "true" | "1" | "да" => Some(true),
        "no" | "off" | "false" | "0" | "нет" => Some(false),
        _ => None,
    }
}

pub(crate) fn test_signing_from_bcd(text: &str) -> Option<bool> {
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        if parts
            .next()
            .is_some_and(|key| key.eq_ignore_ascii_case("testsigning"))
        {
            return parts.next().and_then(bcd_boolean);
        }
    }
    Some(false)
}

pub(crate) fn configured_test_signing() -> Option<bool> {
    let output = run_command("bcdedit.exe", &["/enum", "{current}"]).ok()?;
    test_signing_from_bcd(&decode_windows_output(&output.stdout))
}

pub(crate) fn snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Не удалось определить папку приложения: {error}"))?
        .join("vbs")
        .join("restore-state.json"))
}

pub(crate) fn powershell_output(script: &str) -> Result<String, String> {
    // UTF-8 без BOM: иначе русские сообщения Windows приходят в кодировке консоли и искажаются
    let script = format!(
        "try{{[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)}}catch{{}}\n{script}"
    );
    let output = run_command(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ],
    )?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_start_matches('\u{feff}')
        .trim()
        .to_string())
}

// bcdedit/sc выводят локализованный текст в OEM-кодировке, не обязательно UTF-8.
pub(crate) fn decode_windows_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    #[cfg(windows)]
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetOEMCP() -> u32;
            fn MultiByteToWideChar(
                code_page: u32,
                flags: u32,
                source: *const u8,
                source_len: i32,
                target: *mut u16,
                target_len: i32,
            ) -> i32;
        }
        if bytes.len() <= i32::MAX as usize {
            let page = GetOEMCP();
            let count = MultiByteToWideChar(
                page,
                0,
                bytes.as_ptr(),
                bytes.len() as i32,
                std::ptr::null_mut(),
                0,
            );
            if count > 0 {
                let mut wide = vec![0u16; count as usize];
                if MultiByteToWideChar(
                    page,
                    0,
                    bytes.as_ptr(),
                    bytes.len() as i32,
                    wide.as_mut_ptr(),
                    count,
                ) == count
                {
                    return String::from_utf16_lossy(&wide);
                }
            }
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

pub(crate) fn run_command(program: &str, args: &[&str]) -> Result<Output, String> {
    // Для системных утилит не используем текущую папку и пользовательский PATH.
    let executable = match program {
        "powershell.exe" => system_tool(r"WindowsPowerShell\v1.0\powershell.exe"),
        "winmgmt.exe" => system_tool(r"wbem\winmgmt.exe"),
        "bcdedit.exe" | "sc.exe" | "manage-bde.exe" | "mountvol.exe" | "shutdown.exe"
        | "fltmc.exe" | "tasklist.exe" => system_tool(program),
        _ => return Err("Неразрешённая системная утилита VBS".into()),
    };
    let mut command = crate::process_util::hidden_path_command(&executable);
    command.args(args);
    let output = command
        .output()
        .map_err(|error| format!("Не удалось запустить {program}: {error}"))?;
    if output.status.success() {
        Ok(output)
    } else {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if !error.is_empty() { error } else { stdout })
    }
}

pub(crate) fn is_admin() -> bool {
    crate::elevation::is_elevated().unwrap_or(false)
}
