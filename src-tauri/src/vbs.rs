// Модуль VBS 2.0: расширенное управление изоляцией ядра, защитой целостности памяти (HVCI),
// безопасностью BitLocker, Meltdown mitigation (KVA Shadow), UEFI Lock и системным гипервизором Windows.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};
use tauri::{AppHandle, Manager};
use winreg::{
    enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY, KEY_WRITE},
    RegKey,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Copy)]
struct RegistryTarget {
    path: &'static str,
    name: &'static str,
    disabled_value: u32,
}

// Реестровые параметры Device Guard, LSA, биометрии и виртуализации
const REGISTRY_TARGETS: &[RegistryTarget] = &[
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
        name: "EnableVirtualizationBasedSecurity",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\CI\Config",
        name: "VulnerableDriverBlocklistEnable",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard",
        name: "EnableVirtualizationBasedSecurity",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
        name: "Enabled",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\CredentialGuard",
        name: "Enabled",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\Lsa",
        name: "LsaCfgFlags",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard",
        name: "LsaCfgFlags",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SystemGuard",
        name: "Enabled",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HyperGuard",
        name: "Enabled",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\Host-Guardian",
        name: "Enabled",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
        name: "DisableHypervisorEnforcedPagingTranslation",
        disabled_value: 1,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
        name: "Mandatory",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SecureBiometrics",
        name: "Enabled",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios",
        name: "SecureBiometrics",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\WindowsHelloSecureBiometrics",
        name: "Enabled",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SecureFingerprint",
        name: "Enabled",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios",
        name: "SecureFingerprint",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\WindowsHelloSecureFingerprint",
        name: "Enabled",
        disabled_value: 0,
    },
    RegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\WindowsHello",
        name: "Enabled",
        disabled_value: 0,
    },
];

#[derive(Clone, Copy)]
struct EnableRegistryTarget {
    path: &'static str,
    name: &'static str,
    enabled_value: u32,
}

// Реестровые параметры для полного принудительного включения всех механизмов безопасности ядра Windows
const ALL_ENABLE_REGISTRY_TARGETS: &[EnableRegistryTarget] = &[
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
        name: "EnableVirtualizationBasedSecurity",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
        name: "RequirePlatformSecurityFeatures",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard",
        name: "EnableVirtualizationBasedSecurity",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\CI\Config",
        name: "VulnerableDriverBlocklistEnable",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
        name: "Enabled",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
        name: "WasEnabledBy",
        enabled_value: 2,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\CredentialGuard",
        name: "Enabled",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\Lsa",
        name: "LsaCfgFlags",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard",
        name: "LsaCfgFlags",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SystemGuard",
        name: "Enabled",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HyperGuard",
        name: "Enabled",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\Host-Guardian",
        name: "Enabled",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SecureBiometrics",
        name: "Enabled",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios",
        name: "SecureBiometrics",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\WindowsHelloSecureBiometrics",
        name: "Enabled",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SecureFingerprint",
        name: "Enabled",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios",
        name: "SecureFingerprint",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\WindowsHelloSecureFingerprint",
        name: "Enabled",
        enabled_value: 1,
    },
    EnableRegistryTarget {
        path: r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\WindowsHello",
        name: "Enabled",
        enabled_value: 1,
    },
];

// Чтение младших 32 бит маски расширенных состояний процессора (XCR0)
// из системной структуры KUSER_SHARED_DATA (фиксированный адрес 0x7FFE03D8 в пространстве пользователя Windows).
// Если значение > 7, в процессоре активен AVX-512 (регистры zmm0..zmm31), требующий
// BCD-параметра xsaveremovefeature для исключения сбоев гипервизорного хука при переключении XSAVE.
#[cfg(all(windows, target_arch = "x86_64"))]
fn read_xcr0() -> u32 {
    unsafe {
        let ptr = 0x7FFE03D8 as *const u32;
        *ptr
    }
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
fn read_xcr0() -> u32 {
    0
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SystemProbe {
    vbs_status: i32,
    configured_services: String,
    running_services: String,
    hypervisor_present: bool,
    virtualization_firmware_enabled: bool,
    secure_boot: String,
    dse_mode: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VbsDseStatus {
    state: String,
    label: String,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VbsComponent {
    id: String,
    name: String,
    description: String,
    state: String,
    enabled: bool,
    locked: bool,
}

// Статус защиты BitLocker для безопасной перезагрузки
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BitLockerInfo {
    pub state: String,
    pub diagnostics: Vec<String>,
    pub protected: bool,
    pub suspended: bool,
    pub message: String,
    // Состояние скрыто от процесса без прав администратора (WMI отказал в доступе)
    #[serde(default)]
    pub needs_admin: bool,
}

// Статус защиты Meltdown (KVA Shadow) для старых процессоров
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KvaShadowInfo {
    pub needed: bool,
    pub disabled: bool,
    pub label: String,
}

// Сведения о блокировке параметров в UEFI
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UefiLockInfo {
    pub is_locked: bool,
    pub vbs_locked: bool,
    pub hvci_locked: bool,
    pub credential_locked: bool,
    pub sec_config_available: bool,
}

// Конфликтующее стороннее ПО (античиты, утилиты)
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictItem {
    pub id: String,
    pub name: String,
    pub severity: String,
    pub description: String,
    pub can_fix: bool,
    pub fix_action: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VbsReport {
    admin: bool,
    secure_boot: String,
    virtualization_enabled: bool,
    hypervisor_present: bool,
    restart_required: bool,
    can_restore: bool,
    test_signing_configured: Option<bool>,
    test_signing_active: bool,
    dse: VbsDseStatus,
    components: Vec<VbsComponent>,
    enabled_count: usize,
    warnings: Vec<String>,
    // Расширения VBS 2.0
    bitlocker: BitLockerInfo,
    kva_shadow: KvaShadowInfo,
    uefi_lock: UefiLockInfo,
    conflicts: Vec<ConflictItem>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VbsChangeResult {
    success: bool,
    message: String,
    changed: usize,
    failed: Vec<String>,
    restart_required: bool,
}

// Отдельный элемент защиты для раздела тонкого управления
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndividualProtection {
    pub id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub enabled: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistrySnapshot {
    path: String,
    name: String,
    value: Option<u32>,
    #[serde(default)]
    raw: Option<RawRegistrySnapshot>,
    #[serde(default)]
    key_existed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRegistrySnapshot {
    kind: u32,
    bytes: Vec<u8>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BcdSnapshot {
    entry: String,
    name: String,
    value: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ServiceSnapshot {
    name: String,
    running: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VbsSnapshot {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    bcd: Vec<BcdSnapshot>,
    #[serde(default)]
    services: Vec<ServiceSnapshot>,
    #[serde(default)]
    bitlocker_state: Option<String>,
    registry: Vec<RegistrySnapshot>,
    hypervisor_launch_type: Option<String>,
    vsm_launch_type: Option<String>,
    #[serde(default)]
    test_signing: Option<String>,
    #[serde(default)]
    kva_shadow: Option<bool>,
    #[serde(default)]
    faceit_disabled: Option<bool>,
}

#[derive(Clone, Copy)]
enum BootMode {
    AdvancedOptions,
    TestSigning,
}

fn boot_changes(mode: BootMode) -> Vec<(&'static str, &'static str)> {
    let mut changes = vec![("hypervisorlaunchtype", "off"), ("vsmlaunchtype", "off")];
    match mode {
        BootMode::AdvancedOptions => changes.push(("onetimeadvancedoptions", "on")),
        BootMode::TestSigning => changes.push(("testsigning", "on")),
    }
    changes
}

// Сканирование состояния системы в рамках VBS 2.0
#[tauri::command]
pub(crate) async fn vbs_scan(app: AppHandle) -> Result<VbsReport, String> {
    tauri::async_runtime::spawn_blocking(move || scan_report(&app))
        .await
        .map_err(|error| format!("Проверка VBS 2.0 была прервана: {error}"))?
}

// Отключение VBS и подготовка к запуску неподписанных драйверов
#[tauri::command]
pub(crate) async fn vbs_disable(app: AppHandle) -> Result<VbsChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Изменение VBS",
            || disable_vbs(&app, BootMode::AdvancedOptions),
        )?
    })
    .await
    .map_err(|error| format!("Отключение VBS было прервано: {error}"))?
}

// Восстановление исходного состояния VBS из снимка
#[tauri::command]
pub(crate) async fn vbs_restore(app: AppHandle) -> Result<VbsChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Возврат исходных параметров Windows",
            || restore_vbs(&app, false),
        )?
    })
    .await
    .map_err(|error| format!("Восстановление VBS было прервано: {error}"))?
}

// Принудительное включение всех защитных механизмов ядра Windows
// (VBS, HVCI, изоляция памяти, блокировка уязвимых драйверов, Credential Guard)
// с возможностью немедленной перезагрузки системы.
#[tauri::command]
pub(crate) async fn vbs_enable_all(
    app: AppHandle,
    reboot: bool,
) -> Result<VbsChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Включение защит Windows",
            || enable_all_protections(&app, reboot),
        )?
    })
    .await
    .map_err(|error| format!("Включение всех защит было прервано: {error}"))?
}

// Переключение тестового режима Windows (Testsigning)
#[tauri::command]
pub(crate) async fn vbs_set_test_mode(
    app: AppHandle,
    enabled: bool,
) -> Result<VbsChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Тестовый режим Windows",
            || {
                if enabled {
                    disable_vbs(&app, BootMode::TestSigning)
                } else {
                    restore_vbs(&app, true)
                }
            },
        )?
    })
    .await
    .map_err(|error| format!("Изменение тестового режима было прервано: {error}"))?
}

// Получение списка всех защит ядра и процессора для индивидуального управления
#[tauri::command]
pub(crate) async fn vbs_get_protections(
    app: AppHandle,
) -> Result<Vec<IndividualProtection>, String> {
    tauri::async_runtime::spawn_blocking(move || get_individual_protections(&app))
        .await
        .map_err(|error| format!("Получение списка защит прервано: {error}"))?
}

// Переключение отдельного компонента защиты
#[tauri::command]
pub(crate) async fn vbs_set_protection(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<VbsChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Изменение компонента защиты",
            || set_individual_protection(&app, &id, enabled),
        )?
    })
    .await
    .map_err(|error| format!("Изменение защиты прервано: {error}"))?
}

// Быстрый перезапуск компьютера для применения параметров
#[tauri::command]
pub(crate) fn vbs_restart() -> Result<(), String> {
    run_command("shutdown.exe", &["/r", "/t", "0"])
        .map(|_| ())
        .map_err(|error| format!("Не удалось перезапустить Windows: {error}"))
}

// Подготовка снятия аппаратной блокировки UEFI через SecConfig.efi
#[tauri::command]
pub(crate) async fn vbs_prepare_uefi_optout() -> Result<String, String> {
    Err("Автоматическое изменение EFI/UEFI отключено: для него не реализован проверяемый симметричный откат. Параметры EFI не изменялись.".into())
}

#[tauri::command]
pub(crate) async fn vbs_disable_faceit(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Изменение служб FACEIT",
            || -> Result<String, String> {
                if !is_admin() {
                    return Err("Требуются права администратора".into());
                }
                let snapshot = ensure_snapshot(&app)?;
                let mut errors = Vec::new();
                for service in &snapshot.services {
                    if service.running {
                        if let Err(e) = run_command("sc.exe", &["stop", &service.name]) {
                            errors.push(e);
                        }
                    }
                    if let Err(e) =
                        run_command("sc.exe", &["config", &service.name, "start=", "disabled"])
                    {
                        errors.push(e);
                    }
                    if registry_dword(
                        &format!(r"SYSTEM\CurrentControlSet\Services\{}", service.name),
                        "Start",
                    ) != Some(4)
                    {
                        errors.push(format!("Режим запуска {} не подтверждён", service.name));
                    }
                }
                if errors.is_empty() {
                    Ok(
                        "Изменения служб проверены. Исходные параметры сохранены для возврата."
                            .into(),
                    )
                } else {
                    Err(format!(
                        "Выполнено частично; снимок сохранён: {}",
                        errors.join("; ")
                    ))
                }
            },
        )?
    })
    .await
    .map_err(|e| e.to_string())?
}

// Инструменты устранения системных неполадок (WMI, SFC, DISM)
#[tauri::command]
pub(crate) async fn vbs_troubleshoot(app: AppHandle, action: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::jobs::run(&[crate::jobs::system_resource(&app)], "Диагностика Windows без изменений", || {
        let output = match action.as_str() {
            "wmi"=>run_command("winmgmt.exe", &["/verifyrepository"]),
            "sfc"=>run_command("sfc.exe", &["/verifyonly"]),
            "dism"=>run_command("dism.exe", &["/online","/cleanup-image","/scanhealth"]),
            _=>return Err("Неизвестная диагностика".into())
        }?;
        Ok(format!("Диагностика без автоматического ремонта завершена. Это не утверждение об отсутствии проблем.\n{}",String::from_utf8_lossy(&output.stdout)))
    })?).await.map_err(|e|e.to_string())?
}

// Сбор полного отчёта VBS 2.0
fn scan_report(app: &AppHandle) -> Result<VbsReport, String> {
    let probe = system_probe()?;
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

    let uefi_lock = check_uefi_lock();
    let bitlocker = check_bitlocker();
    let kva_shadow = check_kva_shadow();
    let conflicts = check_conflicts();

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

    Ok(VbsReport {
        admin: is_admin(),
        secure_boot: probe.secure_boot,
        virtualization_enabled: probe.virtualization_firmware_enabled || probe.hypervisor_present,
        hypervisor_present: probe.hypervisor_present,
        restart_required: snapshot_path(app)?.exists(),
        can_restore: snapshot_path(app)?.exists(),
        test_signing_configured: configured_test_signing(),
        test_signing_active: probe.dse_mode == 1,
        dse: dse_status(probe.dse_mode),
        components,
        enabled_count,
        warnings,
        bitlocker,
        kva_shadow,
        uefi_lock,
        conflicts,
    })
}

fn component(id: &str, name: &str, description: &str, enabled: bool, locked: bool) -> VbsComponent {
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

fn dse_status(mode: i32) -> VbsDseStatus {
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

// Проверка статуса BitLocker
fn check_bitlocker() -> BitLockerInfo {
    // Скрипт всегда печатает ASCII-JSON: локализованный текст ошибок PowerShell в интерфейс
    // не попадает, а категория и код ошибки позволяют распознать нехватку прав
    let script = r#"$ErrorActionPreference='Stop'
try {
  $d=$env:SystemDrive
  $v=Get-CimInstance -Namespace 'root/CIMV2/Security/MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -Filter "DriveLetter='$d'"
  if(!$v){ $r=@{error='volume'} }
  else {
    $p=Invoke-CimMethod -InputObject $v -MethodName GetProtectionStatus
    $c=Invoke-CimMethod -InputObject $v -MethodName GetConversionStatus
    if($p.ReturnValue -ne 0 -or $c.ReturnValue -ne 0){ $r=@{error='api';code=('0x{0:X8}/0x{1:X8}' -f $p.ReturnValue,$c.ReturnValue)} }
    else { $r=@{protection=[int]$p.ProtectionStatus;encrypted=[int]$c.EncryptionPercentage} }
  }
} catch {
  $r=@{error='exception';category=[string]$_.CategoryInfo.Category;id=[string]$_.FullyQualifiedErrorId;code=('0x{0:X8}' -f $_.Exception.HResult)}
}
$r | ConvertTo-Json -Compress
"#;
    match powershell_output(script) {
        Ok(text) => parse_bitlocker(&text, is_admin()),
        Err(error) => bitlocker_unknown(
            false,
            BITLOCKER_UNKNOWN_MESSAGE,
            vec![short_diagnostic(&error)],
        ),
    }
}

const BITLOCKER_UNKNOWN_MESSAGE: &str = "Не удалось определить BitLocker. Это не означает отсутствие шифрования; изменения загрузки заблокированы.";
const BITLOCKER_ADMIN_MESSAGE: &str = "Windows сообщает состояние BitLocker только программам с правами администратора. Пока оно не подтверждено, изменения загрузки заблокированы.";

// Разбор ответа скрипта BitLocker (отдельная функция ради модульных тестов)
fn parse_bitlocker(text: &str, admin: bool) -> BitLockerInfo {
    let text = text.trim_start_matches('\u{feff}').trim();
    let value = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) if value.is_object() => value,
        _ => {
            return bitlocker_unknown(
                false,
                BITLOCKER_UNKNOWN_MESSAGE,
                vec![format!(
                    "Неожиданный ответ PowerShell: {}",
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
fn bitlocker_unknown(needs_admin: bool, message: &str, diagnostics: Vec<String>) -> BitLockerInfo {
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
fn bitlocker_access_denied(category: &str, id: &str, code: &str) -> bool {
    let codes = format!("{id} {code}").to_ascii_lowercase();
    category.eq_ignore_ascii_case("PermissionDenied")
        || codes.contains("0x80041003")
        || codes.contains("0x80070005")
        || codes.contains("unauthorizedaccess")
}

// Короткая однострочная диагностика для карточки (не длиннее 160 символов)
fn short_diagnostic(text: &str) -> String {
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

// Проверка KVA Shadow (защита от Meltdown)
fn check_kva_shadow() -> KvaShadowInfo {
    let override_val = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
        "FeatureSettingsOverride",
    );
    let mask_val = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
        "FeatureSettingsOverrideMask",
    );
    let is_disabled = override_val == Some(2) && mask_val == Some(3);

    // Быстрый опрос ядра через PowerShell для выявления необходимости KVA Shadow
    let script = r#"
try {
  $d=Add-Type -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtQuerySystemInformation(uint a,IntPtr b,uint c,IntPtr d);' -Name KvaProbe -Namespace Crocodile -PassThru
  $p=[Runtime.InteropServices.Marshal]::AllocHGlobal(4)
  $r=[Runtime.InteropServices.Marshal]::AllocHGlobal(4)
  $ret=$d::NtQuerySystemInformation(196,$p,4,$r)
  if($ret -eq 0){
    $f=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($p)
    if(($f -band 0x01)-ne 0 -or (($f -band 0x20)-ne 0 -and ($f -band 0x10)-ne 0)){1}else{0}
  }else{0}
} catch {0}
"#;
    let needed = powershell_output(script)
        .map(|s| s.trim() == "1")
        .unwrap_or(false);

    KvaShadowInfo {
        needed,
        disabled: is_disabled,
        label: if is_disabled {
            "Отключено (твик применён)".into()
        } else if needed {
            "Активно (требуется отключение для старых CPU)".into()
        } else {
            "Не требуется (аппаратная изоляция CPU)".into()
        },
    }
}

// Проверка блокировки параметров в UEFI
fn check_uefi_lock() -> UefiLockInfo {
    let vbs_locked = registry_dword(r"SYSTEM\CurrentControlSet\Control\DeviceGuard", "Locked")
        == Some(1)
        || registry_dword(r"SYSTEM\CurrentControlSet\Control\DeviceGuard", "Mandatory") == Some(1);
    let hvci_locked = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
        "Locked",
    ) == Some(1);
    let credential_locked =
        registry_dword(r"SYSTEM\CurrentControlSet\Control\Lsa", "LsaCfgFlags") == Some(1);

    let sec_config_available = PathBuf::from(r"C:\Windows\System32\SecConfig.efi").exists();

    UefiLockInfo {
        is_locked: vbs_locked || hvci_locked || credential_locked,
        vbs_locked,
        hvci_locked,
        credential_locked,
        sec_config_available,
    }
}

// Поиск конфликтующих служб и защитных механизмов
fn check_conflicts() -> Vec<ConflictItem> {
    let mut items = Vec::new();

    // 1. FACEIT Anti-Cheat
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

    // 2. MacType
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

    // 3. Smart App Control (Windows 11)
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

    // 4. Bitdefender ATD
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
fn ensure_snapshot(app: &AppHandle) -> Result<VbsSnapshot, String> {
    let path = snapshot_path(app)?;
    if path.exists() {
        return read_snapshot(app);
    }
    let snapshot = capture_snapshot()?;
    let data = crate::secure_state::crypt(
        &serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?,
        true,
    )?;
    crate::durable::write(&path, &data)?;
    let verified = read_snapshot(app)?;
    if verified.schema_version != 2 {
        return Err("Снимок не прошёл проверку".into());
    }
    Ok(verified)
}
fn read_snapshot(app: &AppHandle) -> Result<VbsSnapshot, String> {
    let data = fs::read(snapshot_path(app)?)
        .map_err(|e| format!("Нет проверяемого снимка восстановления: {e}"))?;
    let decoded = crate::secure_state::crypt(&data, false).map_err(|_| "Старый или неподтверждённый снимок VBS. Он сохранён, но точный автоматический откат по нему невозможен.")?;
    let snapshot: VbsSnapshot = serde_json::from_slice(&decoded).map_err(|e| e.to_string())?;
    if snapshot.schema_version != 2 {
        return Err("Версия снимка не поддерживает точный откат".into());
    }
    if snapshot
        .services
        .iter()
        .any(|s| !["FACEIT", "FACEITService"].contains(&s.name.as_str()))
    {
        return Err("Недопустимая служба в снимке".into());
    }
    let permitted = registry_parameters();
    if snapshot.registry.len() != permitted.len()
        || snapshot
            .registry
            .iter()
            .any(|r| !permitted.iter().any(|(p, n)| *p == r.path && *n == r.name))
        || snapshot.bcd.len() != BCD_NAMES.len()
        || snapshot
            .bcd
            .iter()
            .any(|b| b.entry != "{current}" || !BCD_NAMES.contains(&b.name.as_str()))
    {
        return Err("Снимок не соответствует разрешённым параметрам".into());
    }
    Ok(snapshot)
}
fn prepare_bitlocker(snapshot: &VbsSnapshot) -> Result<(), String> {
    let status = check_bitlocker();
    if status.state == "unknown" {
        return Err(format!(
            "Состояние BitLocker неизвестно. Изменения загрузки отменены. {}",
            status.message
        ));
    }
    if status.protected {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        run_command(
            "manage-bde.exe",
            &["-protectors", "-disable", &drive, "-rebootcount", "1"],
        )?;
        let after = check_bitlocker();
        if after.state != "suspended" {
            return Err("Приостановка BitLocker не подтверждена. Остальные изменения отменены; снимок сохранён.".into());
        }
    } else if snapshot.bitlocker_state.as_deref() == Some("unknown") {
        return Err("Снимок не содержит известного состояния BitLocker".into());
    }
    Ok(())
}
fn change_result(changed: usize, failed: Vec<String>, success_message: &str) -> VbsChangeResult {
    VbsChangeResult {
        success: failed.is_empty(),
        message: if failed.is_empty() {
            success_message.into()
        } else {
            "Выполнено частично: некоторые параметры не подтверждены; снимок сохранён".into()
        },
        changed,
        failed,
        restart_required: changed > 0,
    }
}
fn disable_vbs(app: &AppHandle, mode: BootMode) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Для изменения параметров запустите программу от имени администратора".into());
    }
    let test_mode = matches!(mode, BootMode::TestSigning);
    if test_mode && system_probe()?.secure_boot == "true" {
        return Err("Тестовый режим недоступен при включённом Secure Boot".into());
    }
    let snapshot = ensure_snapshot(app)?;
    prepare_bitlocker(&snapshot)?;
    let mut changed = 0;
    let mut failed = Vec::new();
    for target in REGISTRY_TARGETS {
        match set_registry_dword(target.path, target.name, target.disabled_value)
            .and_then(|_| verify_dword(target.path, target.name, Some(target.disabled_value)))
        {
            Ok(()) => changed += 1,
            Err(e) => failed.push(e),
        }
    }
    let kva = check_kva_shadow();
    if kva.needed && !kva.disabled {
        for (name, value) in [
            ("FeatureSettingsOverride", 2),
            ("FeatureSettingsOverrideMask", 3),
        ] {
            match set_registry_dword(MEMORY_PATH, name, value)
                .and_then(|_| verify_dword(MEMORY_PATH, name, Some(value)))
            {
                Ok(()) => changed += 1,
                Err(e) => failed.push(e),
            }
        }
    }
    for (name, value) in boot_changes(mode) {
        match write_bcd(name, Some(value)) {
            Ok(()) => changed += 1,
            Err(e) => failed.push(e),
        }
    }
    if read_xcr0() > 7 {
        match write_bcd(XSAVE_BCD, Some(XSAVE_HV_MASK_VALUE)) {
            Ok(()) => changed += 1,
            Err(e) => failed.push(e),
        }
    }
    Ok(change_result(changed,failed,"Параметры изменены и проверены. Если BitLocker был активен, защита приостановлена только на одну перезагрузку. Перезапустите Windows."))
}
fn restore_vbs(app: &AppHandle, _disable_test_mode: bool) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Для восстановления запустите программу от имени администратора".into());
    }
    let snapshot = read_snapshot(app)?;
    prepare_bitlocker(&snapshot)?;
    let mut changed = 0;
    let mut failed = Vec::new();
    for item in &snapshot.registry {
        let result = restore_registry(item);
        match result {
            Ok(()) => changed += 1,
            Err(e) => failed.push(e),
        }
    }
    // Маска XSAVE визора снимается, даже если стояла до снимка (Eclipse-HV, VBS.cmd)
    let xsave_mask_set = read_bcd(XSAVE_BCD).ok().flatten().is_some();
    let mut xsave_mask_removed = false;
    for item in &snapshot.bcd {
        let value = restore_bcd_value(&item.name, item.value.as_deref());
        match write_bcd(&item.name, value) {
            Ok(()) => {
                changed += 1;
                xsave_mask_removed |= xsave_mask_set && item.name == XSAVE_BCD && value.is_none();
            }
            Err(e) => failed.push(e),
        }
    }
    if snapshot.bitlocker_state.as_deref() == Some("protected") {
        let state = check_bitlocker();
        if state.state == "suspended" {
            let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
            if let Err(e) = run_command("manage-bde.exe", &["-protectors", "-enable", &drive]) {
                failed.push(e);
            }
        }
        if check_bitlocker().state != "protected" {
            failed.push("Исходная защита BitLocker не подтверждена".into());
        }
    }
    for service in &snapshot.services {
        let result = run_command(
            "sc.exe",
            &[
                if service.running { "start" } else { "stop" },
                &service.name,
            ],
        );
        if service_running(&service.name).ok() != Some(service.running) {
            failed.push(format!(
                "Служба {}: {}",
                service.name,
                result
                    .err()
                    .unwrap_or_else(|| "исходное состояние не подтверждено".into())
            ));
        }
    }
    if failed.is_empty() {
        fs::remove_file(snapshot_path(app)?).map_err(|e| e.to_string())?;
    }
    let mut message =
        String::from("Исходные значения реестра, BCD и служб возвращены и проверены.");
    if xsave_mask_removed {
        message.push(' ');
        message.push_str(XSAVE_REMOVED_MESSAGE);
    }
    message.push_str(" Для применения параметров загрузки требуется перезапуск Windows.");
    Ok(change_result(changed, failed, &message))
}
fn enable_all_protections(app: &AppHandle, reboot: bool) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Для изменения параметров требуются права администратора".into());
    }
    let snapshot = ensure_snapshot(app)?;
    prepare_bitlocker(&snapshot)?;
    let mut changed = 0;
    let mut failed = Vec::new();
    for target in ALL_ENABLE_REGISTRY_TARGETS {
        match set_registry_dword(target.path, target.name, target.enabled_value)
            .and_then(|_| verify_dword(target.path, target.name, Some(target.enabled_value)))
        {
            Ok(()) => changed += 1,
            Err(e) => failed.push(e),
        }
    }
    for name in ["FeatureSettingsOverride", "FeatureSettingsOverrideMask"] {
        match delete_registry_value(MEMORY_PATH, name)
            .and_then(|_| verify_dword(MEMORY_PATH, name, None))
        {
            Ok(()) => changed += 1,
            Err(e) => failed.push(e),
        }
    }
    for (name, value) in [
        ("hypervisorlaunchtype", Some("auto")),
        ("vsmlaunchtype", Some("auto")),
        ("testsigning", Some("off")),
        ("xsaveremovefeature", None),
        ("onetimeadvancedoptions", None),
        ("advancedoptions", None),
    ] {
        match write_bcd(name, value) {
            Ok(()) => changed += 1,
            Err(e) => failed.push(e),
        }
    }
    // Сторонние ключи и режимы запуска служб здесь больше не сбрасываются.
    if reboot && failed.is_empty() {
        if let Err(e) = run_command("shutdown.exe", &["/r", "/t", "5"]) {
            failed.push(e);
        }
    }
    Ok(change_result(changed,failed,"Параметры защиты включены и проверены. Снимок исходных значений сохранён для точного возврата."))
}
const MEMORY_PATH: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management";
const BCD_NAMES: &[&str] = &[
    "hypervisorlaunchtype",
    "vsmlaunchtype",
    "testsigning",
    "onetimeadvancedoptions",
    "xsaveremovefeature",
    "advancedoptions",
];
// Маска XSAVE визора: её ставят «Включить визор», Eclipse-HV и VBS.cmd на процессорах с XCR0 > 7.
// Программам остаются только x87, SSE и AVX, AVX-512 и другие расширения скрываются.
const XSAVE_BCD: &str = "xsaveremovefeature";
const XSAVE_HV_MASK: u64 = 0xFFFF_FFFF_FFFF_FFF8;
const XSAVE_HV_MASK_VALUE: &str = "0xFFFFFFFFFFFFFFF8";
const XSAVE_MASK_WARNING: &str = "Маска XSAVE в загрузчике: Windows скрывает от программ AVX-512 и другие новые расширения процессора, поэтому некоторые программы (например, распаковщики репаков) могут завершаться с ошибкой. Маску ставят визор и Eclipse-HV. Снять или вернуть её можно также во вкладке «Управление защитами», либо через откат визора и «Включить все защиты»; изменение вступает в силу после перезагрузки.";
const XSAVE_OTHER_MASK_WARNING: &str = "Маска XSAVE в загрузчике (не от визора): часть расширений процессора скрыта от программ. Её можно отключить во вкладке «Управление защитами» или через «Включить все защиты»; изменение вступает в силу после перезагрузки.";
const XSAVE_REMOVED_MESSAGE: &str = "Маска XSAVE (xsaveremovefeature) снята: после перезагрузки программам снова станут доступны AVX-512 и другие расширения процессора.";
// bcdedit выводит целые значения в шестнадцатеричном виде; десятичная запись тоже допускается
fn bcd_integer(value: &str) -> Option<u64> {
    let value = value.trim();
    match value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        Some(hex) => u64::from_str_radix(hex, 16).ok(),
        None => value.parse().ok(),
    }
}
fn is_hv_xsave_mask(value: &str) -> bool {
    bcd_integer(value) == Some(XSAVE_HV_MASK)
}
// Значение BCD для отката. Снимок мог быть сделан, когда маску визора уже поставили
// Eclipse-HV или VBS.cmd, поэтому её откат снимает всегда; остальные значения — как в снимке.
fn restore_bcd_value<'a>(name: &str, snapshot: Option<&'a str>) -> Option<&'a str> {
    if name == XSAVE_BCD && snapshot.is_some_and(is_hv_xsave_mask) {
        None
    } else {
        snapshot
    }
}
fn xsave_mask_warning(value: &str) -> &'static str {
    if is_hv_xsave_mask(value) {
        XSAVE_MASK_WARNING
    } else {
        XSAVE_OTHER_MASK_WARNING
    }
}
// Индивидуальное получение состояния всех компонентов защит
fn get_individual_protections(_app: &AppHandle) -> Result<Vec<IndividualProtection>, String> {
    let uefi = check_uefi_lock();
    let kva = check_kva_shadow();

    let vbs_on = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
        "EnableVirtualizationBasedSecurity",
    ) == Some(1);
    let hvci_on = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
        "Enabled",
    ) == Some(1);
    let blocklist_on = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\CI\Config",
        "VulnerableDriverBlocklistEnable",
    ) != Some(0);
    let cred_on = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\CredentialGuard",
        "Enabled",
    ) == Some(1)
        || registry_dword(r"SYSTEM\CurrentControlSet\Control\Lsa", "LsaCfgFlags") == Some(1);
    let sys_on = registry_dword(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SystemGuard",
        "Enabled",
    ) == Some(1);
    let kva_on = !kva.disabled && kva.needed;
    let xsave_on = read_bcd(XSAVE_BCD).ok().flatten().is_some();
    let test_on = configured_test_signing().unwrap_or(false);

    Ok(vec![
        IndividualProtection {
            id: "vbs".into(),
            name: "Virtualization-based Security (VBS)".into(),
            category: "Ядро и гипервизор".into(),
            description: "Базовая изоляция ядра и системный гипервизор Windows".into(),
            enabled: vbs_on,
            locked: uefi.vbs_locked,
            lock_reason: if uefi.vbs_locked {
                Some("Заблокировано в BIOS/UEFI (SecConfig.efi)".into())
            } else {
                None
            },
        },
        IndividualProtection {
            id: "hvci".into(),
            name: "Целостность памяти (HVCI)".into(),
            category: "Ядро и гипервизор".into(),
            description: "Изоляция памяти ядра и проверка целостности исполняемого кода".into(),
            enabled: hvci_on,
            locked: uefi.hvci_locked,
            lock_reason: if uefi.hvci_locked {
                Some("Заблокировано в BIOS/UEFI (SecConfig.efi)".into())
            } else {
                None
            },
        },
        IndividualProtection {
            id: "vulnerable-drivers".into(),
            name: "Черный список уязвимых драйверов".into(),
            category: "Целостность драйверов".into(),
            description: "Блокировка загрузки драйверов из списка Microsoft Vulnerable Driver Blocklist".into(),
            enabled: blocklist_on,
            locked: false,
            lock_reason: None,
        },
        IndividualProtection {
            id: "credential-guard".into(),
            name: "Credential Guard & Защита LSA".into(),
            category: "Учётные данные".into(),
            description: "Изоляция подсистемы LSA для защиты паролей и билетов Kerberos".into(),
            enabled: cred_on,
            locked: uefi.credential_locked,
            lock_reason: if uefi.credential_locked {
                Some("Заблокировано в BIOS/UEFI".into())
            } else {
                None
            },
        },
        IndividualProtection {
            id: "system-guard".into(),
            name: "System Guard & HyperGuard".into(),
            category: "Аппаратная защита".into(),
            description: "Контроль целостности при загрузке системы и защита гипервизора".into(),
            enabled: sys_on,
            locked: false,
            lock_reason: None,
        },
        IndividualProtection {
            id: "kva-shadow".into(),
            name: "KVA Shadow (Meltdown Mitigation)".into(),
            category: "Процессор".into(),
            description: "Теневое разделение адресных пространств ядра для защиты от Meltdown".into(),
            enabled: kva_on,
            locked: false,
            lock_reason: None,
        },
        IndividualProtection {
            id: "xsave-mask".into(),
            name: "Маска XSAVE в загрузчике (xsaveremovefeature)".into(),
            category: "Параметры загрузчика (BCD)".into(),
            description: "Скрытие AVX-512 и расширенных наборов инструкций процессора от программ".into(),
            enabled: xsave_on,
            locked: false,
            lock_reason: None,
        },
        IndividualProtection {
            id: "testsigning".into(),
            name: "Тестовый режим (Testsigning / DSE)".into(),
            category: "Параметры загрузчика (BCD)".into(),
            description: "Разрешение загрузки неподписанных и тестовых драйверов Windows".into(),
            enabled: test_on,
            locked: false,
            lock_reason: None,
        },
    ])
}

// Применение индивидуального изменения защиты
fn set_individual_protection(
    app: &AppHandle,
    id: &str,
    enable: bool,
) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Требуются права администратора".into());
    }
    let snapshot = ensure_snapshot(app)?;

    if ["vbs", "xsave-mask", "testsigning"].contains(&id) {
        prepare_bitlocker(&snapshot)?;
    }

    let mut changed = 0;
    let mut failed = Vec::new();
    let mut restart_required = true;

    match id {
        "vbs" => {
            let val = if enable { 1 } else { 0 };
            if let Err(e) = set_registry_dword(
                r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
                "EnableVirtualizationBasedSecurity",
                val,
            ) {
                failed.push(e);
            } else {
                changed += 1;
            }
            if let Err(e) = set_registry_dword(
                r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard",
                "EnableVirtualizationBasedSecurity",
                val,
            ) {
                failed.push(e);
            } else {
                changed += 1;
            }
            let bcd_val = if enable { Some("auto") } else { Some("off") };
            if let Err(e) = write_bcd("hypervisorlaunchtype", bcd_val) {
                failed.push(e);
            } else {
                changed += 1;
            }
        }
        "hvci" => {
            let val = if enable { 1 } else { 0 };
            if let Err(e) = set_registry_dword(
                r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
                "Enabled",
                val,
            ) {
                failed.push(e);
            } else {
                changed += 1;
            }
            if enable {
                let _ = set_registry_dword(
                    r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
                    "WasEnabledBy",
                    2,
                );
            }
        }
        "vulnerable-drivers" => {
            let val = if enable { 1 } else { 0 };
            if let Err(e) = set_registry_dword(
                r"SYSTEM\CurrentControlSet\Control\CI\Config",
                "VulnerableDriverBlocklistEnable",
                val,
            ) {
                failed.push(e);
            } else {
                changed += 1;
            }
            restart_required = false;
        }
        "credential-guard" => {
            let val = if enable { 1 } else { 0 };
            if let Err(e) = set_registry_dword(
                r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\CredentialGuard",
                "Enabled",
                val,
            ) {
                failed.push(e);
            } else {
                changed += 1;
            }
            if let Err(e) = set_registry_dword(
                r"SYSTEM\CurrentControlSet\Control\Lsa",
                "LsaCfgFlags",
                val,
            ) {
                failed.push(e);
            } else {
                changed += 1;
            }
        }
        "system-guard" => {
            let val = if enable { 1 } else { 0 };
            if let Err(e) = set_registry_dword(
                r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SystemGuard",
                "Enabled",
                val,
            ) {
                failed.push(e);
            } else {
                changed += 1;
            }
            let _ = set_registry_dword(
                r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HyperGuard",
                "Enabled",
                val,
            );
        }
        "kva-shadow" => {
            let override_val = if enable { 0 } else { 3 };
            if let Err(e) = set_registry_dword(
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
                "FeatureSettingsOverride",
                override_val,
            ) {
                failed.push(e);
            } else {
                changed += 1;
            }
            if let Err(e) = set_registry_dword(
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
                "FeatureSettingsOverrideMask",
                3,
            ) {
                failed.push(e);
            } else {
                changed += 1;
            }
        }
        "xsave-mask" => {
            let mask_val = if enable {
                Some(XSAVE_HV_MASK_VALUE)
            } else {
                None
            };
            if let Err(e) = write_bcd(XSAVE_BCD, mask_val) {
                failed.push(e);
            } else {
                changed += 1;
            }
        }
        "testsigning" => {
            let sign_val = if enable { Some("on") } else { Some("off") };
            if let Err(e) = write_bcd("testsigning", sign_val) {
                failed.push(e);
            } else {
                changed += 1;
            }
        }
        _ => return Err(format!("Неизвестный параметр защиты: {id}")),
    }

    let status_word = if enable { "включен" } else { "отключен" };
    let message = if failed.is_empty() {
        if restart_required {
            format!("Параметр успешно {status_word}. Для применения требуется перезагрузка Windows.")
        } else {
            format!("Параметр успешно {status_word} и применён.")
        }
    } else {
        format!("Изменение выполнено с ошибками: {}", failed.join("; "))
    };

    Ok(VbsChangeResult {
        success: failed.is_empty(),
        message,
        changed,
        failed,
        restart_required,
    })
}

fn registry_parameters() -> Vec<(&'static str, &'static str)> {
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
fn raw_registry(path: &str, name: &str) -> Result<(bool, Option<RawRegistrySnapshot>), String> {
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
fn registry_type(kind: u32) -> Result<winreg::enums::RegType, String> {
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
fn restore_registry(item: &RegistrySnapshot) -> Result<(), String> {
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
fn verify_dword(path: &str, name: &str, value: Option<u32>) -> Result<(), String> {
    let raw = raw_registry(path, name)?.1;
    match (raw, value) {
        (None, None) => Ok(()),
        (Some(raw), Some(value)) if raw.kind == 4 && raw.bytes == value.to_le_bytes() => Ok(()),
        _ => Err(format!("Не подтверждён параметр {path}\\{name}")),
    }
}
fn read_bcd(name: &str) -> Result<Option<String>, String> {
    let output = run_command("bcdedit.exe", &["/enum", "{current}"])?;
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let key = parts.next()?;
        if !key.eq_ignore_ascii_case(name) {
            return None;
        }
        let value = parts.collect::<Vec<_>>().join(" ");
        Some(
            if ["testsigning", "onetimeadvancedoptions", "advancedoptions"].contains(&name) {
                bcd_boolean(&value)
                    .map(|v| if v { "on".into() } else { "off".into() })
                    .unwrap_or(value)
            } else {
                value.to_ascii_lowercase()
            },
        )
    }))
}
fn write_bcd(name: &str, value: Option<&str>) -> Result<(), String> {
    if !BCD_NAMES.contains(&name) {
        return Err("Неразрешённый параметр BCD".into());
    }
    let current = read_bcd(name)?;
    let expected = value.map(|v| v.to_ascii_lowercase());
    if current == expected {
        return Ok(());
    }
    if let Some(value) = value {
        run_command("bcdedit.exe", &["/set", "{current}", name, value])?;
    } else {
        run_command("bcdedit.exe", &["/deletevalue", "{current}", name])?;
    }
    if read_bcd(name)? != expected {
        return Err(format!("BCD {name}: значение после записи не подтверждено"));
    }
    Ok(())
}
fn service_running(name: &str) -> Result<bool, String> {
    let output = run_command("sc.exe", &["query", name])?;
    let text = String::from_utf8_lossy(&output.stdout);
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
fn capture_snapshot() -> Result<VbsSnapshot, String> {
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
        schema_version: 2,
        registry,
        bcd,
        services,
        bitlocker_state: Some(bitlocker.state),
        hypervisor_launch_type: None,
        vsm_launch_type: None,
        test_signing: None,
        kva_shadow: None,
        faceit_disabled: None,
    })
}

fn system_probe() -> Result<SystemProbe, String> {
    let script = r#"
$ErrorActionPreference='SilentlyContinue'
$dg=Get-CimInstance -Namespace 'root\Microsoft\Windows\DeviceGuard' -ClassName 'Win32_DeviceGuard'
$cs=Get-CimInstance -ClassName Win32_ComputerSystem
$cpu=Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
$sb='unknown'; try { $sb=([bool](Confirm-SecureBootUEFI)).ToString().ToLowerInvariant() } catch [System.PlatformNotSupportedException] { $sb='false' } catch {}
$dse=-1
try {
  $t=Add-Type -PassThru -MemberDefinition '[DllImport("ntdll.dll")] public static extern uint NtQuerySystemInformation(int c,IntPtr b,uint s,out uint r);' -Name CGSCI -Namespace Crocodile
  $p=[Runtime.InteropServices.Marshal]::AllocHGlobal(8)
  [Runtime.InteropServices.Marshal]::WriteInt32($p,8)
  $r=[uint32]0
  $status=$t::NtQuerySystemInformation(103,$p,8,[ref]$r)
  if($status -eq 0){
    $o=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($p,4)
    if($o -band 2){$dse=1}elseif(-not($o -band 1)){$dse=0}else{$dse=2}
  }
  [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
} catch {}
[pscustomobject]@{
  vbsStatus=[int]$dg.VirtualizationBasedSecurityStatus
  configuredServices=(@($dg.SecurityServicesConfigured | ForEach-Object {[int]$_}) -join ',')
  runningServices=(@($dg.SecurityServicesRunning | ForEach-Object {[int]$_}) -join ',')
  hypervisorPresent=[bool]$cs.HypervisorPresent
  virtualizationFirmwareEnabled=[bool]$cpu.VirtualizationFirmwareEnabled
  secureBoot=$sb
  dseMode=[int]$dse
} | ConvertTo-Json -Compress
"#;
    let output = powershell_output(script)?;
    serde_json::from_str(output.trim())
        .map_err(|error| format!("Windows вернула некорректный отчёт VBS: {error}"))
}

fn parse_service_ids(value: &str) -> Vec<i32> {
    value
        .split(',')
        .filter_map(|item| item.trim().parse::<i32>().ok())
        .collect()
}

fn registry_dword(path: &str, name: &str) -> Option<u32> {
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY)
        .ok()?
        .get_value(name)
        .ok()
}

fn registry_enabled(path: &str, name: &str) -> bool {
    registry_dword(path, name).is_some_and(|value| value > 0)
}

fn set_registry_dword(path: &str, name: &str, value: u32) -> Result<(), String> {
    let (key, _) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .create_subkey_with_flags(path, KEY_WRITE | KEY_WOW64_64KEY)
        .map_err(|error| format!("HKLM\\{path}\\{name}: {error}"))?;
    key.set_value(name, &value)
        .map_err(|error| format!("HKLM\\{path}\\{name}: {error}"))
}

fn delete_registry_value(path: &str, name: &str) -> Result<(), String> {
    let key = match RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(path, KEY_WRITE | KEY_WOW64_64KEY)
    {
        Ok(key) => key,
        Err(_) => return Ok(()),
    };
    match key.delete_value(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("HKLM\\{path}\\{name}: {error}")),
    }
}

fn bcd_boolean(value: &str) -> Option<bool> {
    match value.trim().to_lowercase().as_str() {
        "yes" | "on" | "true" | "1" | "да" => Some(true),
        "no" | "off" | "false" | "0" | "нет" => Some(false),
        _ => None,
    }
}

fn test_signing_from_bcd(text: &str) -> Option<bool> {
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

fn configured_test_signing() -> Option<bool> {
    let output = run_command("bcdedit.exe", &["/enum", "{current}"]).ok()?;
    test_signing_from_bcd(&String::from_utf8_lossy(&output.stdout))
}

fn snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Не удалось определить папку приложения: {error}"))?
        .join("vbs")
        .join("restore-state.json"))
}

fn powershell_output(script: &str) -> Result<String, String> {
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

fn run_command(program: &str, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
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

fn is_admin() -> bool {
    run_command("fltmc.exe", &[]).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mode_uses_normal_boot_and_same_protection_settings() {
        let changes = boot_changes(BootMode::TestSigning);
        assert!(changes.contains(&("testsigning", "on")));
        assert!(!changes
            .iter()
            .any(|(name, _)| *name == "onetimeadvancedoptions"));
        for (name, value) in boot_changes(BootMode::AdvancedOptions) {
            if name != "onetimeadvancedoptions" {
                assert!(changes.contains(&(name, value)));
            }
        }
    }

    #[test]
    fn detects_configured_test_mode_and_pending_rollback() {
        assert_eq!(test_signing_from_bcd("testsigning Yes"), Some(true));
        assert_eq!(test_signing_from_bcd("testsigning Нет"), Some(false));
        assert_eq!(test_signing_from_bcd("testsigning Да"), Some(true));
        assert_eq!(
            test_signing_from_bcd("hypervisorlaunchtype Auto"),
            Some(false)
        );
        assert_eq!(test_signing_from_bcd("testsigning unexpected"), None);
    }

    #[test]
    fn legacy_snapshot_parses_but_requires_version_check() {
        let snapshot: VbsSnapshot = serde_json::from_str(
            r#"{"registry":[],"hypervisorLaunchType":"Auto","vsmLaunchType":null}"#,
        )
        .unwrap();
        assert_eq!(snapshot.schema_version, 0);
        assert!(snapshot.test_signing.is_none());
        assert_eq!(snapshot.hypervisor_launch_type.as_deref(), Some("Auto"));
    }

    #[test]
    fn bitlocker_states_parse_from_script_json() {
        let protected = parse_bitlocker(r#"{"protection":1,"encrypted":100}"#, true);
        assert_eq!(protected.state, "protected");
        assert!(protected.protected && !protected.needs_admin);
        assert_eq!(
            parse_bitlocker("\u{feff}{\"protection\":0,\"encrypted\":0}\r\n", true).state,
            "off"
        );
        let suspended = parse_bitlocker(r#"{"encrypted":100,"protection":0}"#, true);
        assert_eq!(suspended.state, "suspended");
        assert!(suspended.suspended);
        assert_eq!(
            parse_bitlocker(r#"{"protection":2,"encrypted":100}"#, true).state,
            "unknown"
        );
    }

    #[test]
    fn bitlocker_access_denied_without_admin_requests_elevation() {
        let text = r#"{"error":"exception","category":"PermissionDenied","id":"HRESULT 0x80041003,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand","code":"0x80131500"}"#;
        let info = parse_bitlocker(text, false);
        assert_eq!(info.state, "unknown");
        assert!(info.needs_admin && !info.protected && !info.suspended);
        assert_eq!(info.message, BITLOCKER_ADMIN_MESSAGE);
        assert_eq!(info.diagnostics.len(), 3);
        assert!(info
            .diagnostics
            .iter()
            .all(|line| line.chars().count() <= 160));

        let elevated = parse_bitlocker(text, true);
        assert_eq!(elevated.state, "unknown");
        assert!(!elevated.needs_admin);
        assert!(elevated.message.contains("даже с правами администратора"));

        let by_code = parse_bitlocker(
            r#"{"error":"exception","category":"NotSpecified","id":"","code":"0x80070005"}"#,
            false,
        );
        assert!(by_code.needs_admin);
    }

    #[test]
    fn bitlocker_other_failures_stay_unknown_without_elevation_hint() {
        let missing = parse_bitlocker(
            r#"{"error":"exception","category":"ObjectNotFound","id":"HRESULT 0x8004100e,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand","code":"0x80131500"}"#,
            false,
        );
        assert_eq!(missing.state, "unknown");
        assert!(!missing.needs_admin);
        assert_eq!(missing.message, BITLOCKER_UNKNOWN_MESSAGE);
        let api = parse_bitlocker(r#"{"error":"api","code":"0x80310000/0x00000000"}"#, true);
        assert!(api.message.contains("BitLocker API"));
        assert_eq!(api.diagnostics, vec!["0x80310000/0x00000000".to_string()]);
        let volume = parse_bitlocker(r#"{"error":"volume"}"#, true);
        assert!(volume.diagnostics.is_empty());
        let garbage = parse_bitlocker(
            "Get-CimInstance : \u{fffd}\u{fffd}\u{fffd}\r\n+ CategoryInfo",
            false,
        );
        assert_eq!(garbage.state, "unknown");
        assert!(!garbage.needs_admin);
        assert!(!garbage.diagnostics[0].contains('\u{fffd}'));
        assert!(!garbage.diagnostics[0].contains('\n'));
    }

    #[test]
    fn short_diagnostic_is_single_line_and_bounded() {
        assert_eq!(short_diagnostic("  a\r\n\tb  c "), "a b c");
        let long = "x".repeat(400);
        let short = short_diagnostic(&long);
        assert_eq!(short.chars().count(), 160);
        assert!(short.ends_with('…'));
        assert!(bitlocker_access_denied("permissiondenied", "", ""));
        assert!(!bitlocker_access_denied(
            "ObjectNotFound",
            "HRESULT 0x8004100e",
            "0x80131500"
        ));
    }

    #[test]
    fn rollback_removes_hypervisor_xsave_mask_even_if_snapshot_has_it() {
        assert!(BCD_NAMES.contains(&XSAVE_BCD));
        assert_eq!(bcd_integer(XSAVE_HV_MASK_VALUE), Some(XSAVE_HV_MASK));
        for value in [
            "0xfffffffffffffff8",
            "0xFFFFFFFFFFFFFFF8",
            " 0xfffffffffffffff8 ",
            "18446744073709551608",
        ] {
            assert_eq!(restore_bcd_value(XSAVE_BCD, Some(value)), None, "{value}");
        }
        assert_eq!(restore_bcd_value(XSAVE_BCD, None), None);
        assert_eq!(restore_bcd_value(XSAVE_BCD, Some("0x18")), Some("0x18"));
        assert_eq!(restore_bcd_value(XSAVE_BCD, Some("abc")), Some("abc"));
        assert_eq!(
            restore_bcd_value("hypervisorlaunchtype", Some("auto")),
            Some("auto")
        );
        assert_eq!(
            restore_bcd_value("testsigning", Some("0xfffffffffffffff8")),
            Some("0xfffffffffffffff8")
        );
        assert_eq!(bcd_integer("0x"), None);
        assert_eq!(bcd_integer("0x1ffffffffffffffff"), None);
    }

    #[test]
    fn scan_explains_xsave_mask() {
        assert_eq!(xsave_mask_warning("0xfffffffffffffff8"), XSAVE_MASK_WARNING);
        assert_eq!(xsave_mask_warning("0x18"), XSAVE_OTHER_MASK_WARNING);
        assert_eq!(xsave_mask_warning("unexpected"), XSAVE_OTHER_MASK_WARNING);
        assert!(XSAVE_MASK_WARNING.starts_with("Маска XSAVE в загрузчике"));
        assert!(XSAVE_OTHER_MASK_WARNING.starts_with("Маска XSAVE в загрузчике"));
    }
}
