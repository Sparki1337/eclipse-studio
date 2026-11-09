//! Разрешение смещений ядра: кэш → drivers.ini → локальные PDB → сервер символов Microsoft.
//! Подменяется CiValidateImageHeader (SeCiCallbacks + 0x20) на ZwFlushInstructionCache.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::hvlog;

/// Смещение элемента `CiValidateImageHeader` в таблице SeCiCallbacks.
const DEFAULT_CALLBACK_SLOT: u64 = 0x20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KernelOffsets {
    pub se_ci_callbacks: u64,
    pub safe_function: u64,
    pub callback_slot: u64,
    pub build: String,
    pub source: String,
}

impl KernelOffsets {
    pub fn callback_address(&self, kernel_base: u64) -> u64 {
        kernel_base + self.se_ci_callbacks + self.callback_slot
    }

    pub fn safe_address(&self, kernel_base: u64) -> u64 {
        kernel_base + self.safe_function
    }
}

/// Идентификатор PDB из отладочной записи PE-файла.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdbId {
    pub guid: String,
    pub age: u32,
    pub name: String,
}

impl PdbId {
    /// Имя каталога символа на сервере: GUID + age (десятичное).
    pub fn symbol_folder(&self) -> String {
        format!("{}{}", self.guid, self.age)
    }
}

/// Возвращает каталог локального состояния лаунчера (ProgramData).
fn program_data_dir() -> PathBuf {
    std::env::var("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"C:\ProgramData"))
        .join("Eclipse Studio")
        .join("Hypervisor")
}

fn cache_path() -> PathBuf {
    program_data_dir().join("dse-offsets.json")
}

pub fn current_build() -> String {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let version_key = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(version_key) else {
        return "неизвестно".to_string();
    };

    let build: String = key
        .get_value("CurrentBuildNumber")
        .unwrap_or_else(|_| "?".into());
    let update: u32 = key.get_value("UBR").unwrap_or(0);
    format!("{build}.{update}")
}

pub fn resolve() -> Result<KernelOffsets, String> {
    let build = current_build();
    hvlog!(Info, "смещения", "поиск смещений для сборки Windows {build}");

    // 1. Локальный кэш лаунчера
    if let Some(offsets) = load_cache(&build) {
        hvlog!(Info, "смещения", "взяты из кэша: SeCi=0x{:X}, Safe=0x{:X}", offsets.se_ci_callbacks, offsets.safe_function);
        return Ok(offsets);
    }

    // 2. drivers.ini (совместимость с экосистемой запуска)
    if let Some(offsets) = read_drivers_ini() {
        hvlog!(Info, "смещения", "взяты из drivers.ini: SeCi=0x{:X}, Safe=0x{:X}", offsets.se_ci_callbacks, offsets.safe_function);
        save_cache(&offsets);
        return Ok(offsets);
    }

    // 3. PDB: локальные каталоги символов, затем сервер
    let kernel_path = PathBuf::from(r"C:\Windows\System32\ntoskrnl.exe");
    let kernel_bytes = fs::read(&kernel_path)
        .map_err(|err| format!("не удалось прочитать {}: {err}", kernel_path.display()))?;
    let pdb_id = extract_pdb_id(&kernel_bytes)
        .map_err(|err| format!("не удалось извлечь идентификатор PDB из ntoskrnl.exe: {err}"))?;
    hvlog!(
        Info,
        "смещения",
        "PDB ядра: {} сборка {} (age {})",
        pdb_id.name,
        pdb_id.guid,
        pdb_id.age
    );

    let local_paths = [
        program_data_dir().join("symbols").join(&pdb_id.name).join(pdb_id.symbol_folder()).join(&pdb_id.name),
        PathBuf::from(r"C:\ProgramData\dbg\sym").join(&pdb_id.name).join(pdb_id.symbol_folder()).join(&pdb_id.name),
    ];
    for path in &local_paths {
        if let Ok(bytes) = fs::read(path) {
            hvlog!(Info, "смещения", "локальный PDB: {}", path.display());
            let offsets = offsets_from_pdb(&bytes, &build, &format!("локальный PDB ({})", path.display()))?;
            save_cache(&offsets);
            return Ok(offsets);
        }
    }

    // 4. Загрузка PDB с публичного сервера символов Microsoft
    hvlog!(Info, "смещения", "загрузка PDB с сервера символов Microsoft...");
    let bytes = download_pdb(&pdb_id)?;
    let offsets = offsets_from_pdb(&bytes, &build, "сервер символов Microsoft")?;

    let symbol_copy = program_data_dir()
        .join("symbols")
        .join(&pdb_id.name)
        .join(pdb_id.symbol_folder())
        .join(&pdb_id.name);
    if let Some(parent) = symbol_copy.parent() {
        let _ = fs::create_dir_all(parent);
        let _ = fs::write(&symbol_copy, &bytes);
    }

    save_cache(&offsets);
    Ok(offsets)
}

/// Определяет базовый адрес ntoskrnl.exe в пространстве ядра.
pub fn ntoskrnl_base() -> Result<u64, String> {
    use windows::Win32::System::ProcessStatus::{EnumDeviceDrivers, GetDeviceDriverBaseNameW};

    unsafe {
        // Первый вызов определяет необходимый размер буфера
        let mut needed = 0u32;
        let _ = EnumDeviceDrivers(std::ptr::null_mut(), 0, &mut needed);
        let count = needed as usize / std::mem::size_of::<usize>();
        if count == 0 {
            return Err("EnumDeviceDrivers вернул пустой список модулей ядра".into());
        }

        let mut bases = vec![std::ptr::null_mut::<core::ffi::c_void>(); count];
        EnumDeviceDrivers(bases.as_mut_ptr(), needed, &mut needed)
            .map_err(|err| format!("EnumDeviceDrivers: {err}"))?;

        // Первый модуль списка — само ядро; имя проверяется для надёжности
        let mut name_buffer = [0u16; 64];
        let length = GetDeviceDriverBaseNameW(bases[0], &mut name_buffer);
        let name = String::from_utf16_lossy(&name_buffer[..length as usize]);
        hvlog!(Debug, "смещения", "модуль ядра[0]: {name}");

        if name.eq_ignore_ascii_case("ntoskrnl.exe") {
            Ok(bases[0] as u64)
        } else {
            hvlog!(Warn, "смещения", "первый модуль не ntoskrnl, использую базу по индексу 0");
            Ok(bases[0] as u64)
        }
    }
}

fn load_cache(build: &str) -> Option<KernelOffsets> {
    let content = fs::read_to_string(cache_path()).ok()?;
    let offsets: KernelOffsets = serde_json::from_str(&content).ok()?;
    (offsets.build == build).then_some(offsets)
}

fn save_cache(offsets: &KernelOffsets) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(offsets) {
        if let Err(err) = fs::write(&path, json) {
            hvlog!(Warn, "смещения", "не удалось записать кэш {}: {err}", path.display());
        }
    }
}

/// Читает drivers.ini: раздел [Config], ключи Offset_SeCiCallbacks/Offset_SafeFunction/Offset_Callback.
fn read_drivers_ini() -> Option<KernelOffsets> {
    let content = fs::read_to_string(r"C:\Windows\drivers.ini").ok()?;
    parse_drivers_ini_content(&content)
}

pub fn parse_drivers_ini_content(content: &str) -> Option<KernelOffsets> {
    let mut in_config = false;
    let mut se_ci = None;
    let mut safe = None;
    let mut slot = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.eq_ignore_ascii_case("[config]") {
            in_config = true;
            continue;
        }
        if line.starts_with('[') && in_config {
            break;
        }
        if !in_config {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        let value = parse_hex_or_dec(value.trim());

        match key.as_str() {
            // Offset_SeCiCallbacks с одним подчёркиванием; варианты — устойчивость к форматированию
            "offset_seci" | "offset_secicallbacks" | "offset_seci_callbacks" => se_ci = value,
            "offset_safefunction" => safe = value,
            "offset_callback" => slot = value,
            _ => {}
        }
    }

    match (se_ci, safe) {
        (Some(se_ci_callbacks), Some(safe_function)) => Some(KernelOffsets {
            se_ci_callbacks,
            safe_function,
            callback_slot: slot.unwrap_or(DEFAULT_CALLBACK_SLOT),
            build: current_build(),
            source: "drivers.ini".to_string(),
        }),
        _ => None,
    }
}

fn parse_hex_or_dec(value: &str) -> Option<u64> {
    let value = value.trim().trim_matches('"');
    if let Some(hex) = value.strip_prefix("0x").or_else(|| value.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok()
    } else {
        value.parse::<u64>().ok()
    }
}

/// Извлекает идентификатор PDB из отладочной записи PE-файла.
pub fn extract_pdb_id(pe: &[u8]) -> Result<PdbId, String> {
    // DOS-заголовок: смещение PE-подписи
    if pe.len() < 0x40 || &pe[0..2] != b"MZ" {
        return Err("нет DOS-заголовка".into());
    }
    let pe_offset = u32::from_le_bytes(pe[0x3C..0x40].try_into().unwrap()) as usize;
    if pe.len() < pe_offset + 24 || &pe[pe_offset..pe_offset + 4] != b"PE\0\0" {
        return Err("нет PE-подписи".into());
    }

    // COFF: количество секций и размер необязательного заголовка
    let sections = u16::from_le_bytes(pe[pe_offset + 6..pe_offset + 8].try_into().unwrap()) as usize;
    let optional_size = u16::from_le_bytes(pe[pe_offset + 20..pe_offset + 22].try_into().unwrap()) as usize;
    let optional_offset = pe_offset + 24;

    // Таблица секций: адрес RVA → файловое смещение
    let section_table = optional_offset + optional_size;
    let sections_data: Vec<(u32, u32, u32, u32)> = (0..sections)
        .filter_map(|index| {
            let base = section_table + index * 40;
            if base + 40 > pe.len() {
                return None;
            }
            Some((
                u32::from_le_bytes(pe[base + 0x0C..base + 0x10].try_into().unwrap()),
                u32::from_le_bytes(pe[base + 0x08..base + 0x0C].try_into().unwrap()),
                u32::from_le_bytes(pe[base + 0x10..base + 0x14].try_into().unwrap()),
                u32::from_le_bytes(pe[base + 0x14..base + 0x18].try_into().unwrap()),
            ))
        })
        .collect();

    let rva_to_offset = |rva: u32| -> Option<usize> {
        sections_data
            .iter()
            .find(|(address, virtual_size, raw_size, _)| {
                let size = (*virtual_size).max(*raw_size);
                rva >= *address && rva < address.wrapping_add(size)
            })
            .and_then(|(address, _, _, raw_offset)| Some((rva - address + raw_offset) as usize))
    };

    // Каталог отладки (DataDirectory[6]) в необязательном заголовке
    let debug_rva = u32::from_le_bytes(
        pe[optional_offset + 112 + 6 * 8..optional_offset + 112 + 6 * 8 + 4]
            .try_into()
            .map_err(|_| "нет каталога отладки")?,
    );
    let debug_size = u32::from_le_bytes(
        pe[optional_offset + 112 + 6 * 8 + 4..optional_offset + 112 + 6 * 8 + 8]
            .try_into()
            .map_err(|_| "нет размера каталога отладки")?,
    );
    if debug_size == 0 {
        return Err("каталог отладки пуст".into());
    }

    // Поиск записи CODEVIEW (Type = 2)
    let debug_offset = rva_to_offset(debug_rva)
        .ok_or_else(|| "не удалось преобразовать RVA каталога отладки".to_string())?;
    let entries = debug_size as usize / 28;
    for index in 0..entries {
        let entry = debug_offset + index * 28;
        if entry + 28 > pe.len() {
            break;
        }
        let entry_type = u32::from_le_bytes(pe[entry + 12..entry + 16].try_into().unwrap());
        if entry_type != 2 {
            continue;
        }
        let raw_pointer = u32::from_le_bytes(pe[entry + 24..entry + 28].try_into().unwrap()) as usize;
        if raw_pointer + 24 > pe.len() || &pe[raw_pointer..raw_pointer + 4] != b"RSDS" {
            continue;
        }

        // RSDS: подпись, GUID (16 байт), age (4 байта), путь PDB
        let guid_bytes = &pe[raw_pointer + 4..raw_pointer + 20];
        let age = u32::from_le_bytes(pe[raw_pointer + 20..raw_pointer + 24].try_into().unwrap());
        let name_start = raw_pointer + 24;
        let name_end = pe[name_start..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|end| name_start + end)
            .unwrap_or(pe.len());
        let name = String::from_utf8_lossy(&pe[name_start..name_end]).to_string();

        // GUID: Data1 (u32 LE), Data2 (u16 LE), Data3 (u16 LE), Data4 (8 байт)
        let data1 = u32::from_le_bytes(guid_bytes[0..4].try_into().unwrap());
        let data2 = u16::from_le_bytes(guid_bytes[4..6].try_into().unwrap());
        let data3 = u16::from_le_bytes(guid_bytes[6..8].try_into().unwrap());
        let guid = format!(
            "{data1:08X}{data2:04X}{data3:04X}{}",
            guid_bytes[8..16].iter().map(|byte| format!("{byte:02X}")).collect::<String>()
        );

        if name.is_empty() {
            return Err("пустое имя PDB в записи отладки".into());
        }
        return Ok(PdbId { guid, age, name });
    }

    Err("запись CODEVIEW не найдена".into())
}

/// Символы из PDB; резерв — таблица экспорта ntoskrnl.exe (ZwFlushInstructionCache экспортируется ядром).
fn offsets_from_pdb(bytes: &[u8], build: &str, source: &str) -> Result<KernelOffsets, String> {
    let (se_ci_callbacks, safe_function) = parse_pdb_symbols(bytes)?;

    hvlog!(
        Info,
        "смещения",
        "из PDB: SeCiCallbacks=0x{se_ci_callbacks:X}, ZwFlushInstructionCache=0x{safe_function:X}"
    );

    Ok(KernelOffsets {
        se_ci_callbacks,
        safe_function,
        callback_slot: DEFAULT_CALLBACK_SLOT,
        build: build.to_string(),
        source: source.to_string(),
    })
}

fn parse_pdb_symbols(bytes: &[u8]) -> Result<(u64, u64), String> {
    use pdb::{FallibleIterator, PDB};

    let cursor = std::io::Cursor::new(bytes);
    let mut pdb = PDB::open(cursor).map_err(|err| format!("PDB::open: {err}"))?;
    let address_map = pdb
        .address_map()
        .map_err(|err| format!("PDB::address_map: {err}"))?;

    let mut se_ci = None;
    let mut safe = None;

    // Первый проход: глобальная таблица символов
    if let Ok(globals) = pdb.global_symbols() {
        let mut symbols = globals.iter();
        while let Ok(Some(symbol)) = symbols.next() {
            collect_symbol(&symbol, &address_map, &mut se_ci, &mut safe);
        }
    }

    // Второй проход: символы модулей (процедуры и данные внутри модулей)
    if se_ci.is_none() || safe.is_none() {
        if let Ok(debug_info) = pdb.debug_information() {
            if let Ok(mut modules) = debug_info.modules() {
                while let Ok(Some(module)) = modules.next() {
                    let Ok(Some(info)) = pdb.module_info(&module) else {
                        continue;
                    };
                    let Ok(mut module_symbols) = info.symbols() else {
                        continue;
                    };
                    while let Ok(Some(symbol)) = module_symbols.next() {
                        collect_symbol(&symbol, &address_map, &mut se_ci, &mut safe);
                    }
                }
            }
        }
    }

    // Резерв для безопасной функции: таблица экспорта ntoskrnl.exe
    if safe.is_none() {
        if let Ok(kernel) = fs::read(r"C:\Windows\System32\ntoskrnl.exe") {
            if let Ok(rva) = rva_from_export(&kernel, "ZwFlushInstructionCache") {
                hvlog!(Info, "смещения", "ZwFlushInstructionCache взят из таблицы экспорта ядра: 0x{rva:X}");
                safe = Some(rva as u64);
            }
        }
    }

    match (se_ci, safe) {
        (Some(se_ci), Some(safe)) => Ok((se_ci, safe)),
        (None, _) => Err("символ SeCiCallbacks не найден в PDB".into()),
        (_, None) => Err("символ ZwFlushInstructionCache не найден в PDB и таблице экспорта".into()),
    }
}

fn collect_symbol(
    symbol: &pdb::Symbol<'_>,
    address_map: &pdb::AddressMap<'_>,
    se_ci: &mut Option<u64>,
    safe: &mut Option<u64>,
) {
    if se_ci.is_some() && safe.is_some() {
        return;
    }

    // Разбор символа: имя и смещение зависят от типа записи
    let Ok(data) = symbol.parse() else { return };
    let Some(raw_name) = data.name() else { return };
    let name = raw_name.to_string();

    let want_se_ci = name == "SeCiCallbacks" && se_ci.is_none();
    let want_safe = name == "ZwFlushInstructionCache" && safe.is_none();
    if !want_se_ci && !want_safe {
        return;
    }

    // Смещение доступно у символов данных, публичных символов и процедур
    let offset = match data {
        pdb::SymbolData::Data(item) => Some(item.offset),
        pdb::SymbolData::Public(item) => Some(item.offset),
        pdb::SymbolData::Procedure(item) => Some(item.offset),
        _ => None,
    };
    let Some(offset) = offset else { return };
    let Some(rva) = offset.to_rva(address_map) else { return };
    let value = rva.0 as u64;

    if want_se_ci {
        hvlog!(Debug, "смещения", "SeCiCallbacks: 0x{value:X}");
        *se_ci = Some(value);
    }
    if want_safe {
        hvlog!(Debug, "смещения", "ZwFlushInstructionCache: 0x{value:X}");
        *safe = Some(value);
    }
}

/// Ищет RVA функции в таблице экспорта PE-файла.
pub fn rva_from_export(pe: &[u8], function: &str) -> Result<u32, String> {
    if pe.len() < 0x40 || &pe[0..2] != b"MZ" {
        return Err("нет DOS-заголовка".into());
    }
    let pe_offset = u32::from_le_bytes(pe[0x3C..0x40].try_into().unwrap()) as usize;
    if pe.len() < pe_offset + 24 || &pe[pe_offset..pe_offset + 4] != b"PE\0\0" {
        return Err("нет PE-подписи".into());
    }

    let optional_offset = pe_offset + 24;
    // Каталог экспорта: DataDirectory[0]
    let export_rva = u32::from_le_bytes(
        pe[optional_offset + 112..optional_offset + 116]
            .try_into()
            .map_err(|_| "нет каталога экспорта")?,
    );
    let export_size = u32::from_le_bytes(
        pe[optional_offset + 116..optional_offset + 120]
            .try_into()
            .map_err(|_| "нет размера каталога экспорта")?,
    );
    if export_rva == 0 || export_size == 0 {
        return Err("таблица экспорта отсутствует".into());
    }

    // Преобразование RVA в файловое смещение через таблицу секций
    let sections = u16::from_le_bytes(pe[pe_offset + 6..pe_offset + 8].try_into().unwrap()) as usize;
    let optional_size = u16::from_le_bytes(pe[pe_offset + 20..pe_offset + 22].try_into().unwrap()) as usize;
    let section_table = optional_offset + optional_size;
    let rva_to_offset = |rva: u32| -> Option<usize> {
        (0..sections).find_map(|index| {
            let base = section_table + index * 40;
            if base + 40 > pe.len() {
                return None;
            }
            let address = u32::from_le_bytes(pe[base + 0x0C..base + 0x10].try_into().unwrap());
            let virtual_size = u32::from_le_bytes(pe[base + 0x08..base + 0x0C].try_into().unwrap());
            let raw_size = u32::from_le_bytes(pe[base + 0x10..base + 0x14].try_into().unwrap());
            let raw_offset = u32::from_le_bytes(pe[base + 0x14..base + 0x18].try_into().unwrap());
            let size = virtual_size.max(raw_size);
            (rva >= address && rva < address.wrapping_add(size))
                .then_some((rva - address + raw_offset) as usize)
        })
    };

    let export_offset = rva_to_offset(export_rva)
        .ok_or_else(|| "не удалось преобразовать RVA каталога экспорта".to_string())?;
    let names_rva = u32::from_le_bytes(pe[export_offset + 0x20..export_offset + 0x24].try_into().unwrap());
    let functions_rva = u32::from_le_bytes(pe[export_offset + 0x1C..export_offset + 0x20].try_into().unwrap());
    let ordinals_rva = u32::from_le_bytes(pe[export_offset + 0x24..export_offset + 0x28].try_into().unwrap());
    let count = u32::from_le_bytes(pe[export_offset + 0x18..export_offset + 0x1C].try_into().unwrap());

    let names_offset = rva_to_offset(names_rva)
        .ok_or_else(|| "не удалось преобразовать RVA имён экспорта".to_string())?;
    let functions_offset = rva_to_offset(functions_rva)
        .ok_or_else(|| "не удалось преобразовать RVA функций экспорта".to_string())?;
    let ordinals_offset = rva_to_offset(ordinals_rva)
        .ok_or_else(|| "не удалось преобразовать RVA порядковых номеров".to_string())?;

    for index in 0..count as usize {
        let name_rva = u32::from_le_bytes(
            pe[names_offset + index * 4..names_offset + index * 4 + 4]
                .try_into()
                .map_err(|_| "короткий массив имён")?,
        );
        let Some(name_offset) = rva_to_offset(name_rva) else {
            continue;
        };
        let name_end = pe[name_offset..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|end| name_offset + end)
            .unwrap_or(pe.len());
        let name = String::from_utf8_lossy(&pe[name_offset..name_end]);

        if name == function {
            let ordinal = u16::from_le_bytes(
                pe[ordinals_offset + index * 2..ordinals_offset + index * 2 + 2]
                    .try_into()
                    .map_err(|_| "короткий массив порядковых номеров")?,
            );
            let rva = u32::from_le_bytes(
                pe[functions_offset + ordinal as usize * 4..functions_offset + ordinal as usize * 4 + 4]
                    .try_into()
                    .map_err(|_| "короткий массив функций")?,
            );
            return Ok(rva);
        }
    }

    Err(format!("функция {function} не найдена в таблице экспорта").into())
}

/// Загружает PDB с публичного сервера символов Microsoft.
fn download_pdb(id: &PdbId) -> Result<Vec<u8>, String> {
    use windows::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpReceiveResponse,
        WinHttpQueryDataAvailable, WinHttpReadData, WinHttpSendRequest, INTERNET_DEFAULT_HTTPS_PORT,
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_FLAG_SECURE,
    };

    let server: Vec<u16> = "msdl.microsoft.com".encode_utf16().chain(Some(0)).collect();
    let path: Vec<u16> = format!(
        "/download/symbols/{}/{}/{}",
        id.name,
        id.symbol_folder(),
        id.name
    )
    .encode_utf16()
    .chain(Some(0))
    .collect();
    let agent: Vec<u16> = "Eclipse-HV".encode_utf16().chain(Some(0)).collect();

    unsafe {
        let session = WinHttpOpen(
            windows::core::PCWSTR(agent.as_ptr()),
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            None,
            None,
            0,
        );
        if session.is_null() {
            return Err("WinHttpOpen не создал сессию (нет сети?)".into());
        }

        let connect = WinHttpConnect(
            session,
            windows::core::PCWSTR(server.as_ptr()),
            INTERNET_DEFAULT_HTTPS_PORT,
            0,
        );
        if connect.is_null() {
            let _ = WinHttpCloseHandle(session);
            return Err("WinHttpConnect не установил соединение с сервером символов".into());
        }

        let request = WinHttpOpenRequest(
            connect,
            windows::core::w!("GET"),
            windows::core::PCWSTR(path.as_ptr()),
            None,
            None,
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        );
        if request.is_null() {
            let _ = WinHttpCloseHandle(connect);
            let _ = WinHttpCloseHandle(session);
            return Err("WinHttpOpenRequest не создал запрос".into());
        }

        let result = (|| {
            WinHttpSendRequest(request, None, None, 0, 0, 0)
                .map_err(|err| format!("WinHttpSendRequest: {err}"))?;
            WinHttpReceiveResponse(request, std::ptr::null_mut())
                .map_err(|err| format!("WinHttpReceiveResponse: {err}"))?;

            let mut bytes = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                let mut available = 0u32;
                WinHttpQueryDataAvailable(request, &mut available)
                    .map_err(|err| format!("WinHttpQueryDataAvailable: {err}"))?;
                if available == 0 {
                    break;
                }
                let to_read = available.min(buffer.len() as u32);
                let mut read = 0u32;
                WinHttpReadData(
                    request,
                    buffer.as_mut_ptr() as *mut core::ffi::c_void,
                    to_read,
                    &mut read,
                )
                .map_err(|err| format!("WinHttpReadData: {err}"))?;
                if read == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..read as usize]);
            }

            if bytes.is_empty() {
                Err("сервер символов вернул пустой файл".into())
            } else {
                Ok(bytes)
            }
        })();

        let _ = WinHttpCloseHandle(request);
        let _ = WinHttpCloseHandle(connect);
        let _ = WinHttpCloseHandle(session);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn разбор_чисел_ini() {
        assert_eq!(parse_hex_or_dec("0xF04740"), Some(0xF04740));
        assert_eq!(parse_hex_or_dec("15748672"), Some(15748672));
        assert_eq!(parse_hex_or_dec("0x20"), Some(0x20));
        assert_eq!(parse_hex_or_dec("мусор"), None);
    }

    #[test]
    fn разбор_содержимого_drivers_ini() {
        let ini = "[Config]\nOffset_SeCiCallbacks=0xF04740\nOffset_SafeFunction=0x69C1B0\nOffset_Callback=0x20\n";
        let offsets = parse_drivers_ini_content(ini).expect("смещения должны разбираться");
        assert_eq!(offsets.se_ci_callbacks, 0xF04740);
        assert_eq!(offsets.safe_function, 0x69C1B0);
        assert_eq!(offsets.callback_slot, 0x20);

        // Без Offset_Callback используется значение по умолчанию 0x20
        let ini_no_slot = "[Config]\nOffset_SeCiCallbacks=15748672\nOffset_SafeFunction=7007984\n";
        let offsets = parse_drivers_ini_content(ini_no_slot).expect("смещения должны разбираться");
        assert_eq!(offsets.se_ci_callbacks, 15748672);
        assert_eq!(offsets.callback_slot, 0x20);

        // Отсутствие обязательных ключей или раздела
        assert!(parse_drivers_ini_content("[Config]\nOffset_Callback=0x20\n").is_none());
        assert!(parse_drivers_ini_content("[Другое]\nOffset_SeCiCallbacks=0x1\n").is_none());
        assert!(parse_drivers_ini_content("").is_none());
    }

    #[test]
    fn идентификатор_pdb_извлекается_из_живого_ядра() {
        // Интеграционная проверка на реальном ntoskrnl.exe текущей системы
        let kernel = PathBuf::from(r"C:\Windows\System32\ntoskrnl.exe");
        let Ok(bytes) = fs::read(&kernel) else {
            return; // Недоступен для чтения — проверка пропускается
        };
        let id = extract_pdb_id(&bytes).expect("идентификатор PDB должен извлекаться");
        assert_eq!(id.guid.len(), 32);
        assert!(id.name.ends_with(".pdb"));
        assert!(id.age > 0);
        assert!(id.symbol_folder().starts_with(&id.guid));
    }

    #[test]
    fn кэш_сохраняется_и_читается() {
        let dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("target")
            .join("eclipse-hv-tests")
            .join("offsets-cache");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let offsets = KernelOffsets {
            se_ci_callbacks: 0xF04740,
            safe_function: 0x69C1B0,
            callback_slot: 0x20,
            build: "тест-сборка".to_string(),
            source: "тест".to_string(),
        };
        let json = serde_json::to_string_pretty(&offsets).unwrap();
        let path = dir.join("dse-offsets.json");
        fs::write(&path, json).unwrap();

        let restored: KernelOffsets =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(restored.se_ci_callbacks, offsets.se_ci_callbacks);
        assert_eq!(restored.build, "тест-сборка");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn адреса_указателей_считаются_корректно() {
        let offsets = KernelOffsets {
            se_ci_callbacks: 0x1000,
            safe_function: 0x2000,
            callback_slot: 0x20,
            build: "test".into(),
            source: "test".into(),
        };
        assert_eq!(offsets.callback_address(0xFFFFF800_00000000), 0xFFFFF800_00001020);
        assert_eq!(offsets.safe_address(0xFFFFF800_00000000), 0xFFFFF800_00002000);
    }

    #[test]
    fn символы_находятся_в_реальном_pdb_текущего_ядра() {
        // Интеграционная проверка на локальном кэше символов текущего ядра
        let kernel_path = PathBuf::from(r"C:\Windows\System32\ntoskrnl.exe");
        let Ok(kernel) = fs::read(&kernel_path) else {
            return; // Ядро недоступно для чтения — проверка пропускается
        };
        let Ok(id) = extract_pdb_id(&kernel) else {
            return;
        };

        let candidates = [
            program_data_dir()
                .join("symbols")
                .join(&id.name)
                .join(id.symbol_folder())
                .join(&id.name),
            PathBuf::from(r"C:\ProgramData\dbg\sym")
                .join(&id.name)
                .join(id.symbol_folder())
                .join(&id.name),
        ];
        let Some(pdb_path) = candidates.iter().find(|path| path.is_file()) else {
            return; // Локальный PDB отсутствует — проверка пропускается
        };
        let Ok(bytes) = fs::read(pdb_path) else {
            return;
        };

        let (se_ci, safe) = parse_pdb_symbols(&bytes).expect("символы должны находиться в PDB");

        // Смещения должны быть разумными RVA внутри образа ядра
        assert!(se_ci > 0 && se_ci < 0x1000_0000, "SeCiCallbacks=0x{se_ci:X}");
        assert!(safe > 0 && safe < 0x1000_0000, "ZwFlushInstructionCache=0x{safe:X}");

        // Сверка: безопасная функция обязана совпадать с таблицей экспорта ядра
        let export_rva = rva_from_export(&kernel, "ZwFlushInstructionCache")
            .expect("ZwFlushInstructionCache экспортируется ядром");
        assert_eq!(safe, export_rva as u64, "смещение PDB должно совпадать с таблицей экспорта");
    }

    #[test]
    fn таблица_экспорта_ядра_даёт_смещение_безопасной_функции() {
        let kernel_path = PathBuf::from(r"C:\Windows\System32\ntoskrnl.exe");
        let Ok(kernel) = fs::read(&kernel_path) else {
            return;
        };
        let rva = rva_from_export(&kernel, "ZwFlushInstructionCache").expect("функция должна находиться");
        assert!(rva > 0 && rva < 0x1000_0000);

        // Отсутствующая функция отклоняется
        assert!(rva_from_export(&kernel, "EclipseНесуществующаяФункция").is_err());
    }
}
