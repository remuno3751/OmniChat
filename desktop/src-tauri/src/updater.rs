//! Desktop client update check.
//!
//! At startup (after a short delay, then every 6 hours, or on demand from Settings) the client asks GitHub Releases for a newer desktop
//! installer. When one is due, a small `update` window is opened. "Update now" downloads the
//! installer over HTTPS, verifies its SHA-256 against the release checksums (refuses when no
//! checksum exists or it does not match) and, on Windows only, runs the NSIS installer silently
//! and restarts the app. Other platforms open the release page.
//!
//! Optional settings live in `<app_data_dir>/update.json`:
//! `{"token": "...", "channel": "stable|prerelease", "skipped": ["1.2.0"], "remindAfter": {"1.2.0": <epoch ms>}}`.
//! The token is never shown in the UI and never logged.
//! Environment overrides (tests / private mirrors): OMNICHAT_UPDATE_API_BASE,
//! OMNICHAT_UPDATE_REPO, OMNICHAT_UPDATE_TOKEN, OMNICHAT_UPDATE_DELAY_MS.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

pub const UPDATE_WINDOW: &str = "update";
const UPDATE_FILE: &str = "update.json";
const DEFAULT_API: &str = "https://api.github.com";
const DEFAULT_REPO: &str = "remuno3751/omnichat";
const CURRENT: &str = env!("CARGO_PKG_VERSION");
const REMIND_LATER_MS: u64 = 24 * 3600 * 1000;
const FIRST_CHECK_DELAY_MS: u64 = 20_000;
const PERIODIC_CHECK_MS: u64 = 6 * 3600 * 1000;
/// A failed background check is retried after this delay instead of waiting for the next 6 h slot.
const RETRY_AFTER_FAILURE_MS: u64 = 15 * 60 * 1000;
const RELEASES_PER_PAGE: u32 = 30;
const MAX_INSTALLER_BYTES: u64 = 300 * 1024 * 1024;
const MAX_JSON_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 1024 * 1024;
const NOTES_MAX_CHARS: usize = 1500;

// ---------------------------------------------------------------------------
// Semantic versions (SemVer 2.0 precedence; build metadata ignored)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemVer {
    pub core: [u64; 3],
    pub pre: Vec<String>,
}

impl std::fmt::Display for SemVer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.core[0], self.core[1], self.core[2])?;
        if !self.pre.is_empty() {
            write!(f, "-{}", self.pre.join("."))?;
        }
        Ok(())
    }
}

/// Parse `v1.2.3`, `1.2.3-rc.1`, `1.2.3+build`. Returns None for anything else.
pub fn parse_version(s: &str) -> Option<SemVer> {
    let s = s.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    let s = s.split('+').next()?;
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut nums = [0u64; 3];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        nums[i] = p.parse().ok()?;
    }
    let pre = match pre {
        None => Vec::new(),
        Some(p) => {
            let ids: Vec<String> = p.split('.').map(|x| x.to_string()).collect();
            let valid = ids
                .iter()
                .all(|i| !i.is_empty() && i.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
            if !valid {
                return None;
            }
            ids
        }
    };
    Some(SemVer { core: nums, pre })
}

fn cmp_ident(x: &str, y: &str) -> Ordering {
    let xn = !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    let yn = !y.is_empty() && y.bytes().all(|b| b.is_ascii_digit());
    match (xn, yn) {
        // numeric identifiers compare numerically (length first avoids overflow)
        (true, true) => x.len().cmp(&y.len()).then_with(|| x.cmp(y)),
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => x.cmp(y),
    }
}

pub fn compare_versions(a: &SemVer, b: &SemVer) -> Ordering {
    match a.core.cmp(&b.core) {
        Ordering::Equal => {}
        o => return o,
    }
    match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        (false, false) => {}
    }
    for (x, y) in a.pre.iter().zip(b.pre.iter()) {
        match cmp_ident(x, y) {
            Ordering::Equal => {}
            o => return o,
        }
    }
    a.pre.len().cmp(&b.pre.len())
}

/// True when `candidate` is a valid version strictly newer than `current`.
#[cfg(test)]
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(c), Some(cur)) => compare_versions(&c, &cur) == Ordering::Greater,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// GitHub release model and selection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct GhAsset {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    /// API asset url (needs `Accept: application/octet-stream`, works with a token).
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub browser_download_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhRelease {
    #[serde(default)]
    pub tag_name: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub html_url: String,
    #[serde(default)]
    pub assets: Vec<GhAsset>,
}

fn is_version_chars(mid: &str) -> bool {
    !mid.is_empty() && mid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'+')
}

/// Windows NSIS installer of the desktop client. Two names are accepted (case sensitive; the server app is excluded):
/// `OmniChat_<ver>_x64-setup.exe` (Tauri's default) and the release name used by packaging/local/build-windows.sh,
/// `OmniChat-Desktop-v<ver>-Windows-x64-Setup.exe`. The version-less alias `OmniChat-Desktop-Windows-x64-Setup.exe` is not
/// taken: the release tag already says which version it is.
pub fn is_windows_installer(name: &str) -> bool {
    if let Some(mid) = name.strip_prefix("OmniChat_").and_then(|r| r.strip_suffix("_x64-setup.exe")) {
        return is_version_chars(mid);
    }
    match name.strip_prefix("OmniChat-Desktop-v").and_then(|r| r.strip_suffix("-Windows-x64-Setup.exe")) {
        Some(mid) => is_version_chars(mid),
        None => false,
    }
}

fn is_linux_package(name: &str) -> bool {
    match name.strip_prefix("OmniChat_") {
        Some(rest) => {
            (rest.ends_with(".AppImage") || rest.ends_with(".deb")) && rest.len() > 9 && !rest.contains(' ')
        }
        None => false,
    }
}

fn is_macos_package(name: &str) -> bool {
    if let Some(mid) = name.strip_prefix("OmniChat-Desktop-v").and_then(|r| r.strip_suffix("-macOS-universal.dmg")) {
        return is_version_chars(mid); // the name packaging/local/build-mac.sh publishes
    }
    match name.strip_prefix("OmniChat_") {
        Some(rest) => rest.ends_with(".dmg") && rest.len() > 4 && !rest.contains(' '),
        None => false,
    }
}

/// Desktop installer asset for an OS name ("windows" | "linux" | "macos").
pub fn find_desktop_asset<'a>(assets: &'a [GhAsset], os: &str) -> Option<&'a GhAsset> {
    assets.iter().find(|a| match os {
        "windows" => is_windows_installer(&a.name),
        "linux" => is_linux_package(&a.name),
        "macos" => is_macos_package(&a.name),
        _ => false,
    })
}

/// (SHA256SUMS asset, `<asset>.sha256` asset) of the release for `asset_name`.
pub fn checksum_assets(assets: &[GhAsset], asset_name: &str) -> (Option<GhAsset>, Option<GhAsset>) {
    let per = format!("{asset_name}.sha256");
    let sums = assets.iter().find(|a| a.name == "SHA256SUMS").cloned();
    let per_asset = assets.iter().find(|a| a.name == per).cloned();
    (sums, per_asset)
}

pub struct Picked<'a> {
    pub release: &'a GhRelease,
    /// Normalised version (no leading v, no build metadata).
    pub version: String,
    pub asset: &'a GhAsset,
}

/// Newest non-draft release with a desktop installer for `os`, newer than `current`.
/// `channel` "stable" ignores prereleases; anything else includes them.
pub fn pick_release<'a>(releases: &'a [GhRelease], channel: &str, current: &str, os: &str) -> Option<Picked<'a>> {
    let cur = parse_version(current)?;
    let stable_only = channel != "prerelease";
    let mut best: Option<(SemVer, Picked<'a>)> = None;
    for r in releases {
        if r.draft {
            continue;
        }
        let Some(v) = parse_version(&r.tag_name) else { continue };
        if stable_only && (r.prerelease || !v.pre.is_empty()) {
            continue;
        }
        let Some(asset) = find_desktop_asset(&r.assets, os) else { continue };
        if compare_versions(&v, &cur) != Ordering::Greater {
            continue;
        }
        let better = match &best {
            None => true,
            Some((bv, _)) => compare_versions(&v, bv) == Ordering::Greater,
        };
        if better {
            let version = v.to_string();
            best = Some((v, Picked { release: r, version, asset }));
        }
    }
    best.map(|(_, p)| p)
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

/// Parse `sha256sum`-style lines: `<64 hex>  <name>` (`*name` binary marker tolerated) or a bare
/// `<64 hex>`. Returns (name if present, lowercase hex). Malformed lines are skipped.
pub fn parse_sums(text: &str) -> Vec<(Option<String>, String)> {
    text.lines()
        .filter_map(|line| {
            // First 64 characters are the hash; the rest is "  name" or " *name" (names may contain spaces).
            let hex = line.get(..64)?;
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            let rest = line[64..].trim();
            let name = match rest.trim_start_matches('*').trim() {
                "" => None,
                n => Some(n.to_string()),
            };
            Some((name, hex.to_ascii_lowercase()))
        })
        .collect()
}

/// Expected SHA-256 of `name`: from the SHA256SUMS text, else from a `<name>.sha256` text
/// (a bare hash line is accepted there). None when neither lists it.
pub fn sum_for(name: &str, sums: Option<&str>, per: Option<&str>) -> Option<String> {
    if let Some(t) = sums {
        for (n, h) in parse_sums(t) {
            if n.as_deref() == Some(name) {
                return Some(h);
            }
        }
    }
    if let Some(t) = per {
        for (n, h) in parse_sums(t) {
            if n.as_deref().map_or(true, |x| x == name) {
                return Some(h);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Prompt rules (same as the server popup: skip per version, remind after 24 h)
// ---------------------------------------------------------------------------

pub struct Prefs {
    pub channel: String,
    pub skipped: Vec<String>,
    pub remind_after: HashMap<String, u64>,
}

fn norm_version(s: &str) -> String {
    let t = s.trim();
    t.strip_prefix('v').unwrap_or(t).to_string()
}

fn prefs_from(obj: &Map<String, Value>) -> Prefs {
    let channel = match obj.get("channel").and_then(Value::as_str) {
        Some("prerelease") => "prerelease",
        _ => "stable",
    }
    .to_string();
    let skipped = obj
        .get("skipped")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(norm_version).collect())
        .unwrap_or_default();
    let remind_after = obj
        .get("remindAfter")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_u64().map(|t| (norm_version(k), t)))
                .collect()
        })
        .unwrap_or_default();
    Prefs { channel, skipped, remind_after }
}

/// Show the popup unless the version was skipped or "remind later" has not expired yet.
pub fn should_prompt(skipped: &[String], remind_after: &HashMap<String, u64>, version: &str, now_ms: u64) -> bool {
    if skipped.iter().any(|s| s == version) {
        return false;
    }
    !matches!(remind_after.get(version), Some(t) if *t > now_ms)
}

// ---------------------------------------------------------------------------
// SHA-256 helpers and base64 (for the PowerShell helper command line)
// ---------------------------------------------------------------------------

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
pub fn sha256_hex(data: &[u8]) -> String {
    to_hex(&Sha256::digest(data)[..])
}

pub fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b0 = c[0];
        let b1 = *c.get(1).unwrap_or(&0);
        let b2 = *c.get(2).unwrap_or(&0);
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

// ---------------------------------------------------------------------------
// Settings file (update.json), read/modify/write while keeping unknown keys
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn data_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(UPDATE_FILE))
        .map_err(|_| "other".to_string())
}

fn read_obj(path: &Path) -> Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .filter(|s| s.len() as u64 <= MAX_JSON_BYTES)
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

fn write_obj(path: &Path, obj: &Map<String, Value>) -> Result<(), String> {
    if let Some(d) = path.parent() {
        fs::create_dir_all(d).map_err(|_| "other".to_string())?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(obj.clone())).map_err(|_| "other".to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|_| "other".to_string())?;
    fs::rename(&tmp, path).map_err(|_| "other".to_string())
}

fn mutate_prefs(app: &AppHandle, f: impl FnOnce(&mut Map<String, Value>)) -> Result<(), String> {
    let path = data_file(app)?;
    let mut obj = read_obj(&path);
    f(&mut obj);
    write_obj(&path, &obj)
}

/// Token from env first, then update.json. Never logged, never sent to the UI.
fn load_token(app: &AppHandle) -> Option<String> {
    let env = std::env::var("OMNICHAT_UPDATE_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    env.or_else(|| {
        let path = data_file(app).ok()?;
        read_obj(&path)
            .get("token")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

// ---------------------------------------------------------------------------
// Network (ureq, platform certificate verifier like the connect check)
// ---------------------------------------------------------------------------

fn api_base() -> String {
    std::env::var("OMNICHAT_UPDATE_API_BASE")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_API.to_string())
}

fn repo_name() -> Result<String, String> {
    let r = std::env::var("OMNICHAT_UPDATE_REPO")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_REPO.to_string());
    let parts: Vec<&str> = r.split('/').collect();
    let ok = parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        });
    if ok {
        Ok(r)
    } else {
        Err("bad-repo".to_string())
    }
}

/// Plain http is allowed only for loopback test servers.
fn is_local_host(base: &str) -> bool {
    url::Url::parse(base)
        .ok()
        .and_then(|u| u.host_str().map(|h| matches!(h, "127.0.0.1" | "localhost" | "[::1]")))
        .unwrap_or(false)
}

fn agent(https_only: bool, timeout: Duration) -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig};
    // Redirects: ureq never forwards the Authorization header on a redirect by default.
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .https_only(https_only)
        .max_redirects(5)
        .user_agent(format!("OmniChat-Desktop/{CURRENT}"))
        .timeout_global(Some(timeout))
        .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
        .build()
        .into()
}

/// Rate-limit related response headers (GitHub: X-RateLimit-*, secondary limits: Retry-After).
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct RateHeaders {
    pub remaining: Option<u64>,
    /// Unix seconds when the primary limit resets.
    pub reset: Option<u64>,
    /// Seconds to wait (Retry-After).
    pub retry_after: Option<u64>,
}

/// Why one HTTP attempt failed. `Transient` may be retried, `Fatal` never is.
#[derive(Debug, PartialEq)]
pub enum Failure {
    Transient(&'static str),
    Fatal(String),
}

/// Map a non-200 status to an error. 403 is a rate limit when the quota is exhausted or
/// Retry-After is present; 429 is always a rate limit. 5xx and network errors are transient.
pub fn classify_failure(status: u16, rate: RateHeaders, now_secs: u64) -> Failure {
    let limited = status == 429
        || (status == 403 && (rate.remaining == Some(0) || rate.retry_after.is_some()));
    if limited {
        let reset = rate.reset.or_else(|| rate.retry_after.map(|s| now_secs + s));
        return Failure::Fatal(match reset {
            Some(t) => format!("rate-limited:{t}"),
            None => "rate-limited".to_string(),
        });
    }
    match status {
        401 => Failure::Fatal("unauthorized".into()),
        403 => Failure::Fatal("forbidden".into()),
        404 => Failure::Fatal("not-found".into()),
        500..=599 => Failure::Transient("bad-response"),
        _ => Failure::Fatal("bad-response".into()),
    }
}

/// Seconds to wait before attempt `attempt + 1` (attempt 1 failed -> 2 s, attempt 2 failed -> 6 s).
/// None means no more attempts (at most 3 attempts in total).
pub fn retry_backoff_secs(attempt: u32) -> Option<u64> {
    match attempt {
        1 => Some(2),
        2 => Some(6),
        _ => None,
    }
}

fn rate_headers(h: &ureq::http::HeaderMap) -> RateHeaders {
    let num = |name: &str| h.get(name).and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok());
    RateHeaders {
        remaining: num("x-ratelimit-remaining"),
        reset: num("x-ratelimit-reset"),
        retry_after: num("retry-after"),
    }
}

/// Successful GET: a fresh body, or 304 Not Modified for a conditional request.
enum Got {
    Body(ureq::http::Response<ureq::Body>),
    NotModified,
}

fn send_once(
    url: &str,
    accept: &str,
    token: Option<&str>,
    etag: Option<&str>,
    https_only: bool,
    timeout: Duration,
) -> Result<Got, Failure> {
    let mut req = agent(https_only, timeout)
        .get(url)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    if let Some(e) = etag {
        req = req.header("If-None-Match", e);
    }
    let resp = req.call().map_err(|_| Failure::Transient("network"))?;
    let status = resp.status().as_u16();
    if status == 200 {
        return Ok(Got::Body(resp));
    }
    if status == 304 && etag.is_some() {
        return Ok(Got::NotModified);
    }
    let rate = rate_headers(resp.headers());
    Err(classify_failure(status, rate, now_ms() / 1000))
}

/// GET with optional Bearer token and optional If-None-Match. Up to 3 attempts for network
/// errors and 5xx (backoff 2 s, 6 s); 4xx is never retried.
fn send(
    url: &str,
    accept: &str,
    token: Option<&str>,
    etag: Option<&str>,
    https_only: bool,
    timeout: Duration,
) -> Result<Got, String> {
    let mut attempt = 1u32;
    loop {
        match send_once(url, accept, token, etag, https_only, timeout) {
            Ok(got) => return Ok(got),
            Err(Failure::Fatal(code)) => return Err(code),
            Err(Failure::Transient(code)) => match retry_backoff_secs(attempt) {
                Some(secs) => {
                    std::thread::sleep(Duration::from_secs(secs));
                    attempt += 1;
                }
                None => return Err(code.to_string()),
            },
        }
    }
}

fn body_of(got: Got) -> Result<ureq::http::Response<ureq::Body>, String> {
    match got {
        Got::Body(r) => Ok(r),
        Got::NotModified => Err("bad-response".into()),
    }
}

fn read_text(mut resp: ureq::http::Response<ureq::Body>, max: u64) -> Result<String, String> {
    resp.body_mut()
        .with_config()
        .limit(max)
        .read_to_string()
        .map_err(|_| "bad-response".to_string())
}

/// Release list: `GET {api}/repos/{repo}/releases?per_page=30`, conditional on the cached ETag
/// (stored in update.json as `releasesCache`). A 304 reuses the cached body.
fn fetch_releases(app: &AppHandle, base: &str, repo: &str, token: Option<&str>) -> Result<Vec<GhRelease>, String> {
    let url = format!("{base}/repos/{repo}/releases?per_page={RELEASES_PER_PAGE}");
    let path = data_file(app).ok();
    let cache = path.as_deref().map(|p| read_obj(p)).and_then(|o| o.get("releasesCache").and_then(Value::as_object).cloned());
    let cache = cache.filter(|c| c.get("url").and_then(Value::as_str) == Some(url.as_str()));
    let cached_etag = cache.as_ref().and_then(|c| c.get("etag").and_then(Value::as_str)).map(str::to_string);
    let cached_body = cache.as_ref().and_then(|c| c.get("body").and_then(Value::as_str)).map(str::to_string);
    let accept = "application/vnd.github+json";
    let https_only = !is_local_host(base);
    let timeout = Duration::from_secs(20);

    let got = send(&url, accept, token, cached_etag.as_deref(), https_only, timeout)?;
    let (text, etag) = match got {
        Got::NotModified => (cached_body.ok_or_else(|| "bad-response".to_string())?, cached_etag),
        Got::Body(resp) => {
            let etag = resp.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_string);
            (read_text(resp, MAX_JSON_BYTES)?, etag)
        }
    };
    let releases = serde_json::from_str::<Vec<GhRelease>>(&text).map_err(|_| "bad-response".to_string())?;
    if let (Some(etag), Some(p)) = (etag, path.as_deref()) {
        // Only a body that parsed is cached; cache errors are ignored (a fresh fetch still works).
        let mut obj = read_obj(p);
        obj.insert(
            "releasesCache".to_string(),
            serde_json::json!({ "url": url, "etag": etag, "body": text }),
        );
        let _ = write_obj(p, &obj);
    }
    Ok(releases)
}

/// Last check outcome in update.json (`lastCheck` epoch ms, `lastError` short code). Success clears the error.
fn record_check(app: &AppHandle, error: Option<&str>) {
    let _ = mutate_prefs(app, |obj| {
        obj.insert("lastCheck".to_string(), Value::from(now_ms()));
        match error {
            Some(code) => {
                obj.insert("lastError".to_string(), Value::String(code.to_string()));
            }
            None => {
                obj.remove("lastError");
            }
        }
    });
}

/// Download URL for an asset. With a token the API asset url is used (private repos); the token
/// is only sent to the API base host. Without a token the public browser URL is used.
fn asset_url(asset: &GhAsset, base: &str, token: Option<&str>) -> Result<(String, &'static str), String> {
    if token.is_some() {
        if asset.url.starts_with(&format!("{base}/")) {
            return Ok((asset.url.clone(), "application/octet-stream"));
        }
        return Err("unsupported".into());
    }
    if asset.browser_download_url.is_empty() {
        return Err("bad-response".into());
    }
    Ok((asset.browser_download_url.clone(), "application/octet-stream"))
}

fn fetch_asset_text(asset: &GhAsset, base: &str, token: Option<&str>, https_only: bool) -> Result<String, String> {
    let (url, accept) = asset_url(asset, base, token)?;
    let resp = body_of(send(&url, accept, token, None, https_only, Duration::from_secs(20))?)?;
    read_text(resp, MAX_TEXT_BYTES)
}

/// Stream the response into `dest.part` while hashing; rename to `dest` only when the size
/// (when known) and SHA-256 match. A mismatch deletes the partial file and nothing else.
fn download_verified(
    mut resp: ureq::http::Response<ureq::Body>,
    dest: &Path,
    expected_size: u64,
    expected_sha: &str,
) -> Result<(), String> {
    if let Some(len) = resp.body().content_length() {
        if len > MAX_INSTALLER_BYTES {
            return Err("download".into());
        }
    }
    let part = {
        let mut p = dest.as_os_str().to_owned();
        p.push(".part");
        PathBuf::from(p)
    };
    let mut file = File::create(&part).map_err(|_| "download".to_string())?;
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let streamed: Result<(), String> = {
        let mut reader = resp.body_mut().with_config().limit(MAX_INSTALLER_BYTES).reader();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break Ok(()),
                Ok(n) => {
                    total += n as u64;
                    hasher.update(&buf[..n]);
                    if file.write_all(&buf[..n]).is_err() {
                        break Err("download".to_string());
                    }
                }
                Err(_) => break Err("download".to_string()),
            }
        }
    };
    if let Err(e) = streamed {
        drop(file);
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    if file.sync_all().is_err() {
        drop(file);
        let _ = fs::remove_file(&part);
        return Err("download".into());
    }
    drop(file);
    if expected_size > 0 && total != expected_size {
        let _ = fs::remove_file(&part);
        return Err("download".into());
    }
    let got = to_hex(&hasher.finalize()[..]);
    if !got.eq_ignore_ascii_case(expected_sha) {
        let _ = fs::remove_file(&part);
        return Err("checksum-mismatch".into());
    }
    fs::rename(&part, dest).map_err(|_| "download".to_string())
}

// ---------------------------------------------------------------------------
// Offer (what the update window shows) and shared state
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Offer {
    pub version: String,
    pub notes: String,
    pub page_url: String,
    pub asset: GhAsset,
    pub sums: Option<GhAsset>,
    pub per_asset: Option<GhAsset>,
}

#[derive(Default)]
pub struct UpdateCtx {
    offer: Mutex<Option<Offer>>,
    busy: AtomicBool,
    /// A manual check is running (prevents overlapping manual checks).
    checking: AtomicBool,
}

fn current_offer(app: &AppHandle) -> Result<Offer, String> {
    let ctx = app.state::<UpdateCtx>();
    let guard = ctx.offer.lock().unwrap_or_else(|e| e.into_inner());
    guard.clone().ok_or_else(|| "no-offer".to_string())
}

fn current_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

// ---------------------------------------------------------------------------
// Background check and window
// ---------------------------------------------------------------------------

/// Start the background checks: the first one after 20 s (env OMNICHAT_UPDATE_DELAY_MS overrides),
/// then every 6 hours while the app runs.
pub fn spawn_check(app: AppHandle) {
    std::thread::spawn(move || {
        let delay = std::env::var("OMNICHAT_UPDATE_DELAY_MS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(FIRST_CHECK_DELAY_MS);
        std::thread::sleep(Duration::from_millis(delay));
        loop {
            let res = check_once(&app);
            // Background check: stay quiet for the user; the code never contains secrets.
            // The outcome is kept in update.json (shown by the update window), and a failure is retried sooner.
            let wait = match &res {
                Ok(()) => PERIODIC_CHECK_MS,
                Err(code) => {
                    eprintln!("omnichat update check skipped: {code}");
                    RETRY_AFTER_FAILURE_MS
                }
            };
            record_check(&app, res.as_ref().err().map(String::as_str));
            std::thread::sleep(Duration::from_millis(wait));
        }
    });
}

/// Fetch the releases and build the offer for the configured channel (None = nothing newer).
fn find_offer(app: &AppHandle, prefs: &Prefs) -> Result<Option<Offer>, String> {
    let base = api_base();
    let repo = repo_name()?;
    let token = load_token(app);
    let releases = fetch_releases(app, &base, &repo, token.as_deref())?;
    let Some(p) = pick_release(&releases, &prefs.channel, CURRENT, current_os()) else {
        return Ok(None);
    };
    let (sums, per_asset) = checksum_assets(&p.release.assets, &p.asset.name);
    Ok(Some(Offer {
        version: p.version.clone(),
        notes: truncate_chars(p.release.body.as_deref().unwrap_or("").replace('\r', "").trim(), NOTES_MAX_CHARS),
        page_url: p.release.html_url.clone(),
        asset: p.asset.clone(),
        sums,
        per_asset,
    }))
}

fn store_offer(app: &AppHandle, offer: Option<Offer>) {
    let ctx = app.state::<UpdateCtx>();
    *ctx.offer.lock().unwrap_or_else(|e| e.into_inner()) = offer;
}

/// Background check: respects "skip" and "remind later".
fn check_once(app: &AppHandle) -> Result<(), String> {
    let prefs = prefs_from(&read_obj(&data_file(app)?));
    let Some(offer) = find_offer(app, &prefs)? else {
        return Ok(());
    };
    if !should_prompt(&prefs.skipped, &prefs.remind_after, &offer.version, now_ms()) {
        return Ok(());
    }
    store_offer(app, Some(offer));
    open_window(app);
    Ok(())
}

/// Result of a manual check, handed to the settings page (camelCase JSON).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// "available" | "latest" | "error"
    pub status: &'static str,
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    pub channel: String,
    pub can_install: bool,
    /// Short error code (never contains the token).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CheckResult {
    fn base(status: &'static str, channel: &str) -> Self {
        CheckResult {
            status,
            current: CURRENT.to_string(),
            latest: None,
            channel: channel.to_string(),
            can_install: false,
            error: None,
        }
    }
    pub fn available(channel: &str, version: &str, can_install: bool) -> Self {
        CheckResult { latest: Some(version.to_string()), can_install, ..Self::base("available", channel) }
    }
    pub fn latest(channel: &str) -> Self {
        Self::base("latest", channel)
    }
    pub fn error(channel: &str, code: &str) -> Self {
        CheckResult { error: Some(code.to_string()), ..Self::base("error", channel) }
    }
}

/// True when the desktop shell can install this asset itself (Windows NSIS installer only).
fn can_install_asset(asset_name: &str) -> bool {
    cfg!(windows) && is_windows_installer(asset_name)
}

/// Manual check (settings page): no delay, ignores "skip" and "remind later". An available update opens the update window.
/// Always returns a result; failures are reported as status "error" with a short code.
pub fn check_now(app: &AppHandle) -> CheckResult {
    let ctx = app.state::<UpdateCtx>();
    let channel = get_channel(app);
    if ctx.checking.swap(true, AtomicOrdering::SeqCst) {
        return CheckResult::error(&channel, "busy");
    }
    let r = (|| -> Result<CheckResult, String> {
        let prefs = prefs_from(&read_obj(&data_file(app)?));
        Ok(match find_offer(app, &prefs)? {
            None => {
                store_offer(app, None);
                CheckResult::latest(&prefs.channel)
            }
            Some(o) => {
                let res = CheckResult::available(&prefs.channel, &o.version, can_install_asset(&o.asset.name));
                store_offer(app, Some(o));
                open_window(app);
                res
            }
        })
    })();
    ctx.checking.store(false, AtomicOrdering::SeqCst);
    let out = r.unwrap_or_else(|code| CheckResult::error(&channel, &code));
    record_check(app, out.error.as_deref());
    out
}

/// Last background or manual check error code, if the most recent check failed.
fn last_error(app: &AppHandle) -> Option<String> {
    data_file(app)
        .ok()
        .and_then(|p| read_obj(&p).get("lastError").and_then(Value::as_str).map(str::to_string))
}

/// Open (or focus) the update window for the current offer; without one, run a manual check.
pub fn open_update(app: &AppHandle) -> bool {
    let has = app.state::<UpdateCtx>().offer.lock().unwrap_or_else(|e| e.into_inner()).is_some();
    if has {
        open_window(app);
        true
    } else {
        let r = check_now(app);
        // Show the failure in the update window (persistent until the next successful check).
        if r.status == "error" && r.error.as_deref() != Some("busy") {
            open_window(app);
        }
        r.status == "available"
    }
}

/// Configured channel ("stable" | "prerelease"). Never exposes the token.
pub fn get_channel(app: &AppHandle) -> String {
    data_file(app).map(|p| prefs_from(&read_obj(&p)).channel).unwrap_or_else(|_| "stable".to_string())
}

/// Persist the channel; only the two known values are accepted. Drops the cached offer (it belonged to the old channel).
pub fn set_channel(app: &AppHandle, channel: &str) -> Result<String, String> {
    if !is_channel(channel) {
        return Err("bad-channel".into());
    }
    mutate_prefs(app, |obj| {
        obj.insert("channel".to_string(), Value::String(channel.to_string()));
    })?;
    store_offer(app, None);
    Ok(channel.to_string())
}

fn is_channel(s: &str) -> bool {
    matches!(s, "stable" | "prerelease")
}

/// A version with a pre-release part (contains a hyphen) is a prerelease.
pub fn is_prerelease_version(v: &str) -> bool {
    parse_version(v).is_some_and(|s| !s.pre.is_empty())
}

/// Create (or focus) the small update window. Window creation runs on the main thread.
fn open_window(app: &AppHandle) {
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = h.get_webview_window(UPDATE_WINDOW) {
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let built = WebviewWindowBuilder::new(&h, UPDATE_WINDOW, WebviewUrl::App("update.html".into()))
            .title("OmniChat")
            .inner_size(440.0, 300.0)
            .resizable(false)
            .center()
            .always_on_top(false)
            .build();
        if built.is_err() {
            eprintln!("omnichat update window could not be created");
        }
    });
}

fn close_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(UPDATE_WINDOW) {
        let _ = w.close();
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (callable only from the `update` window, see capabilities/update.json)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: String,
    pub can_install: bool,
    pub page_url: String,
    pub channel: String,
    pub prerelease: bool,
}

#[tauri::command]
pub fn update_info(app: AppHandle) -> Result<UpdateInfo, String> {
    let o = match current_offer(&app) {
        Ok(o) => o,
        // No offer because the last check failed: report that error instead of "no-offer".
        Err(code) => return Err(last_error(&app).unwrap_or(code)),
    };
    Ok(UpdateInfo {
        can_install: can_install_asset(&o.asset.name),
        channel: get_channel(&app),
        prerelease: is_prerelease_version(&o.version),
        version: o.version,
        current: CURRENT.to_string(),
        notes: o.notes,
        page_url: o.page_url,
    })
}

#[tauri::command]
pub fn update_skip(app: AppHandle) -> Result<(), String> {
    let o = current_offer(&app)?;
    let v = o.version;
    mutate_prefs(&app, |obj| {
        let entry = obj.entry("skipped").or_insert_with(|| Value::Array(Vec::new()));
        if !matches!(entry, Value::Array(_)) {
            *entry = Value::Array(Vec::new());
        }
        if let Value::Array(list) = entry {
            if !list.iter().any(|x| x.as_str() == Some(v.as_str())) {
                list.push(Value::String(v.clone()));
            }
        }
    })?;
    close_window(&app);
    Ok(())
}

#[tauri::command]
pub fn update_later(app: AppHandle) -> Result<(), String> {
    let o = current_offer(&app)?;
    let v = o.version;
    let until = now_ms() + REMIND_LATER_MS;
    mutate_prefs(&app, |obj| {
        let entry = obj.entry("remindAfter").or_insert_with(|| Value::Object(Map::new()));
        if !matches!(entry, Value::Object(_)) {
            *entry = Value::Object(Map::new());
        }
        if let Value::Object(m) = entry {
            m.insert(v.clone(), Value::from(until));
        }
    })?;
    close_window(&app);
    Ok(())
}

/// Download, verify and run the installer (Windows). Other platforms open the release page.
/// Async so the download does not block the UI thread.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(&app))
        .await
        .map_err(|_| "other".to_string())?
}

fn open_page(app: &AppHandle, url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("unsupported".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|_| "other".to_string())
}

fn install_blocking(app: &AppHandle) -> Result<(), String> {
    let o = current_offer(app)?;
    if !cfg!(windows) {
        return open_page(app, &o.page_url);
    }
    let ctx = app.state::<UpdateCtx>();
    if ctx.busy.swap(true, AtomicOrdering::SeqCst) {
        return Err("busy".into());
    }
    let r = install_windows(app, &o);
    ctx.busy.store(false, AtomicOrdering::SeqCst);
    r
}

#[cfg(not(windows))]
fn install_windows(_app: &AppHandle, _o: &Offer) -> Result<(), String> {
    Err("unsupported".into())
}

#[cfg(windows)]
fn install_windows(app: &AppHandle, o: &Offer) -> Result<(), String> {
    let base = api_base();
    let https_only = !is_local_host(&base);
    let token = load_token(app);
    let tok = token.as_deref();

    // Refuse without a checksum for this exact installer.
    let sums_text = match &o.sums {
        Some(a) => Some(fetch_asset_text(a, &base, tok, https_only)?),
        None => None,
    };
    let per_text = match &o.per_asset {
        Some(a) => Some(fetch_asset_text(a, &base, tok, https_only)?),
        None => None,
    };
    let expected = sum_for(&o.asset.name, sums_text.as_deref(), per_text.as_deref())
        .ok_or_else(|| "checksum-missing".to_string())?;

    let (url, accept) = asset_url(&o.asset, &base, tok)?;
    let dir = std::env::temp_dir().join(format!("omnichat-update-{}", o.version));
    fs::create_dir_all(&dir).map_err(|_| "download".to_string())?;
    let dest = dir.join(&o.asset.name);
    let resp = body_of(send(&url, accept, tok, None, https_only, Duration::from_secs(900))?)?;
    download_verified(resp, &dest, o.asset.size, &expected)?;

    let exe = std::env::current_exe().map_err(|_| "launch".to_string())?;
    launch_installer_helper(&dest, &exe)?;

    // Let the window receive the success reply, then quit so the installer can replace the files.
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1000));
        h.exit(0);
    });
    Ok(())
}

/// Detached PowerShell: wait until this process exits, run the NSIS installer silently (/S,
/// currentUser install), then start the app again when the install succeeded and the exe exists.
/// The script is passed as -EncodedCommand and paths via env vars, so no quoting is involved.
#[cfg(windows)]
fn launch_installer_helper(installer: &Path, exe: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const SCRIPT: &str = "$ErrorActionPreference = 'SilentlyContinue'\n\
        $p = Get-Process -Id ([int]$env:OMNI_UPD_PID) -ErrorAction SilentlyContinue\n\
        if ($p) { [void]$p.WaitForExit(120000) }\n\
        $i = Start-Process -FilePath $env:OMNI_UPD_INSTALLER -ArgumentList '/S' -Wait -PassThru\n\
        if ($i -and $i.ExitCode -eq 0 -and (Test-Path -LiteralPath $env:OMNI_UPD_EXE)) { Start-Process -FilePath $env:OMNI_UPD_EXE }\n";
    let utf16: Vec<u8> = SCRIPT.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = base64_encode(&utf16);
    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            &encoded,
        ])
        .env("OMNI_UPD_PID", std::process::id().to_string())
        .env("OMNI_UPD_INSTALLER", installer)
        .env("OMNI_UPD_EXE", exe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|_| "launch".to_string())
}

// ---------------------------------------------------------------------------
// Tests (pure functions only; no network, no installer)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GhAsset {
        GhAsset {
            name: name.to_string(),
            size: 0,
            url: format!("https://api.github.com/repos/x/y/releases/assets/{}", name.len()),
            browser_download_url: format!("https://github.com/x/y/releases/download/v/{name}"),
        }
    }

    fn release(tag: &str, draft: bool, pre: bool, assets: &[&str]) -> GhRelease {
        GhRelease {
            tag_name: tag.to_string(),
            body: Some(format!("notes {tag}")),
            draft,
            prerelease: pre,
            html_url: format!("https://github.com/x/y/releases/tag/{tag}"),
            assets: assets.iter().map(|n| asset(n)).collect(),
        }
    }

    #[test]
    fn semver_compare_table() {
        let lt = [
            ("1.0.0-alpha", "1.0.0-alpha.1"),
            ("1.0.0-alpha.1", "1.0.0-alpha.beta"),
            ("1.0.0-alpha.beta", "1.0.0-beta"),
            ("1.0.0-beta", "1.0.0-beta.2"),
            ("1.0.0-beta.2", "1.0.0-beta.11"),
            ("1.0.0-beta.11", "1.0.0-rc.1"),
            ("1.0.0-rc.1", "1.0.0"),
            ("1.0.0", "1.0.1"),
            ("1.9.0", "1.10.0"),
            ("0.9.9", "1.0.0"),
            ("1.0.0-1", "1.0.0-a"),
        ];
        for (a, b) in lt {
            let (x, y) = (parse_version(a).unwrap(), parse_version(b).unwrap());
            assert_eq!(compare_versions(&x, &y), Ordering::Less, "{a} < {b}");
            assert_eq!(compare_versions(&y, &x), Ordering::Greater, "{b} > {a}");
        }
        let eq = [("v1.2.3", "1.2.3"), ("1.0.0+abc", "1.0.0"), ("1.0.0+a-b", "1.0.0")];
        for (a, b) in eq {
            let (x, y) = (parse_version(a).unwrap(), parse_version(b).unwrap());
            assert_eq!(compare_versions(&x, &y), Ordering::Equal, "{a} == {b}");
        }
    }

    #[test]
    fn parse_rejects_invalid() {
        for s in ["", "1.0", "1.0.0.0", "a.b.c", "1.0.0-", "1.0.0-a..b", "1.0.0-a_b", "01.x.0", "v"] {
            assert!(parse_version(s).is_none(), "{s} should be invalid");
        }
        assert_eq!(parse_version("v1.2.3-rc.1").unwrap().to_string(), "1.2.3-rc.1");
    }

    #[test]
    fn is_newer_rules() {
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("0.9.0", "1.0.0"));
        assert!(!is_newer("1.0.0-rc.1", "1.0.0"));
        assert!(is_newer("1.0.0", "1.0.0-rc.1"));
        assert!(!is_newer("garbage", "1.0.0"));
    }

    #[test]
    fn pick_release_rules() {
        let rs = vec![
            release("v1.2.0", true, false, &["OmniChat_1.2.0_x64-setup.exe"]), // draft
            release("v1.1.0-rc.1", false, true, &["OmniChat_1.1.0-rc.1_x64-setup.exe"]), // prerelease
            release("v1.0.1", false, false, &["OmniChat Server_1.0.1_x64-setup.exe"]), // server only
            release("v1.0.0", false, false, &["OmniChat_1.0.0_x64-setup.exe"]),
            release("v0.9.0", false, false, &["OmniChat_0.9.0_x64-setup.exe"]),
        ];
        // stable: drafts, prereleases and server-only releases are ignored, 1.0.0 is not newer than 1.0.0
        assert!(pick_release(&rs, "stable", "1.0.0", "windows").is_none());
        // prerelease channel: 1.1.0-rc.1 is newer than 1.0.0
        let p = pick_release(&rs, "prerelease", "1.0.0", "windows").unwrap();
        assert_eq!(p.version, "1.1.0-rc.1");
        assert_eq!(p.asset.name, "OmniChat_1.1.0-rc.1_x64-setup.exe");
        // stable from 0.9.0 gets 1.0.0 (not the server-only 1.0.1, not the draft)
        let p = pick_release(&rs, "stable", "0.9.0", "windows").unwrap();
        assert_eq!(p.version, "1.0.0");
        assert_eq!(p.release.tag_name, "v1.0.0");
        // linux has no installer in these releases
        assert!(pick_release(&rs, "stable", "0.9.0", "linux").is_none());
    }

    #[test]
    fn pick_release_prefers_highest_numeric() {
        let rs = vec![
            release("v1.10.0", false, false, &["OmniChat_1.10.0_x64-setup.exe"]),
            release("v1.9.0", false, false, &["OmniChat_1.9.0_x64-setup.exe"]),
        ];
        let p = pick_release(&rs, "stable", "1.0.0", "windows").unwrap();
        assert_eq!(p.version, "1.10.0");
    }

    #[test]
    fn windows_installer_regex() {
        assert!(is_windows_installer("OmniChat_1.0.1_x64-setup.exe"));
        assert!(is_windows_installer("OmniChat_1.1.0-rc.1_x64-setup.exe"));
        assert!(!is_windows_installer("OmniChat Server_1.0.1_x64-setup.exe"));
        assert!(!is_windows_installer("omnichat_1.0.1_x64-setup.exe"));
        assert!(!is_windows_installer("OmniChat_1.0.1_arm64-setup.exe"));
        assert!(!is_windows_installer("OmniChat_1.0.1_x64-setup.exe.sig"));
        // the names the local build script publishes
        assert!(is_windows_installer("OmniChat-Desktop-v0.5.0-Windows-x64-Setup.exe"));
        assert!(is_windows_installer("OmniChat-Desktop-v0.5.0-beta.2-Windows-x64-Setup.exe"));
        assert!(!is_windows_installer("OmniChat-Desktop-Windows-x64-Setup.exe")); // version-less alias
        assert!(!is_windows_installer("OmniChat-Server-App-v0.5.0-Windows-x64-Setup.exe"));
        assert!(!is_windows_installer("OmniChat-Desktop-v0.5.0-Windows-x64.msi"));
        assert!(is_macos_package("OmniChat-Desktop-v0.5.0-macOS-universal.dmg"));
        assert!(!is_macos_package("OmniChat-Desktop-macOS-universal.dmg"));
        assert!(!is_windows_installer("OmniChat_x64-setup.exe"));
        assert!(!is_windows_installer("OmniChat__x64-setup.exe.zip"));
        assert!(!is_windows_installer("OmniChat_../evil_x64-setup.exe"));
        assert!(!is_windows_installer("OmniChat-Server-Setup-1.0.1.exe"));
    }

    #[test]
    fn checksum_asset_lookup() {
        let assets = vec![
            asset("OmniChat_1.0.1_x64-setup.exe"),
            asset("SHA256SUMS"),
            asset("OmniChat_1.0.1_x64-setup.exe.sha256"),
        ];
        let (s, p) = checksum_assets(&assets, "OmniChat_1.0.1_x64-setup.exe");
        assert_eq!(s.unwrap().name, "SHA256SUMS");
        assert_eq!(p.unwrap().name, "OmniChat_1.0.1_x64-setup.exe.sha256");
        let (s, p) = checksum_assets(&assets[..1], "OmniChat_1.0.1_x64-setup.exe");
        assert!(s.is_none() && p.is_none());
    }

    const H1: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const H2: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn parse_sums_lines() {
        let text = format!(
            "{H1}  OmniChat_1.0.1_x64-setup.exe\n\
             {H2} *OmniChat Server_1.0.1_x64-setup.exe\n\
             not-a-hash  foo\n\
             abcd  short\n\
             \n\
             {}  bad-hex-tail-{}\n",
            "G".repeat(64),
            "x"
        );
        let got = parse_sums(&text);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], (Some("OmniChat_1.0.1_x64-setup.exe".to_string()), H1.to_string()));
        assert_eq!(got[1].0.as_deref(), Some("OmniChat Server_1.0.1_x64-setup.exe"));
        // uppercase hex normalised
        let up = format!("{}  a.exe", H1.to_uppercase());
        assert_eq!(parse_sums(&up)[0].1, H1);
    }

    #[test]
    fn sum_for_selection() {
        let name = "OmniChat_1.0.1_x64-setup.exe";
        let sums = format!("{H1}  other.exe\n{H2}  {name}\n");
        assert_eq!(sum_for(name, Some(&sums), None).as_deref(), Some(H2));
        // SHA256SUMS without this name -> per-asset file used
        let per = format!("{H1}  {name}\n");
        assert_eq!(sum_for(name, Some(""), None), None);
        assert_eq!(sum_for(name, Some(&format!("{H2}  other.exe")), Some(&per)).as_deref(), Some(H1));
        // bare hash in the per-asset file
        assert_eq!(sum_for(name, None, Some(H2)).as_deref(), Some(H2));
        // per-asset file for a different name is not used
        assert_eq!(sum_for(name, None, Some(&format!("{H2}  another.exe"))), None);
        assert_eq!(sum_for(name, None, None), None);
    }

    #[test]
    fn prompt_rules() {
        let now = 1_000_000u64;
        let skipped = vec!["1.0.1".to_string()];
        let mut remind = HashMap::new();
        remind.insert("1.0.2".to_string(), now + 1);
        remind.insert("1.0.3".to_string(), now - 1);
        assert!(!should_prompt(&skipped, &remind, "1.0.1", now));
        assert!(!should_prompt(&skipped, &remind, "1.0.2", now));
        assert!(should_prompt(&skipped, &remind, "1.0.3", now));
        assert!(should_prompt(&skipped, &remind, "1.0.4", now));
    }

    #[test]
    fn prefs_defaults_and_normalisation() {
        let empty = Map::new();
        let p = prefs_from(&empty);
        assert_eq!(p.channel, "stable");
        assert!(p.skipped.is_empty() && p.remind_after.is_empty());
        let v: Value = serde_json::from_str(
            r#"{"channel":"prerelease","skipped":["v1.0.1",3],"remindAfter":{"v1.0.2":42,"x":"no"},"token":"t"}"#,
        )
        .unwrap();
        let p = prefs_from(v.as_object().unwrap());
        assert_eq!(p.channel, "prerelease");
        assert_eq!(p.skipped, vec!["1.0.1".to_string()]);
        assert_eq!(p.remind_after.get("1.0.2"), Some(&42));
        assert_eq!(p.remind_after.len(), 1);
        let bad: Value = serde_json::from_str(r#"{"channel":"nightly"}"#).unwrap();
        assert_eq!(prefs_from(bad.as_object().unwrap()).channel, "stable");
    }

    #[test]
    fn check_result_json_shape() {
        let a = serde_json::to_value(CheckResult::available("prerelease", "1.2.0-rc.1", true)).unwrap();
        assert_eq!(a["status"], "available");
        assert_eq!(a["latest"], "1.2.0-rc.1");
        assert_eq!(a["channel"], "prerelease");
        assert_eq!(a["canInstall"], true);
        assert_eq!(a["current"], CURRENT);
        assert!(a.get("error").is_none());
        let l = serde_json::to_value(CheckResult::latest("stable")).unwrap();
        assert_eq!(l["status"], "latest");
        assert!(l.get("latest").is_none() && l.get("error").is_none());
        assert_eq!(l["canInstall"], false);
        let e = serde_json::to_value(CheckResult::error("stable", "network")).unwrap();
        assert_eq!(e["status"], "error");
        assert_eq!(e["error"], "network");
    }

    #[test]
    fn channel_and_prerelease_helpers() {
        assert!(is_channel("stable") && is_channel("prerelease"));
        assert!(!is_channel("nightly") && !is_channel(""));
        assert!(is_prerelease_version("0.4.0-beta.2"));
        assert!(is_prerelease_version("v1.0.0-rc.1"));
        assert!(!is_prerelease_version("1.0.0"));
        assert!(!is_prerelease_version("garbage-x"));
        assert!(can_install_asset("OmniChat_1.0.0_x64-setup.exe") == cfg!(windows));
        assert!(!can_install_asset("OmniChat_1.0.0_amd64.deb"));
    }

    #[test]
    fn sha256_vectors() {
        assert_eq!(sha256_hex(b""), H1);
        assert_eq!(sha256_hex(b"abc"), H2);
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        let million = vec![b'a'; 1_000_000];
        assert_eq!(
            sha256_hex(&million),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn base64_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"M"), "TQ==");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"hello world"), "aGVsbG8gd29ybGQ=");
    }

    #[test]
    fn truncate_is_char_safe() {
        assert_eq!(truncate_chars("日本語テキスト", 3), "日本語");
        assert_eq!(truncate_chars("abc", 10), "abc");
    }
}

#[cfg(test)]
mod network_policy_tests {
    use super::*;

    fn none() -> RateHeaders {
        RateHeaders::default()
    }

    #[test]
    fn exhausted_quota_is_rate_limited_with_reset() {
        let rate = RateHeaders { remaining: Some(0), reset: Some(1_700_000_000), retry_after: None };
        assert_eq!(classify_failure(403, rate, 1), Failure::Fatal("rate-limited:1700000000".into()));
    }

    #[test]
    fn retry_after_is_rate_limited_and_uses_now_plus_wait() {
        let rate = RateHeaders { retry_after: Some(60), ..none() };
        assert_eq!(classify_failure(403, rate, 1_000), Failure::Fatal("rate-limited:1060".into()));
        assert_eq!(classify_failure(429, rate, 1_000), Failure::Fatal("rate-limited:1060".into()));
    }

    #[test]
    fn plain_429_without_headers_is_rate_limited() {
        assert_eq!(classify_failure(429, none(), 0), Failure::Fatal("rate-limited".into()));
    }

    #[test]
    fn plain_403_stays_forbidden_when_quota_remains() {
        let rate = RateHeaders { remaining: Some(42), reset: None, retry_after: None };
        assert_eq!(classify_failure(403, rate, 0), Failure::Fatal("forbidden".into()));
        assert_eq!(classify_failure(403, none(), 0), Failure::Fatal("forbidden".into()));
    }

    #[test]
    fn not_found_maps_to_not_found_and_never_retries() {
        assert_eq!(classify_failure(404, none(), 0), Failure::Fatal("not-found".into()));
        assert_eq!(classify_failure(401, none(), 0), Failure::Fatal("unauthorized".into()));
        assert_eq!(classify_failure(422, none(), 0), Failure::Fatal("bad-response".into()));
    }

    #[test]
    fn server_errors_are_transient() {
        assert_eq!(classify_failure(502, none(), 0), Failure::Transient("bad-response"));
        assert_eq!(classify_failure(503, none(), 0), Failure::Transient("bad-response"));
    }

    #[test]
    fn backoff_is_two_then_six_seconds_then_stop() {
        assert_eq!(retry_backoff_secs(1), Some(2));
        assert_eq!(retry_backoff_secs(2), Some(6));
        assert_eq!(retry_backoff_secs(3), None);
    }
}
