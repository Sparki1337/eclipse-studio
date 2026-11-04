#![allow(dead_code)]
#[path = "../../../src-tauri/src/archive_policy.rs"]
mod archive_policy;
#[path = "../../../src-tauri/src/backup.rs"]
mod backup;
#[path = "../../../src-tauri/src/durable.rs"]
mod durable;
#[path = "../../../src-tauri/src/safe_path.rs"]
mod safe_path;

#[path = "../../../src-tauri/src/resource_lock.rs"]
mod resource_lock;

#[path = "../../../src-tauri/src/download.rs"]
mod download;

#[path = "../../../src-tauri/src/operation_outcome.rs"]
mod operation_outcome;

#[cfg(test)]
#[path = "../../../src-tauri/src/ryuu_auth.rs"]
mod ryuu_auth;

#[path = "../../../src-tauri/src/external_vbs_plan.rs"]
mod external_vbs_plan;

#[path = "../../../src-tauri/src/local_cloud_core.rs"]
mod local_cloud_core;

#[path = "../../../src-tauri/src/update_core.rs"]
mod update_core;
