//! Проверка прав через токен процесса, а не через fltmc из PATH (без дочернего процесса и UAC).
#[cfg(windows)]
pub fn is_elevated() -> Result<bool, String> {
    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| format!("Не удалось проверить права процесса: {e}"))?;
        let mut value = TOKEN_ELEVATION::default();
        let mut returned = 0;
        let result = GetTokenInformation(
            token,
            TokenElevation,
            Some((&mut value as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);
        result.map_err(|e| format!("Не удалось прочитать права процесса: {e}"))?;
        if returned != std::mem::size_of::<TOKEN_ELEVATION>() as u32 {
            return Err("Windows вернула неполные данные о правах процесса".into());
        }
        Ok(value.TokenIsElevated != 0)
    }
}
#[cfg(not(windows))]
pub fn is_elevated() -> Result<bool, String> {
    Ok(false)
}
#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn reads_only_the_current_token_without_launching_any_program() {
        super::is_elevated().unwrap();
    }
}
