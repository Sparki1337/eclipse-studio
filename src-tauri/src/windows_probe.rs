//! Диагностика Windows через WMI/Win32/NT API, без запуска PowerShell.
use crate::{
    windows_probe_core as core,
    windows_wmi::{Connection, Input},
};
use serde_json::{json, Value};
use windows::Win32::System::SystemInformation::{GetFirmwareType, FIRMWARE_TYPE};
use winreg::{
    enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY},
    RegKey,
};
pub(crate) struct Probe {
    pub vbs_status: i32,
    pub configured_services: String,
    pub running_services: String,
    pub hypervisor_present: bool,
    pub virtualization_firmware_enabled: bool,
    pub secure_boot: String,
    pub dse_mode: i32,
    pub boot_id: String,
}
#[link(name = "ntdll")]
extern "system" {
    fn NtQuerySystemInformation(
        class: u32,
        value: *mut std::ffi::c_void,
        length: u32,
        returned: *mut u32,
    ) -> i32;
}
fn query_kernel<T>(class: u32, value: &mut T) -> Result<(), String> {
    let mut returned = 0;
    let size = std::mem::size_of::<T>() as u32;
    let status =
        unsafe { NtQuerySystemInformation(class, (value as *mut T).cast(), size, &mut returned) };
    if status != 0 || (returned != 0 && returned != size) {
        return Err(format!(
            "NtQuerySystemInformation: 0x{:08X}, размер {returned}",
            status as u32
        ));
    }
    Ok(())
}
pub(crate) fn kva_needed() -> Result<bool, String> {
    let mut flags = 0u32;
    query_kernel(196, &mut flags)?;
    Ok(core::kva_needed(flags))
}
fn dse_mode() -> Result<i32, String> {
    #[repr(C)]
    struct CodeIntegrity {
        length: u32,
        options: u32,
    }
    let mut value = CodeIntegrity {
        length: 8,
        options: 0,
    };
    query_kernel(103, &mut value)?;
    Ok(core::dse_mode(value.options))
}
fn secure_boot() -> String {
    let mut firmware = FIRMWARE_TYPE::default();
    if unsafe { GetFirmwareType(&mut firmware) }.is_err() {
        return "unknown".into();
    }
    if firmware.0 == 1 {
        return "false".into();
    }
    if firmware.0 != 2 {
        return "unknown".into();
    }
    let value = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            r"SYSTEM\CurrentControlSet\Control\SecureBoot\State",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .and_then(|key| key.get_value::<u32, _>("UEFISecureBootEnabled"));
    match value {
        Ok(0) => "false",
        Ok(1) => "true",
        _ => "unknown",
    }
    .into()
}
pub(crate) fn bitlocker() -> Result<Value, String> {
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let bytes = drive.as_bytes();
    if bytes.len() != 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return Err("Некорректный SystemDrive".into());
    }
    let connection = Connection::open(r"root\CIMV2\Security\MicrosoftVolumeEncryption")?;
    let volumes = connection.query(&format!(
        "SELECT * FROM Win32_EncryptableVolume WHERE DriveLetter='{drive}'"
    ))?;
    if volumes.is_empty() {
        return Ok(json!({"error":"volume"}));
    }
    if volumes.len() != 1 {
        return Err("BitLocker вернул несколько системных томов".into());
    }
    let path = volumes[0].text("__PATH")?;
    let protection =
        connection.call("Win32_EncryptableVolume", &path, "GetProtectionStatus", &[])?;
    let conversion = connection.call(
        "Win32_EncryptableVolume",
        &path,
        "GetConversionStatus",
        &[("PrecisionFactor", Input::Number(0))],
    )?;
    let p = protection.number("ReturnValue")?;
    let c = conversion.number("ReturnValue")?;
    if p != 0 || c != 0 {
        return Ok(json!({"error":"api","code":format!("0x{p:08X}/0x{c:08X}")}));
    }
    Ok(
        json!({"protection":protection.number("ProtectionStatus")?,"encrypted":conversion.number("EncryptionPercentage")?}),
    )
}
pub(crate) fn probe() -> Result<Probe, String> {
    let system = Connection::open(r"root\CIMV2")?;
    let computer = system.query("SELECT HypervisorPresent FROM Win32_ComputerSystem")?;
    let cpu = system.query("SELECT VirtualizationFirmwareEnabled FROM Win32_Processor")?;
    let os = system.query("SELECT LastBootUpTime FROM Win32_OperatingSystem")?;
    let hypervisor_present = computer
        .first()
        .and_then(|v| v.boolean("HypervisorPresent").ok())
        .unwrap_or(false);
    let virtualization_firmware_enabled = cpu
        .first()
        .and_then(|v| v.boolean("VirtualizationFirmwareEnabled").ok())
        .unwrap_or(false);
    let boot_id = os
        .first()
        .and_then(|v| v.text("LastBootUpTime").ok())
        .and_then(|v| core::cim_boot_id(&v).ok())
        .unwrap_or_default();
    let mut result = Probe {
        vbs_status: 0,
        configured_services: String::new(),
        running_services: String::new(),
        hypervisor_present,
        virtualization_firmware_enabled,
        secure_boot: secure_boot(),
        dse_mode: dse_mode().unwrap_or(-1),
        boot_id,
    };
    // На старых сборках Windows класс DeviceGuard отсутствует; остальные проверки сохраняются.
    if let Ok(connection) = Connection::open(r"root\Microsoft\Windows\DeviceGuard") {
        if let Ok(objects) = connection.query("SELECT VirtualizationBasedSecurityStatus,SecurityServicesConfigured,SecurityServicesRunning FROM Win32_DeviceGuard") {
            if let Some(object) = objects.first() {
                result.vbs_status = object.number("VirtualizationBasedSecurityStatus").unwrap_or(0) as i32;
                let list = |name| object.numbers(name).unwrap_or_default().iter().map(u32::to_string).collect::<Vec<_>>().join(",");
                result.configured_services = list("SecurityServicesConfigured"); result.running_services = list("SecurityServicesRunning");
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod read_only_integration {
    #[test]
    #[ignore = "Явный диагностический опрос Windows без записи настроек"]
    fn native_probe_read_only() {
        let value = super::probe().unwrap();
        assert!(
            !value.boot_id.is_empty(),
            "Нет проверенного времени загрузки"
        );
        eprintln!(
            "VBS={}, DSE={}, SecureBoot={}",
            value.vbs_status, value.dse_mode, value.secure_boot
        );
        match super::bitlocker() {
            Ok(value) => eprintln!("BitLocker diagnostic: {value}"),
            Err(error) => eprintln!("BitLocker остаётся неизвестным, изменения запрещены: {error}"),
        }
    }
}
