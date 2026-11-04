// Адаптер внешнего VBS.cmd: только журнал, фиксированные цели и проверяемый откат.
use super::*;
use crate::external_vbs_plan::{build_plan, ExternalPlan, RestoreAction, JOURNAL_PATH};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalEntry {
    name: String,
    raw: RawRegistrySnapshot,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExternalBackup {
    schema_version: u32,
    journal: Vec<JournalEntry>,
    registry: Vec<RegistrySnapshot>,
    bcd: Vec<BcdSnapshot>,
    services: Vec<ServiceSnapshot>,
    bitlocker_state: String,
    boot_id: String,
    completed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExternalStatus {
    pub detected: bool,
    pub can_restore: bool,
    pub tracked_changes: usize,
    pub requires_uefi_consent: bool,
    pub pending_restart: bool,
    pub detail: String,
    pub blocked_reason: Option<String>,
}

struct ExternalState {
    journal: Vec<JournalEntry>,
    plan: ExternalPlan,
    backup: Option<ExternalBackup>,
    pending_restart: bool,
}

fn plan(journal: &[JournalEntry]) -> Result<ExternalPlan, String> {
    build_plan(
        &journal
            .iter()
            .map(|e| (e.name.clone(), e.raw.kind, e.raw.bytes.clone()))
            .collect::<Vec<_>>(),
    )
}

// Отсутствие ключа не равно отказу в доступе. Неизвестные поля останавливают запись.
fn read_journal() -> Result<Vec<JournalEntry>, String> {
    let key = match RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(JOURNAL_PATH, KEY_READ | KEY_WOW64_64KEY)
    {
        Ok(key) => key,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Не удалось прочитать журнал ManageVBS: {e}")),
    };
    if key.enum_keys().next().is_some() {
        return Err("В ManageVBS обнаружены неподдерживаемые вложенные ключи".into());
    }
    let mut entries = Vec::new();
    let mut size = 0;
    for item in key.enum_values() {
        let (name, raw) = item.map_err(|e| format!("Не удалось прочитать ManageVBS: {e}"))?;
        size += raw.bytes.len();
        if entries.len() >= 31 || name.len() > 64 || size > 4096 {
            return Err("Журнал ManageVBS превышает допустимый размер".into());
        }
        entries.push(JournalEntry {
            name,
            raw: RawRegistrySnapshot {
                kind: raw.vtype as u32,
                bytes: raw.bytes,
            },
        });
    }
    entries.sort_by_key(|e| e.name.to_ascii_lowercase());
    Ok(entries)
}

fn backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(snapshot_path(app)?.with_file_name("external-restore-state.bin"))
}

fn registry_targets(plan: &ExternalPlan) -> Vec<(String, String)> {
    let mut targets = BTreeSet::new();
    for action in &plan.actions {
        match action {
            RestoreAction::Registry { path, name, .. } => {
                targets.insert(((*path).into(), (*name).into()));
            }
            RestoreAction::Service { name, .. } => {
                targets.insert((
                    format!(r"SYSTEM\CurrentControlSet\Services\{name}"),
                    "Start".into(),
                ));
            }
            _ => {}
        }
    }
    targets.into_iter().collect()
}

fn read_backup(app: &AppHandle) -> Result<Option<ExternalBackup>, String> {
    let path = backup_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 512 * 1024 {
        return Err("Слишком большой снимок внешнего VBS".into());
    }
    let decoded = crate::secure_state::crypt(&fs::read(path).map_err(|e| e.to_string())?, false)
        .map_err(|_| "Снимок внешнего VBS не прошёл проверку Windows DPAPI")?;
    let backup: ExternalBackup =
        serde_json::from_slice(&decoded).map_err(|_| "Повреждён снимок внешнего VBS")?;
    if backup.schema_version != 1
        || backup.boot_id.is_empty()
        || backup.boot_id.len() > 128
        || !["off", "protected", "suspended"].contains(&backup.bitlocker_state.as_str())
    {
        return Err("Неподдерживаемый снимок внешнего VBS".into());
    }
    let expected = plan(&backup.journal)?;
    let targets = registry_targets(&expected);
    let actual = backup
        .registry
        .iter()
        .map(|r| (r.path.clone(), r.name.clone()))
        .collect::<BTreeSet<_>>();
    let bcd_expected = expected
        .actions
        .iter()
        .filter_map(|a| match a {
            RestoreAction::Bcd { entry, name, .. } => {
                Some(((*entry).to_string(), (*name).to_string()))
            }
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let bcd_actual = backup
        .bcd
        .iter()
        .map(|b| (b.entry.clone(), b.name.clone()))
        .collect::<BTreeSet<_>>();
    let service_expected = expected
        .actions
        .iter()
        .filter_map(|a| match a {
            RestoreAction::Service { name, .. } => Some((*name).to_string()),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let service_actual = backup
        .services
        .iter()
        .map(|s| s.name.clone())
        .collect::<BTreeSet<_>>();
    if expected.tracked_changes == 0
        || backup.registry.len() != targets.len()
        || actual.into_iter().collect::<Vec<_>>() != targets
        || backup.registry.iter().any(|r| {
            r.raw
                .as_ref()
                .is_some_and(|raw| raw.bytes.len() > 65536 || registry_type(raw.kind).is_err())
        })
        || backup.bcd.len() != bcd_expected.len()
        || bcd_actual != bcd_expected
        || backup
            .bcd
            .iter()
            .any(|b| !valid_bcd_value(&b.name, b.value.as_deref()))
        || backup.services.len() != service_expected.len()
        || service_actual != service_expected
    {
        return Err("Снимок внешнего VBS содержит неразрешённые цели".into());
    }
    Ok(Some(backup))
}

fn save_backup(app: &AppHandle, backup: &ExternalBackup) -> Result<(), String> {
    let data = serde_json::to_vec(backup).map_err(|e| e.to_string())?;
    let encrypted = crate::secure_state::crypt(&data, true)?;
    crate::durable::write(&backup_path(app)?, &encrypted)?;
    let verified = read_backup(app)?.ok_or("Не найден сохранённый снимок внешнего VBS")?;
    if serde_json::to_vec(&verified).map_err(|e| e.to_string())? != data {
        return Err("Снимок внешнего VBS не прошёл проверку после записи".into());
    }
    Ok(())
}

fn is_subset(current: &[JournalEntry], original: &[JournalEntry]) -> bool {
    current.iter().all(|now| {
        original
            .iter()
            .any(|old| old.name.eq_ignore_ascii_case(&now.name) && old.raw == now.raw)
    })
}

fn load(app: &AppHandle, boot_id: &str) -> Result<ExternalState, String> {
    let current = read_journal()?;
    let backup = read_backup(app)?;
    let pending_restart = backup
        .as_ref()
        .is_some_and(|b| b.completed && (boot_id.is_empty() || b.boot_id == boot_id));
    let journal = if let Some(unfinished) = backup.as_ref().filter(|b| !b.completed) {
        if !is_subset(&current, &unfinished.journal) {
            return Err("Журнал ManageVBS изменён после незавершённого отката. Автоматическое объединение отменено; снимок сохранён.".into());
        }
        unfinished.journal.clone()
    } else {
        current
    };
    let plan = plan(&journal)?;
    Ok(ExternalState {
        journal,
        plan,
        backup,
        pending_restart,
    })
}

pub(super) fn status(app: &AppHandle, boot_id: &str, own_snapshot: bool) -> ExternalStatus {
    match load(app, boot_id) {
        Ok(state) => {
            let detected = state.plan.tracked_changes > 0;
            let blocked_reason = if detected && own_snapshot {
                Some("Сначала откатите изменения Eclipse по его снимку, затем восстановите внешний режим VBS.cmd.".into())
            } else if state.pending_restart {
                Some("Сначала перезагрузите Windows для завершения отката внешнего режима.".into())
            } else {
                None
            };
            let detail = if state.pending_restart {
                "Внешний режим восстановлен. Изменения загрузки вступят в силу после перезагрузки Windows."
            } else if state.backup.as_ref().is_some_and(|b| !b.completed) {
                "Незавершённый откат внешнего режима. Проверенный снимок сохранён; можно повторить восстановление."
            } else {
                "Найден журнал VBS.cmd / ARTIFACT. Это настройки Windows, а не подтверждение запуска игрового гипервизора."
            }.into();
            ExternalStatus {
                detected,
                can_restore: detected && blocked_reason.is_none(),
                tracked_changes: state.plan.tracked_changes,
                requires_uefi_consent: state.plan.requires_uefi_consent,
                pending_restart: state.pending_restart,
                detail,
                blocked_reason,
            }
        }
        Err(reason) => ExternalStatus {
            detected: true,
            can_restore: false,
            tracked_changes: 0,
            requires_uefi_consent: false,
            pending_restart: false,
            detail:
                "Внешний режим нельзя безопасно восстановить: журнал или снимок не прошёл проверку."
                    .into(),
            blocked_reason: Some(reason),
        },
    }
}

pub(super) fn guard_enable(app: &AppHandle, boot_id: &str) -> Result<(), String> {
    if boot_id.is_empty() {
        return Err("Windows не вернула время загрузки; изменения отменены".into());
    }
    let state = load(app, boot_id)?;
    if state.pending_restart {
        return Err("Сначала перезагрузите Windows для завершения отката внешнего режима.".into());
    }
    if state.plan.tracked_changes > 0 {
        return Err("Сначала выключите внешний режим VBS.cmd по его журналу. Снимки Eclipse и внешнего скрипта не объединяются автоматически.".into());
    }
    Ok(())
}

fn capture(
    app: &AppHandle,
    state: &ExternalState,
    boot_id: &str,
) -> Result<ExternalBackup, String> {
    if boot_id.is_empty() {
        return Err("Windows не вернула время загрузки; изменения отменены".into());
    }
    let bitlocker = check_bitlocker();
    if bitlocker.state == "unknown" {
        return Err("Состояние BitLocker неизвестно; внешний откат отменён".into());
    }
    let mut registry = Vec::new();
    for (path, name) in registry_targets(&state.plan) {
        let (key_existed, raw) = raw_registry(&path, &name)?;
        registry.push(RegistrySnapshot {
            value: registry_dword(&path, &name),
            path,
            name,
            raw,
            key_existed,
        });
    }
    let mut bcd = Vec::new();
    let mut services = Vec::new();
    for action in &state.plan.actions {
        match action {
            RestoreAction::Bcd { entry, name, .. } => bcd.push(BcdSnapshot {
                entry: (*entry).into(),
                name: (*name).into(),
                value: read_bcd_at(entry, name)?,
            }),
            RestoreAction::Service { name, .. } => {
                // Отсутствующую службу нельзя создавать из неполного внешнего журнала.
                if raw_registry(
                    &format!(r"SYSTEM\CurrentControlSet\Services\{name}"),
                    "Start",
                )?
                .1
                .is_none()
                {
                    return Err(format!("Служба {name} из журнала ManageVBS не установлена"));
                }
                services.push(ServiceSnapshot {
                    name: (*name).into(),
                    running: service_running(name)?,
                });
            }
            _ => {}
        }
    }
    let backup = ExternalBackup {
        schema_version: 1,
        journal: state.journal.clone(),
        registry,
        bcd,
        services,
        bitlocker_state: bitlocker.state,
        boot_id: boot_id.into(),
        completed: false,
    };
    save_backup(app, &backup)?;
    Ok(backup)
}

fn verify_action(action: &RestoreAction) -> Result<(), String> {
    match action {
        RestoreAction::Registry { path, name, value } => verify_dword(path, name, *value),
        RestoreAction::Bcd { entry, name, value } => {
            if bcd_values_match(name, read_bcd_at(entry, name)?.as_deref(), value.as_deref()) {
                Ok(())
            } else {
                Err(format!("Не подтверждён BCD {entry} {name}"))
            }
        }
        RestoreAction::Service {
            name,
            start,
            restart_now,
        } => {
            verify_dword(
                &format!(r"SYSTEM\CurrentControlSet\Services\{name}"),
                "Start",
                Some(*start),
            )?;
            if *restart_now && !service_running(name)? {
                return Err(format!("Служба {name} не запущена"));
            }
            Ok(())
        }
    }
}

fn apply_action(action: &RestoreAction) -> Result<(), String> {
    match action {
        RestoreAction::Registry { path, name, value } => match value {
            Some(number) => set_registry_dword(path, name, *number)?,
            None => delete_registry_value(path, name)?,
        },
        RestoreAction::Bcd { entry, name, value } => write_bcd_at(entry, name, value.as_deref())?,
        RestoreAction::Service {
            name,
            start,
            restart_now,
        } => {
            let mode = match start {
                1 => "system",
                2 => "auto",
                3 => "demand",
                _ => return Err("Неразрешённый тип запуска службы".into()),
            };
            run_command("sc.exe", &["config", name, "start=", mode])?;
            if *restart_now && !service_running(name)? {
                run_command("sc.exe", &["start", name])?;
                // Ожидаем только окончание уже запрошенного запуска, без повторной команды start.
                for _ in 0..20 {
                    if service_running(name).ok() == Some(true) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
            }
        }
    }
    verify_action(action)
}

// Удаляются только проверенные собственные значения скрипта, а не весь ключ реестра.
fn consume_journal(original: &[JournalEntry]) -> Result<(), String> {
    let current = read_journal()?;
    if !is_subset(&current, original) {
        return Err("ManageVBS изменён во время отката; журнал не очищен".into());
    }
    if current.is_empty() {
        return Ok(());
    }
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(JOURNAL_PATH, KEY_READ | KEY_WRITE | KEY_WOW64_64KEY)
        .map_err(|e| e.to_string())?;
    for entry in current {
        let raw = key.get_raw_value(&entry.name).map_err(|e| e.to_string())?;
        if raw.vtype as u32 != entry.raw.kind || raw.bytes != entry.raw.bytes {
            return Err("ManageVBS изменён во время очистки; снимок сохранён".into());
        }
        key.delete_value(&entry.name)
            .map_err(|e| format!("Не удалось удалить ManageVBS\\{}: {e}", entry.name))?;
    }
    if !read_journal()?.is_empty() {
        return Err("В ManageVBS появились новые значения; снимок сохранён".into());
    }
    Ok(())
}

pub(super) fn restore(app: &AppHandle, allow_uefi: bool) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Для восстановления внешнего VBS требуются права администратора".into());
    }
    if snapshot_path(app)?.exists() {
        return Err("Сначала откатите изменения Eclipse по его снимку, затем восстановите внешний режим VBS.cmd.".into());
    }
    let probe = system_probe()?;
    if probe.boot_id.is_empty() {
        return Err("Windows не вернула время загрузки; изменения отменены".into());
    }
    let state = load(app, &probe.boot_id)?;
    if state.pending_restart {
        return Err("Сначала перезагрузите Windows для завершения отката внешнего режима.".into());
    }
    if state.plan.tracked_changes == 0 {
        return Err("В журнале VBS.cmd нет изменений для восстановления".into());
    }
    if state.plan.requires_uefi_consent && !allow_uefi {
        return Err(
            "Внешний журнал требует восстановления UEFI Lock. Необходимо отдельное подтверждение."
                .into(),
        );
    }
    let mut backup = match state.backup.as_ref() {
        Some(backup) if !backup.completed => {
            read_backup(app)?.ok_or("Не найден снимок незавершённого отката")?
        }
        _ => capture(app, &state, &probe.boot_id)?,
    };
    prepare_bitlocker_state(Some(&backup.bitlocker_state))?;
    let mut changed = 0;
    let mut failed = Vec::new();
    for action in &state.plan.actions {
        if verify_action(action).is_ok() {
            continue;
        }
        match apply_action(action) {
            Ok(()) => changed += 1,
            Err(e) => failed.push(e),
        }
    }
    if failed.is_empty() {
        for action in &state.plan.actions {
            if let Err(e) = verify_action(action) {
                failed.push(e);
            }
        }
    }
    if failed.is_empty() {
        if let Err(e) = consume_journal(&backup.journal) {
            failed.push(e);
        }
    }
    if failed.is_empty() {
        backup.completed = true;
        backup.boot_id = probe.boot_id;
        if let Err(e) = save_backup(app, &backup) {
            failed.push(e);
        }
    }
    let mut message = if failed.is_empty() {
        "Настройки внешнего VBS.cmd / ARTIFACT восстановлены по его журналу и проверены. Перезагрузите Windows перед повторным включением через Eclipse."
    } else {
        "Откат выполнен не полностью. Проверенный снимок и оставшийся журнал сохранены; устраните ошибки и повторите восстановление."
    }.to_string();
    if state
        .plan
        .actions
        .iter()
        .any(|a| matches!(a, RestoreAction::Service { name: "FACEIT", .. }))
    {
        message.push_str(" Режимы запуска FACEIT возвращены; драйвер не запускается в текущем сеансе с изменённой DSE. После перезагрузки откройте клиент FACEIT.");
    }
    Ok(VbsChangeResult {
        success: failed.is_empty(),
        message,
        changed,
        failed,
        restart_required: true,
    })
}
