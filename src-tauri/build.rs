use std::{env, fs, path::Path};

// Значение не выводится в Cargo-логи и не передаётся через cargo:rustc-env.
fn prepare_ryuu_key() -> Result<(), String> {
    const ENV_NAME: &str = "ECLIPSE_RYUU_BUILTIN_KEY";
    const MAX_KEY_BYTES: usize = 16 * 1024;

    println!("cargo:rerun-if-env-changed={ENV_NAME}");
    let manifest_dir =
        env::var_os("CARGO_MANIFEST_DIR").ok_or("Не определён каталог проекта Cargo")?;
    let secret_file = Path::new(&manifest_dir).join("../.secrets/ryuu-key.txt");
    println!("cargo:rerun-if-changed={}", secret_file.display());

    let configured = match env::var(ENV_NAME) {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => match fs::metadata(&secret_file) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.len() > MAX_KEY_BYTES as u64 {
                    return Err("Локальный файл ключа Ryuu имеет неверный размер или тип".into());
                }
                Some(
                    fs::read_to_string(&secret_file)
                        .map_err(|_| "Не удалось прочитать локальный файл ключа Ryuu как UTF-8")?,
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("Не удалось открыть локальный файл ключа Ryuu".into()),
        },
        Err(env::VarError::NotUnicode(_)) => {
            return Err("Переменная ECLIPSE_RYUU_BUILTIN_KEY должна содержать текст UTF-8".into());
        }
    };

    let key = match configured.as_deref() {
        Some(value) => {
            let key = value.trim();
            if value.len() > MAX_KEY_BYTES
                || key.is_empty()
                || !key.bytes().all(|byte| byte.is_ascii_graphic())
            {
                return Err(
                    "Ключ Ryuu должен содержать непустой ASCII-текст без внутренних пробелов; максимум 16384 байта"
                        .into(),
                );
            }
            key
        }
        None => {
            println!("cargo:warning=Встроенный ключ Ryuu не задан; доступен режим своего ключа");
            ""
        }
    };

    let out_dir = env::var_os("OUT_DIR").ok_or("Не определён каталог артефактов Cargo")?;
    let output = Path::new(&out_dir).join("ryuu-builtin-key.txt");
    fs::write(&output, key).map_err(|_| "Не удалось подготовить сборочный файл ключа Ryuu")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&output, fs::Permissions::from_mode(0o600))
            .map_err(|_| "Не удалось ограничить доступ к сборочному файлу ключа Ryuu")?;
    }
    Ok(())
}

fn main() {
    if let Err(message) = prepare_ryuu_key() {
        panic!("{message}");
    }
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        tauri_build::build();
        return;
    }
    let manifest = r#"
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>
"#;
    let windows = tauri_build::WindowsAttributes::new().app_manifest(manifest);
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attributes).expect("failed to run build script");
}
