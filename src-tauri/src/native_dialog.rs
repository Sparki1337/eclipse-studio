//! Нативные диалоги Windows: выбор папки и исполняемого файла через COM IFileOpenDialog.

/// Общий диалог выбора папки Windows в стиле Проводника
pub(crate) fn pick_folder(title: &str, owner: isize) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        use windows::{
            core::{HRESULT, HSTRING},
            Win32::{
                Foundation::HWND,
                System::Com::{
                    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
                },
                UI::Shell::{
                    FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST,
                    FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
                },
            },
        };
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe { CoUninitialize() };
            }
        }
        let result = unsafe {
            (|| -> windows::core::Result<Option<String>> {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
                let _apartment = Apartment;
                let dialog: IFileOpenDialog =
                    CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
                let options = dialog.GetOptions()?;
                dialog.SetOptions(
                    options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST,
                )?;
                dialog.SetTitle(&HSTRING::from(title))?;
                if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
                    if error.code() == HRESULT(0x800704c7u32 as i32) {
                        return Ok(None);
                    }
                    return Err(error);
                }
                let item = dialog.GetResult()?;
                let selected = item.GetDisplayName(SIGDN_FILESYSPATH)?;
                let path = selected.to_string();
                CoTaskMemFree(Some(selected.0.cast()));
                Ok(Some(path?))
            })()
        };
        result.map_err(|error| format!("Не удалось открыть выбор папки: {error}"))
    }
    #[cfg(not(windows))]
    {
        let _ = owner;
        Ok(rfd::FileDialog::new()
            .set_title(title)
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned()))
    }
}

/// Нативный системный выбор исполняемого файла (.exe) через Windows COM IFileOpenDialog
pub(crate) fn pick_exe_file(title: &str, owner: isize) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        use windows::{
            core::{HRESULT, HSTRING},
            Win32::{
                Foundation::HWND,
                System::Com::{
                    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
                },
                UI::Shell::{
                    FileOpenDialog, IFileOpenDialog, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM,
                    FOS_PATHMUSTEXIST, SIGDN_FILESYSPATH,
                },
            },
        };
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe { CoUninitialize() };
            }
        }
        let result = unsafe {
            (|| -> windows::core::Result<Option<String>> {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
                let _apartment = Apartment;
                let dialog: IFileOpenDialog =
                    CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
                let options = dialog.GetOptions()?;
                dialog.SetOptions(
                    options | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_FILEMUSTEXIST,
                )?;
                dialog.SetTitle(&HSTRING::from(title))?;
                let _ = dialog.SetDefaultExtension(&HSTRING::from("exe"));

                if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
                    if error.code() == HRESULT(0x800704c7u32 as i32) {
                        return Ok(None);
                    }
                    return Err(error);
                }
                let item = dialog.GetResult()?;
                let selected = item.GetDisplayName(SIGDN_FILESYSPATH)?;
                let path = selected.to_string();
                CoTaskMemFree(Some(selected.0.cast()));
                Ok(Some(path?))
            })()
        };
        result.map_err(|error| format!("Не удалось открыть выбор файла: {error}"))
    }
    #[cfg(not(windows))]
    {
        let _ = owner;
        Ok(rfd::FileDialog::new()
            .set_title(title)
            .add_filter("Исполняемые файлы", &["exe"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned()))
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn pick_files(title: &str, extensions: &[&str]) -> Vec<String> {
    rfd::FileDialog::new()
        .set_title(title)
        .add_filter("Поддерживаемые файлы", extensions)
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

#[cfg(target_os = "linux")]
pub(crate) fn save_file(title: &str, file_name: &str, extension: &str) -> Option<String> {
    rfd::FileDialog::new()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter(extension.to_ascii_uppercase(), &[extension])
        .save_file()
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(target_os = "linux")]
pub(crate) fn pick_file(title: &str, extensions: &[&str]) -> Option<String> {
    rfd::FileDialog::new()
        .set_title(title)
        .add_filter("Поддерживаемые файлы", extensions)
        .pick_file()
        .map(|path| path.to_string_lossy().into_owned())
}

// Общие современные диалоги вместо запуска отдельного WinForms/PowerShell-процесса.
pub(crate) fn pick_supported_files(
    title: &str,
    extensions: &[&str],
    multiple: bool,
    all_files: bool,
) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        file_dialogs::open(title, extensions, multiple, all_files)
    }
    #[cfg(not(windows))]
    {
        let _ = all_files;
        Ok(if multiple {
            pick_files(title, extensions)
        } else {
            pick_file(title, extensions).into_iter().collect()
        })
    }
}
pub(crate) fn save_archive_file(
    title: &str,
    name: &str,
    extension: &str,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        file_dialogs::save(title, name, extension)
    }
    #[cfg(not(windows))]
    {
        Ok(save_file(title, name, extension))
    }
}
#[cfg(windows)]
mod file_dialogs {
    use windows::{
        core::{HSTRING, PCWSTR},
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
            },
            UI::Shell::{
                Common::COMDLG_FILTERSPEC, FileOpenDialog, FileSaveDialog, IFileOpenDialog,
                IFileSaveDialog, IShellItem, FOS_ALLOWMULTISELECT, FOS_FILEMUSTEXIST,
                FOS_FORCEFILESYSTEM, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST, SIGDN_FILESYSPATH,
            },
        },
    };
    struct Apartment;
    impl Apartment {
        fn enter() -> windows::core::Result<Self> {
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()?;
            }
            Ok(Self)
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    fn filesystem_path(item: IShellItem) -> windows::core::Result<String> {
        unsafe {
            let value = item.GetDisplayName(SIGDN_FILESYSPATH)?;
            let text = value.to_string();
            CoTaskMemFree(Some(value.0.cast()));
            Ok(text?)
        }
    }
    fn filters(extensions: &[&str], all_files: bool) -> Vec<(HSTRING, HSTRING)> {
        let pattern = extensions
            .iter()
            .map(|ext| format!("*.{ext}"))
            .collect::<Vec<_>>()
            .join(";");
        let mut result = vec![(
            HSTRING::from(format!("Поддерживаемые файлы ({pattern})")),
            HSTRING::from(pattern),
        )];
        if extensions.len() > 1 {
            for ext in extensions {
                result.push((
                    HSTRING::from(format!("{} (*.{ext})", ext.to_ascii_uppercase())),
                    HSTRING::from(format!("*.{ext}")),
                ));
            }
        }
        if all_files {
            result.push((HSTRING::from("Все файлы (*.*)"), HSTRING::from("*.*")));
        }
        result
    }
    fn specs(values: &[(HSTRING, HSTRING)]) -> Vec<COMDLG_FILTERSPEC> {
        values
            .iter()
            .map(|(label, pattern)| COMDLG_FILTERSPEC {
                pszName: PCWSTR(label.as_ptr()),
                pszSpec: PCWSTR(pattern.as_ptr()),
            })
            .collect()
    }
    pub(super) fn open(
        title: &str,
        extensions: &[&str],
        multiple: bool,
        all_files: bool,
    ) -> Result<Vec<String>, String> {
        let result = unsafe {
            (|| -> windows::core::Result<Vec<String>> {
                let _apartment = Apartment::enter()?;
                let dialog: IFileOpenDialog =
                    CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
                let mut flags = dialog.GetOptions()?
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_FILEMUSTEXIST;
                if multiple {
                    flags |= FOS_ALLOWMULTISELECT;
                }
                dialog.SetOptions(flags)?;
                dialog.SetTitle(&HSTRING::from(title))?;
                let values = filters(extensions, all_files);
                dialog.SetFileTypes(&specs(&values))?;
                if let Err(e) = dialog.Show(None) {
                    if e.code().0 as u32 == 0x800704c7 {
                        return Ok(Vec::new());
                    }
                    return Err(e);
                }
                let items = dialog.GetResults()?;
                let count = items.GetCount()?;
                let mut paths = Vec::with_capacity(count as usize);
                for index in 0..count {
                    paths.push(filesystem_path(items.GetItemAt(index)?)?);
                }
                Ok(paths)
            })()
        };
        result.map_err(|e| format!("Не удалось открыть выбор файлов: {e}"))
    }
    pub(super) fn save(title: &str, name: &str, extension: &str) -> Result<Option<String>, String> {
        let result = unsafe {
            (|| -> windows::core::Result<Option<String>> {
                let _apartment = Apartment::enter()?;
                let dialog: IFileSaveDialog =
                    CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)?;
                dialog.SetOptions(
                    dialog.GetOptions()?
                        | FOS_FORCEFILESYSTEM
                        | FOS_PATHMUSTEXIST
                        | FOS_OVERWRITEPROMPT,
                )?;
                dialog.SetTitle(&HSTRING::from(title))?;
                dialog.SetFileName(&HSTRING::from(name))?;
                dialog.SetDefaultExtension(&HSTRING::from(extension))?;
                let values = filters(&[extension], false);
                dialog.SetFileTypes(&specs(&values))?;
                if let Err(e) = dialog.Show(None) {
                    if e.code().0 as u32 == 0x800704c7 {
                        return Ok(None);
                    }
                    return Err(e);
                }
                Ok(Some(filesystem_path(dialog.GetResult()?)?))
            })()
        };
        result.map_err(|e| format!("Не удалось открыть сохранение архива: {e}"))
    }
    #[cfg(test)]
    mod tests {
        #[test]
        fn archive_and_lua_filters_preserve_supported_extensions() {
            let archive = super::filters(&["zip", "rar"], false);
            assert_eq!(archive[0].1.to_string(), "*.zip;*.rar");
            assert_eq!(archive.len(), 3);
            let lua = super::filters(&["lua", "manifest", "zip"], true);
            assert_eq!(lua[0].1.to_string(), "*.lua;*.manifest;*.zip");
            assert_eq!(lua.last().unwrap().1.to_string(), "*.*");
        }
    }
}
