//! Выбор ключа Ryuu выполняется в бэкенде; встроенный ключ не передаётся WebView.
//! Приватное значение подготавливает build.rs, в исходниках ключа нет.

#[cfg(not(test))]
const CROCODILE_GENA_STUDIO_KEY: &str =
    include_str!(concat!(env!("OUT_DIR"), "/ryuu-builtin-key.txt"));
#[cfg(test)]
const CROCODILE_GENA_STUDIO_KEY: &str = "";

pub(crate) fn resolve_key<'a>(
    source: Option<&str>,
    custom_key: Option<&'a str>,
) -> Result<&'a str, String> {
    resolve_key_with_builtin(source, custom_key, CROCODILE_GENA_STUDIO_KEY)
}

fn resolve_key_with_builtin<'a>(
    source: Option<&str>,
    custom_key: Option<&'a str>,
    builtin_key: &'a str,
) -> Result<&'a str, String> {
    let custom_key = custom_key.map(str::trim).filter(|key| !key.is_empty());
    let builtin = || {
        let key = builtin_key.trim();
        if key.is_empty() {
            Err("Встроенный ключ Ryuu не задан при сборке. Выберите свой ключ в настройках".into())
        } else {
            Ok(key)
        }
    };
    match source {
        Some("crocodile") => builtin(),
        Some("custom") => {
            custom_key.ok_or_else(|| "Укажите свой API-ключ Ryuu в настройках".into())
        }
        // При обновлении сохраняем уже настроенный личный ключ.
        None => match custom_key {
            Some(key) => Ok(key),
            None => builtin(),
        },
        Some(_) => Err("Неизвестный источник ключа Ryuu. Выберите его в настройках".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_key_with_builtin;

    const CROCODILE_GENA_STUDIO_KEY: &str = "test-only-builtin-key";

    fn resolve_key<'a>(
        source: Option<&str>,
        custom_key: Option<&'a str>,
    ) -> Result<&'a str, String> {
        resolve_key_with_builtin(source, custom_key, CROCODILE_GENA_STUDIO_KEY)
    }

    #[test]
    fn builtin_source_ignores_saved_personal_key() {
        assert_eq!(
            resolve_key(Some("crocodile"), Some("personal-key")).unwrap(),
            CROCODILE_GENA_STUDIO_KEY
        );
        assert_eq!(
            resolve_key(Some("crocodile"), None).unwrap(),
            CROCODILE_GENA_STUDIO_KEY
        );
    }

    #[test]
    fn custom_source_uses_only_personal_key() {
        assert_eq!(
            resolve_key(Some("custom"), Some("  personal-key \n")).unwrap(),
            "personal-key"
        );
    }

    #[test]
    fn missing_custom_key_never_falls_back_to_builtin() {
        assert!(resolve_key(Some("custom"), None).is_err());
        assert!(resolve_key(Some("custom"), Some(" \n\t")).is_err());
    }

    #[test]
    fn legacy_personal_key_stays_selected() {
        assert_eq!(
            resolve_key(None, Some("personal-key")).unwrap(),
            "personal-key"
        );
    }

    #[test]
    fn fresh_install_uses_builtin_key() {
        assert_eq!(resolve_key(None, None).unwrap(), CROCODILE_GENA_STUDIO_KEY);
        assert_eq!(
            resolve_key(None, Some(" ")).unwrap(),
            CROCODILE_GENA_STUDIO_KEY
        );
    }

    #[test]
    fn unknown_source_is_rejected() {
        assert!(resolve_key(Some("unexpected"), Some("personal-key")).is_err());
    }

    #[test]
    fn missing_builtin_key_reports_configuration_error() {
        for source in [Some("crocodile"), None] {
            let error = resolve_key_with_builtin(source, None, "").unwrap_err();
            assert!(error.contains("не задан при сборке"));
        }
        assert!(
            resolve_key_with_builtin(Some("crocodile"), Some("personal-key"), "").is_err()
        );
    }

    #[test]
    fn own_key_works_without_builtin_configuration() {
        assert_eq!(
            super::resolve_key(Some("custom"), Some("personal-key")).unwrap(),
            "personal-key"
        );
        assert_eq!(
            super::resolve_key(None, Some("personal-key")).unwrap(),
            "personal-key"
        );
    }

    #[test]
    fn configured_builtin_key_is_trimmed() {
        assert_eq!(
            resolve_key_with_builtin(Some("crocodile"), None, "  test-only-builtin-key\n").unwrap(),
            CROCODILE_GENA_STUDIO_KEY
        );
    }
}