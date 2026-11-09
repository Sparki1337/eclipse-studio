//! Windows-адаптер журналируемой транзакции UEFI; тесты используют макет платформы.
use super::*;
use crate::{
    uefi_files,
    uefi_transaction::{
        self as transaction, BitLocker, Journal, Observed, Phase, Platform, RegistryChange,
    },
};
use std::{collections::BTreeMap, io::Read};

const ACTIVE: &str = "uefi-transaction.bin";
const RESTORED: &str = "uefi-last-restored.bin";
const MAX_JOURNAL: u64 = 20 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    pub(super) active: bool,
    pub(super) prepared: bool,
    pub(super) can_continue: bool,
    pub(super) pending_restart: bool,
    pub(super) requires_relock: bool,
    pub(super) detail: String,
    pub(super) blocked_reason: Option<String>,
}
fn journal_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let path = snapshot_path(app)?
        .parent()
        .ok_or("Нет каталога снимка VBS")?
        .join(name);
    crate::safe_path::no_links(&path)?;
    Ok(path)
}
pub(super) fn exists(app: &AppHandle) -> Result<bool, String> {
    journal_path(app, ACTIVE)?
        .try_exists()
        .map_err(|e| e.to_string())
}
fn read_journal(app: &AppHandle) -> Result<Journal, String> {
    let path = journal_path(app, ACTIVE)?;
    let file = fs::File::open(&path).map_err(|e| format!("Журнал UEFI недоступен: {e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_JOURNAL {
        return Err("Журнал UEFI превышает допустимый размер".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_JOURNAL + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let decoded = crate::secure_state::crypt(&bytes, false)
        .map_err(|_| "Журнал UEFI не прошёл DPAPI-проверку; исходные данные сохранены")?;
    let journal: Journal = serde_json::from_slice(&decoded)
        .map_err(|_| "Формат журнала UEFI повреждён; данные сохранены")?;
    journal.validate()?;
    Ok(journal)
}
fn store(app: &AppHandle, name: &str, plan: &Journal) -> Result<(), String> {
    plan.validate()?;
    let path = journal_path(app, name)?;
    let bytes = serde_json::to_vec(plan).map_err(|e| e.to_string())?;
    let encoded = crate::secure_state::crypt(&bytes, true)?;
    crate::durable::write(&path, &encoded)?;
    let verified = crate::secure_state::crypt(&fs::read(path).map_err(|e| e.to_string())?, false)?;
    if verified != bytes {
        return Err("Снимок UEFI не прошёл проверку чтением".into());
    }
    Ok(())
}
pub(super) fn status(app: &AppHandle, boot_id: &str) -> Option<Status> {
    match exists(app) {
        Ok(false) => None,
        Err(error) => Some(Status {
            active: true,
            prepared: false,
            can_continue: false,
            pending_restart: false,
            requires_relock: true,
            detail: error.clone(),
            blocked_reason: Some(error),
        }),
        Ok(true) => Some(match read_journal(app) {
            Ok(plan) => {
                let prepared = plan.phase == Phase::Prepared;
                let pending = prepared && plan.boot_id == boot_id;
                Status{active:true,prepared,can_continue:prepared&&!pending&&!plan.continuation_done,pending_restart:pending,requires_relock:true,
                    detail:if pending {"UEFI Opt-Out подготовлен. При следующей загрузке подтвердите запрос SecConfig на экране компьютера. Можно отменить через откат Eclipse."}else if prepared {"Снимок UEFI сохранён. Если подтверждение при загрузке прошло, можно продолжить подготовку визора. Для возврата исходных блокировок используйте откат Eclipse."}else{"Незавершённая операция UEFI. Сначала выполните откат Eclipse; повторное выполнение безопасно проверит уже возвращённые части."}.into(),
                    blocked_reason:if pending{Some("Сначала перезагрузите Windows и подтвердите UEFI Opt-Out либо выполните откат".into())}else if !prepared {Some("Сначала завершите откат незавершённой операции UEFI".into())}else{None}}
            }
            Err(error) => Status {
                active: true,
                prepared: false,
                can_continue: false,
                pending_restart: false,
                requires_relock: true,
                detail: error.clone(),
                blocked_reason: Some(error),
            },
        }),
    }
}
pub(super) fn guard_enable(app: &AppHandle, probe: &SystemProbe) -> Result<(), String> {
    if let Some(status) = status(app, &probe.boot_id) {
        if let Some(reason) = status.blocked_reason {
            return Err(reason);
        }
        let plan = read_journal(app)?;
        if (plan.disable_vbs && probe.vbs_status == 2)
            || parse_service_ids(&probe.running_services).contains(&1)
        {
            return Err("После перезагрузки защита ещё активна: UEFI Opt-Out не подтверждён. Сначала выполните откат Eclipse; не повторяйте изменения вслепую".into());
        }
    }
    Ok(())
}
pub(super) fn mark_continuation(app: &AppHandle) -> Result<(), String> {
    if exists(app)? {
        let mut plan = read_journal(app)?;
        plan.continuation_done = true;
        store(app, ACTIVE, &plan)?;
    }
    Ok(())
}
pub(super) fn guard_other_mutation(app: &AppHandle) -> Result<(), String> {
    if exists(app)? {
        return Err("Активен снимок UEFI Opt-Out. Сначала выполните откат Eclipse, чтобы не смешивать настройки восстановления".into());
    }
    Ok(())
}
fn bitlocker_state() -> Result<BitLocker, String> {
    let state = check_bitlocker();
    match state.state.as_str() {
        "protected" => Ok(BitLocker::Protected),
        "suspended" => Ok(BitLocker::Suspended),
        "off" => Ok(BitLocker::Off),
        _ => Err(format!("Изменения UEFI запрещены: {}", state.message)),
    }
}
fn read_dword(path: &str, name: &str) -> Result<Option<u32>, String> {
    match raw_registry(path, name)?.1 {
        None => Ok(None),
        Some(raw) if raw.kind == 4 && raw.bytes.len() == 4 => Ok(Some(u32::from_le_bytes(
            raw.bytes.try_into().map_err(|_| "Неверный DWORD")?,
        ))),
        Some(_) => Err(format!(
            "UEFI: неподдерживаемый тип параметра {path}\\{name}"
        )),
    }
}
fn validate_image(bytes: &[u8]) -> Result<(), String> {
    let fail = || "Системный SecConfig.efi не является допустимым EFI-приложением".to_string();
    if bytes.len() < 128 || bytes.len() > transaction::MAX_IMAGE || bytes.get(..2) != Some(b"MZ") {
        return Err(fail());
    }
    let offset = u32::from_le_bytes(bytes[0x3c..0x40].try_into().map_err(|_| fail())?) as usize;
    let header = bytes
        .get(offset..offset.saturating_add(96))
        .ok_or_else(fail)?;
    if header.get(..4) != Some(b"PE\0\0")
        || !matches!(u16::from_le_bytes([header[24], header[25]]), 0x10b | 0x20b)
        || u16::from_le_bytes([header[92], header[93]]) != 10
    {
        return Err(fail());
    }
    Ok(())
}
struct WindowsPlatform<'a> {
    app: &'a AppHandle,
    boot_id: String,
}
impl WindowsPlatform<'_> {
    fn progress(&self, text: &str) {
        let _ = self.app.emit("vbs-progress", text);
    }
    fn volume(plan: &Journal) -> PathBuf {
        PathBuf::from(&plan.volume_id)
    }
    fn guard_write(&self) -> Result<(), String> {
        transaction::check_bitlocker_for_write(bitlocker_state()?)
    }
}
impl Platform for WindowsPlatform<'_> {
    fn save(&mut self, plan: &Journal) -> Result<(), String> {
        store(self.app, ACTIVE, plan)
    }
    fn observe(&mut self, plan: &Journal) -> Result<Observed, String> {
        let result = crate::uefi_bcd::observe(plan)?;
        let registry = plan
            .registry
            .iter()
            .map(|c| {
                Ok((
                    (c.path.clone(), c.name.clone()),
                    read_dword(&c.path, &c.name)?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        Ok(Observed {
            boot_id: self.boot_id.clone(),
            bitlocker: bitlocker_state()?,
            sequence: result.sequence,
            entry: result.entry,
            efi: uefi_files::inspect(&Self::volume(plan), plan)?,
            registry,
        })
    }
    fn suspend_bitlocker(&mut self) -> Result<(), String> {
        self.progress("Проверка и приостановка BitLocker на одну перезагрузку…");
        prepare_bitlocker_state(None)
    }
    fn resume_bitlocker(&mut self) -> Result<(), String> {
        self.progress("Возврат защиты BitLocker после отменённой подготовки…");
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        run_command("manage-bde.exe", &["-protectors", "-enable", &drive]).map(|_| ())
    }
    fn install_efi(&mut self, plan: &Journal) -> Result<(), String> {
        self.guard_write()?;
        self.progress("Создание отдельной проверяемой копии SecConfig в EFI…");
        uefi_files::install(&Self::volume(plan), plan)
    }
    fn create_entry(&mut self, plan: &Journal) -> Result<(), String> {
        self.guard_write()?;
        self.progress("Создание собственной одноразовой записи BCD…");
        crate::uefi_bcd::create(plan, || self.guard_write())
    }
    fn set_registry(&mut self, item: &RegistryChange, value: u32) -> Result<(), String> {
        if !transaction::REGISTRY_TARGETS.contains(&(item.path.as_str(), item.name.as_str()))
            || !(value == 0 || value == item.original)
        {
            return Err("Неразрешённый параметр UEFI".into());
        }
        let current = read_dword(&item.path, &item.name)?;
        if current != Some(0) && current != Some(item.original) {
            return Err("Параметр UEFI изменился перед записью".into());
        }
        self.guard_write()?;
        set_registry_dword(&item.path, &item.name, value)?;
        verify_dword(&item.path, &item.name, Some(value))
    }
    fn set_sequence(&mut self, sequence: Option<&[String]>) -> Result<(), String> {
        // Только проверенный активный журнал задаёт допустимые идентификаторы BCD.
        let plan = read_journal(self.app)?;
        let expected = crate::uefi_bcd::observe(&plan)?.sequence;
        let planned = plan.scheduled_sequence();
        if expected != plan.original_sequence
            && expected.as_deref() != Some(planned.as_slice())
            && !(self.boot_id != plan.boot_id
                && expected.as_deref() == Some(std::slice::from_ref(&plan.loader_id)))
        {
            return Err("Очередь BCD изменена извне".into());
        }
        if sequence != plan.original_sequence.as_deref() && sequence != Some(planned.as_slice()) {
            return Err("Неразрешённая очередь BCD".into());
        }
        self.guard_write()?;
        self.progress("Проверка одноразовой очереди загрузки…");
        crate::uefi_bcd::set_sequence(&plan, sequence, expected.as_deref())
    }
    fn delete_entry(&mut self, plan: &Journal) -> Result<(), String> {
        self.guard_write()?;
        self.progress("Удаление только собственной записи UEFI Opt-Out…");
        crate::uefi_bcd::delete(plan)
    }
    fn delete_efi(&mut self, plan: &Journal) -> Result<(), String> {
        self.guard_write()?;
        self.progress("Проверка и удаление только собственной EFI-копии…");
        uefi_files::remove(&Self::volume(plan), plan)
    }
    fn finish(&mut self, plan: &Journal) -> Result<(), String> {
        store(self.app, RESTORED, plan)?;
        fs::remove_file(journal_path(self.app, ACTIVE)?).map_err(|e| e.to_string())
    }
}

pub(super) fn prepare(app: &AppHandle, consent: bool) -> Result<String, String> {
    if !is_admin() {
        return Err("Для UEFI Opt-Out нужны права администратора".into());
    }
    if !consent {
        return Err("Для снятия UEFI Lock требуется отдельное явное согласие".into());
    }
    let probe = system_probe()?;
    if probe.boot_id.is_empty() {
        return Err("Не удалось определить текущую загрузку Windows".into());
    }
    windows_hello_preflight()?;
    external::guard_enable(app, &probe.boot_id)?;
    if exists(app)? {
        return Err("Операция UEFI уже записана. Перезагрузите Windows для подтверждения либо сначала выполните откат Eclipse".into());
    }
    let locks = check_uefi_lock();
    if !locks.is_locked {
        return Ok("UEFI Lock не обнаружен; изменение EFI не требуется".into());
    }
    let original_bitlocker = bitlocker_state()?; // ДО временного монтирования EFI
    let own = ensure_snapshot(app)?;
    if own.uefi_optout_configured {
        return Err(LEGACY_UEFI_SNAPSHOT.into());
    }
    let source = system_tool("SecConfig.efi");
    crate::safe_path::no_links(&source)?;
    let mut image = Vec::new();
    fs::File::open(source)
        .map_err(|e| format!("SecConfig.efi недоступен: {e}"))?
        .take(transaction::MAX_IMAGE as u64 + 1)
        .read_to_end(&mut image)
        .map_err(|e| e.to_string())?;
    validate_image(&image)?;
    let env = crate::uefi_bcd::capture()?;
    let registry = transaction::REGISTRY_TARGETS
        .iter()
        .filter_map(|(path, name)| match read_dword(path, name) {
            Ok(Some(value)) if value != 0 => Some(Ok(RegistryChange {
                path: (*path).into(),
                name: (*name).into(),
                original: value,
            })),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut plan = Journal {
        version: transaction::VERSION,
        nonce: uuid::Uuid::new_v4().simple().to_string(),
        boot_id: probe.boot_id.clone(),
        loader_id: env.loader_id,
        volume_id: env.volume_id,
        image_sha256: transaction::digest(&image),
        image,
        original_sequence: env.sequence,
        original_bitlocker,
        registry,
        disable_vbs: locks.vbs_locked || locks.hvci_locked,
        continuation_done: false,
        phase: Phase::Preparing,
    };
    transaction::prepare(
        &mut WindowsPlatform {
            app,
            boot_id: probe.boot_id,
        },
        &mut plan,
    )?;
    Ok("UEFI Opt-Out подготовлен и проверен. Исходные параметры сохранены в защищённом журнале; существующие системный SecConfig.efi и DGOptOut не перезаписаны. При следующей загрузке подтвердите запрос SecConfig на экране компьютера. После входа снова проверьте VBS. Для отмены и возврата исходных UEFI Lock используйте откат Eclipse; потребуется перезагрузка.".into())
}
pub(super) fn restore(app: &AppHandle, consent: bool) -> Result<bool, String> {
    if !exists(app)? {
        return Ok(false);
    }
    let mut plan = read_journal(app)?;
    let probe = system_probe()?;
    if probe.boot_id.is_empty() {
        return Err("Нельзя подтвердить текущую загрузку для отката UEFI".into());
    }
    transaction::restore(
        &mut WindowsPlatform {
            app,
            boot_id: probe.boot_id,
        },
        &mut plan,
        consent,
        false,
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn efi_pe_validation_rejects_wrong_subsystem_and_truncation() {
        let mut b = vec![0u8; 256];
        b[..2].copy_from_slice(b"MZ");
        b[0x3c..0x40].copy_from_slice(&64u32.to_le_bytes());
        b[64..68].copy_from_slice(b"PE\0\0");
        b[88..90].copy_from_slice(&0x20bu16.to_le_bytes());
        b[156..158].copy_from_slice(&10u16.to_le_bytes());
        validate_image(&b).unwrap();
        b[156] = 3;
        assert!(validate_image(&b).is_err());
        assert!(validate_image(&b[..100]).is_err());
    }
    #[test]
    fn bcd_adapter_has_no_fixed_example_guid_or_system_secconfig_overwrite() {
        let s = include_str!("uefi_bcd.rs");
        assert!(!s.contains("0cb3b571-2f2e-4343-a879-d86a476d7215"));
        assert!(!s.contains("\\EFI\\Microsoft\\Boot\\SecConfig.efi"));
        assert!(s.contains("SetObjectListElement"));
        assert!(s.contains("store.sequence()?.as_deref() != expected"));
        assert!(s.contains("store.sequence()?.as_deref() != desired"));
        assert!(!s.to_ascii_lowercase().contains("powershell"));
    }
}
