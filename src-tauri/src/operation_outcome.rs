//! Единое представление результата: пропуски не сериализуются как полный успех.
use serde::{ser::SerializeStruct, Serializer};
pub fn serialize<S: Serializer>(
    success: bool,
    message: &str,
    logs: &[String],
    added: Option<&[String]>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let skipped = logs
        .iter()
        .filter(|line| line.trim_start().starts_with('⚠'))
        .collect::<Vec<_>>();
    let partial = (!skipped.is_empty() && success)
        || (!success && added.is_some_and(|items| !items.is_empty()));
    let complete = success && skipped.is_empty();
    let status = if partial {
        "partial"
    } else if complete {
        "success"
    } else {
        "failed"
    };
    let message = if partial && !message.contains("частично") {
        format!("Выполнено частично. {message}")
    } else {
        message.to_string()
    };
    let mut value =
        serializer.serialize_struct("OperationResult", if added.is_some() { 6 } else { 5 })?;
    value.serialize_field("success", &complete)?;
    value.serialize_field("status", status)?;
    value.serialize_field("message", &message)?;
    value.serialize_field("logs", logs)?;
    value.serialize_field("skipped", &skipped)?;
    if let Some(items) = added {
        value.serialize_field("addedAppids", items)?;
    }
    value.end()
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        success: bool,
        logs: Vec<String>,
        added: Option<Vec<String>>,
    }
    impl serde::Serialize for Fixture {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serialize(
                self.success,
                "Результат",
                &self.logs,
                self.added.as_deref(),
                serializer,
            )
        }
    }
    #[test]
    fn skipped_files_never_become_full_success() {
        let result = serde_json::to_value(Fixture {
            success: true,
            logs: vec!["⚠ b.dll: отказ записи".into()],
            added: None,
        })
        .unwrap();
        assert_eq!(result["status"], "partial");
        assert_eq!(result["success"], false);
        assert!(result["message"].as_str().unwrap().contains("частично"));
        assert_eq!(result["skipped"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn partially_added_games_preserve_ids_and_partial_status() {
        let result = serde_json::to_value(Fixture {
            success: false,
            logs: vec![],
            added: Some(vec!["10".into()]),
        })
        .unwrap();
        assert_eq!(result["status"], "partial");
        assert_eq!(result["addedAppids"][0], "10");
    }
    #[test]
    fn clean_success_and_clean_failure_are_distinct() {
        for (success, status) in [(true, "success"), (false, "failed")] {
            let result = serde_json::to_value(Fixture {
                success,
                logs: vec![],
                added: None,
            })
            .unwrap();
            assert_eq!(result["status"], status);
            assert_eq!(result["success"], success);
        }
    }
}
