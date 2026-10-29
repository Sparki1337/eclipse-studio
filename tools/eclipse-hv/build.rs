// Скрипт сборки для встраивания иконки и метаданных приложения Eclipse-HV

#[cfg(windows)]
fn main() {
    let mut res = winres::WindowsResource::new();
    res.set_icon("app-icon.ico");
    res.set("FileDescription", "Eclipse-HV: автономный лаунчер игр с обходом DSE");
    res.set("ProductName", "Eclipse-HV");
    res.set("OriginalFilename", "Eclipse-HV.exe");
    res.set("LegalCopyright", "Copyright (c) Sparki 2026");
    if let Err(e) = res.compile() {
        eprintln!("Предупреждение: не удалось скомпилировать ресурсы Windows: {e}");
    }
}

#[cfg(not(windows))]
fn main() {}
