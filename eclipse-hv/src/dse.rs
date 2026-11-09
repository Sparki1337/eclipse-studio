//! Сессия обхода DSE: подмена CiValidateImageHeader с восстановлением после запуска игры.

use crate::{hvlog, offsets, rtcore};

const STATE_KEY: &str = r"SOFTWARE\Eclipse Studio\Hypervisor\DSE";

pub enum PrepareError {
    DriverBlocked(Vec<rtcore::DeployAttempt>),
    Other(String),
}

/// Состояние патча, сохраняемое в реестре для восстановления.
#[derive(Debug, Clone, Default)]
struct PatchState {
    original: Option<u64>,
    patched: bool,
}

pub struct DseSession {
    rtcore: rtcore::RtCore,
    kernel_base: u64,
    pub offsets: offsets::KernelOffsets,
    original_callback: Option<u64>,
    pub bypassed: bool,
}

impl DseSession {
    /// Разворачивает драйвер и разрешает смещения до изменения состояния ядра.
    pub fn prepare(base_dir: &std::path::Path) -> Result<Self, PrepareError> {
        let rtcore = rtcore::RtCore::deploy_preferred(base_dir).map_err(|err| match err {
            rtcore::DeployError::Blocked(attempts) => PrepareError::DriverBlocked(attempts),
            rtcore::DeployError::Io(attempts) => {
                PrepareError::Other(rtcore::describe_attempts(&attempts))
            }
        })?;

        let kernel_base = offsets::ntoskrnl_base().map_err(|err| {
            PrepareError::Other(format!(
                "не удалось определить базу ядра ntoskrnl.exe: {err}"
            ))
        })?;
        hvlog!(Info, "dse", "база ntoskrnl.exe: 0x{kernel_base:X}");

        let offsets = offsets::resolve().map_err(PrepareError::Other)?;
        hvlog!(
            Info,
            "dse",
            "смещения ядра ({}, сборка {}): SeCiCallbacks=0x{:X}, SafeFunction=0x{:X}",
            offsets.source,
            offsets.build,
            offsets.se_ci_callbacks,
            offsets.safe_function
        );

        Ok(Self {
            rtcore,
            kernel_base,
            offsets,
            original_callback: None,
            bypassed: false,
        })
    }

    /// Применяет временный обход DSE.
    pub fn bypass(&mut self) -> Result<(), String> {
        hvlog!(Info, "dse", "запуск службы доступа к ядру");
        self.rtcore.start()?;

        let result = self.apply_patch();
        if result.is_err() {
            // При сбое служба драйвера удаляется до возврата ошибки
            self.rtcore.stop();
        }
        result
    }

    fn apply_patch(&mut self) -> Result<(), String> {
        let callback_address = self.offsets.callback_address(self.kernel_base);
        let safe_address = self.offsets.safe_address(self.kernel_base);

        let current = self
            .rtcore
            .read_u64(callback_address)
            .map_err(|err| format!("не удалось прочитать указатель колбэка: {err}"))?;
        hvlog!(Info, "dse", "текущий указатель CiValidateImageHeader: 0x{current:X}");

        let state = load_state();

        if current == safe_address {
            // Патч уже применён — сбой прошлой сессии
            match state.original {
                Some(original) => {
                    hvlog!(Warn, "dse", "обнаружен активный патч от предыдущей сессии, исходное значение взято из реестра");
                    self.original_callback = Some(original);
                }
                None => {
                    return Err(
                        "обнаружен активный патч без сохранённого исходного значения: запустите восстановление вручную"
                            .into(),
                    );
                }
            }
        } else {
            // Исходный указатель сохраняется в реестр ДО изменения памяти
            save_state(&PatchState {
                original: Some(current),
                patched: true,
            });
            self.original_callback = Some(current);
            hvlog!(Info, "dse", "исходный указатель сохранён в реестр");
        }

        if current != safe_address {
            hvlog!(Info, "dse", "подмена указателя на ZwFlushInstructionCache: 0x{safe_address:X}");
            self.rtcore
                .write_u64(callback_address, safe_address)
                .map_err(|err| format!("не удалось записать указатель колбэка: {err}"))?;

            // Проверка записи повторным чтением
            let written = self
                .rtcore
                .read_u64(callback_address)
                .map_err(|err| format!("не удалось проверить запись: {err}"))?;
            if written != safe_address {
                save_state(&PatchState { original: self.original_callback, patched: false });
                return Err(format!(
                    "проверка подмены не пройдена: прочитано 0x{written:X} вместо 0x{safe_address:X}"
                ));
            }
        }

        // Служба драйвера больше не нужна: патч живёт в памяти ядра
        self.rtcore.stop();
        self.bypassed = true;
        hvlog!(Info, "dse", "обход применён, служба драйвера остановлена и удалена");
        Ok(())
    }

    /// Восстанавливает исходное состояние проверки подписей.
    pub fn restore(&mut self) -> Result<(), String> {
        if !self.bypassed && self.original_callback.is_none() {
            hvlog!(Info, "dse", "патч не применялся в этой сессии, восстановление не требуется");
            return Ok(());
        }

        let Some(original) = self.original_callback else {
            return Ok(());
        };

        hvlog!(Info, "dse", "запуск службы доступа к ядру для восстановления");
        self.rtcore.start()?;

        let result = self.restore_callback(original);
        if result.is_err() {
            // Служба не остаётся в системе даже при сбое восстановления
            self.rtcore.stop();
        }
        result
    }

    fn restore_callback(&mut self, original: u64) -> Result<(), String> {
        let callback_address = self.offsets.callback_address(self.kernel_base);
        hvlog!(Info, "dse", "восстановление указателя: 0x{original:X}");

        self.rtcore
            .write_u64(callback_address, original)
            .map_err(|err| format!("не удалось восстановить указатель колбэка: {err}"))?;

        // Проверка восстановления повторным чтением
        let written = self
            .rtcore
            .read_u64(callback_address)
            .map_err(|err| format!("не удалось проверить восстановление: {err}"))?;
        if written != original {
            hvlog!(
                Error,
                "dse",
                "проверка восстановления не пройдена: прочитано 0x{written:X} вместо 0x{original:X}"
            );
            return Err("проверка восстановления указателя не пройдена".into());
        }

        self.rtcore.stop();
        self.bypassed = false;
        self.original_callback = None;
        clear_state();
        hvlog!(Info, "dse", "проверка подписей восстановлена, состояние реестра очищено");
        Ok(())
    }

    pub fn cleanup(&self) {
        self.rtcore.cleanup();
    }

    pub fn driver_path(&self) -> &std::path::Path {
        self.rtcore.driver_path()
    }
}

fn load_state() -> PatchState {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(STATE_KEY) else {
        return PatchState::default();
    };

    let original = key
        .get_value::<String, _>("OriginalCallback")
        .ok()
        .and_then(|value| u64::from_str_radix(value.trim_start_matches("0x"), 16).ok());
    let patched = key
        .get_value::<u32, _>("Patched")
        .map(|value| value == 1)
        .unwrap_or(false);

    PatchState { original, patched }
}

fn save_state(state: &PatchState) {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Err(err) = hklm.create_subkey(STATE_KEY) {
        hvlog!(Warn, "dse", "не удалось создать ключ состояния в реестре: {err}");
        return;
    }
    let Ok(key) = hklm.open_subkey_with_flags(STATE_KEY, winreg::enums::KEY_SET_VALUE) else {
        hvlog!(Warn, "dse", "не удалось открыть ключ состояния для записи");
        return;
    };

    if let Some(original) = state.original {
        let _ = key.set_value("OriginalCallback", &format!("{original:X}"));
    }
    let _ = key.set_value("Patched", &(state.patched as u32));
    let _ = key.set_value("Timestamp", &crate::sys::timestamp());
}

fn clear_state() {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let _ = RegKey::predef(HKEY_LOCAL_MACHINE).delete_subkey_all(STATE_KEY);
}

pub fn patch_state() -> Option<u64> {
    let state = load_state();
    (state.patched || state.original.is_some()).then(|| state.original).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn состояние_патча_по_умолчанию_отсутствует() {
        let state = PatchState::default();
        assert!(!state.patched);
        assert!(state.original.is_none());
    }

    #[test]
    fn адрес_колбэка_сходится_с_офсетами() {
        // Смещения реальной сборки из истории запусков
        let offsets = offsets::KernelOffsets {
            se_ci_callbacks: 0xF04740,
            safe_function: 0x69C1B0,
            callback_slot: 0x20,
            build: "test".into(),
            source: "test".into(),
        };
        let base = 0xFFFFF805_00000000u64;
        // Адрес колбэка: база + SeCiCallbacks + 0x20
        assert_eq!(
            offsets.callback_address(base),
            base + 0xF04740 + 0x20
        );
        assert_eq!(offsets.safe_address(base), base + 0x69C1B0);
    }
}
