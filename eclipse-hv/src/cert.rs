//! Тестовый сертификат «Eclipse-HV Test CA»: установка, подпись, удаление.
//! Подпись всегда видна в свойствах файла и хранилищах — маскировки нет.

use std::path::{Path, PathBuf};

use crate::{hvlog, process, sys};

const CERT_SUBJECT: &str = "CN=Eclipse-HV Test CA";

const STORES: [&str; 3] = [
    "Cert:\\CurrentUser\\My",
    "Cert:\\LocalMachine\\Root",
    "Cert:\\LocalMachine\\TrustedPublisher",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CertOp {
    Install,
    Remove,
    Sign(PathBuf),
    Status,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CertState {
    pub thumbprint: Option<String>,
    pub stores: Vec<String>,
}

impl CertState {
    pub fn installed(&self) -> bool {
        !self.stores.is_empty()
    }
}

fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Запускает сценарий PowerShell и возвращает (stdout, stderr, код).
fn run_ps(script: &str) -> Result<(String, String, Option<i32>), String> {
    let output = process::run_capture(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
    )?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok((stdout, stderr, output.status.code()))
}

/// Требует прав администратора (запись в LocalMachine); возвращает отпечаток.
pub fn install() -> Result<String, String> {
    if !sys::is_elevated().unwrap_or(false) {
        return Err("операция требует прав администратора: запустите Eclipse-HV от имени администратора".into());
    }

    hvlog!(Info, "сертификат", "создание тестового сертификата «{CERT_SUBJECT}»");

    let script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         $existing = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object {{ $_.Subject -eq '{CERT_SUBJECT}' }} | Select-Object -First 1\n\
         if ($existing) {{ Write-Output ('EXISTING ' + $existing.Thumbprint); exit 0 }}\n\
         $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject '{CERT_SUBJECT}' -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(5)\n\
         $cer = Join-Path $env:TEMP 'Eclipse-HV-Test-CA.cer'\n\
         Export-Certificate -Cert $cert -FilePath $cer | Out-Null\n\
         Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\\LocalMachine\\Root' | Out-Null\n\
         Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\\LocalMachine\\TrustedPublisher' | Out-Null\n\
         Remove-Item $cer -ErrorAction SilentlyContinue\n\
         Write-Output ('CREATED ' + $cert.Thumbprint)"
    );

    let (stdout, stderr, code) = run_ps(&script)?;
    let marker = stdout
        .lines()
        .find(|line| line.starts_with("CREATED ") || line.starts_with("EXISTING "));

    match marker {
        Some(line) => {
            let thumbprint = line.split_whitespace().nth(1).unwrap_or_default().to_string();
            if line.starts_with("EXISTING ") {
                hvlog!(Info, "сертификат", "сертификат уже существует, отпечаток: {thumbprint}");
            } else {
                hvlog!(Info, "сертификат", "сертификат создан, отпечаток: {thumbprint}");
            }
            hvlog!(Info, "сертификат", "установлен в Root и TrustedPublisher локальной машины");
            Ok(thumbprint)
        }
        None => Err(format!(
            "PowerShell завершился с кодом {code:?}; вывод: {stdout}; ошибки: {stderr}"
        )),
    }
}

/// Требует прав администратора; возвращает количество удалённых записей.
pub fn remove() -> Result<usize, String> {
    if !sys::is_elevated().unwrap_or(false) {
        return Err("операция требует прав администратора: запустите Eclipse-HV от имени администратора".into());
    }

    hvlog!(Info, "сертификат", "удаление тестового сертификата из хранилищ");

    let stores = STORES
        .iter()
        .map(|store| ps_quote(store))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         $stores = @({stores})\n\
         $targets = @()\n\
         foreach ($store in $stores) {{\n\
             $targets += Get-ChildItem $store -ErrorAction SilentlyContinue | Where-Object {{ $_.Subject -eq '{CERT_SUBJECT}' }}\n\
         }}\n\
         foreach ($target in $targets) {{\n\
             Remove-Item $target.PSPath -ErrorAction Stop\n\
         }}\n\
         Write-Output ('REMOVED ' + $targets.Count)"
    );

    let (stdout, stderr, code) = run_ps(&script)?;
    let count = stdout
        .lines()
        .find_map(|line| line.strip_prefix("REMOVED "))
        .and_then(|value| value.trim().parse::<usize>().ok());

    match count {
        Some(0) => {
            hvlog!(Info, "сертификат", "сертификат в хранилищах не найден");
            Ok(0)
        }
        Some(count) => {
            hvlog!(Info, "сертификат", "удалено записей: {count}");
            Ok(count)
        }
        None => Err(format!(
            "PowerShell завершился с кодом {code:?}; вывод: {stdout}; ошибки: {stderr}"
        )),
    }
}

pub fn sign(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("файл не существует: {}", path.display()));
    }
    let state = status();
    if !state.installed() {
        return Err("тестовый сертификат не установлен: выполните сначала «cert install»".into());
    }

    hvlog!(Info, "сертификат", "подпись файла: {}", path.display());

    let script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         $cert = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object {{ $_.Subject -eq '{CERT_SUBJECT}' }} | Select-Object -First 1\n\
         if (-not $cert) {{ Write-Output 'NOCERT'; exit 2 }}\n\
         $sign = Set-AuthenticodeSignature -FilePath {} -Certificate $cert\n\
         Write-Output ($sign.Status.ToString() + ' | ' + $sign.StatusMessage)",
        ps_quote(&path.to_string_lossy())
    );

    let (stdout, stderr, code) = run_ps(&script)?;
    if stdout.starts_with("NOCERT") {
        return Err("сертификат не найден в личном хранилище: выполните «cert install»".into());
    }

    let valid = stdout.lines().any(|line| {
        let lower = line.to_lowercase();
        lower.starts_with("valid") || lower.starts_with("validcertificate")
    });

    if valid {
        hvlog!(Info, "сертификат", "подпись применена: {stdout}");
        Ok(())
    } else {
        Err(format!(
            "подпись не применена (код {code:?}); вывод: {stdout}; ошибки: {stderr}"
        ))
    }
}

pub fn status() -> CertState {
    let stores = STORES
        .iter()
        .map(|store| ps_quote(store))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "$stores = @({stores})\n\
         $found = @()\n\
         foreach ($store in $stores) {{\n\
             $cert = Get-ChildItem $store -ErrorAction SilentlyContinue | Where-Object {{ $_.Subject -eq '{CERT_SUBJECT}' }} | Select-Object -First 1\n\
             if ($cert) {{ $found += ($store + '|' + $cert.Thumbprint) }}\n\
         }}\n\
         if ($found.Count -eq 0) {{ Write-Output 'NOTINSTALLED' }} else {{ $found | ForEach-Object {{ Write-Output $_ }} }}"
    );

    match run_ps(&script) {
        Ok((stdout, _, _)) => parse_status_output(&stdout),
        Err(err) => {
            hvlog!(Warn, "сертификат", "не удалось запросить состояние хранилищ: {err}");
            CertState::default()
        }
    }
}

fn parse_status_output(stdout: &str) -> CertState {
    let mut state = CertState::default();
    for line in stdout.lines() {
        if line.trim() == "NOTINSTALLED" {
            continue;
        }
        // Формат строки: «хранилище|отпечаток»
        if let Some((store, thumbprint)) = line.split_once('|') {
            let thumbprint = thumbprint.trim();
            if !thumbprint.is_empty() && state.thumbprint.is_none() {
                state.thumbprint = Some(thumbprint.to_string());
            }
            state.stores.push(store.trim().to_string());
        }
    }
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn разбор_вывода_состояния_хранилищ() {
        // Отсутствие сертификата
        assert_eq!(parse_status_output("NOTINSTALLED"), CertState::default());
        assert!(!parse_status_output("NOTINSTALLED").installed());

        // Одна запись хранилища
        let state = parse_status_output("Cert:\\CurrentUser\\My|ABC123");
        assert_eq!(state.thumbprint.as_deref(), Some("ABC123"));
        assert_eq!(state.stores, vec!["Cert:\\CurrentUser\\My".to_string()]);
        assert!(state.installed());

        // Несколько хранилищ: отпечаток берётся из первой записи
        let state = parse_status_output(
            "Cert:\\CurrentUser\\My|AAA\nCert:\\LocalMachine\\Root|AAA\nCert:\\LocalMachine\\TrustedPublisher|AAA",
        );
        assert_eq!(state.stores.len(), 3);
        assert_eq!(state.thumbprint.as_deref(), Some("AAA"));
    }

    #[test]
    fn экранирование_строк_power_shell() {
        assert_eq!(ps_quote("C:\\Games\\My Game"), "'C:\\Games\\My Game'");
        // Внутренние кавычки удваиваются
        assert_eq!(ps_quote("a'b"), "'a''b'");
    }

    #[test]
    fn состояние_на_чистой_системе_отсутствует() {
        // Машина без сертификата Eclipse-HV: состояние определяется без ошибок
        let state = status();
        if state.installed() {
            // Если сертификат уже ставили вручную — проверяем согласованность полей
            assert!(state.thumbprint.is_some());
            assert!(!state.stores.is_empty());
        }
    }
}
