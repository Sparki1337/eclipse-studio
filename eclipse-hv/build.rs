//! Сборочный скрипт Eclipse-HV: иконка и метаданные ресурсов Windows.

#[cfg(windows)]
fn main() {
    let mut res = winres::WindowsResource::new();
    res.set_icon("app-icon.ico");
    res.set("FileDescription", "Eclipse-HV: автономный лаунчер гипервизорного окружения");
    res.set("ProductName", "Eclipse-HV");
    res.set("OriginalFilename", "Eclipse-HV.exe");
    res.set("LegalCopyright", "Copyright (c) Sparki 2026");
    if let Err(e) = res.compile() {
        eprintln!("Предупреждение: не удалось скомпилировать ресурсы Windows: {e}");
    }
}

#[cfg(not(windows))]
fn main() {}
