//! Проверяемый план отката журнала VBS.cmd 2.0.1. Модуль не обращается к Windows.
use std::collections::BTreeMap;

pub const JOURNAL_PATH: &str = r"SOFTWARE\ManageVBS";
pub const DG: &str = r"SYSTEM\CurrentControlSet\Control\DeviceGuard";
pub const HVCI: &str =
    r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity";
pub const LSA: &str = r"SYSTEM\CurrentControlSet\Control\Lsa";
pub const POLICY: &str = r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard";
pub const MEMORY: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management";

pub const FIELDS: &[&str] = &[
    "XCR0",
    "FACEIT",
    "MacType",
    "UEFILockAgreed",
    "VBSLocked",
    "HVCILocked",
    "CGLocked",
    "WindowsHello",
    "SecureBiometrics",
    "SecureBiometricsScenario",
    "SecureBiometricsWHS",
    "SecureFingerprint",
    "SecureFingerprintScenario",
    "SecureFingerprintWHS",
    "HyperGuard",
    "GuardedHost",
    "VBS",
    "RequirePlatformSecurityFeatures",
    "SystemGuard",
    "HVCI",
    "HVPT",
    "CredentialGuardScenario",
    "CredentialGuardLsa",
    "CredentialGuardPolicy",
    "KVAShadow",
    "Hypervisor",
    "HypervisorLaunchType",
    "HypervisorSettingsLaunchType",
    "BootloaderSettingsLaunchType",
    "VsmLaunchType",
    "TestSigning",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreAction {
    Registry {
        path: &'static str,
        name: &'static str,
        value: Option<u32>,
    },
    Bcd {
        entry: &'static str,
        name: &'static str,
        value: Option<String>,
    },
    Service {
        name: &'static str,
        start: u32,
        restart_now: bool,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct ExternalPlan {
    pub tracked_changes: usize,
    pub requires_uefi_consent: bool,
    pub actions: Vec<RestoreAction>,
}

#[derive(Debug)]
enum Value {
    Flag,
    Number(u32),
    Launch(String),
}

fn decode_text(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() < 2 || bytes.len() > 128 || !bytes.len().is_multiple_of(2) {
        return Err("Недопустимая длина строки ManageVBS".into());
    }
    let mut words = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect::<Vec<_>>();
    if words.pop() != Some(0) || words.contains(&0) {
        return Err("Некорректная строка ManageVBS".into());
    }
    String::from_utf16(&words).map_err(|_| "Некорректная кодировка ManageVBS".into())
}

// Имена и значения из журнала никогда не становятся произвольными путями или командами.
pub fn build_plan(entries: &[(String, u32, Vec<u8>)]) -> Result<ExternalPlan, String> {
    if entries.len() > FIELDS.len() {
        return Err("Слишком много значений ManageVBS".into());
    }
    let mut values = BTreeMap::new();
    for (name, kind, bytes) in entries {
        let canonical = FIELDS
            .iter()
            .find(|field| field.eq_ignore_ascii_case(name))
            .ok_or_else(|| {
                format!(
                    "Неизвестный параметр ManageVBS: {}",
                    name.chars().take(64).collect::<String>()
                )
            })?;
        if values.contains_key(*canonical) {
            return Err("Повтор параметра ManageVBS".into());
        }
        let value = match *canonical {
            "RequirePlatformSecurityFeatures" | "CredentialGuardLsa" | "CredentialGuardPolicy" => {
                if *kind != 1 {
                    return Err(format!("Неверный тип ManageVBS\\{canonical}"));
                }
                let text = decode_text(bytes)?;
                let number = if let Some(hex) =
                    text.strip_prefix("0x").or_else(|| text.strip_prefix("0X"))
                {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    text.parse().ok()
                }
                .ok_or_else(|| format!("Неверное число ManageVBS\\{canonical}"))?;
                let valid = if *canonical == "RequirePlatformSecurityFeatures" {
                    number <= 3
                } else {
                    number == 1 || number == 2
                };
                if !valid {
                    return Err(format!("Неверное значение ManageVBS\\{canonical}"));
                }
                Value::Number(number)
            }
            "HypervisorLaunchType"
            | "HypervisorSettingsLaunchType"
            | "BootloaderSettingsLaunchType"
            | "VsmLaunchType" => {
                if *kind != 1 {
                    return Err(format!("Неверный тип ManageVBS\\{canonical}"));
                }
                let text = decode_text(bytes)?.to_ascii_lowercase();
                if !["auto", "off"].contains(&text.as_str())
                    || (*canonical == "VsmLaunchType" && text != "auto")
                {
                    return Err(format!("Неверный режим ManageVBS\\{canonical}"));
                }
                Value::Launch(text)
            }
            _ => {
                if *kind != 4 || bytes.as_slice() != 1u32.to_le_bytes() {
                    return Err(format!("Неверный флаг ManageVBS\\{canonical}"));
                }
                Value::Flag
            }
        };
        values.insert(*canonical, value);
    }
    for (dependent, parent) in [
        ("RequirePlatformSecurityFeatures", "VBS"),
        ("HypervisorLaunchType", "Hypervisor"),
        ("HypervisorSettingsLaunchType", "Hypervisor"),
        ("BootloaderSettingsLaunchType", "Hypervisor"),
    ] {
        if values.contains_key(dependent) && !values.contains_key(parent) {
            return Err(format!(
                "Неполный журнал ManageVBS: {dependent} без {parent}"
            ));
        }
    }
    let tracked_changes = values.len() - usize::from(values.contains_key("UEFILockAgreed"));
    let mut registry = BTreeMap::new();
    let mut bcd = BTreeMap::new();
    let mut services = Vec::new();
    let mut reg = |path, name, value| {
        registry.insert((path, name), value);
    };
    let mut boot = |entry, name, value: Option<String>| {
        bcd.insert((entry, name), value);
    };
    for (field, value) in &values {
        let scenario = match *field {
            "WindowsHello" => {
                Some(r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\WindowsHello")
            }
            "SecureBiometrics" => {
                Some(r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SecureBiometrics")
            }
            "SecureBiometricsWHS" => Some(
                r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\WindowsHelloSecureBiometrics",
            ),
            "SecureFingerprint" => {
                Some(r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SecureFingerprint")
            }
            "SecureFingerprintWHS" => Some(
                r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\WindowsHelloSecureFingerprint",
            ),
            "HyperGuard" => {
                Some(r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HyperGuard")
            }
            "GuardedHost" => {
                Some(r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\Host-Guardian")
            }
            "SystemGuard" => {
                Some(r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SystemGuard")
            }
            "CredentialGuardScenario" => {
                Some(r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\CredentialGuard")
            }
            _ => None,
        };
        if let Some(path) = scenario {
            reg(path, "Enabled", Some(1));
            continue;
        }
        match *field {
            "XCR0" => boot("{current}", "xsaveremovefeature", None),
            "TestSigning" => boot("{current}", "testsigning", None),
            "FACEIT" => {
                // Драйвер античита нельзя запускать в текущем сеансе с отключённой DSE.
                services.push(RestoreAction::Service {
                    name: "FACEIT",
                    start: 1,
                    restart_now: false,
                });
                services.push(RestoreAction::Service {
                    name: "FACEITService",
                    start: 3,
                    restart_now: false,
                });
            }
            "MacType" => services.push(RestoreAction::Service {
                name: "MacType",
                start: 2,
                restart_now: true,
            }),
            "VBSLocked" => reg(DG, "Locked", Some(1)),
            "HVCILocked" => reg(HVCI, "Locked", Some(1)),
            "CGLocked" => {
                reg(DG, "EnableVirtualizationBasedSecurity", Some(1));
                reg(DG, "RequirePlatformSecurityFeatures", Some(3));
                reg(LSA, "LsaCfgFlags", Some(1));
                reg(
                    r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\CredentialGuard",
                    "Enabled",
                    Some(1),
                );
            }
            "SecureBiometricsScenario" => reg(
                r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios",
                "SecureBiometrics",
                Some(1),
            ),
            "SecureFingerprintScenario" => reg(
                r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios",
                "SecureFingerprint",
                Some(1),
            ),
            "VBS" => reg(DG, "EnableVirtualizationBasedSecurity", Some(1)),
            "RequirePlatformSecurityFeatures" => {
                if let Value::Number(number) = value {
                    reg(DG, "RequirePlatformSecurityFeatures", Some(*number));
                }
            }
            "HVCI" => {
                reg(HVCI, "WasEnabledBy", Some(2));
                reg(HVCI, "Enabled", Some(1));
            }
            "HVPT" => reg(DG, "DisableHypervisorEnforcedPagingTranslation", None),
            "CredentialGuardLsa" => {
                if let Value::Number(number) = value {
                    reg(LSA, "LsaCfgFlags", Some(*number));
                }
            }
            "CredentialGuardPolicy" => {
                if let Value::Number(number) = value {
                    reg(POLICY, "LsaCfgFlags", Some(*number));
                }
            }
            "KVAShadow" => {
                reg(MEMORY, "FeatureSettingsOverride", None);
                reg(MEMORY, "FeatureSettingsOverrideMask", None);
            }
            "Hypervisor" => {
                let previous = match values.get("HypervisorLaunchType") {
                    Some(Value::Launch(value)) => Some(value.clone()),
                    _ => None,
                };
                boot("{current}", "hypervisorlaunchtype", previous);
            }
            "HypervisorSettingsLaunchType" => {
                if let Value::Launch(previous) = value {
                    boot(
                        "{hypervisorsettings}",
                        "hypervisorlaunchtype",
                        Some(previous.clone()),
                    );
                }
            }
            "BootloaderSettingsLaunchType" => {
                if let Value::Launch(previous) = value {
                    boot(
                        "{bootloadersettings}",
                        "hypervisorlaunchtype",
                        Some(previous.clone()),
                    );
                }
            }
            "VsmLaunchType" => boot("{current}", "vsmlaunchtype", Some("auto".into())),
            _ => {}
        }
    }
    // Одноразовое меню не должно оставаться после выхода из внешнего режима.
    if tracked_changes > 0 {
        boot("{current}", "onetimeadvancedoptions", None);
    }
    let requires_uefi_consent = ["VBSLocked", "HVCILocked", "CGLocked"]
        .iter()
        .any(|name| values.contains_key(name))
        || ["CredentialGuardLsa", "CredentialGuardPolicy"]
            .iter()
            .any(|name| matches!(values.get(name), Some(Value::Number(1))));
    let mut actions = registry
        .into_iter()
        .map(|((path, name), value)| RestoreAction::Registry { path, name, value })
        .collect::<Vec<_>>();
    actions.extend(
        bcd.into_iter()
            .map(|((entry, name), value)| RestoreAction::Bcd { entry, name, value }),
    );
    actions.extend(services);
    Ok(ExternalPlan {
        tracked_changes,
        requires_uefi_consent,
        actions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn flag(name: &str) -> (String, u32, Vec<u8>) {
        (name.into(), 4, 1u32.to_le_bytes().to_vec())
    }
    fn text(name: &str, value: &str) -> (String, u32, Vec<u8>) {
        (
            name.into(),
            1,
            value
                .encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes)
                .collect(),
        )
    }
    fn has_reg(plan: &ExternalPlan, path: &str, name: &str, value: Option<u32>) -> bool {
        plan.actions.iter().any(|a| matches!(a, RestoreAction::Registry {path: p, name: n, value: v} if *p == path && *n == name && *v == value))
    }
    #[test]
    fn empty_and_consent_only_do_not_mean_external_mode() {
        for entries in [vec![], vec![flag("UEFILockAgreed")]] {
            let p = build_plan(&entries).unwrap();
            assert_eq!(p.tracked_changes, 0);
            assert!(p.actions.is_empty());
        }
    }
    #[test]
    fn every_supported_flag_has_a_known_plan() {
        for field in FIELDS.iter().filter(|s| {
            ![
                "RequirePlatformSecurityFeatures",
                "CredentialGuardLsa",
                "CredentialGuardPolicy",
                "HypervisorLaunchType",
                "HypervisorSettingsLaunchType",
                "BootloaderSettingsLaunchType",
                "VsmLaunchType",
            ]
            .contains(s)
        }) {
            let p = build_plan(&[flag(field)]).unwrap();
            assert_eq!(p.tracked_changes, usize::from(*field != "UEFILockAgreed"));
        }
    }
    #[test]
    fn unknown_values_block_the_whole_plan() {
        assert!(build_plan(&[flag("HVCI"), flag("Unexpected")]).is_err());
    }
    #[test]
    fn wrong_types_and_flags_are_rejected() {
        assert!(build_plan(&[text("HVCI", "1")]).is_err());
        assert!(build_plan(&[("HVCI".into(), 4, 0u32.to_le_bytes().to_vec())]).is_err());
        assert!(build_plan(&[("HVCI".into(), 4, vec![1])]).is_err());
    }
    #[test]
    fn names_are_case_insensitive_but_unique() {
        assert!(build_plan(&[flag("hvci")]).is_ok());
        assert!(build_plan(&[flag("HVCI"), flag("hvci")]).is_err());
    }
    #[test]
    fn originals_cannot_be_orphaned() {
        for field in [
            "RequirePlatformSecurityFeatures",
            "HypervisorLaunchType",
            "HypervisorSettingsLaunchType",
            "BootloaderSettingsLaunchType",
        ] {
            assert!(build_plan(&[text(
                field,
                if field == "RequirePlatformSecurityFeatures" {
                    "0x3"
                } else {
                    "Auto"
                }
            )])
            .is_err());
        }
    }
    #[test]
    fn numeric_originals_are_validated_and_preserved() {
        for value in ["2", "0x2"] {
            let p = build_plan(&[text("CredentialGuardLsa", value)]).unwrap();
            assert!(has_reg(&p, LSA, "LsaCfgFlags", Some(2)));
            assert!(!p.requires_uefi_consent);
        }
        for value in ["-1", "4294967296", "3", "1 & calc.exe"] {
            assert!(build_plan(&[text("CredentialGuardLsa", value)]).is_err());
        }
    }
    #[test]
    fn platform_features_original_survives() {
        let p = build_plan(&[flag("VBS"), text("RequirePlatformSecurityFeatures", "0x3")]).unwrap();
        assert!(has_reg(&p, DG, "RequirePlatformSecurityFeatures", Some(3)));
    }
    #[test]
    fn uefi_relock_always_needs_explicit_consent() {
        for entries in [
            vec![flag("VBSLocked")],
            vec![flag("HVCILocked")],
            vec![flag("CGLocked")],
            vec![text("CredentialGuardLsa", "1")],
            vec![text("CredentialGuardPolicy", "1")],
        ] {
            assert!(build_plan(&entries).unwrap().requires_uefi_consent);
        }
    }
    #[test]
    fn biometric_keys_are_not_confused() {
        let p = build_plan(&[flag("SecureFingerprintScenario")]).unwrap();
        assert!(has_reg(
            &p,
            r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios",
            "SecureFingerprint",
            Some(1)
        ));
        assert!(!has_reg(
            &p,
            r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\SecureFingerprint",
            "Enabled",
            Some(1)
        ));
    }
    #[test]
    fn no_untracked_protections_are_enabled() {
        let p = build_plan(&[flag("TestSigning")]).unwrap();
        assert!(p
            .actions
            .iter()
            .all(|a| matches!(a, RestoreAction::Bcd { .. })));
    }
    #[test]
    fn hvci_and_xsave_have_complete_restore_steps() {
        let p = build_plan(&[flag("HVCI"), flag("XCR0")]).unwrap();
        assert!(has_reg(&p, HVCI, "WasEnabledBy", Some(2)));
        assert!(p.actions.contains(&RestoreAction::Bcd {
            entry: "{current}",
            name: "xsaveremovefeature",
            value: None
        }));
    }
    #[test]
    fn all_three_bcd_scopes_are_restored() {
        let p = build_plan(&[
            flag("Hypervisor"),
            text("HypervisorLaunchType", "Auto"),
            text("HypervisorSettingsLaunchType", "Auto"),
            text("BootloaderSettingsLaunchType", "Auto"),
        ])
        .unwrap();
        for entry in ["{current}", "{hypervisorsettings}", "{bootloadersettings}"] {
            assert!(p.actions.contains(&RestoreAction::Bcd {
                entry,
                name: "hypervisorlaunchtype",
                value: Some("auto".into())
            }));
        }
    }
    #[test]
    fn missing_hypervisor_original_means_delete_not_force_auto() {
        assert!(build_plan(&[flag("Hypervisor")])
            .unwrap()
            .actions
            .contains(&RestoreAction::Bcd {
                entry: "{current}",
                name: "hypervisorlaunchtype",
                value: None
            }));
    }
    #[test]
    fn invalid_bcd_and_strings_are_rejected() {
        for value in ["auto /delete {current}", "on", "AUTO\0OFF", "{bad}"] {
            assert!(
                build_plan(&[flag("Hypervisor"), text("HypervisorLaunchType", value)]).is_err()
            );
        }
        assert!(build_plan(&[("VsmLaunchType".into(), 1, vec![65, 0])]).is_err());
    }
    #[test]
    fn faceit_driver_is_not_started_in_unsafe_session() {
        let p = build_plan(&[flag("FACEIT"), flag("MacType")]).unwrap();
        assert!(p.actions.contains(&RestoreAction::Service {
            name: "FACEIT",
            start: 1,
            restart_now: false
        }));
        assert!(p.actions.contains(&RestoreAction::Service {
            name: "MacType",
            start: 2,
            restart_now: true
        }));
    }
    #[test]
    fn complete_journal_is_deterministic() {
        let mut entries = FIELDS
            .iter()
            .map(|name| match *name {
                "RequirePlatformSecurityFeatures" => text(name, "0x3"),
                "CredentialGuardLsa" | "CredentialGuardPolicy" => text(name, "2"),
                "HypervisorLaunchType"
                | "HypervisorSettingsLaunchType"
                | "BootloaderSettingsLaunchType"
                | "VsmLaunchType" => text(name, "Auto"),
                _ => flag(name),
            })
            .collect::<Vec<_>>();
        let a = build_plan(&entries).unwrap();
        entries.reverse();
        assert_eq!(a, build_plan(&entries).unwrap());
        assert_eq!(a.tracked_changes, 30);
    }
    #[test]
    fn oversized_journal_is_rejected() {
        assert!(build_plan(&vec![flag("XCR0"); 32]).is_err());
    }
}
