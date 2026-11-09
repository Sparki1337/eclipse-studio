//! Нативный адаптер UEFI: COM/WMI, Win32 и системный bcdedit без оболочки.
use crate::{
    bcd_policy::{self as policy, Content, Element},
    uefi_transaction::{valid_guid, Journal, Presence},
    windows_wmi::{Connection, Input, Object},
};
use std::{
    io::Read,
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use windows::{
    core::HSTRING,
    Win32::Storage::FileSystem::{
        GetLogicalDrives, GetVolumeNameForVolumeMountPointW, QueryDosDeviceW,
    },
};
const MANAGER: &str = "{9dea862c-5cdd-4e70-acc1-f32b344d4795}";
const STORE: &str = "BcdStore.FilePath=\"\"";
fn object_path(id: &str) -> Result<String, String> {
    if !valid_guid(id) {
        return Err("Неверный идентификатор BCD".into());
    }
    Ok(format!("BcdObject.Id=\"{id}\",StoreFilePath=\"\""))
}
fn checked<'a>(result: Object<'a>) -> Result<Object<'a>, String> {
    if !result.boolean("ReturnValue")? {
        return Err("Провайдер BCD отклонил операцию".into());
    }
    Ok(result)
}
struct Store<'a> {
    connection: &'a Connection,
}
impl<'a> Store<'a> {
    fn open(connection: &'a Connection) -> Result<Self, String> {
        checked(connection.call(
            "BcdStore",
            "BcdStore",
            "OpenStore",
            &[("File", Input::Text(""))],
        )?)?
        .object("Store")?;
        Ok(Self { connection })
    }
    fn objects(&self) -> Result<Vec<Object<'a>>, String> {
        checked(self.connection.call(
            "BcdStore",
            STORE,
            "EnumerateObjects",
            &[("Type", Input::Number(0))],
        )?)?
        .objects("Objects")
    }
    fn elements(&self, id: &str) -> Result<Vec<Object<'a>>, String> {
        checked(
            self.connection
                .call("BcdObject", &object_path(id)?, "EnumerateElements", &[])?,
        )?
        .objects("Elements")
    }
    fn sequence(&self) -> Result<Option<Vec<String>>, String> {
        let mut result = None;
        for element in self.elements(MANAGER)? {
            if element.number("Type")? != policy::BOOT_SEQUENCE {
                continue;
            }
            if result.is_some() {
                return Err("Повторяющийся элемент очереди BCD".into());
            }
            result = Some(policy::normalize_sequence(element.strings("Ids")?)?);
        }
        Ok(result)
    }
    fn records(&self, id: &str) -> Result<Vec<Element>, String> {
        self.elements(id)?
            .into_iter()
            .map(|element| {
                let kind = element.number("Type")?;
                let content = match kind {
                    policy::DESCRIPTION | policy::APPLICATION_PATH | policy::LOAD_OPTIONS => {
                        Content::Text(element.text("String")?)
                    }
                    policy::APPLICATION_DEVICE => {
                        let device = element.object("Device")?;
                        Content::Device {
                            kind: device.number("DeviceType")?,
                            path: device.text("Path")?,
                            additional: device
                                .optional_text("AdditionalOptions")?
                                .unwrap_or_default(),
                        }
                    }
                    _ => Content::Other,
                };
                Ok(Element { kind, content })
            })
            .collect()
    }
    fn entry(&self, plan: &Journal) -> Result<(Presence, Vec<Element>), String> {
        let id = plan.entry_id();
        let mut found = None;
        for object in self.objects()? {
            if !object.text("Id")?.eq_ignore_ascii_case(&id) {
                continue;
            }
            if found.is_some() {
                return Ok((Presence::Conflict, Vec::new()));
            }
            found = Some(object.number("Type")?);
        }
        let Some(kind) = found else {
            return Ok((Presence::Absent, Vec::new()));
        };
        if kind != policy::LOADER_TYPE {
            return Ok((Presence::Conflict, Vec::new()));
        }
        let records = self.records(&id)?;
        let presence = policy::ownership(plan, kind, &records, &nt_volume(&plan.volume_id)?);
        Ok((presence, records))
    }
}
pub(crate) struct Captured {
    pub loader_id: String,
    pub volume_id: String,
    pub sequence: Option<Vec<String>>,
}
pub(crate) struct Observed {
    pub entry: Presence,
    pub sequence: Option<Vec<String>>,
}
pub(crate) fn capture() -> Result<Captured, String> {
    let _privileges = crate::windows_token::BcdPrivileges::acquire()?;
    let connection = Connection::open(r"root\WMI")?;
    let store = Store::open(&connection)?;
    let sequence = store.sequence()?;
    if sequence.is_some() {
        return Err("В BCD уже есть одноразовая очередь, даже если она пуста. Сначала завершите чужую операцию".into());
    }
    let loaders = store
        .objects()?
        .iter()
        .filter_map(|object| match object.number("Type") {
            Ok(policy::LOADER_TYPE) => Some(object.text("Id").map(|v| v.to_ascii_lowercase())),
            Ok(_) => None,
            Err(e) => Some(Err(e)),
        })
        .collect::<Result<Vec<_>, String>>()?;
    let text = tool("bcdedit.exe", &["/enum", "{current}", "/v"])?;
    let loader_id = policy::current_loader(&text, &loaders)?;
    let volume_id = with_efi(None, |_, volume| Ok(volume.to_string()))?;
    Ok(Captured {
        loader_id,
        volume_id,
        sequence,
    })
}
pub(crate) fn observe(plan: &Journal) -> Result<Observed, String> {
    plan.validate()?;
    let _privileges = crate::windows_token::BcdPrivileges::acquire()?;
    let connection = Connection::open(r"root\WMI")?;
    let store = Store::open(&connection)?;
    Ok(Observed {
        entry: store.entry(plan)?.0,
        sequence: store.sequence()?,
    })
}
pub(crate) fn create(plan: &Journal, guard: impl Fn() -> Result<(), String>) -> Result<(), String> {
    plan.validate()?;
    let _privileges = crate::windows_token::BcdPrivileges::acquire()?;
    let connection = Connection::open(r"root\WMI")?;
    let store = Store::open(&connection)?;
    if store.entry(plan)?.0 != Presence::Absent {
        return Err("Идентификатор BCD уже занят".into());
    }
    let id = plan.entry_id();
    // /create одновременно задаёт метку владельца: откат отличит даже частичную запись.
    guard()?;
    tool(
        "bcdedit.exe",
        &[
            "/create",
            &id,
            "/d",
            &plan.description(),
            "/application",
            "osloader",
        ],
    )?;
    guard()?;
    tool("bcdedit.exe", &["/set", &id, "path", &plan.efi_path()])?;
    guard()?;
    tool(
        "bcdedit.exe",
        &["/set", &id, "loadoptions", plan.load_options()],
    )?;
    guard()?;
    with_efi(Some(&plan.volume_id), |drive, _| {
        guard()?;
        tool(
            "bcdedit.exe",
            &["/set", &id, "device", &format!("partition={drive}")],
        )
        .map(|_| ())
    })?;
    let (presence, records) = store.entry(plan)?;
    if presence != Presence::Owned || !policy::complete(&records) {
        return Err("Созданная запись BCD не прошла полную проверку".into());
    }
    Ok(())
}
pub(crate) fn delete(plan: &Journal) -> Result<(), String> {
    plan.validate()?;
    let _privileges = crate::windows_token::BcdPrivileges::acquire()?;
    let connection = Connection::open(r"root\WMI")?;
    let store = Store::open(&connection)?;
    match store.entry(plan)?.0 {
        Presence::Conflict => {
            return Err("Запись BCD изменена посторонней программой; удаление запрещено".into())
        }
        Presence::Owned => {
            checked(connection.call(
                "BcdStore",
                STORE,
                "DeleteObject",
                &[("Id", Input::Text(&plan.entry_id()))],
            )?)?;
        }
        Presence::Absent => {}
    }
    if store.entry(plan)?.0 != Presence::Absent {
        return Err("Удаление записи BCD не подтверждено".into());
    }
    Ok(())
}
pub(crate) fn set_sequence(
    plan: &Journal,
    desired: Option<&[String]>,
    expected: Option<&[String]>,
) -> Result<(), String> {
    policy::allow_sequence(plan, desired)?;
    let _privileges = crate::windows_token::BcdPrivileges::acquire()?;
    let connection = Connection::open(r"root\WMI")?;
    let store = Store::open(&connection)?;
    if store.sequence()?.as_deref() != expected {
        return Err("Очередь BCD изменилась перед записью; журнал сохранён".into());
    }
    match desired {
        Some(ids) => {
            checked(connection.call(
                "BcdObject",
                &object_path(MANAGER)?,
                "SetObjectListElement",
                &[
                    ("Type", Input::Number(policy::BOOT_SEQUENCE)),
                    ("Ids", Input::Strings(ids)),
                ],
            )?)?;
        }
        None if expected.is_some() => {
            checked(connection.call(
                "BcdObject",
                &object_path(MANAGER)?,
                "DeleteElement",
                &[("Type", Input::Number(policy::BOOT_SEQUENCE))],
            )?)?;
        }
        None => {}
    }
    if store.sequence()?.as_deref() != desired {
        return Err("Запись одноразовой очереди не подтверждена".into());
    }
    Ok(())
}
fn nt_volume(volume: &str) -> Result<String, String> {
    let name = volume
        .strip_prefix(r"\\?\")
        .and_then(|s| s.strip_suffix('\\'))
        .ok_or("Неверный путь тома EFI")?;
    let mut buffer = [0u16; 4096];
    let count = unsafe { QueryDosDeviceW(&HSTRING::from(name), Some(&mut buffer)) };
    if count == 0 {
        return Err(format!(
            "Не удалось определить устройство EFI: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(String::from_utf16_lossy(
        &buffer[..buffer
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(count as usize)],
    ))
}
fn volume_at(drive: &str) -> Result<String, String> {
    let mut buffer = [0u16; 1024];
    unsafe { GetVolumeNameForVolumeMountPointW(&HSTRING::from(format!("{drive}\\")), &mut buffer) }
        .map_err(|e| format!("Не удалось определить смонтированный том EFI: {e}"))?;
    let raw = String::from_utf16_lossy(
        &buffer[..buffer
            .iter()
            .position(|c| *c == 0)
            .ok_or("Неполный путь тома EFI")?],
    )
    .to_ascii_lowercase();
    let guid = raw
        .strip_prefix(r"\\?\volume")
        .and_then(|s| s.strip_suffix('\\'))
        .filter(|id| valid_guid(id))
        .ok_or("Некорректный том EFI")?;
    Ok(format!(r"\\?\Volume{guid}\"))
}
fn with_efi<T>(
    expected: Option<&str>,
    body: impl FnOnce(&str, &str) -> Result<T, String>,
) -> Result<T, String> {
    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        return Err("Не удалось проверить свободные буквы дисков".into());
    }
    let drive = (b'S'..=b'Z')
        .find_map(|letter| {
            if mask & (1 << (letter - b'A')) != 0 {
                return None;
            }
            let drive = format!("{}:", letter as char);
            let mut existing = [0u16; 1024];
            if unsafe { QueryDosDeviceW(&HSTRING::from(&drive), Some(&mut existing)) } != 0 {
                None
            } else if std::io::Error::last_os_error().raw_os_error() == Some(2) {
                Some(drive)
            } else {
                None
            }
        })
        .ok_or("Нет свободной буквы для временного подключения EFI")?;
    // Неудачное подключение не даёт права отключать чей-либо диск.
    tool("mountvol.exe", &[&drive, "/s"])?;
    let volume = volume_at(&drive);
    let outcome = volume.as_ref().map_err(Clone::clone).and_then(|volume| {
        if expected.is_some_and(|id| id != volume) {
            return Err("Системный EFI-том изменился после снимка".into());
        }
        body(&drive, volume)
    });
    let cleanup = match volume {
        Ok(volume) if volume_at(&drive).as_deref() == Ok(volume.as_str()) => {
            tool("mountvol.exe", &[&drive, "/d"]).map(|_| ())
        }
        _ => Err(format!(
            "Не подтверждён владелец подключения {drive}; автоматическое отключение запрещено"
        )),
    };
    match (outcome, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; {cleanup}")),
    }
}
fn tool(name: &str, args: &[&str]) -> Result<String, String> {
    if !matches!(name, "bcdedit.exe" | "mountvol.exe") {
        return Err("Неразрешённая утилита UEFI".into());
    }
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let path = std::path::PathBuf::from(root).join("System32").join(name);
    let mut child = Command::new(path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| format!("{name}: {e}"))?;
    fn drain(mut input: impl Read) -> Result<Vec<u8>, String> {
        let mut data = Vec::new();
        let mut buffer = [0u8; 4096];
        let mut exceeded = false;
        loop {
            let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            if data.len() + n <= 128 * 1024 {
                data.extend_from_slice(&buffer[..n]);
            } else {
                exceeded = true;
            }
        }
        if exceeded {
            Err("Вывод системной утилиты превышает предел".into())
        } else {
            Ok(data)
        }
    }
    let out = child.stdout.take().ok_or("Нет stdout системной утилиты")?;
    let err = child.stderr.take().ok_or("Нет stderr системной утилиты")?;
    let stdout = thread::spawn(move || drain(out));
    let stderr = thread::spawn(move || drain(err));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < Duration::from_secs(15) => {
                thread::sleep(Duration::from_millis(50))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("Истекло время системной утилиты; журнал сохранён".to_string());
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(e.to_string());
            }
        }
    };
    let output = stdout.join().map_err(|_| "Поток stdout прерван")?;
    let diagnostic = stderr.join().map_err(|_| "Поток stderr прерван")?;
    let status = status?;
    if !status.success() {
        return Err(format!(
            "{name}: код {:?}; {}",
            status.code(),
            String::from_utf8_lossy(&diagnostic?)
        ));
    }
    Ok(String::from_utf8_lossy(&output?).into_owned())
}
