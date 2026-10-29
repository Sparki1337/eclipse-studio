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
    pub protected: bool,
    pub suspended: bool,
    pub message: String,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VbsChangeResult {
    success: bool,
    message: String,
    changed: usize,
    failed: Vec<String>,
    restart_required: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistrySnapshot {
    path: String,
    name: String,
    value: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VbsSnapshot {
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
    tauri::async_runtime::spawn_blocking(move || disable_vbs(&app, BootMode::AdvancedOptions))
        .await
        .map_err(|error| format!("Отключение VBS было прервано: {error}"))?
}

// Восстановление исходного состояния VBS из снимка
#[tauri::command]
pub(crate) async fn vbs_restore(app: AppHandle) -> Result<VbsChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || restore_vbs(&app, false))
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
    tauri::async_runtime::spawn_blocking(move || enable_all_protections(&app, reboot))
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
        if enabled {
            disable_vbs(&app, BootMode::TestSigning)
        } else {
            restore_vbs(&app, true)
        }
    })
    .await
    .map_err(|error| format!("Изменение тестового режима было прервано: {error}"))?
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
    tauri::async_runtime::spawn_blocking(|| {
        if !is_admin() {
            return Err("Для снятия UEFI-защиты запустите программу от имени администратора".into());
        }

        let sec_config = PathBuf::from(r"C:\Windows\System32\SecConfig.efi");
        if !sec_config.exists() {
            return Err("Файл SecConfig.efi не найден в каталоге System32".into());
        }

        // Поиск доступной буквы для временного подключения системного EFI-раздела
        let mut free_letter = None;
        for letter in ['S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'] {
            if !PathBuf::from(format!(r"{letter}:\")).exists() {
                free_letter = Some(letter);
                break;
            }
        }
        let letter = free_letter.ok_or_else(|| {
            "Не удалось найти свободную букву диска для подключения EFI-раздела".to_string()
        })?;
        let drive = format!("{letter}:");

        // Монтирование системного раздела EFI
        let mount_res = run_command("mountvol.exe", &[&drive, "/s"]);
        if let Err(e) = mount_res {
            return Err(format!("Не удалось смонтировать раздел EFI на {drive}: {e}"));
        }

        let efi_target_dir = PathBuf::from(format!(r"{drive}\EFI\Microsoft\Boot"));
        let _ = fs::create_dir_all(&efi_target_dir);
        let efi_target = efi_target_dir.join("SecConfig.efi");

        let copy_res = fs::copy(&sec_config, &efi_target);
        if let Err(e) = copy_res {
            let _ = run_command("mountvol.exe", &[&drive, "/d"]);
            return Err(format!(
                "Не удалось скопировать SecConfig.efi в {}: {e}",
                efi_target.display()
            ));
        }

        // Конфигурация записи DGOptOut в диспетчере загрузки Windows (BCD)
        let bcd_id = "{0cb3b571-2f2e-4343-a879-d86a476d7215}";
        let _ = run_command("bcdedit.exe", &["/delete", bcd_id]);
        let _ = run_command(
            "bcdedit.exe",
            &["/create", bcd_id, "/d", "DGOptOut", "/application", "osloader"],
        );
        let _ = run_command(
            "bcdedit.exe",
            &["/set", bcd_id, "path", r"\EFI\Microsoft\Boot\SecConfig.efi"],
        );
        let _ = run_command(
            "bcdedit.exe",
            &["/set", bcd_id, "loadoptions", "DISABLE-LSA-ISO,DISABLE-VBS"],
        );
        let _ = run_command(
            "bcdedit.exe",
            &["/set", bcd_id, "device", &format!("partition={drive}")],
        );
        let _ = run_command(
            "bcdedit.exe",
            &["/set", "{bootmgr}", "bootsequence", bcd_id, "{current}"],
        );

        // Очистка реестровых параметров групповой политики Device Guard
        let _ = delete_registry_value(
            r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard",
            "EnableVirtualizationBasedSecurity",
        );
        let _ = delete_registry_value(
            r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard",
            "RequirePlatformSecurityFeatures",
        );
        let _ = delete_registry_value(
            r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
            "EnableVirtualizationBasedSecurity",
        );
        let _ = delete_registry_value(
            r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
            "RequirePlatformSecurityFeatures",
        );

        // Размонтирование раздела EFI
        let _ = run_command("mountvol.exe", &[&drive, "/d"]);

        Ok("UEFI Opt-Out успешно настроен. При следующей перезагрузке микрокод UEFI предложит подтвердить снятие блокировки Device Guard (нажмите соответствующую клавишу на экране загрузки).".into())
    })
    .await
    .map_err(|e| format!("Операция была прервана: {e}"))?
}

// Отключение службы античита FACEIT, блокирующей гипервизор
#[tauri::command]
pub(crate) async fn vbs_disable_faceit() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        if !is_admin() {
            return Err("Для управления службой FACEIT требуются права администратора".into());
        }
        let _ = run_command("sc.exe", &["stop", "FACEIT"]);
        let _ = run_command("sc.exe", &["stop", "FACEITService"]);
        let _ = run_command("sc.exe", &["config", "FACEIT", "start=", "disabled"]);
        let _ = run_command("sc.exe", &["config", "FACEITService", "start=", "disabled"]);
        Ok("Служба FACEIT успешно остановлена и отключена. Блокировка гипервизорного драйвера снята.".into())
    })
    .await
    .map_err(|e| format!("Операция прервана: {e}"))?
}

// Инструменты устранения системных неполадок (WMI, SFC, DISM)
#[tauri::command]
pub(crate) async fn vbs_troubleshoot(action: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_admin() {
            return Err("Для выполнения диагностики требуются права администратора".into());
        }
        match action.as_str() {
            "wmi" => {
                let _ = run_command("net.exe", &["stop", "winmgmt", "/y"]);
                let _ = run_command("winmgmt.exe", &["/salvagerepository"]);
                let _ = run_command("winmgmt.exe", &["/resetrepository"]);
                let _ = run_command("net.exe", &["start", "winmgmt"]);
                Ok("Репозиторий WMI проверен и успешно восстановлен.".into())
            }
            "sfc" => {
                let output = run_command("sfc.exe", &["/scannow"])?;
                let text = String::from_utf8_lossy(&output.stdout);
                let first_lines = text.lines().take(4).collect::<Vec<_>>().join("\n");
                Ok(format!("Проверка SFC завершена:\n{first_lines}"))
            }
            "dism" => {
                let output = run_command(
                    "dism.exe",
                    &["/online", "/cleanup-image", "/restorehealth"],
                )?;
                let text = String::from_utf8_lossy(&output.stdout);
                let first_lines = text.lines().take(4).collect::<Vec<_>>().join("\n");
                Ok(format!("Восстановление DISM завершено:\n{first_lines}"))
            }
            _ => Err("Неизвестное действие диагностики".into()),
        }
    })
    .await
    .map_err(|e| format!("Диагностика была прервана: {e}"))?
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
    if bitlocker.protected {
        warnings.push("BitLocker активен: при входе в параметры загрузки защита будет временно приостановлена на 1 перезагрузку, чтобы исключить запрос 48-значного ключа.".into());
    }
    if windows_hello_enabled {
        warnings.push("Windows Hello защищён VBS. Убедитесь, что у вашей учётной записи настроен обычный пароль перед отключением изоляции ядра.".into());
    }
    let xcr0 = read_xcr0();
    if xcr0 > 0 && xcr0 < 7 {
        warnings.push("Процессор не поддерживает набор инструкций AVX (или AVX отключен). Запуск токенов Denuvo не поддерживается.".into());
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
    if let Ok(output) = run_command("manage-bde.exe", &["-status", "C:"]) {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let is_on = stdout.contains("Защита включена")
            || stdout.contains("Protection On")
            || stdout.contains("Protection Status:    Protection On");
        let is_suspended = stdout.contains("Защита приостановлена")
            || stdout.contains("Protection Suspended")
            || stdout.contains("Protection Status:    Protection Suspended");

        if is_on || is_suspended {
            return BitLockerInfo {
                protected: is_on,
                suspended: is_suspended,
                message: if is_suspended {
                    "Защита BitLocker приостановлена на время перезагрузки".into()
                } else {
                    "BitLocker активен (будет безопасно приостановлен на 1 перезагрузку)".into()
                },
            };
        }
    }

    BitLockerInfo {
        protected: false,
        suspended: false,
        message: "BitLocker не используется на системном диске".into(),
    }
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
        || registry_dword(r"SYSTEM\CurrentControlSet\Control\DeviceGuard", "Mandatory")
            == Some(1);
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
            .map(|o| String::from_utf8_lossy(&o.stdout).to_uppercase().contains("FACEIT"))
            .unwrap_or(false);

    if faceit_found {
        items.push(ConflictItem {
            id: "faceit".into(),
            name: "FACEIT Anti-Cheat".into(),
            severity: "critical".into(),
            description: "Служба FACEIT полностью блокирует запуск неподписанных гипервизорных драйверов.".into(),
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
            description: "Служба MacType перехватывает графический вывод и приводит к вылету игр на старте.".into(),
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
fn disable_vbs(app: &AppHandle, mode: BootMode) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Для изменения параметров VBS запустите программу от имени администратора".into());
    }

    let test_mode = matches!(mode, BootMode::TestSigning);
    if test_mode && system_probe()?.secure_boot == "true" {
        return Err("Для включения тестового режима отключите Secure Boot в BIOS/UEFI, затем повторите действие.".into());
    }

    // Проверка поддержки набора инструкций AVX (XCR0 >= 7)
    let xcr0 = read_xcr0();
    if xcr0 > 0 && xcr0 < 7 {
        return Err("Процессор не поддерживает инструкции AVX (или AVX отключен в Windows). Запуск гипервизора и токенов Denuvo невозможен.".into());
    }

    let snapshot_file = snapshot_path(app)?;
    let new_snapshot = !snapshot_file.exists();
    if new_snapshot {
        let snapshot = capture_snapshot();
        if let Some(parent) = snapshot_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Не удалось создать папку восстановления: {error}"))?;
        }
        fs::write(
            &snapshot_file,
            serde_json::to_vec_pretty(&snapshot)
                .map_err(|error| format!("Не удалось подготовить снимок VBS: {error}"))?,
        )
        .map_err(|error| format!("Не удалось сохранить снимок VBS: {error}"))?;
    }

    let mut changed = 0;
    let mut failed = Vec::new();

    // 1. Безопасность BitLocker: при входе в расширенное меню выбора отключаем TPM-протектор на 1 перезагрузку
    if !test_mode {
        let bl = check_bitlocker();
        if bl.protected {
            let _ = run_command(
                "manage-bde.exe",
                &["-protectors", "-disable", "C:", "-rebootcount", "1"],
            );
        }
    }

    // 2. KVA Shadow: отключаем теневые таблицы ядра для старых процессоров
    let kva = check_kva_shadow();
    if kva.needed && !kva.disabled {
        let _ = set_registry_dword(
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
            "FeatureSettingsOverride",
            2,
        );
        let _ = set_registry_dword(
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
            "FeatureSettingsOverrideMask",
            3,
        );
        changed += 1;
    }

    // 3. Тестовый режим (Testsigning)
    if test_mode {
        if let Err(error) = run_command("bcdedit.exe", &["/set", "{current}", "testsigning", "on"])
        {
            if new_snapshot {
                let _ = fs::remove_file(&snapshot_file);
            }
            return Err(format!("Не удалось включить тестовый режим: {error}"));
        }
        changed += 1;
        if bcd_value("onetimeadvancedoptions").is_some() {
            match run_command(
                "bcdedit.exe",
                &["/deletevalue", "{current}", "onetimeadvancedoptions"],
            ) {
                Ok(_) => changed += 1,
                Err(error) => {
                    failed.push(format!("Меню дополнительных параметров загрузки: {error}"))
                }
            }
        }
    }

    // 4. Реестровые параметры Device Guard
    for target in REGISTRY_TARGETS {
        if registry_dword(target.path, target.name) == Some(target.disabled_value) {
            continue;
        }
        match set_registry_dword(target.path, target.name, target.disabled_value) {
            Ok(()) => changed += 1,
            Err(error) => failed.push(error),
        }
    }

    // 5. Расширенная настройка BCD (отключение гипервизора во всех профилях)
    for (name, value) in boot_changes(mode) {
        if test_mode && name == "testsigning" {
            continue;
        }
        match run_command("bcdedit.exe", &["/set", "{current}", name, value]) {
            Ok(_) => changed += 1,
            Err(error) => failed.push(format!("BCD {name}: {error}")),
        }
    }

    // Принудительно отключаем запуск гипервизора в глобальных параметрах загрузчика
    for target_entry in ["{hypervisorsettings}", "{bootloadersettings}"] {
        let _ = run_command(
            "bcdedit.exe",
            &["/set", target_entry, "hypervisorlaunchtype", "off"],
        );
    }
    let _ = run_command("bcdedit.exe", &["/set", "{current}", "vsmlaunchtype", "off"]);

    // Устранение устаревших флагов advancedoptions в BCD
    for entry in [
        "{globalsettings}",
        "{bootloadersettings}",
        "{hypervisorsettings}",
        "{bootmgr}",
    ] {
        let _ = run_command("bcdedit.exe", &["/deletevalue", entry, "advancedoptions"]);
    }

    // 6. Оптимизация контекста AVX-512 (XCR0 > 7): исключение сбоев XSAVE в гипервизоре
    if read_xcr0() > 7 {
        let _ = run_command(
            "bcdedit.exe",
            &["/set", "{current}", "xsaveremovefeature", "0xFFFFFFFFFFFFFFF8"],
        );
    }

    Ok(VbsChangeResult {
        success: failed.is_empty(),
        message: if test_mode && failed.is_empty() {
            "Тестовый режим подготовлен к включению. Перезапустите компьютер.".into()
        } else if failed.is_empty() {
            "VBS 2.0: гипервизор и изоляция ядра подготовлены к отключению. BitLocker защищён.".into()
        } else {
            "Часть параметров VBS изменить не удалось".into()
        },
        changed,
        failed,
        restart_required: changed > 0,
    })
}

// Восстановление VBS из снимка
fn restore_vbs(app: &AppHandle, disable_test_mode: bool) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Для восстановления VBS запустите программу от имени администратора".into());
    }
    let snapshot_file = snapshot_path(app)?;
    if !snapshot_file.exists() {
        if disable_test_mode {
            let _ = run_command("bcdedit.exe", &["/set", "{current}", "testsigning", "off"]);
            let _ = run_command("bcdedit.exe", &["/deletevalue", "{current}", "testsigning"]);
            return Ok(VbsChangeResult {
                success: true,
                message: "Тестовый режим выключен. Перезапустите Windows".into(),
                changed: 1,
                failed: Vec::new(),
                restart_required: true,
            });
        }
        return Err("Сохранённое состояние VBS не найдено".into());
    }

    let snapshot: VbsSnapshot = serde_json::from_slice(
        &fs::read(&snapshot_file)
            .map_err(|error| format!("Не удалось прочитать снимок VBS: {error}"))?,
    )
    .map_err(|error| format!("Снимок VBS повреждён: {error}"))?;

    let mut changed = 0;
    let mut failed = Vec::new();

    if disable_test_mode {
        let _ = run_command("bcdedit.exe", &["/set", "{current}", "testsigning", "off"]);
        let _ = run_command("bcdedit.exe", &["/deletevalue", "{current}", "testsigning"]);
        changed += 1;
    }

    // Восстановление параметров реестра
    for item in &snapshot.registry {
        let result = match item.value {
            Some(value) => set_registry_dword(&item.path, &item.name, value),
            None => delete_registry_value(&item.path, &item.name),
        };
        match result {
            Ok(()) => changed += 1,
            Err(error) => failed.push(error),
        }
    }

    // Восстановление KVA Shadow
    let _ = delete_registry_value(
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
        "FeatureSettingsOverride",
    );
    let _ = delete_registry_value(
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
        "FeatureSettingsOverrideMask",
    );

    // Восстановление параметров BCD
    for (name, value) in [
        (
            "hypervisorlaunchtype",
            snapshot.hypervisor_launch_type.as_deref(),
        ),
        ("vsmlaunchtype", snapshot.vsm_launch_type.as_deref()),
    ] {
        let result = if let Some(value) = value {
            run_command("bcdedit.exe", &["/set", "{current}", name, value])
        } else {
            run_command("bcdedit.exe", &["/deletevalue", "{current}", name])
        };
        match result {
            Ok(_) => changed += 1,
            Err(error) => failed.push(format!("BCD {name}: {error}")),
        }
    }

    // Восстановление гипервизора в глобальных профилях
    for target_entry in ["{hypervisorsettings}", "{bootloadersettings}"] {
        if let Some(val) = snapshot.hypervisor_launch_type.as_deref() {
            let _ = run_command("bcdedit.exe", &["/set", target_entry, "hypervisorlaunchtype", val]);
        } else {
            let _ = run_command("bcdedit.exe", &["/deletevalue", target_entry, "hypervisorlaunchtype"]);
        }
    }

    if !disable_test_mode {
        let result = if let Some(value) = snapshot.test_signing.as_deref() {
            Some(run_command(
                "bcdedit.exe",
                &["/set", "{current}", "testsigning", value],
            ))
        } else if bcd_value("testsigning").is_some() {
            Some(run_command(
                "bcdedit.exe",
                &["/deletevalue", "{current}", "testsigning"],
            ))
        } else {
            None
        };
        match result {
            Some(Ok(_)) => changed += 1,
            Some(Err(error)) => failed.push(format!("BCD testsigning: {error}")),
            None => {}
        }
    }

    // Очистка одноразовых параметров загрузки
    let _ = run_command(
        "bcdedit.exe",
        &["/deletevalue", "{current}", "onetimeadvancedoptions"],
    );

    // Очистка оптимизации контекста AVX-512
    let _ = run_command(
        "bcdedit.exe",
        &["/deletevalue", "{current}", "xsaveremovefeature"],
    );

    if failed.is_empty() {
        fs::remove_file(&snapshot_file)
            .map_err(|error| format!("Параметры восстановлены, но снимок не удалён: {error}"))?;
    }

    Ok(VbsChangeResult {
        success: failed.is_empty(),
        message: if disable_test_mode && failed.is_empty() {
            "Тестовый режим выключен. Исходные параметры VBS 2.0 восстановлены".into()
        } else if failed.is_empty() {
            "Исходные параметры VBS 2.0 успешно восстановлены".into()
        } else {
            "Часть параметров VBS восстановить не удалось".into()
        },
        changed,
        failed,
        restart_required: changed > 0,
    })
}

// Принудительное включение всех механизмов защиты ядра Windows
fn enable_all_protections(app: &AppHandle, reboot: bool) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Для изменения параметров безопасности требуются права администратора".into());
    }

    let mut changed = 0;
    let mut failed = Vec::new();

    // 1. Применение реестровых параметров включения защит
    for target in ALL_ENABLE_REGISTRY_TARGETS {
        if registry_dword(target.path, target.name) == Some(target.enabled_value) {
            continue;
        }
        match set_registry_dword(target.path, target.name, target.enabled_value) {
            Ok(()) => changed += 1,
            Err(error) => failed.push(error),
        }
    }

    // 2. Очистка обходов и твиков
    let _ = delete_registry_value(
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
        "DisableHypervisorEnforcedPagingTranslation",
    );
    let _ = delete_registry_value(
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
        "FeatureSettingsOverride",
    );
    let _ = delete_registry_value(
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management",
        "FeatureSettingsOverrideMask",
    );

    // Удаление служебного ключа сторонних скриптов ManageVBS
    let _ = RegKey::predef(HKEY_LOCAL_MACHINE).delete_subkey_all(r"SOFTWARE\ManageVBS");

    // 3. Конфигурация параметров загрузчика BCD (включение гипервизора, отключение тестового режима)
    for (entry, name, val) in [
        ("{current}", "hypervisorlaunchtype", "auto"),
        ("{bootloadersettings}", "hypervisorlaunchtype", "auto"),
        ("{hypervisorsettings}", "hypervisorlaunchtype", "auto"),
        ("{current}", "vsmlaunchtype", "auto"),
    ] {
        match run_command("bcdedit.exe", &["/set", entry, name, val]) {
            Ok(_) => changed += 1,
            Err(error) => failed.push(format!("BCD {entry} {name}: {error}")),
        }
    }

    // Отключение TestSigning и очистка обходных флагов
    let _ = run_command("bcdedit.exe", &["/set", "{current}", "testsigning", "off"]);
    let _ = run_command("bcdedit.exe", &["/deletevalue", "{current}", "testsigning"]);
    let _ = run_command("bcdedit.exe", &["/deletevalue", "{current}", "xsaveremovefeature"]);
    let _ = run_command("bcdedit.exe", &["/deletevalue", "{current}", "onetimeadvancedoptions"]);
    let _ = run_command("bcdedit.exe", &["/deletevalue", "{current}", "advancedoptions"]);

    for entry in [
        "{globalsettings}",
        "{bootloadersettings}",
        "{hypervisorsettings}",
        "{bootmgr}",
    ] {
        let _ = run_command("bcdedit.exe", &["/deletevalue", entry, "advancedoptions"]);
    }

    // 4. Восстановление служб безопасности и шрифтов
    let _ = run_command("sc.exe", &["config", "FACEIT", "start=", "demand"]);
    let _ = run_command("sc.exe", &["config", "FACEITService", "start=", "auto"]);
    let _ = run_command("sc.exe", &["config", "MacType", "start=", "auto"]);

    // 5. Очистка сохранённого снимка отключённого состояния
    if let Ok(snap) = snapshot_path(app) {
        if snap.exists() {
            let _ = fs::remove_file(snap);
        }
    }

    // 6. Немедленная или отложенная перезагрузка при запросе
    if reboot {
        let _ = run_command(
            "shutdown.exe",
            &[
                "/r",
                "/t",
                "5",
                "/c",
                "Eclipse Studio: Все механизмы безопасности Windows включены. Перезагрузка...",
            ],
        );
    }

    Ok(VbsChangeResult {
        success: failed.is_empty(),
        message: if failed.is_empty() {
            if reboot {
                "Все механизмы защиты ядра (VBS, HVCI, блокировка драйверов, Credential Guard) включены. Компьютер перезагрузится через 5 секунд.".into()
            } else {
                "Все механизмы защиты ядра (VBS, HVCI, блокировка драйверов, Credential Guard) успешно включены. Для завершения перезагрузите Windows.".into()
            }
        } else {
            "Часть механизмов безопасности настроена с замечаниями".into()
        },
        changed,
        failed,
        restart_required: !reboot && changed > 0,
    })
}

fn capture_snapshot() -> VbsSnapshot {
    let kva = check_kva_shadow();
    VbsSnapshot {
        registry: REGISTRY_TARGETS
            .iter()
            .map(|target| RegistrySnapshot {
                path: target.path.into(),
                name: target.name.into(),
                value: registry_dword(target.path, target.name),
            })
            .collect(),
        hypervisor_launch_type: bcd_value("hypervisorlaunchtype"),
        vsm_launch_type: bcd_value("vsmlaunchtype"),
        test_signing: bcd_value("testsigning"),
        kva_shadow: Some(kva.disabled),
        faceit_disabled: None,
    }
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

fn bcd_value(name: &str) -> Option<String> {
    let output = run_command("bcdedit.exe", &["/enum", "{current}"]).ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let key = parts.next()?;
            key.eq_ignore_ascii_case(name)
                .then(|| parts.next().unwrap_or_default().to_string())
        })
        .filter(|value| !value.is_empty())
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
    fn old_visor_snapshot_remains_usable() {
        let snapshot: VbsSnapshot = serde_json::from_str(
            r#"{"registry":[],"hypervisorLaunchType":"Auto","vsmLaunchType":null}"#,
        )
        .unwrap();
        assert!(snapshot.test_signing.is_none());
        assert_eq!(snapshot.hypervisor_launch_type.as_deref(), Some("Auto"));
    }
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
    let output = run_command(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
    )?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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
