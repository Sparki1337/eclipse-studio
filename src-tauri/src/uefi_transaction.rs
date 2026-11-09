//! Журналируемая, переживает перезапуск транзакция SecConfig. Вызовов Windows в модуле нет.
//! Владеем только свежим каталогом EFI и своим объектом BCD; примерный GUID Microsoft не переиспользуется.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const VERSION: u32 = 1;
pub const MAX_IMAGE: usize = 2 * 1024 * 1024;
pub const REGISTRY_TARGETS: &[(&str, &str)] = &[
    (
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
        "EnableVirtualizationBasedSecurity",
    ),
    (
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard",
        "RequirePlatformSecurityFeatures",
    ),
    (r"SYSTEM\CurrentControlSet\Control\DeviceGuard", "Locked"),
    (
        r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard",
        "EnableVirtualizationBasedSecurity",
    ),
    (
        r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard",
        "RequirePlatformSecurityFeatures",
    ),
    (
        r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard",
        "LsaCfgFlags",
    ),
    (
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
        "Enabled",
    ),
    (
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
        "Locked",
    ),
    (r"SYSTEM\CurrentControlSet\Control\Lsa", "LsaCfgFlags"),
    (
        r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\CredentialGuard",
        "Enabled",
    ),
    (r"SYSTEM\CurrentControlSet\Control\DeviceGuard", "Mandatory"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BitLocker {
    Off,
    Protected,
    Suspended,
}
/// Повторная проверка непосредственно перед нативной записью, а не только при фиксации плана.
pub fn check_bitlocker_for_write(state: BitLocker) -> Result<(), String> {
    if state == BitLocker::Protected {
        return Err("Защита BitLocker снова активна. Изменения остановлены; журнал сохранён для безопасного отката".into());
    }
    Ok(())
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Preparing,
    Prepared,
    Restoring,
    Restored,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Presence {
    Absent,
    Owned,
    Conflict,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryChange {
    pub path: String,
    pub name: String,
    pub original: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    pub version: u32,
    pub nonce: String,
    pub boot_id: String,
    pub loader_id: String,
    pub volume_id: String,
    pub image: Vec<u8>,
    pub image_sha256: String,
    pub original_sequence: Option<Vec<String>>,
    pub original_bitlocker: BitLocker,
    pub registry: Vec<RegistryChange>,
    pub disable_vbs: bool,
    #[serde(default)]
    pub continuation_done: bool,
    pub phase: Phase,
}
#[derive(Debug, Clone)]
pub struct Observed {
    pub boot_id: String,
    pub bitlocker: BitLocker,
    pub sequence: Option<Vec<String>>,
    pub efi: Presence,
    pub entry: Presence,
    pub registry: BTreeMap<(String, String), Option<u32>>,
}

pub trait Platform {
    /// Состояние фиксируется и перечитывается ДО первой системной записи.
    fn save(&mut self, plan: &Journal) -> Result<(), String>;
    fn observe(&mut self, plan: &Journal) -> Result<Observed, String>;
    fn suspend_bitlocker(&mut self) -> Result<(), String>;
    fn resume_bitlocker(&mut self) -> Result<(), String>;
    fn install_efi(&mut self, plan: &Journal) -> Result<(), String>;
    fn create_entry(&mut self, plan: &Journal) -> Result<(), String>;
    fn set_registry(&mut self, change: &RegistryChange, value: u32) -> Result<(), String>;
    fn set_sequence(&mut self, sequence: Option<&[String]>) -> Result<(), String>;
    fn delete_entry(&mut self, plan: &Journal) -> Result<(), String>;
    fn delete_efi(&mut self, plan: &Journal) -> Result<(), String>;
    /// Сохранять проверенную запись последнего восстановления; активное состояние снимается только при успехе.
    fn finish(&mut self, plan: &Journal) -> Result<(), String>;
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn valid_guid(value: &str) -> bool {
    value.len() == 38
        && value.starts_with('{')
        && value.ends_with('}')
        && uuid::Uuid::parse_str(&value[1..37])
            .is_ok_and(|id| !id.is_nil() && format!("{{{id}}}") == value)
}
impl Journal {
    pub fn entry_id(&self) -> String {
        let id = uuid::Uuid::parse_str(&self.nonce).expect("validated transaction nonce");
        format!("{{{id}}}")
    }
    pub fn efi_path(&self) -> String {
        format!(r"\EFI\EclipseStudio-{}\SecConfig.efi", self.nonce)
    }
    pub fn description(&self) -> String {
        format!("Eclipse Studio UEFI Opt-Out {}", self.nonce)
    }
    pub fn load_options(&self) -> &'static str {
        if self.disable_vbs {
            "DISABLE-LSA-ISO,DISABLE-VBS"
        } else {
            "DISABLE-LSA-ISO"
        }
    }
    pub fn scheduled_sequence(&self) -> Vec<String> {
        vec![self.entry_id(), self.loader_id.clone()]
    }
    pub fn validate(&self) -> Result<(), String> {
        let nonce_ok = self.nonce.len() == 32
            && self
                .nonce
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
        let volume = self
            .volume_id
            .strip_prefix(r"\\?\Volume")
            .and_then(|v| v.strip_suffix('\\'));
        if self.version != VERSION
            || !nonce_ok
            || !valid_guid(&self.loader_id)
            || !valid_guid(&self.entry_id())
            || self.entry_id() == self.loader_id
            || self.boot_id.is_empty()
            || self.boot_id.len() > 96
            || !volume.is_some_and(valid_guid)
            || self.image.is_empty()
            || self.image.len() > MAX_IMAGE
            || self.image_sha256 != digest(&self.image)
            || self
                .original_sequence
                .as_ref()
                .is_some_and(|s| !s.is_empty())
            || self.registry.is_empty()
            || self.registry.len() > REGISTRY_TARGETS.len()
        {
            return Err(
                "Некорректный или неподдерживаемый журнал UEFI; изменения запрещены".into(),
            );
        }
        let mut unique = BTreeSet::new();
        for item in &self.registry {
            if item.original == 0
                || !REGISTRY_TARGETS.contains(&(item.path.as_str(), item.name.as_str()))
                || !unique.insert((&item.path, &item.name))
            {
                return Err("Неразрешённый параметр в журнале UEFI".into());
            }
        }
        let locked = |path: &str, name: &str| {
            self.registry
                .iter()
                .any(|c| c.path == path && c.name == name && c.original == 1)
        };
        let vbs = locked(REGISTRY_TARGETS[2].0, "Locked")
            || locked(REGISTRY_TARGETS[7].0, "Locked")
            || locked(REGISTRY_TARGETS[10].0, "Mandatory");
        let cg = locked(REGISTRY_TARGETS[8].0, "LsaCfgFlags");
        if !(vbs || cg) || self.disable_vbs != vbs {
            return Err("Журнал не подтверждает исходную UEFI-блокировку".into());
        }
        Ok(())
    }
}

fn registry_value(observed: &Observed, item: &RegistryChange) -> Option<u32> {
    observed
        .registry
        .get(&(item.path.clone(), item.name.clone()))
        .copied()
        .flatten()
}
fn check_artifacts(plan: &Journal, observed: &Observed) -> Result<(), String> {
    if observed.efi == Presence::Conflict || observed.entry == Presence::Conflict {
        return Err(
            "EFI-файлы или BCD-объект изменены извне. Они не будут перезаписаны; журнал сохранён"
                .into(),
        );
    }
    let original = observed.sequence == plan.original_sequence;
    let planned = observed.sequence.as_deref() == Some(plan.scheduled_sequence().as_slice());
    let consumed = observed.boot_id != plan.boot_id
        && observed.sequence.as_deref() == Some(std::slice::from_ref(&plan.loader_id));
    if !original && !planned && !consumed {
        return Err("Одноразовая очередь BCD изменена извне. Откат остановлен до изменений; журнал сохранён".into());
    }
    for item in &plan.registry {
        if !matches!(registry_value(observed, item), Some(v) if v == 0 || v == item.original) {
            return Err(format!(
                "Параметр {}\\{} изменён извне; откат остановлен",
                item.path, item.name
            ));
        }
    }
    Ok(())
}
fn baseline(plan: &Journal, observed: &Observed) -> bool {
    observed.efi == Presence::Absent
        && observed.entry == Presence::Absent
        && observed.sequence == plan.original_sequence
        && plan
            .registry
            .iter()
            .all(|item| registry_value(observed, item) == Some(item.original))
}

/// Полностью сохранённого плана достаточно для восстановления даже при потере подтверждения операции.
pub fn prepare<P: Platform>(platform: &mut P, plan: &mut Journal) -> Result<(), String> {
    plan.validate()?;
    if plan.phase != Phase::Preparing {
        return Err("Этап UEFI уже существует; сначала завершите его или выполните откат".into());
    }
    let before = platform.observe(plan)?;
    if !baseline(plan, &before)
        || before.bitlocker != plan.original_bitlocker
        || before.boot_id != plan.boot_id
    {
        return Err(
            "Система изменилась после снимка UEFI. Подготовка отменена до изменений".into(),
        );
    }
    platform.save(plan)?;
    let result = (|| {
        if before.bitlocker == BitLocker::Protected {
            platform.suspend_bitlocker()?;
            if platform.observe(plan)?.bitlocker != BitLocker::Suspended {
                return Err("Приостановка BitLocker не подтверждена".into());
            }
        }
        platform.install_efi(plan)?;
        if platform.observe(plan)?.efi != Presence::Owned {
            return Err("EFI-копия SecConfig не подтверждена".into());
        }
        platform.create_entry(plan)?;
        if platform.observe(plan)?.entry != Presence::Owned {
            return Err("Собственная загрузочная запись не подтверждена".into());
        }
        for item in &plan.registry {
            let observed = platform.observe(plan)?;
            check_artifacts(plan, &observed)?;
            if registry_value(&observed, item) != Some(item.original) {
                return Err("Параметры изменились во время подготовки UEFI".into());
            }
            platform.set_registry(item, 0)?;
            if registry_value(&platform.observe(plan)?, item) != Some(0) {
                return Err("Изменение параметра UEFI не подтверждено".into());
            }
        }
        let observed = platform.observe(plan)?;
        check_artifacts(plan, &observed)?;
        if observed.sequence != plan.original_sequence {
            return Err("Очередь загрузки изменилась во время подготовки".into());
        }
        platform.set_sequence(Some(&plan.scheduled_sequence()))?;
        let after = platform.observe(plan)?;
        if after.efi != Presence::Owned
            || after.entry != Presence::Owned
            || after.sequence.as_deref() != Some(plan.scheduled_sequence().as_slice())
            || plan
                .registry
                .iter()
                .any(|item| registry_value(&after, item) != Some(0))
        {
            return Err("Итоговая проверка подготовки UEFI не пройдена".into());
        }
        plan.phase = Phase::Prepared;
        platform.save(plan)
    })();
    if let Err(error) = result {
        return match restore(platform, plan, true, true) {
            Ok(()) => Err(format!("Подготовка UEFI не выполнена: {error}. Собственные изменения возвращены и проверены.")),
            Err(rollback) => Err(format!("Подготовка UEFI не выполнена: {error}. Автоматический откат не завершён: {rollback}. Журнал сохранён; не повторяйте подготовку до восстановления.")),
        };
    }
    Ok(())
}

/// Проверить ВСЁ до отката, затем отменить очередь перед удалением EFI/BCD.
/// Ручной откат возвращает исходные политики блокировки, но применение в прошивке требует перезагрузки.
pub fn restore<P: Platform>(
    platform: &mut P,
    plan: &mut Journal,
    consent: bool,
    failure: bool,
) -> Result<(), String> {
    plan.validate()?;
    if !consent {
        return Err("Для возврата исходных UEFI Lock требуется отдельное подтверждение".into());
    }
    let before = platform.observe(plan)?;
    check_artifacts(plan, &before)?;
    plan.phase = Phase::Restoring;
    platform.save(plan)?;
    if !baseline(plan, &before) && before.bitlocker == BitLocker::Protected {
        platform.suspend_bitlocker()?;
        if platform.observe(plan)?.bitlocker != BitLocker::Suspended {
            return Err("BitLocker не приостановлен; откат сохранён для повтора".into());
        }
    }
    if before.sequence != plan.original_sequence {
        platform.set_sequence(plan.original_sequence.as_deref())?;
        if platform.observe(plan)?.sequence != plan.original_sequence {
            return Err("Очередь BCD не вернулась к снимку".into());
        }
    }
    for item in &plan.registry {
        let observed = platform.observe(plan)?;
        check_artifacts(plan, &observed)?;
        if registry_value(&observed, item) != Some(item.original) {
            platform.set_registry(item, item.original)?;
            if registry_value(&platform.observe(plan)?, item) != Some(item.original) {
                return Err("Возврат параметра UEFI не подтверждён".into());
            }
        }
    }
    let observed = platform.observe(plan)?;
    check_artifacts(plan, &observed)?;
    if observed.entry == Presence::Owned {
        platform.delete_entry(plan)?;
    }
    let observed = platform.observe(plan)?;
    check_artifacts(plan, &observed)?;
    if observed.entry != Presence::Absent {
        return Err("Загрузочная запись не удалена; EFI сохранён".into());
    }
    if observed.efi == Presence::Owned {
        platform.delete_efi(plan)?;
    }
    let restored = platform.observe(plan)?;
    if !baseline(plan, &restored) {
        return Err("Итоговый откат UEFI не подтверждён; журнал сохранён".into());
    }
    if failure
        && restored.boot_id == plan.boot_id
        && plan.original_bitlocker == BitLocker::Protected
        && restored.bitlocker == BitLocker::Suspended
    {
        platform.resume_bitlocker()?;
        if platform.observe(plan)?.bitlocker != BitLocker::Protected {
            return Err("Исходная защита BitLocker не подтверждена; журнал сохранён".into());
        }
    }
    plan.phase = Phase::Restored;
    platform.finish(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan() -> Journal {
        let image = b"MZ fixture EFI - never executable".to_vec();
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
            registry: vec![
                RegistryChange {
                    path: REGISTRY_TARGETS[2].0.into(),
                    name: "Locked".into(),
                    original: 1,
                },
                RegistryChange {
                    path: REGISTRY_TARGETS[8].0.into(),
                    name: "LsaCfgFlags".into(),
                    original: 1,
                },
            ],
            disable_vbs: true,
            continuation_done: false,
            phase: Phase::Preparing,
        }
    }
    #[derive(Clone)]
    struct Fake {
        state: Observed,
        journal: Option<Journal>,
        ops: Vec<String>,
        fail_at: Option<usize>,
        calls: usize,
        lost_ack: bool,
        conflict_after: Option<usize>,
    }
    impl Fake {
        fn new(p: &Journal) -> Self {
            Self {
                state: Observed {
                    boot_id: p.boot_id.clone(),
                    bitlocker: p.original_bitlocker,
                    sequence: p.original_sequence.clone(),
                    efi: Presence::Absent,
                    entry: Presence::Absent,
                    registry: p
                        .registry
                        .iter()
                        .map(|c| ((c.path.clone(), c.name.clone()), Some(c.original)))
                        .collect(),
                },
                journal: None,
                ops: vec![],
                fail_at: None,
                calls: 0,
                lost_ack: false,
                conflict_after: None,
            }
        }
        fn op(&mut self, name: &str) -> Result<(), String> {
            self.calls += 1;
            self.ops.push(name.into());
            if self.conflict_after == Some(self.calls) {
                self.state.efi = Presence::Conflict;
            }
            if self.fail_at == Some(self.calls) {
                self.fail_at = None;
                return Err(format!("injected {name}"));
            }
            Ok(())
        }
        fn ack(&mut self) -> Result<(), String> {
            if self.lost_ack {
                self.lost_ack = false;
                Err("lost reply".into())
            } else {
                Ok(())
            }
        }
    }
    impl Platform for Fake {
        fn save(&mut self, p: &Journal) -> Result<(), String> {
            self.op("save")?;
            self.journal = Some(p.clone());
            Ok(())
        }
        fn observe(&mut self, _: &Journal) -> Result<Observed, String> {
            Ok(self.state.clone())
        }
        fn suspend_bitlocker(&mut self) -> Result<(), String> {
            self.op("suspend")?;
            self.state.bitlocker = BitLocker::Suspended;
            Ok(())
        }
        fn resume_bitlocker(&mut self) -> Result<(), String> {
            self.op("resume")?;
            self.state.bitlocker = BitLocker::Protected;
            Ok(())
        }
        fn install_efi(&mut self, _: &Journal) -> Result<(), String> {
            self.op("efi")?;
            self.state.efi = Presence::Owned;
            self.ack()
        }
        fn create_entry(&mut self, _: &Journal) -> Result<(), String> {
            self.op("entry")?;
            self.state.entry = Presence::Owned;
            Ok(())
        }
        fn set_registry(&mut self, c: &RegistryChange, v: u32) -> Result<(), String> {
            self.op("registry")?;
            self.state
                .registry
                .insert((c.path.clone(), c.name.clone()), Some(v));
            Ok(())
        }
        fn set_sequence(&mut self, s: Option<&[String]>) -> Result<(), String> {
            self.op("sequence")?;
            self.state.sequence = s.map(|s| s.to_vec());
            Ok(())
        }
        fn delete_entry(&mut self, _: &Journal) -> Result<(), String> {
            self.op("delete-entry")?;
            self.state.entry = Presence::Absent;
            Ok(())
        }
        fn delete_efi(&mut self, _: &Journal) -> Result<(), String> {
            self.op("delete-efi")?;
            self.state.efi = Presence::Absent;
            Ok(())
        }
        fn finish(&mut self, _: &Journal) -> Result<(), String> {
            self.op("finish")?;
            self.journal = None;
            Ok(())
        }
    }
    #[test]
    fn round_trip_before_reboot() {
        let mut p = plan();
        let mut f = Fake::new(&p);
        prepare(&mut f, &mut p).unwrap();
        assert_eq!(p.phase, Phase::Prepared);
        assert!(f.journal.is_some());
        restore(&mut f, &mut p, true, false).unwrap();
        assert!(baseline(&p, &f.state));
        assert_eq!(f.state.bitlocker, BitLocker::Suspended);
        assert!(f.journal.is_none());
    }
    #[test]
    fn restore_after_consumed_boot_sequence() {
        let mut p = plan();
        let mut f = Fake::new(&p);
        prepare(&mut f, &mut p).unwrap();
        f.state.boot_id = "boot-2".into();
        f.state.sequence = None;
        f.state.bitlocker = BitLocker::Protected;
        restore(&mut f, &mut p, true, false).unwrap();
        assert!(baseline(&p, &f.state));
        assert_eq!(f.state.bitlocker, BitLocker::Suspended);
    }
    #[test]
    fn restore_after_only_loader_remains() {
        let mut p = plan();
        let mut f = Fake::new(&p);
        prepare(&mut f, &mut p).unwrap();
        f.state.boot_id = "boot-2".into();
        f.state.sequence = Some(vec![p.loader_id.clone()]);
        restore(&mut f, &mut p, true, false).unwrap();
        assert!(baseline(&p, &f.state));
    }
    #[test]
    fn all_prepare_write_failures_restore_originals() {
        for at in 1..=8 {
            let mut p = plan();
            let mut f = Fake::new(&p);
            f.fail_at = Some(at);
            assert!(prepare(&mut f, &mut p).is_err(), "point {at}");
            assert!(baseline(&p, &f.state), "point {at}: {:?}", f.ops);
            assert_eq!(f.state.bitlocker, BitLocker::Protected, "point {at}");
        }
    }
    #[test]
    fn lost_efi_reply_still_rolls_back() {
        let mut p = plan();
        let mut f = Fake::new(&p);
        f.lost_ack = true;
        assert!(prepare(&mut f, &mut p).is_err());
        assert!(baseline(&p, &f.state));
        assert!(f.journal.is_none());
    }
    #[test]
    fn all_restore_write_failures_are_retryable() {
        for at in 1..=7 {
            let mut p = plan();
            let mut f = Fake::new(&p);
            prepare(&mut f, &mut p).unwrap();
            f.calls = 0;
            f.fail_at = Some(at);
            let first = restore(&mut f, &mut p, true, false);
            if first.is_err() {
                assert!(f.journal.is_some());
                restore(&mut f, &mut p, true, false).unwrap();
            }
            assert!(baseline(&p, &f.state), "point {at}");
            assert!(f.journal.is_none());
        }
    }
    #[test]
    fn conflicts_preflight_without_writes() {
        for what in 0..4 {
            let mut p = plan();
            let mut f = Fake::new(&p);
            prepare(&mut f, &mut p).unwrap();
            match what {
                0 => f.state.efi = Presence::Conflict,
                1 => f.state.entry = Presence::Conflict,
                2 => f.state.sequence = Some(vec![p.loader_id.clone()]),
                _ => {
                    let c = &p.registry[0];
                    f.state
                        .registry
                        .insert((c.path.clone(), c.name.clone()), Some(7));
                }
            }
            let count = f.ops.len();
            assert!(restore(&mut f, &mut p, true, false).is_err());
            assert_eq!(f.ops.len(), count);
            assert!(f.journal.is_some());
        }
    }
    #[test]
    fn deletion_of_registry_value_is_not_silently_undone() {
        let mut p = plan();
        let mut f = Fake::new(&p);
        prepare(&mut f, &mut p).unwrap();
        let c = &p.registry[0];
        f.state
            .registry
            .insert((c.path.clone(), c.name.clone()), None);
        let count = f.ops.len();
        assert!(restore(&mut f, &mut p, true, false).is_err());
        assert_eq!(count, f.ops.len());
    }
    #[test]
    fn no_relock_without_consent() {
        let mut p = plan();
        let mut f = Fake::new(&p);
        prepare(&mut f, &mut p).unwrap();
        let count = f.ops.len();
        assert!(restore(&mut f, &mut p, false, false).is_err());
        assert_eq!(count, f.ops.len());
    }
    #[test]
    fn a_new_boot_queue_is_not_clobbered() {
        let mut p = plan();
        p.original_sequence = Some(vec![p.loader_id.clone()]);
        let mut f = Fake::new(&p);
        assert!(prepare(&mut f, &mut p).is_err());
        assert!(f.ops.is_empty());
    }
    #[test]
    fn empty_vs_absent_queue_is_preserved() {
        let mut p = plan();
        p.original_sequence = Some(vec![]);
        let mut f = Fake::new(&p);
        prepare(&mut f, &mut p).unwrap();
        restore(&mut f, &mut p, true, false).unwrap();
        assert_eq!(f.state.sequence, Some(vec![]));
    }
    #[test]
    fn tampered_or_foreign_journals_are_rejected() {
        for what in 0..8 {
            let mut p = plan();
            match what {
                0 => p.nonce = "../../BCD".into(),
                1 => p.image.push(1),
                2 => p.registry[0].path = "SOFTWARE\\Unrelated".into(),
                3 => p.registry.push(p.registry[0].clone()),
                4 => p.loader_id = "{current}".into(),
                5 => p.volume_id = "C:\\".into(),
                6 => p.disable_vbs = false,
                _ => p.registry[0].original = 0,
            }
            let mut f = Fake::new(&p);
            assert!(prepare(&mut f, &mut p).is_err());
            assert!(f.ops.is_empty());
        }
    }
    #[test]
    fn combined_locks_keep_disable_vbs() {
        let p = plan();
        assert_eq!(p.load_options(), "DISABLE-LSA-ISO,DISABLE-VBS");
        let mut cg = p.clone();
        cg.registry.remove(0);
        cg.disable_vbs = false;
        cg.validate().unwrap();
        assert_eq!(cg.load_options(), "DISABLE-LSA-ISO");
    }
    #[test]
    fn a_copy_of_original_is_kept_until_success() {
        let mut p = plan();
        let mut f = Fake::new(&p);
        prepare(&mut f, &mut p).unwrap();
        let saved = f.journal.clone().unwrap();
        assert_eq!(saved.registry[0].original, 1);
        assert_eq!(saved.original_sequence, None);
        f.fail_at = Some(f.calls + 2);
        assert!(restore(&mut f, &mut p, true, false).is_err());
        assert!(f.journal.is_some());
    }
    #[test]
    fn unique_objects_do_not_reuse_microsoft_example() {
        let p = plan();
        assert_ne!(p.entry_id(), "{0cb3b571-2f2e-4343-a879-d86a476d7215}");
        assert!(!p.efi_path().contains(r"\Microsoft\Boot\SecConfig.efi"));
    }
    #[test]
    fn suspend_only_after_verified_snapshot() {
        let mut p = plan();
        let mut f = Fake::new(&p);
        prepare(&mut f, &mut p).unwrap();
        assert_eq!(&f.ops[..2], &["save", "suspend"]);
    }
    #[test]
    fn cancel_queue_before_deleting_anything() {
        let mut p = plan();
        let mut f = Fake::new(&p);
        prepare(&mut f, &mut p).unwrap();
        f.ops.clear();
        restore(&mut f, &mut p, true, false).unwrap();
        let sequence = f.ops.iter().position(|s| s == "sequence").unwrap();
        assert!(sequence < f.ops.iter().position(|s| s == "delete-entry").unwrap());
        assert!(sequence < f.ops.iter().position(|s| s == "delete-efi").unwrap());
    }
    #[test]
    fn already_suspended_bitlocker_stays_suspended() {
        let mut p = plan();
        p.original_bitlocker = BitLocker::Suspended;
        let mut f = Fake::new(&p);
        f.lost_ack = true;
        assert!(prepare(&mut f, &mut p).is_err());
        assert_eq!(f.state.bitlocker, BitLocker::Suspended);
        assert!(!f.ops.iter().any(|s| s == "resume"));
    }
    #[test]
    fn round_trip_without_bitlocker() {
        let mut p = plan();
        p.original_bitlocker = BitLocker::Off;
        let mut f = Fake::new(&p);
        prepare(&mut f, &mut p).unwrap();
        restore(&mut f, &mut p, true, false).unwrap();
        assert_eq!(f.state.bitlocker, BitLocker::Off);
        assert!(!f.ops.iter().any(|s| s == "suspend"));
    }
    #[test]
    fn native_writes_reject_resumed_bitlocker() {
        assert!(check_bitlocker_for_write(BitLocker::Protected).is_err());
        assert!(check_bitlocker_for_write(BitLocker::Suspended).is_ok());
        assert!(check_bitlocker_for_write(BitLocker::Off).is_ok());
    }
}
