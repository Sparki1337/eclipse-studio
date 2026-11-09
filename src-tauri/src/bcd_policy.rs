//! Чистые проверки владения BCD и одноразовой очередью; системных вызовов нет.
use crate::uefi_transaction::{valid_guid, Journal, Presence};
use std::collections::BTreeSet;
pub const LOADER_TYPE: u32 = 0x10200003;
pub const DESCRIPTION: u32 = 0x12000004;
pub const APPLICATION_PATH: u32 = 0x12000002;
pub const LOAD_OPTIONS: u32 = 0x12000030;
pub const APPLICATION_DEVICE: u32 = 0x11000001;
pub const BOOT_SEQUENCE: u32 = 0x24000002;
#[derive(Debug, Clone)]
pub enum Content {
    Text(String),
    Device {
        kind: u32,
        path: String,
        additional: String,
    },
    Other,
}
#[derive(Debug, Clone)]
pub struct Element {
    pub kind: u32,
    pub content: Content,
}
pub fn ownership(
    plan: &Journal,
    object_type: u32,
    elements: &[Element],
    nt_volume: &str,
) -> Presence {
    if plan.validate().is_err() || object_type != LOADER_TYPE || nt_volume.is_empty() {
        return Presence::Conflict;
    }
    let mut seen = BTreeSet::new();
    for element in elements {
        if !seen.insert(element.kind) {
            return Presence::Conflict;
        }
        let valid = match (element.kind, &element.content) {
            (DESCRIPTION, Content::Text(value)) => *value == plan.description(),
            (APPLICATION_PATH, Content::Text(value)) => *value == plan.efi_path(),
            (LOAD_OPTIONS, Content::Text(value)) => value == plan.load_options(),
            (
                APPLICATION_DEVICE,
                Content::Device {
                    kind,
                    path,
                    additional,
                },
            ) => {
                *kind == 2
                    && path.eq_ignore_ascii_case(nt_volume)
                    && (additional.is_empty()
                        || additional == "{00000000-0000-0000-0000-000000000000}")
            }
            _ => false,
        };
        if !valid {
            return Presence::Conflict;
        }
    }
    // Частичная запись допускается только для отката и только с точной меткой владельца.
    if seen.contains(&DESCRIPTION) {
        Presence::Owned
    } else {
        Presence::Conflict
    }
}
pub fn complete(elements: &[Element]) -> bool {
    elements.len() == 4
        && [
            DESCRIPTION,
            APPLICATION_PATH,
            LOAD_OPTIONS,
            APPLICATION_DEVICE,
        ]
        .iter()
        .all(|kind| elements.iter().filter(|e| e.kind == *kind).count() == 1)
}
pub fn normalize_sequence(ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.len() > 32 {
        return Err("Слишком длинная одноразовая очередь BCD".into());
    }
    ids.into_iter()
        .map(|id| {
            let id = id.to_ascii_lowercase();
            if valid_guid(&id) {
                Ok(id)
            } else {
                Err("Неверный идентификатор в очереди BCD".into())
            }
        })
        .collect()
}
pub fn allow_sequence(plan: &Journal, desired: Option<&[String]>) -> Result<(), String> {
    plan.validate()?;
    if desired != plan.original_sequence.as_deref()
        && desired != Some(plan.scheduled_sequence().as_slice())
    {
        return Err("Чужая одноразовая очередь BCD: запись запрещена".into());
    }
    Ok(())
}
pub fn current_loader(text: &str, loaders: &[String]) -> Result<String, String> {
    // /v выводит настоящий GUID вместо {current}; язык подписей не имеет значения.
    for (start, _) in text.match_indices('{') {
        if let Some(candidate) = text.get(start..start + 38) {
            let id = candidate.to_ascii_lowercase();
            if valid_guid(&id)
                && loaders
                    .iter()
                    .filter(|loader| loader.eq_ignore_ascii_case(&id))
                    .count()
                    == 1
            {
                return Ok(id);
            }
        }
    }
    Err("Не удалось однозначно определить текущий загрузчик Windows".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::uefi_transaction::{
        digest, BitLocker, Phase, RegistryChange, REGISTRY_TARGETS, VERSION,
    };
    fn plan() -> Journal {
        let image = b"MZ fixture - not executable".to_vec();
        Journal {
            version: VERSION,
            nonce: "5f8a5242b3324fabac840b30f550e019".into(),
            boot_id: "boot-1".into(),
            loader_id: "{ecab19ae-988a-4527-af8b-e85e5753e5b1}".into(),
            volume_id: r"\\?\Volume{cb8af634-faf2-47ed-9e66-a8d0a1e9d723}\".into(),
            image_sha256: digest(&image),
            image,
            original_sequence: None,
            original_bitlocker: BitLocker::Protected,
            registry: vec![RegistryChange {
                path: REGISTRY_TARGETS[2].0.into(),
                name: "Locked".into(),
                original: 1,
            }],
            disable_vbs: true,
            continuation_done: false,
            phase: Phase::Preparing,
        }
    }
    fn elements(p: &Journal) -> Vec<Element> {
        vec![
            Element {
                kind: DESCRIPTION,
                content: Content::Text(p.description()),
            },
            Element {
                kind: APPLICATION_PATH,
                content: Content::Text(p.efi_path()),
            },
            Element {
                kind: LOAD_OPTIONS,
                content: Content::Text(p.load_options().into()),
            },
            Element {
                kind: APPLICATION_DEVICE,
                content: Content::Device {
                    kind: 2,
                    path: r"\Device\HarddiskVolume1".into(),
                    additional: String::new(),
                },
            },
        ]
    }
    #[test]
    fn complete_and_partial_entries_require_exact_owner() {
        let p = plan();
        let all = elements(&p);
        assert_eq!(
            ownership(&p, LOADER_TYPE, &all, r"\Device\HarddiskVolume1"),
            Presence::Owned
        );
        assert!(complete(&all));
        assert_eq!(
            ownership(&p, LOADER_TYPE, &all[..1], r"\Device\HarddiskVolume1"),
            Presence::Owned
        );
        assert!(!complete(&all[..1]));
        assert_eq!(
            ownership(&p, LOADER_TYPE, &all[1..], r"\Device\HarddiskVolume1"),
            Presence::Conflict
        );
        assert_eq!(
            ownership(&p, 1, &all, r"\Device\HarddiskVolume1"),
            Presence::Conflict
        );
    }
    #[test]
    fn foreign_fields_duplicates_and_changed_fields_are_conflicts() {
        let p = plan();
        let all = elements(&p);
        for index in 0..4 {
            let mut altered = all.clone();
            altered[index].content = Content::Other;
            assert_eq!(
                ownership(&p, LOADER_TYPE, &altered, r"\Device\HarddiskVolume1"),
                Presence::Conflict
            );
            let mut duplicated = all.clone();
            duplicated.push(all[index].clone());
            assert_eq!(
                ownership(&p, LOADER_TYPE, &duplicated, r"\Device\HarddiskVolume1"),
                Presence::Conflict
            );
            assert!(!complete(&duplicated));
        }
        let mut extra = all;
        extra.push(Element {
            kind: 99,
            content: Content::Other,
        });
        assert_eq!(
            ownership(&p, LOADER_TYPE, &extra, r"\Device\HarddiskVolume1"),
            Presence::Conflict
        );
    }
    #[test]
    fn different_volume_or_additional_options_never_belong_to_us() {
        let p = plan();
        let mut all = elements(&p);
        assert_eq!(
            ownership(&p, LOADER_TYPE, &all, r"\Device\HarddiskVolume2"),
            Presence::Conflict
        );
        if let Content::Device { additional, .. } = &mut all[3].content {
            *additional = p.loader_id.clone();
        }
        assert_eq!(
            ownership(&p, LOADER_TYPE, &all, r"\Device\HarddiskVolume1"),
            Presence::Conflict
        );
    }
    #[test]
    fn secconfig_modes_remain_compatible() {
        let mut p = plan();
        p.disable_vbs = false;
        p.registry = vec![RegistryChange {
            path: REGISTRY_TARGETS[8].0.into(),
            name: "LsaCfgFlags".into(),
            original: 1,
        }];
        p.validate().unwrap();
        assert_eq!(p.load_options(), "DISABLE-LSA-ISO");
        assert_eq!(
            ownership(&p, LOADER_TYPE, &elements(&p), r"\Device\HarddiskVolume1"),
            Presence::Owned
        );
    }
    #[test]
    fn only_original_or_own_sequence_can_be_written() {
        let p = plan();
        allow_sequence(&p, None).unwrap();
        allow_sequence(&p, Some(&p.scheduled_sequence())).unwrap();
        assert!(allow_sequence(&p, Some(std::slice::from_ref(&p.loader_id))).is_err());
        assert!(allow_sequence(&p, Some(&[])).is_err());
        let mut p = p;
        p.original_sequence = Some(Vec::new());
        allow_sequence(&p, Some(&[])).unwrap();
        assert!(allow_sequence(&p, None).is_err());
    }
    #[test]
    fn queue_validation_rejects_aliases_commands_and_zero_guids() {
        let p = plan();
        assert_eq!(
            normalize_sequence(vec![p.loader_id.to_uppercase()]).unwrap(),
            vec![p.loader_id]
        );
        for value in [
            "{current}",
            "{00000000-0000-0000-0000-000000000000}",
            "x\n/create",
        ] {
            assert!(normalize_sequence(vec![value.into()]).is_err());
        }
        assert!(normalize_sequence(vec![plan().loader_id; 33]).is_err());
    }
    #[test]
    fn loader_guid_is_locale_independent_but_must_exist_exactly_once() {
        let p = plan();
        let text = format!(
            "Идентификатор: {}\nВосстановление: {}",
            p.loader_id.to_uppercase(),
            p.entry_id()
        );
        assert_eq!(
            current_loader(&text, std::slice::from_ref(&p.loader_id)).unwrap(),
            p.loader_id
        );
        assert!(current_loader(&text, &[]).is_err());
        assert!(current_loader(&text, &[p.loader_id.clone(), p.loader_id]).is_err());
        assert!(current_loader("{current}", &[]).is_err());
    }
}
