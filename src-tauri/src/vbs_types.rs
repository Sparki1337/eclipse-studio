//! Типы данных, структуры состояния и таблицы целевых параметров VBS/HVCI/BCD.

use super::{external, uefi};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy)]
pub(crate) struct RegistryTarget {
    pub(crate) path: &'static str,
    pub(crate) name: &'static str,
    pub(crate) disabled_value: u32,
}

// Реестровые параметры Device Guard, LSA, биометрии и виртуализации
pub(crate) const REGISTRY_TARGETS: &[RegistryTarget] = &[
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
pub(crate) struct EnableRegistryTarget {
    pub(crate) path: &'static str,
    pub(crate) name: &'static str,
    pub(crate) enabled_value: u32,
}

// Реестровые параметры для полного принудительного включения всех механизмов безопасности ядра Windows
pub(crate) const ALL_ENABLE_REGISTRY_TARGETS: &[EnableRegistryTarget] = &[
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

// XCR0 > 7 требует xsaveremovefeature в BCD для совместимости с гипервизором
#[cfg(all(windows, target_arch = "x86_64"))]
pub(crate) fn read_xcr0() -> u32 {
    unsafe {
        let ptr = 0x7FFE03D8 as *const u32;
        *ptr
    }
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
pub(crate) fn read_xcr0() -> u32 {
    0
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemProbe {
    pub(crate) vbs_status: i32,
    pub(crate) configured_services: String,
    pub(crate) running_services: String,
    pub(crate) hypervisor_present: bool,
    pub(crate) virtualization_firmware_enabled: bool,
    pub(crate) secure_boot: String,
    pub(crate) dse_mode: i32,
    #[serde(default)]
    pub(crate) boot_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VbsDseStatus {
    pub(crate) state: String,
    pub(crate) label: String,
    pub(crate) detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VbsComponent {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) state: String,
    pub(crate) enabled: bool,
    pub(crate) locked: bool,
}

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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KvaShadowInfo {
    pub needed: bool,
    pub disabled: bool,
    pub label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UefiLockInfo {
    pub is_locked: bool,
    pub vbs_locked: bool,
    pub hvci_locked: bool,
    pub credential_locked: bool,
    pub sec_config_available: bool,
}

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
    pub(crate) admin: bool,
    pub(crate) secure_boot: String,
    pub(crate) virtualization_enabled: bool,
    pub(crate) hypervisor_present: bool,
    pub(crate) restart_required: bool,
    pub(crate) can_restore: bool,
    pub(crate) external: external::ExternalStatus,
    pub(crate) preferred_boot_mode: String,
    pub(crate) enable_block_reason: Option<String>,
    pub(crate) test_signing_configured: Option<bool>,
    pub(crate) test_signing_active: bool,
    pub(crate) dse: VbsDseStatus,
    pub(crate) components: Vec<VbsComponent>,
    pub(crate) enabled_count: usize,
    pub(crate) warnings: Vec<String>,
    // Расширения VBS 2.0.1
    pub(crate) bitlocker: BitLockerInfo,
    pub(crate) kva_shadow: KvaShadowInfo,
    pub(crate) uefi_lock: UefiLockInfo,
    pub(crate) uefi_optout: Option<uefi::Status>,
    pub(crate) conflicts: Vec<ConflictItem>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VbsChangeResult {
    pub(crate) success: bool,
    pub(crate) message: String,
    pub(crate) changed: usize,
    pub(crate) failed: Vec<String>,
    pub(crate) restart_required: bool,
}

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
pub(crate) struct RegistrySnapshot {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) value: Option<u32>,
    #[serde(default)]
    pub(crate) raw: Option<RawRegistrySnapshot>,
    #[serde(default)]
    pub(crate) key_existed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawRegistrySnapshot {
    pub(crate) kind: u32,
    pub(crate) bytes: Vec<u8>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BcdSnapshot {
    pub(crate) entry: String,
    pub(crate) name: String,
    pub(crate) value: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ServiceSnapshot {
    pub(crate) name: String,
    pub(crate) running: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VbsSnapshot {
    #[serde(default)]
    pub(crate) schema_version: u32,
    #[serde(default)]
    pub(crate) boot_id: String,
    #[serde(default)]
    pub(crate) scoped_bcd: Vec<BcdSnapshot>,
    #[serde(default)]
    pub(crate) bcd: Vec<BcdSnapshot>,
    #[serde(default)]
    pub(crate) services: Vec<ServiceSnapshot>,
    #[serde(default)]
    pub(crate) bitlocker_state: Option<String>,
    pub(crate) registry: Vec<RegistrySnapshot>,
    pub(crate) hypervisor_launch_type: Option<String>,
    pub(crate) vsm_launch_type: Option<String>,
    #[serde(default)]
    pub(crate) test_signing: Option<String>,
    #[serde(default)]
    pub(crate) kva_shadow: Option<bool>,
    #[serde(default)]
    pub(crate) faceit_disabled: Option<bool>,
    #[serde(default)]
    pub(crate) uefi_optout_configured: bool,
    #[serde(default)]
    pub(crate) efi_backup: Option<Vec<u8>>,
    #[serde(default)]
    pub(crate) efi_file_existed: bool,
    #[serde(default)]
    pub(crate) bitlocker_was_suspended: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum BootMode {
    Auto,
    AdvancedOptions,
    TestSigning,
    // Только защиты Windows для Hypervisor: без тестового режима, DSE и меню загрузки
    ProtectionsOnly,
}

pub(crate) fn boot_changes(mode: BootMode) -> Vec<(&'static str, &'static str)> {
    let mut changes = vec![("hypervisorlaunchtype", "off"), ("vsmlaunchtype", "off")];
    match mode {
        BootMode::Auto | BootMode::AdvancedOptions => {
            changes.push(("onetimeadvancedoptions", "on"))
        }
        BootMode::TestSigning => changes.push(("testsigning", "on")),
        // Для защит Hypervisor достаточно только отключить VBS/HVCI при следующей загрузке
        BootMode::ProtectionsOnly => {}
    }
    changes
}
