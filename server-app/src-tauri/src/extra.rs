//! Extra settings and backup/overview commands for the server UI: the server overview, backups (list, create, delete,
//! restore), the public URL and backup schedule in config.env, and opening the project page in the browser.

use std::fs;
use std::path::Path;

use super::*;

const REPO_URL: &str = "https://github.com/remuno3751/omnichat";

// ---------------------------------------------------------------------------------------------------------------
// pure validators

/// Backup names are the server's file names (omnichat-YYYYMMDD-HHMMSS.db); anything that could escape the backups
/// directory or the URL path is refused before it is used.
fn check_backup_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 40
        && !name.starts_with('.')
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(())
    } else {
        Err("不正なバックアップ名です".into())
    }
}

/// Returns the trimmed public URL (empty means "not set") when all values are acceptable.
fn check_extra(public_url: &str, hours: i64, keep: i64) -> Result<String, String> {
    let url = public_url.trim().to_string();
    if !url.is_empty() {
        let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"));
        let ok = is_safe_value(&url) && rest.is_some_and(|r| !r.is_empty()) && !url.contains(char::is_whitespace);
        if !ok {
            return Err("公開 URL は http:// または https:// で始め、空白や引用符を含めないでください".into());
        }
    }
    if !(0..=8760).contains(&hours) {
        return Err("バックアップ間隔は 0〜8760 時間で指定してください".into());
    }
    if !(1..=365).contains(&keep) {
        return Err("バックアップの保持数は 1〜365 で指定してください".into());
    }
    Ok(url)
}

fn is_allowed_url(url: &str) -> bool {
    url == REPO_URL || url.strip_suffix('/') == Some(REPO_URL)
}

// ---------------------------------------------------------------------------------------------------------------
// extra settings (config.env)

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Extra {
    pub public_url: String,
    pub backup_interval_hours: i64,
    pub backup_keep: i64,
}

/// Reads the values the way the server will see them; out-of-range or unparsable values show the default.
fn extra_of(cfg: &[(String, String)]) -> Extra {
    let num = |key: &str, default: i64, ok: fn(&i64) -> bool| {
        cfg_get(cfg, key).and_then(|v| v.trim().parse::<i64>().ok()).filter(ok).unwrap_or(default)
    };
    Extra {
        public_url: cfg_get(cfg, "OMNICHAT_PUBLIC_URL").map(|v| v.trim().to_string()).unwrap_or_default(),
        backup_interval_hours: num("BACKUP_INTERVAL_HOURS", 24, |n| (0..=8760).contains(n)),
        backup_keep: num("BACKUP_KEEP", 7, |n| (1..=365).contains(n)),
    }
}

#[tauri::command]
pub fn get_extra(app: AppHandle) -> Result<Extra, String> {
    let p = paths(&app)?;
    Ok(extra_of(&read_config(&p.config)))
}

#[tauri::command]
pub fn set_extra(app: AppHandle, public_url: String, backup_interval_hours: i64, backup_keep: i64) -> Result<Value, String> {
    let url = check_extra(&public_url, backup_interval_hours, backup_keep)?;
    let p = paths(&app)?;
    ensure_default_config(&p)?;
    let before = extra_of(&read_config(&p.config));
    write_config(
        &p.config,
        &[
            ("OMNICHAT_PUBLIC_URL", url.clone()),
            ("BACKUP_INTERVAL_HOURS", backup_interval_hours.to_string()),
            ("BACKUP_KEEP", backup_keep.to_string()),
        ],
    )?;
    let after = Extra { public_url: url, backup_interval_hours, backup_keep };
    let ctx = app.state::<Ctx>();
    Ok(json!({ "restartRequired": before != after && running(&ctx).is_some() }))
}

// ---------------------------------------------------------------------------------------------------------------
// overview

#[tauri::command]
pub async fn provider_add(app: AppHandle, name: String, base_url: String, model: String, api_key: String, owner: Option<String>) -> Result<Value, String> {
    blocking(move || {
        admin_call(
            &app,
            "POST",
            "/local-admin/providers",
            Some(json!({ "name": name, "baseUrl": base_url, "model": model, "apiKey": api_key, "owner": owner })),
        )
    })
    .await
}

#[tauri::command]
pub async fn provider_delete(app: AppHandle, id: String) -> Result<(), String> {
    blocking(move || {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("invalid id".into());
        }
        admin_call(&app, "DELETE", &format!("/local-admin/providers/{id}"), None).map(|_| ())
    })
    .await
}

// ---------------------------------------------------------------------------------------------------------------
// maintenance mode (PUT /local-admin/maintenance: partial body; only the fields given are sent)

#[tauri::command]
pub async fn maintenance_get(app: AppHandle) -> Result<Value, String> {
    blocking(move || admin_call(&app, "GET", "/local-admin/maintenance", None)).await
}

#[tauri::command]
pub async fn maintenance_set(
    app: AppHandle,
    enabled: Option<bool>,
    message: Option<String>,
    eta: Option<i64>,
    clear_eta: bool,
) -> Result<Value, String> {
    blocking(move || {
        let mut body = serde_json::Map::new();
        if let Some(v) = enabled {
            body.insert("enabled".into(), json!(v));
        }
        if let Some(v) = message {
            body.insert("message".into(), json!(v));
        }
        // clear_eta wins over eta: the server reads clearEta as "eta = null"
        if clear_eta {
            body.insert("clearEta".into(), json!(true));
        } else if let Some(v) = eta {
            body.insert("eta".into(), json!(v));
        }
        if body.is_empty() {
            return Err("nothing to change".into());
        }
        admin_call(&app, "PUT", "/local-admin/maintenance", Some(Value::Object(body)))
    })
    .await
}

// ---------------------------------------------------------------------------------------------------------------
// shared providers and per-user model grants (docs/PROTOCOL-v7-shared-providers.md, local-admin-shared.ts)

/// Ids are UUIDs or the short ids the server makes: ASCII letters, digits and '-', at most 64 characters.
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid id".into());
    }
    Ok(())
}

/// Grant models: 1 to 500 names, each 1 to 300 characters (the server checks again).
fn check_models(models: &[String]) -> Result<(), String> {
    if models.is_empty() || models.len() > 500 || models.iter().any(|m| m.trim().is_empty() || m.chars().count() > 300) {
        return Err("models must be 1 to 500 names of 1 to 300 characters".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn shared_provider_set(app: AppHandle, id: String, shared: bool) -> Result<Value, String> {
    blocking(move || {
        check_id(&id)?;
        admin_call(&app, "PUT", &format!("/local-admin/providers/{id}/shared"), Some(json!({ "shared": shared })))
    })
    .await
}

#[tauri::command]
pub async fn shared_providers_get(app: AppHandle) -> Result<Value, String> {
    blocking(move || admin_call(&app, "GET", "/local-admin/shared-providers", None)).await
}

#[tauri::command]
pub async fn provider_models_get(app: AppHandle, id: String, refresh: bool) -> Result<Value, String> {
    blocking(move || {
        check_id(&id)?;
        let path = if refresh { format!("/local-admin/providers/{id}/models?refresh=1") } else { format!("/local-admin/providers/{id}/models") };
        admin_call_secs(&app, "GET", &path, None, 20)
    })
    .await
}

#[tauri::command]
pub async fn user_grants_get(app: AppHandle, user_id: String) -> Result<Value, String> {
    blocking(move || {
        check_id(&user_id)?;
        admin_call(&app, "GET", &format!("/local-admin/users/{user_id}/grants"), None)
    })
    .await
}

/// mode: "all" | "list" | "none"; models is sent only for "list".
#[tauri::command]
pub async fn user_grant_set(app: AppHandle, user_id: String, provider_id: String, mode: String, models: Vec<String>) -> Result<Value, String> {
    blocking(move || {
        check_id(&user_id)?;
        check_id(&provider_id)?;
        let body = match mode.as_str() {
            "all" | "none" => json!({ "mode": mode }),
            "list" => {
                check_models(&models)?;
                json!({ "mode": "list", "models": models })
            }
            _ => return Err("mode must be all, list or none".into()),
        };
        admin_call(&app, "PUT", &format!("/local-admin/users/{user_id}/grants/{provider_id}"), Some(body))
    })
    .await
}

/// Removing the grant restores the default for that user and provider.
#[tauri::command]
pub async fn user_grant_delete(app: AppHandle, user_id: String, provider_id: String) -> Result<Value, String> {
    blocking(move || {
        check_id(&user_id)?;
        check_id(&provider_id)?;
        admin_call(&app, "DELETE", &format!("/local-admin/users/{user_id}/grants/{provider_id}"), None)
    })
    .await
}

#[tauri::command]
pub async fn shared_settings_get(app: AppHandle) -> Result<Value, String> {
    blocking(move || admin_call(&app, "GET", "/local-admin/shared-settings", None)).await
}

/// Only the fields given are sent. default_shared_access: "none" | "all".
#[tauri::command]
pub async fn shared_settings_set(app: AppHandle, default_shared_access: Option<String>, allow_own_providers: Option<bool>) -> Result<Value, String> {
    blocking(move || {
        let mut body = serde_json::Map::new();
        if let Some(v) = default_shared_access {
            if v != "none" && v != "all" {
                return Err("defaultSharedAccess must be none or all".into());
            }
            body.insert("defaultSharedAccess".into(), json!(v));
        }
        if let Some(v) = allow_own_providers {
            body.insert("allowOwnProviders".into(), json!(v));
        }
        if body.is_empty() {
            return Err("nothing to change".into());
        }
        admin_call(&app, "PUT", "/local-admin/shared-settings", Some(Value::Object(body)))
    })
    .await
}

#[tauri::command]
pub async fn server_overview(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        if running(&app.state::<Ctx>()).is_none() {
            return Err("サーバーが起動していません".into());
        }
        let status = admin_call(&app, "GET", "/local-admin/status", None)?;
        let overview = admin_call(&app, "GET", "/local-admin/overview", None)?;
        let pick = |src: &Value, key: &str| src.get(key).cloned().unwrap_or(Value::Null);
        Ok(json!({
            "uptimeSec": pick(&status, "uptimeSec"),
            "users": pick(&status, "users"),
            "allowRegistration": pick(&status, "allowRegistration"),
            "connections": pick(&overview, "connections"),
            "bridges": pick(&overview, "bridges"),
            "activeChats": pick(&overview, "activeChats"),
            "localServers": pick(&overview, "localServers"),
            "providers": pick(&overview, "providers"),
        }))
    })
    .await
}

// ---------------------------------------------------------------------------------------------------------------
// backups

#[tauri::command]
pub async fn backups_list(app: AppHandle) -> Result<Value, String> {
    blocking(move || admin_call(&app, "GET", "/local-admin/backups", None)).await
}

#[tauri::command]
pub async fn backup_create(app: AppHandle) -> Result<Value, String> {
    // the server takes no body; an empty object keeps the call a POST with JSON
    blocking(move || admin_call_secs(&app, "POST", "/local-admin/backups", Some(json!({})), 60)).await
}

#[tauri::command]
pub async fn backup_delete(app: AppHandle, name: String) -> Result<Value, String> {
    check_backup_name(&name)?;
    blocking(move || admin_call(&app, "DELETE", &format!("/local-admin/backups/{name}"), None)).await
}

/// Copies the backup over omnichat.db through a temp file, after dropping the WAL/SHM files of the old database.
/// On failure the temp file is removed and the old database is left as it was.
fn swap_in_backup(data_dir: &Path, src: &Path) -> Result<(), String> {
    let db = data_dir.join("omnichat.db");
    let tmp = data_dir.join("omnichat.db.restore-tmp");
    for suffix in ["-wal", "-shm"] {
        match fs::remove_file(data_dir.join(format!("omnichat.db{suffix}"))) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    fs::copy(src, &tmp).and_then(|_| fs::rename(&tmp, &db)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Stops the server, replaces the database with the chosen backup and starts the server again (also when the
/// replacement failed, so the server is never left stopped by a failed restore). The UI creates a fresh backup first.
#[tauri::command]
pub async fn backup_restore(app: AppHandle, name: String) -> Result<StateOut, String> {
    check_backup_name(&name)?;
    blocking(move || {
        let p = paths(&app)?;
        let src = p.data_dir.join("backups").join(&name);
        if !src.is_file() {
            return Err("バックアップが見つかりません".into());
        }
        // the server would open DB_PATH instead of data_dir/omnichat.db, so the copy would silently do nothing
        if cfg_get(&read_config(&p.config), "DB_PATH").is_some() {
            return Err("config.env に DB_PATH が設定されているため、復元できません".into());
        }
        stop(&app);
        let swapped = swap_in_backup(&p.data_dir, &src);
        let started = start(&app);
        let s = state(&app)?;
        swapped.and(started).map(|_| s)
    })
    .await
}

// ---------------------------------------------------------------------------------------------------------------
// attachments, plugins and usage quotas (local admin API; mirrors /admin/attachments, /admin/plugins and
// /admin/quotas: docs/design/ATTACHMENTS.md, docs/PROTOCOL-v7-plugins.md, docs/PROTOCOL-v7-quotas.md)

/// Same bounds the server enforces for the attachment settings (docs/PROTOCOL-v7-attachments.md).
fn check_attachment_range(key: &str, v: i64) -> Result<(), String> {
    let (lo, hi) = match key {
        "maxFileMB" => (1, 500),
        "quotaMB" => (0, 1_000_000),
        "retentionDays" => (0, 3650),
        "maxPerMessage" => (1, 50),
        "extractMaxChars" => (1000, 500_000),
        _ => return Err("unknown attachment setting".into()),
    };
    if (lo..=hi).contains(&v) {
        Ok(())
    } else {
        Err(format!("{key} は {lo} 〜 {hi} の範囲で指定してください"))
    }
}

/// Plugin ids are folder names; reject anything that could escape the URL path.
fn check_plugin_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && !id.contains("..")
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err("invalid plugin id".into())
    }
}

/// Opaque tokens from the server (inspection ids): letters, digits, '-' and '_' only.
fn check_token(v: &str) -> Result<(), String> {
    if !v.is_empty() && v.len() <= 128 && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        Ok(())
    } else {
        Err("invalid token".into())
    }
}

/// Token counts: 0 (unlimited) up to 1e12.
fn check_tokens(v: i64) -> Result<(), String> {
    if (0..=1_000_000_000_000).contains(&v) {
        Ok(())
    } else {
        Err("トークン数は 0 以上で指定してください".into())
    }
}

#[tauri::command]
pub async fn attachments_get(app: AppHandle) -> Result<Value, String> {
    blocking(move || admin_call(&app, "GET", "/local-admin/attachments", None)).await
}

/// Only the fields given are sent. clear_transcribe_model turns speech transcription off (sends null).
#[tauri::command]
pub async fn attachments_set(
    app: AppHandle,
    max_file_mb: Option<i64>,
    quota_mb: Option<i64>,
    retention_days: Option<i64>,
    max_per_message: Option<i64>,
    extract_max_chars: Option<i64>,
    transcribe_model: Option<String>,
    clear_transcribe_model: bool,
) -> Result<Value, String> {
    blocking(move || {
        let mut body = serde_json::Map::new();
        let nums = [
            ("maxFileMB", max_file_mb),
            ("quotaMB", quota_mb),
            ("retentionDays", retention_days),
            ("maxPerMessage", max_per_message),
            ("extractMaxChars", extract_max_chars),
        ];
        for (key, value) in nums {
            if let Some(v) = value {
                check_attachment_range(key, v)?;
                body.insert(key.into(), json!(v));
            }
        }
        if clear_transcribe_model {
            body.insert("transcribeModel".into(), Value::Null);
        } else if let Some(m) = transcribe_model {
            let m = m.trim().to_string();
            if m.is_empty() || m.len() > 200 || !m.contains("::") {
                return Err("transcribeModel は <providerId>::<model> の形で指定してください".into());
            }
            body.insert("transcribeModel".into(), json!(m));
        }
        if body.is_empty() {
            return Err("nothing to change".into());
        }
        admin_call(&app, "PUT", "/local-admin/attachments", Some(Value::Object(body)))
    })
    .await
}

#[tauri::command]
pub async fn plugins_get(app: AppHandle) -> Result<Value, String> {
    blocking(move || admin_call(&app, "GET", "/local-admin/plugins", None)).await
}

#[tauri::command]
pub async fn plugin_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<Value, String> {
    blocking(move || {
        check_plugin_id(&id)?;
        admin_call(&app, "PATCH", &format!("/local-admin/plugins/{id}"), Some(json!({ "enabled": enabled })))
    })
    .await
}

#[tauri::command]
pub async fn plugin_delete(app: AppHandle, id: String) -> Result<Value, String> {
    blocking(move || {
        check_plugin_id(&id)?;
        admin_call(&app, "DELETE", &format!("/local-admin/plugins/{id}"), None)
    })
    .await
}

/// Fetches and inspects a GitHub repository on the server (nothing is installed yet).
#[tauri::command]
pub async fn plugin_inspect(app: AppHandle, repo: String, git_ref: Option<String>, subdir: Option<String>) -> Result<Value, String> {
    blocking(move || {
        let repo = repo.trim().to_string();
        if repo.is_empty() || repo.len() > 300 {
            return Err("repo".into());
        }
        let mut body = json!({ "source": "github", "repo": repo });
        if let Some(r) = git_ref.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()) {
            body["ref"] = json!(r);
        }
        if let Some(s) = subdir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            if s.split(['/', '\\']).any(|seg| seg == "..") || s.starts_with('/') {
                return Err("subdir".into());
            }
            body["subdir"] = json!(s);
        }
        admin_call_secs(&app, "POST", "/local-admin/plugins/inspect", Some(body), 60)
    })
    .await
}

/// Installs an inspected plugin, disabled. confirm_id must equal the inspected plugin id (the server checks).
#[tauri::command]
pub async fn plugin_install(app: AppHandle, inspection_id: String, confirm_id: String) -> Result<Value, String> {
    blocking(move || {
        check_token(&inspection_id)?;
        check_plugin_id(&confirm_id)?;
        admin_call_secs(&app, "POST", "/local-admin/plugins/install", Some(json!({ "inspectionId": inspection_id, "confirmId": confirm_id })), 60)
    })
    .await
}

#[tauri::command]
pub async fn plugin_check_update(app: AppHandle, id: String) -> Result<Value, String> {
    blocking(move || {
        check_plugin_id(&id)?;
        admin_call_secs(&app, "POST", &format!("/local-admin/plugins/{id}/check-update"), Some(json!({})), 60)
    })
    .await
}

/// Every user's tokens, active time and last activity (days = 0: all time; tz = minutes east of UTC).
#[tauri::command]
pub async fn usage_users_get(app: AppHandle, days: i64, tz: i64) -> Result<Value, String> {
    if !(0..=3660).contains(&days) || !(-840..=840).contains(&tz) {
        return Err("days / tz out of range".into());
    }
    blocking(move || admin_call(&app, "GET", &format!("/local-admin/usage/users?days={days}&tz={tz}"), None)).await
}

/// Daily token buckets of everybody (user_id None) or of one user; days 1..=3660, tz in minutes east of UTC.
#[tauri::command]
pub async fn usage_daily_get(app: AppHandle, user_id: Option<String>, days: i64, tz: i64) -> Result<Value, String> {
    if !(1..=3660).contains(&days) || !(-840..=840).contains(&tz) {
        return Err("days / tz out of range".into());
    }
    let user = match &user_id {
        Some(id) => {
            check_id(id)?;
            format!("&user={id}")
        }
        None => String::new(),
    };
    blocking(move || admin_call(&app, "GET", &format!("/local-admin/usage/daily?scope=all&days={days}&tz={tz}{user}"), None)).await
}

#[tauri::command]
pub async fn quotas_get(app: AppHandle) -> Result<Value, String> {
    blocking(move || admin_call(&app, "GET", "/local-admin/quotas", None)).await
}

/// Default limits. Only the fields given are sent; 0 means unlimited.
#[tauri::command]
pub async fn quotas_set(app: AppHandle, enabled: Option<bool>, daily_tokens: Option<i64>, monthly_tokens: Option<i64>) -> Result<Value, String> {
    blocking(move || {
        let mut body = serde_json::Map::new();
        if let Some(v) = enabled {
            body.insert("enabled".into(), json!(v));
        }
        if let Some(v) = daily_tokens {
            check_tokens(v)?;
            body.insert("dailyTokens".into(), json!(v));
        }
        if let Some(v) = monthly_tokens {
            check_tokens(v)?;
            body.insert("monthlyTokens".into(), json!(v));
        }
        if body.is_empty() {
            return Err("nothing to change".into());
        }
        admin_call(&app, "PUT", "/local-admin/quotas", Some(Value::Object(body)))
    })
    .await
}

#[tauri::command]
pub async fn quota_users_get(app: AppHandle) -> Result<Value, String> {
    blocking(move || admin_call(&app, "GET", "/local-admin/quotas/users", None)).await
}

/// None sends null, which means "follow the default" for that user; 0 means unlimited for that user.
#[tauri::command]
pub async fn quota_user_set(app: AppHandle, user_id: String, daily_tokens: Option<i64>, monthly_tokens: Option<i64>) -> Result<Value, String> {
    blocking(move || {
        check_id(&user_id)?;
        if let Some(v) = daily_tokens {
            check_tokens(v)?;
        }
        if let Some(v) = monthly_tokens {
            check_tokens(v)?;
        }
        admin_call(&app, "PUT", &format!("/local-admin/quotas/users/{user_id}"), Some(json!({ "dailyTokens": daily_tokens, "monthlyTokens": monthly_tokens })))
    })
    .await
}

#[tauri::command]
pub async fn quota_user_delete(app: AppHandle, user_id: String) -> Result<Value, String> {
    blocking(move || {
        check_id(&user_id)?;
        admin_call(&app, "DELETE", &format!("/local-admin/quotas/users/{user_id}"), None)
    })
    .await
}

// ---------------------------------------------------------------------------------------------------------------
// opening the project page

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !is_allowed_url(&url) {
        return Err("開けない URL です".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_names_are_checked() {
        for ok in ["omnichat-20261016-031500.db", "omnichat-20261016-031500-2.db", "a.b_c-1"] {
            assert!(check_backup_name(ok).is_ok(), "{ok}");
        }
        let long = format!("{}.db", "x".repeat(40));
        for bad in ["", ".", "..", ".hidden", "../x.db", "a/b.db", "a\\b.db", "a..b.db", "a b.db", "naïve.db", "a?b", long.as_str()] {
            assert!(check_backup_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn extra_values_are_checked() {
        assert_eq!(check_extra("", 24, 7).as_deref(), Ok(""));
        assert_eq!(check_extra("  https://omni.example.com  ", 0, 1).as_deref(), Ok("https://omni.example.com"));
        assert!(check_extra("http://127.0.0.1:8787", 8760, 365).is_ok());
        for bad_url in ["ftp://x", "https://", "https://a b", "https://a\"b", "https://a'b", "https://a#b", "omni.example.com"] {
            assert!(check_extra(bad_url, 24, 7).is_err(), "{bad_url}");
        }
        assert!(check_extra("", -1, 7).is_err());
        assert!(check_extra("", 8761, 7).is_err());
        assert!(check_extra("", 24, 0).is_err());
        assert!(check_extra("", 24, 366).is_err());
    }

    #[test]
    fn extra_defaults_and_out_of_range_values() {
        assert_eq!(extra_of(&[]), Extra { public_url: String::new(), backup_interval_hours: 24, backup_keep: 7 });
        let cfg = vec![("BACKUP_KEEP".to_string(), "0".to_string()), ("BACKUP_INTERVAL_HOURS".to_string(), " 6 ".to_string())];
        let e = extra_of(&cfg);
        assert_eq!((e.backup_interval_hours, e.backup_keep), (6, 7));
    }

    #[test]
    fn only_the_project_page_may_be_opened() {
        assert!(is_allowed_url(REPO_URL));
        assert!(is_allowed_url("https://github.com/remuno3751/omnichat/"));
        for bad in [
            "",
            "https://github.com/remuno3751/omnichat.git",
            "https://github.com/remuno3751/omnichat//",
            "https://github.com/remuno3751/omnichat/issues",
            "http://github.com/remuno3751/omnichat",
            "file:///etc/passwd",
        ] {
            assert!(!is_allowed_url(bad), "{bad}");
        }
    }

    #[test]
    fn attachment_ranges_and_plugin_ids_are_checked() {
        assert!(check_attachment_range("maxFileMB", 25).is_ok());
        assert!(check_attachment_range("maxFileMB", 501).is_err());
        assert!(check_attachment_range("quotaMB", 0).is_ok());
        assert!(check_attachment_range("retentionDays", 3651).is_err());
        assert!(check_attachment_range("extractMaxChars", 999).is_err());
        assert!(check_attachment_range("nope", 1).is_err());
        for ok in ["weather", "my-plugin_2", "a.b"] {
            assert!(check_plugin_id(ok).is_ok(), "{ok}");
        }
        for bad in ["", ".hidden", "../x", "a/b", "a b", "x\\y", "é"] {
            assert!(check_plugin_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn restore_swaps_the_database_and_drops_wal_files() {
        let dir = std::env::temp_dir().join(format!("omni-extra-{}-restore", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("backups")).unwrap();
        fs::write(dir.join("omnichat.db"), "old").unwrap();
        fs::write(dir.join("omnichat.db-wal"), "w").unwrap();
        fs::write(dir.join("omnichat.db-shm"), "s").unwrap();
        let src = dir.join("backups").join("omnichat-20261016-031500.db");
        fs::write(&src, "new").unwrap();

        swap_in_backup(&dir, &src).unwrap();
        assert_eq!(fs::read_to_string(dir.join("omnichat.db")).unwrap(), "new");
        assert!(!dir.join("omnichat.db-wal").exists());
        assert!(!dir.join("omnichat.db-shm").exists());
        assert!(!dir.join("omnichat.db.restore-tmp").exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
