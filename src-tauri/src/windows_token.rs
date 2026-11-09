//! Текущий SID и краткоживущие привилегии BCD только в рабочем потоке.
use std::{marker::PhantomData, rc::Rc};
use windows::{
    core::{HSTRING, PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, LocalFree, SetLastError, HANDLE, HLOCAL, LUID, WIN32_ERROR,
        },
        Security::{
            AdjustTokenPrivileges, Authorization::ConvertSidToStringSidW, GetTokenInformation,
            ImpersonateSelf, LookupPrivilegeValueW, RevertToSelf, SecurityImpersonation, TokenUser,
            LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES,
            TOKEN_QUERY, TOKEN_USER,
        },
        System::Threading::{
            GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken,
        },
    },
};
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
pub(crate) fn current_sid() -> Result<String, String> {
    unsafe {
        let mut raw = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw)
            .map_err(|e| format!("Токен пользователя: {e}"))?;
        let token = Handle(raw);
        let mut length = 0;
        let first = GetTokenInformation(token.0, TokenUser, None, 0, &mut length);
        if first.is_ok() || !(std::mem::size_of::<TOKEN_USER>() as u32..=65536).contains(&length) {
            return Err("Windows вернула неверный размер TOKEN_USER".into());
        }
        // Буфер выровнен по размеру указателя, в отличие от обычного Vec<u8>.
        let mut data = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(data.as_mut_ptr().cast()),
            length,
            &mut length,
        )
        .map_err(|e| format!("SID пользователя недоступен: {e}"))?;
        let user = &*data.as_ptr().cast::<TOKEN_USER>();
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text)
            .map_err(|e| format!("Преобразование SID: {e}"))?;
        let value = text.to_string();
        let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        value.map_err(|e| format!("Неверная строка SID: {e}"))
    }
}
pub(crate) struct BcdPrivileges {
    _thread: PhantomData<Rc<()>>,
}
impl BcdPrivileges {
    pub(crate) fn acquire() -> Result<Self, String> {
        unsafe {
            let mut existing = HANDLE::default();
            match OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut existing) {
                Ok(()) => {
                    let _token = Handle(existing);
                    return Err("Поток уже выполняет олицетворение; права BCD не изменены".into());
                }
                Err(e) if e.code().0 as u32 == 0x800703F0 => {} // У потока нет отдельного токена.
                Err(e) => return Err(format!("Проверка контекста BCD: {e}")),
            }
            ImpersonateSelf(SecurityImpersonation).map_err(|e| format!("Контекст BCD: {e}"))?;
            let guard = Self {
                _thread: PhantomData,
            };
            let mut raw = HANDLE::default();
            OpenThreadToken(
                GetCurrentThread(),
                TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
                true,
                &mut raw,
            )
            .map_err(|e| format!("Токен BCD: {e}"))?;
            let token = Handle(raw);
            for privilege in ["SeBackupPrivilege", "SeRestorePrivilege"] {
                let mut luid = LUID::default();
                LookupPrivilegeValueW(PCWSTR::null(), &HSTRING::from(privilege), &mut luid)
                    .map_err(|e| format!("Привилегия BCD: {e}"))?;
                let state = TOKEN_PRIVILEGES {
                    PrivilegeCount: 1,
                    Privileges: [LUID_AND_ATTRIBUTES {
                        Luid: luid,
                        Attributes: SE_PRIVILEGE_ENABLED,
                    }],
                };
                SetLastError(WIN32_ERROR(0));
                AdjustTokenPrivileges(token.0, false, Some(&state), 0, None, None)
                    .map_err(|e| format!("Недоступны права BCD: {e}"))?;
                let code = GetLastError();
                if code.0 != 0 {
                    return Err(format!("Токен не содержит {privilege} (код {})", code.0));
                }
            }
            Ok(guard)
        }
    }
}
impl Drop for BcdPrivileges {
    fn drop(&mut self) {
        unsafe {
            let _ = RevertToSelf();
        }
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn sid_is_read_without_elevation_or_system_changes() {
        let sid = super::current_sid().unwrap();
        assert!(sid.starts_with("S-1-"));
        assert!(sid
            .bytes()
            .all(|b| b == b'S' || b == b'-' || b.is_ascii_digit()));
    }
}
