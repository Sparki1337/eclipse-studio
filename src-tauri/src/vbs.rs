//! Управление VBS, HVCI, BitLocker, KVA Shadow, UEFI Lock и гипервизором Windows.

#[path = "vbs_diag.rs"]
mod diag;
#[path = "vbs_external.rs"]
mod external;
#[path = "vbs_types.rs"]
mod types;
#[path = "vbs_uefi.rs"]
mod uefi;

pub(crate) use diag::*;
pub(crate) use serde::{Deserialize, Serialize};
pub(crate) use std::{fs, path::PathBuf};
pub(crate) use tauri::{AppHandle, Emitter};
pub(crate) use types::*;
pub(crate) use winreg::{
    enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY, KEY_WRITE},
    RegKey,
};

#[tauri::command]
pub(crate) async fn vbs_scan(app: AppHandle) -> Result<VbsReport, String> {
    tauri::async_runtime::spawn_blocking(move || scan_report(&app))
        .await
        .map_err(|error| format!("Проверка VBS 2.0.1 была прервана: {error}"))?
}

// Отключение VBS и подготовка к запуску неподписанных драйверов
#[tauri::command]
pub(crate) async fn vbs_disable(
    app: AppHandle,
    allow_uefi: Option<bool>,
) -> Result<VbsChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Изменение VBS",
            || disable_vbs(&app, BootMode::Auto, allow_uefi.unwrap_or(false)),
        )?
    })
    .await
    .map_err(|error| format!("Отключение VBS было прервано: {error}"))?
}

// Подготовка защит Windows для запуска Hypervisor без VBS/HVCI.
// Не включает тестовый режим, DSE и меню выбора загрузки.
#[tauri::command]
pub(crate) async fn hv_disable_protections(
    app: AppHandle,
    allow_uefi: Option<bool>,
) -> Result<VbsChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Подготовка защит Hypervisor",
            || disable_vbs(&app, BootMode::ProtectionsOnly, allow_uefi.unwrap_or(false)),
        )?
    })
    .await
    .map_err(|error| format!("Отключение защит Hypervisor было прервано: {error}"))?
}

#[tauri::command]
pub(crate) async fn vbs_restore(
    app: AppHandle,
    allow_uefi: Option<bool>,
) -> Result<VbsChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Возврат исходных параметров Windows",
            || restore_vbs(&app, false, allow_uefi.unwrap_or(false)),
        )?
    })
    .await
    .map_err(|error| format!("Восстановление VBS было прервано: {error}"))?
}

// Восстановление внешнего режима без подмены собственного снимка Eclipse.
#[tauri::command]
pub(crate) async fn vbs_restore_external(
    app: AppHandle,
    allow_uefi: Option<bool>,
) -> Result<VbsChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Восстановление внешнего VBS.cmd",
            || external::restore(&app, allow_uefi.unwrap_or(false)),
        )?
    })
    .await
    .map_err(|error| format!("Внешний откат VBS был прерван: {error}"))?
}

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

#[tauri::command]
pub(crate) async fn vbs_set_test_mode(
    app: AppHandle,
    enabled: bool,
    allow_uefi: Option<bool>,
) -> Result<VbsChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Тестовый режим Windows",
            || {
                if enabled {
                    disable_vbs(&app, BootMode::TestSigning, allow_uefi.unwrap_or(false))
                } else {
                    restore_vbs(&app, true, allow_uefi.unwrap_or(false))
                }
            },
        )?
    })
    .await
    .map_err(|error| format!("Изменение тестового режима было прервано: {error}"))?
}

#[tauri::command]
pub(crate) async fn vbs_get_protections(
    app: AppHandle,
) -> Result<Vec<IndividualProtection>, String> {
    tauri::async_runtime::spawn_blocking(move || get_individual_protections(&app))
        .await
        .map_err(|error| format!("Получение списка защит прервано: {error}"))?
}

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

#[tauri::command]
pub(crate) fn vbs_restart(app: AppHandle) -> Result<(), String> {
    crate::jobs::run(
        &[crate::jobs::system_resource(&app)],
        "Перезапуск Windows",
        || {
            run_command("shutdown.exe", &["/r", "/t", "0"])
                .map(|_| ())
                .map_err(|error| format!("Не удалось перезапустить Windows: {error}"))
        },
    )?
}

// Подготовка снятия аппаратной блокировки UEFI через SecConfig.efi
#[tauri::command]
pub(crate) async fn vbs_prepare_uefi_optout(
    app: AppHandle,
    allow_uefi: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Подготовка UEFI Opt-Out с журналом возврата",
            || uefi::prepare(&app, allow_uefi.unwrap_or(false)),
        )?
    })
    .await
    .map_err(|error| format!("Подготовка UEFI была прервана: {error}"))?
}

// Активное восстановление подсистем Windows (Fix WMI, DISM RestoreHealth, SFC Scannow)
#[tauri::command]
pub(crate) async fn vbs_repair(app: AppHandle, kind: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Восстановление Windows",
            || run_repair_inner(&app, &kind),
        )?
    })
    .await
    .map_err(|e| e.to_string())?
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

// Диагностика подсистем Windows (WMI, SFC, DISM) без внесения изменений
#[tauri::command]
pub(crate) async fn vbs_troubleshoot(app: AppHandle, action: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::jobs::run(
            &[crate::jobs::system_resource(&app)],
            "Диагностика Windows",
            || run_troubleshoot_inner(&app, &action),
        )?
    })
    .await
    .map_err(|e| e.to_string())?
}

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
    if ![2, 3].contains(&verified.schema_version) {
        return Err("Снимок не прошёл проверку".into());
    }
    Ok(verified)
}
fn read_snapshot(app: &AppHandle) -> Result<VbsSnapshot, String> {
    let data = fs::read(snapshot_path(app)?)
        .map_err(|e| format!("Нет проверяемого снимка восстановления: {e}"))?;
    let decoded = crate::secure_state::crypt(&data, false).map_err(|_| "Старый или неподтверждённый снимок VBS. Он сохранён, но точный автоматический откат по нему невозможен.")?;
    let snapshot: VbsSnapshot = serde_json::from_slice(&decoded).map_err(|e| e.to_string())?;
    if ![2, 3].contains(&snapshot.schema_version) {
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
    let registry_unique = snapshot
        .registry
        .iter()
        .map(|r| (&r.path, &r.name))
        .collect::<std::collections::BTreeSet<_>>();
    let bcd_unique = snapshot
        .bcd
        .iter()
        .map(|b| (&b.entry, &b.name))
        .collect::<std::collections::BTreeSet<_>>();
    let scoped_unique = snapshot
        .scoped_bcd
        .iter()
        .map(|b| (&b.entry, &b.name))
        .collect::<std::collections::BTreeSet<_>>();
    let services_unique = snapshot
        .services
        .iter()
        .map(|s| &s.name)
        .collect::<std::collections::BTreeSet<_>>();
    if registry_unique.len() != snapshot.registry.len()
        || bcd_unique.len() != snapshot.bcd.len()
        || services_unique.len() != snapshot.services.len()
        || scoped_unique.len() != snapshot.scoped_bcd.len()
        || snapshot.scoped_bcd.len() > 2
        || snapshot.bcd.iter().chain(&snapshot.scoped_bcd).any(|b| {
            !permitted_bcd_target(&b.entry, &b.name)
                || !valid_bcd_value(&b.name, b.value.as_deref())
        })
        || snapshot.scoped_bcd.iter().any(|b| b.entry == "{current}")
        || (snapshot.schema_version == 2 && !snapshot.scoped_bcd.is_empty())
    {
        return Err("Снимок содержит повторяющиеся или неразрешённые параметры".into());
    }
    Ok(snapshot)
}
fn prepare_bitlocker(snapshot: &VbsSnapshot) -> Result<(), String> {
    prepare_bitlocker_state(snapshot.bitlocker_state.as_deref())
}
fn prepare_bitlocker_state(original_state: Option<&str>) -> Result<(), String> {
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
    } else if original_state == Some("unknown") {
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
fn disable_vbs(
    app: &AppHandle,
    mode: BootMode,
    allow_uefi: bool,
) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Для изменения параметров запустите программу от имени администратора".into());
    }
    let protections_only = matches!(mode, BootMode::ProtectionsOnly);
    let probe = system_probe()?;
    if !protections_only && !probe.virtualization_firmware_enabled && !probe.hypervisor_present {
        return Err(
            "Включите аппаратную виртуализацию VT-x/SVM в BIOS/UEFI перед изменением VBS".into(),
        );
    }
    windows_hello_preflight()?;
    external::guard_enable(app, &probe.boot_id)?;
    uefi::guard_enable(app, &probe)?;
    let mode = match mode {
        BootMode::Auto if probe.secure_boot == "false" => BootMode::TestSigning,
        BootMode::Auto => BootMode::AdvancedOptions,
        mode => mode,
    };
    if matches!(mode, BootMode::TestSigning) && probe.secure_boot != "false" {
        return Err(
            "Для тестового режима необходимо подтверждённое отключение Secure Boot в BIOS/UEFI"
                .into(),
        );
    }
    let uefi = check_uefi_lock();
    if uefi.is_locked {
        if !allow_uefi {
            return Err(
                "Для снятия UEFI Lock сначала подтвердите отдельную подготовку UEFI Opt-Out".into(),
            );
        }
        let message = uefi::prepare(app, true)?;
        return Ok(change_result(1, Vec::new(), &message));
    }
    let snapshot = ensure_snapshot(app)?;
    if snapshot.uefi_optout_configured {
        return Err(LEGACY_UEFI_SNAPSHOT.into());
    }
    uefi::mark_continuation(app)?;
    prepare_bitlocker(&snapshot)?;
    let mut changed = 0;
    let mut failed = Vec::new();
    for target in REGISTRY_TARGETS {
        // Как VBS.cmd 2.0.1: не создаём отсутствующие неподдерживаемые параметры.
        match raw_registry(target.path, target.name) {
            Ok((_, None)) => continue,
            Ok((_, Some(raw)))
                if raw.kind == 4 && raw.bytes == target.disabled_value.to_le_bytes() =>
            {
                continue
            }
            Ok(_) => {}
            Err(error) => {
                failed.push(error);
                continue;
            }
        }
        match set_registry_dword(target.path, target.name, target.disabled_value)
            .and_then(|_| verify_dword(target.path, target.name, Some(target.disabled_value)))
        {
            Ok(()) => changed += 1,
            Err(e) => failed.push(e),
        }
    }
    // KVA Shadow относится к совместимости со старыми процессорами, а не к защитам Hypervisor
    if !protections_only {
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
    }
    for (name, value) in boot_changes(mode) {
        match write_bcd(name, Some(value)) {
            Ok(()) => changed += 1,
            Err(e) => failed.push(e),
        }
    }
    // Маску XSAVE меняет только полный режим VBS; защитам Hypervisor она не нужна
    if !protections_only && read_xcr0() > 7 {
        match write_bcd(XSAVE_BCD, Some(XSAVE_HV_MASK_VALUE)) {
            Ok(()) => changed += 1,
            Err(e) => failed.push(e),
        }
    }
    for item in &snapshot.scoped_bcd {
        if item.value.as_deref() == Some("auto") {
            match write_bcd_at(&item.entry, &item.name, Some("off")) {
                Ok(()) => changed += 1,
                Err(error) => failed.push(error),
            }
        }
    }
    let mut message = if protections_only {
        "Защиты Windows подготовлены к отключению. Драйвер-подпись, тестовый режим и меню загрузки не изменялись. Перезагрузите Windows."
    } else if matches!(mode, BootMode::TestSigning) {
        "Параметры VBS 2.0.1 изменены и проверены. Secure Boot отключён: выбран Test Signing. Для применения нужна обычная перезагрузка Windows."
    } else {
        "Параметры VBS 2.0.1 изменены и проверены. Подготовлено одноразовое меню: после перезагрузки выберите отключение обязательной проверки подписи драйверов."
    }.to_string();
    message.push_str(
        " Если BitLocker был активен, его защита приостановлена только на одну перезагрузку.",
    );
    if snapshot.scoped_bcd.len() < 2 {
        message.push_str(
            " Недоступные общие записи BCD не изменялись; настройки текущей загрузки проверены.",
        );
    }
    Ok(change_result(changed, failed, &message))
}
fn restore_vbs(
    app: &AppHandle,
    _disable_test_mode: bool,
    allow_uefi: bool,
) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Для восстановления запустите программу от имени администратора".into());
    }
    if !snapshot_path(app)?
        .try_exists()
        .map_err(|e| e.to_string())?
        && uefi::exists(app)?
    {
        uefi::restore(app, allow_uefi)?;
        return Ok(change_result(1, Vec::new(), "Самостоятельный журнал UEFI восстановлен. Собственные EFI/BCD-объекты убраны, исходные параметры блокировки возвращены. Для применения UEFI Lock нужна перезагрузка Windows."));
    }
    // Независимый корректный журнал UEFI всё равно откатывается, когда основной снимок VBS
    // повреждён или устарел. Не выдавать это за успешный основной откат.
    let snapshot = match read_snapshot(app).and_then(|snapshot| {
        if snapshot.uefi_optout_configured {
            Err(LEGACY_UEFI_SNAPSHOT.into())
        } else {
            Ok(snapshot)
        }
    }) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            if !uefi::exists(app)? {
                return Err(error);
            }
            uefi::restore(app, allow_uefi)?;
            return Ok(change_result(
                1,
                vec![format!("Основной снимок VBS сохранён, но не восстановлен: {error}")],
                "Собственная операция UEFI отменена по независимому проверенному журналу. Очередь и собственные EFI/BCD-объекты убраны, исходные политики UEFI возвращены. Для их применения нужна перезагрузка. Общий откат VBS не объявляется выполненным.",
            ));
        }
    };
    let uefi_restored = uefi::restore(app, allow_uefi)?;
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
    for item in snapshot.bcd.iter().chain(&snapshot.scoped_bcd) {
        let value = restore_bcd_value(&item.name, item.value.as_deref());
        match write_bcd_at(&item.entry, &item.name, value) {
            Ok(()) => {
                changed += 1;
                xsave_mask_removed |= xsave_mask_set && item.name == XSAVE_BCD && value.is_none();
            }
            Err(e) => failed.push(e),
        }
    }
    // После изменения BCD не возобновляем BitLocker до перезагрузки: rebootcount=1
    // автоматически вернёт защиту после загрузки с уже восстановленными параметрами.
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
    if uefi_restored {
        message.push_str(" Собственные EFI/BCD-объекты UEFI Opt-Out убраны; исходные политики UEFI Lock возвращены. Применение блокировок прошивкой требует перезагрузки; очистка файлов сама по себе не подтверждает состояние firmware.");
    }
    message.push_str(" Для применения параметров загрузки требуется перезапуск Windows.");
    Ok(change_result(changed, failed, &message))
}
fn enable_all_protections(app: &AppHandle, reboot: bool) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Для изменения параметров требуются права администратора".into());
    }
    external::guard_enable(app, &system_probe()?.boot_id)?;
    uefi::guard_other_mutation(app)?;
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
    for item in &snapshot.scoped_bcd {
        if item.value.is_some() {
            match write_bcd_at(&item.entry, &item.name, Some("auto")) {
                Ok(()) => changed += 1,
                Err(error) => failed.push(error),
            }
        }
    }
    // Сторонние ключи и режимы запуска служб здесь больше не сбрасываются
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
// Маска XSAVE скрывает расширения сверх x87, SSE и AVX при XCR0 > 7
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
// При откате всегда снимаем маску XSAVE; остальные значения BCD восстанавливаем из снимка
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
            description:
                "Блокировка загрузки драйверов из списка Microsoft Vulnerable Driver Blocklist"
                    .into(),
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
            description: "Теневое разделение адресных пространств ядра для защиты от Meltdown"
                .into(),
            enabled: kva_on,
            locked: false,
            lock_reason: None,
        },
        IndividualProtection {
            id: "xsave-mask".into(),
            name: "Маска XSAVE в загрузчике (xsaveremovefeature)".into(),
            category: "Параметры загрузчика (BCD)".into(),
            description: "Скрытие AVX-512 и расширенных наборов инструкций процессора от программ"
                .into(),
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

fn set_individual_protection(
    app: &AppHandle,
    id: &str,
    enable: bool,
) -> Result<VbsChangeResult, String> {
    if !is_admin() {
        return Err("Требуются права администратора".into());
    }
    uefi::guard_other_mutation(app)?;
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
            if let Err(e) =
                set_registry_dword(r"SYSTEM\CurrentControlSet\Control\Lsa", "LsaCfgFlags", val)
            {
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

    let status_word = if enable {
        "включен"
    } else {
        "отключен"
    };
    let message = if failed.is_empty() {
        if restart_required {
            format!(
                "Параметр успешно {status_word}. Для применения требуется перезагрузка Windows."
            )
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
    fn protections_only_keeps_boot_changes_minimal() {
        let changes = boot_changes(BootMode::ProtectionsOnly);
        assert_eq!(
            changes,
            vec![("hypervisorlaunchtype", "off"), ("vsmlaunchtype", "off")]
        );
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
    fn native_wmi_errors_keep_bitlocker_unknown_and_request_rights() {
        for code in ["0x80041003", "0x80070005"] {
            let text = serde_json::json!({"error":"exception", "code":format!("Подключение WMI: {code} ({code})")}).to_string();
            let info = parse_bitlocker(&text, false);
            assert_eq!(info.state, "unknown");
            assert!(info.needs_admin && !info.protected && !info.suspended);
            assert!(!parse_bitlocker(&text, true).needs_admin);
        }
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

    #[test]
    fn bcd_matching_recognizes_custom_xsave_id() {
        assert!(matches_bcd_key("xsaveremovefeature", "xsaveremovefeature"));
        assert!(matches_bcd_key("custom:25000129", "xsaveremovefeature"));
        assert!(matches_bcd_key("custom:0x25000129", "xsaveremovefeature"));
        assert!(matches_bcd_key("25000129", "xsaveremovefeature"));
        assert!(!matches_bcd_key("custom:25000128", "xsaveremovefeature"));

        assert!(bcd_values_match(
            "xsaveremovefeature",
            Some("0xfffffffffffffff8"),
            Some("0xFFFFFFFFFFFFFFF8")
        ));
        assert!(bcd_values_match(
            "xsaveremovefeature",
            Some("18446744073709551608"),
            Some("0xfffffffffffffff8")
        ));
        assert!(bcd_values_match("xsaveremovefeature", None, None));
        assert!(!bcd_values_match(
            "xsaveremovefeature",
            Some("0xfffffffffffffff8"),
            None
        ));
        assert!(!bcd_values_match(
            "xsaveremovefeature",
            None,
            Some("0xfffffffffffffff8")
        ));
    }
}
