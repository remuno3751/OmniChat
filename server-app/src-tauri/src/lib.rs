//! OmniChat Server: a desktop app that runs the OmniChat server (bundled Node + server build) as a child process and
//! manages it: start/stop, logs, settings (config.env) and accounts (through the server's loopback-only
//! /local-admin API, authenticated by DATA_DIR/local-admin.token).
//!
//! The webview only ever shows the bundled local UI (../ui); it talks to this file through the commands below.

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_opener::OpenerExt;

mod autostart;
mod background;
mod extra;
mod jobobj;
mod sysinfo;

const MAIN: &str = "main";
const LOG_CAP: usize = 2000;
const DEFAULT_PORT: u16 = 8787;

/// Keys in config.env that must never reach the server's environment (they would let a config edit run code).
const DENIED_ENV: &[&str] = &[
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "SYSTEMROOT",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
];

// ---------------------------------------------------------------------------------------------------------------
// state

#[derive(Default)]
struct Ctx {
    child: Mutex<Option<Child>>,
    logs: Arc<Mutex<VecDeque<String>>>,
    last_error: Mutex<Option<String>>,
    quitting: Mutex<bool>,
    /// false when the tray icon could not be created (e.g. libayatana-appindicator3 missing on Linux): closing the window then quits.
    tray_ok: Mutex<bool>,
    /// set by stop() (user pressed stop / restart); cleared by start(). A stopped server is never auto-restarted.
    stopping: Mutex<bool>,
    /// exit code of the last server child that running() reaped (None when it was killed by a signal).
    last_exit_code: Mutex<Option<i32>>,
    /// the disabled status line at the top of the tray menu (updated by spawn_tray_status)
    tray_status: Mutex<Option<MenuItem<Wry>>>,
    /// held for the whole of start(): the monitor, the tray, the setup hook and the UI can all ask for a start at once,
    /// and two of them past the running() check would start two servers (the second one lands on the fallback port)
    start_lock: Mutex<()>,
}

/// Exit code the server uses to ask its supervisor for a restart (see server/src/updater/restart.ts).
const RESTART_EXIT_CODE: i32 = 75;
/// Loop guard: at most this many automatic restarts within RESTART_WINDOW.
const MAX_RESTARTS: usize = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(120);

/// Pure decision used by the monitor thread: restart only after an exit with code 75 that was not caused by
/// the user (stop/quit) and only while the loop guard allows it.
fn should_restart(code: Option<i32>, stopping: bool, quitting: bool, recent: usize) -> bool {
    code == Some(RESTART_EXIT_CODE) && !stopping && !quitting && recent < MAX_RESTARTS
}

struct Paths {
    server_dir: PathBuf,
    data_dir: PathBuf,
    config: PathBuf,
}

fn paths(app: &AppHandle) -> Result<Paths, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let server_dir = match std::env::var_os("OMNICHAT_SERVER_DIR") {
        Some(p) => PathBuf::from(p),
        None => app.path().resource_dir().map_err(|e| e.to_string())?.join("server"),
    };
    Ok(Paths { server_dir, data_dir: base.join("data"), config: base.join("config.env") })
}

fn push_log(logs: &Arc<Mutex<VecDeque<String>>>, line: String) {
    let mut l = logs.lock().unwrap();
    if l.len() >= LOG_CAP {
        l.pop_front();
    }
    l.push_back(line);
}

// ---------------------------------------------------------------------------------------------------------------
// config.env (KEY=VALUE lines; no quoting, no expansion: the same format the installers and run scripts read)

fn read_config(path: &Path) -> Vec<(String, String)> {
    let Ok(text) = fs::read_to_string(path) else { return Vec::new() };
    let text = text.trim_start_matches('\u{feff}'); // Windows editors (Notepad) may save a UTF-8 BOM
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        let Some((k, v)) = line.split_once('=') else { continue };
        let ok = !k.is_empty()
            && !k.starts_with(|c: char| c.is_ascii_digit())
            && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if ok {
            out.push((k.to_string(), v.to_string()));
        }
    }
    out
}

fn cfg_get(cfg: &[(String, String)], key: &str) -> Option<String> {
    cfg.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

/// Replace (or append) the given keys while keeping every other line, comment and blank line as it was.
fn write_config(path: &Path, updates: &[(&str, String)]) -> Result<(), String> {
    let existing = fs::read_to_string(path).unwrap_or_default();
    let existing = existing.trim_start_matches('\u{feff}').to_string();
    let mut lines: Vec<String> = existing.lines().map(|l| l.trim_end_matches('\r').to_string()).collect();
    for (key, value) in updates {
        let prefix = format!("{key}=");
        let new_line = format!("{key}={value}");
        let mut found = false;
        for l in lines.iter_mut() {
            if l.starts_with(&prefix) {
                *l = new_line.clone();
                found = true;
            }
        }
        if !found {
            lines.push(new_line);
        }
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("env.tmp");
    fs::write(&tmp, lines.join("\n") + "\n").map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn ensure_default_config(p: &Paths) -> Result<(), String> {
    if p.config.exists() {
        return Ok(());
    }
    write_config(
        &p.config,
        &[
            ("PORT", DEFAULT_PORT.to_string()),
            ("HOST", "0.0.0.0".into()),
            ("ALLOW_REGISTRATION", "0".into()),
        ],
    )
}

fn port_of(cfg: &[(String, String)]) -> u16 {
    cfg_get(cfg, "PORT").and_then(|v| v.trim().parse().ok()).filter(|p| *p >= 1).unwrap_or(DEFAULT_PORT)
}

/// Port the running server actually listens on when the configured one was busy at start (0 = none, use the config).
static FALLBACK_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

/// The port to talk to: the fallback port while a server started on one is running, else the configured port.
fn effective_port(app: &AppHandle, cfg: &[(String, String)]) -> u16 {
    let fb = FALLBACK_PORT.load(std::sync::atomic::Ordering::Relaxed);
    if fb != 0 && running(&app.state::<Ctx>()).is_some() {
        fb
    } else {
        port_of(cfg)
    }
}

/// True when nothing else can listen on this port (bind fails) or an HTTP server already answers there.
fn port_busy(port: u16, host: &str) -> bool {
    let addr = if host == "127.0.0.1" { "127.0.0.1" } else { "0.0.0.0" };
    std::net::TcpListener::bind((addr, port)).is_err() || healthy(port)
}

/// First free port after `from` (up to 100 tries), or None.
fn find_free_port(from: u16, host: &str) -> Option<u16> {
    (1..=100u16).filter_map(|i| from.checked_add(i)).find(|p| !port_busy(*p, host))
}

fn is_safe_value(v: &str) -> bool {
    !v.contains(['\n', '\r', '"', '\'', '#', '=']) && v.len() <= 500
}

// ---------------------------------------------------------------------------------------------------------------
// local admin API client (loopback only; the token file is written by the server at every start)

fn agent() -> ureq::Agent {
    agent_secs(8)
}

fn agent_secs(secs: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(secs)))
        .build()
        .into()
}

fn read_token(p: &Paths) -> Result<String, String> {
    let t = fs::read_to_string(p.data_dir.join("local-admin.token")).map_err(|_| "サーバーが起動していません(管理用トークンがありません)".to_string())?;
    Ok(t.trim().to_string())
}

fn admin_call(app: &AppHandle, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    admin_call_secs(app, method, path, body, 8)
}

fn admin_call_secs(app: &AppHandle, method: &str, path: &str, body: Option<Value>, secs: u64) -> Result<Value, String> {
    let p = paths(app)?;
    let cfg = read_config(&p.config);
    let url = format!("http://127.0.0.1:{}{}", effective_port(app, &cfg), path);
    let token = read_token(&p)?;
    let ag = agent_secs(secs);
    let resp = match (method, body) {
        ("GET", _) => ag.get(&url).header("x-local-admin", &token).call(),
        ("POST", Some(b)) => ag.post(&url).header("x-local-admin", &token).send_json(b),
        ("PATCH", Some(b)) => ag.patch(&url).header("x-local-admin", &token).send_json(b),
        ("PUT", Some(b)) => ag.put(&url).header("x-local-admin", &token).send_json(b),
        ("DELETE", _) => ag.delete(&url).header("x-local-admin", &token).call(),
        _ => return Err("bad request".into()),
    };
    let mut resp = resp.map_err(|e| format!("サーバーに接続できません: {e}"))?;
    let status = resp.status().as_u16();
    let v: Value = resp.body_mut().read_json().unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        Ok(v)
    } else {
        Err(v.get("error").and_then(|e| e.as_str()).map(String::from).unwrap_or_else(|| format!("HTTP {status}")))
    }
}

fn healthy(port: u16) -> bool {
    agent().get(&format!("http://127.0.0.1:{port}/healthz")).call().map(|r| r.status().as_u16() == 200).unwrap_or(false)
}

// ---------------------------------------------------------------------------------------------------------------
// server process

fn running(ctx: &Ctx) -> Option<u32> {
    let mut g = ctx.child.lock().unwrap();
    match g.as_mut() {
        Some(c) => match c.try_wait() {
            Ok(None) => Some(c.id()),
            Ok(Some(status)) => {
                *ctx.last_exit_code.lock().unwrap() = status.code();
                *g = None;
                None
            }
            Err(_) => {
                *g = None;
                None
            }
        },
        None => None,
    }
}

/// Watches the server child. When it exits with RESTART_EXIT_CODE (an update was applied and the server asks to be
/// started again), starts it again after a short pause. Stops restarting after MAX_RESTARTS within RESTART_WINDOW.
fn spawn_monitor(app: AppHandle) {
    std::thread::spawn(move || {
        let mut was_running = false;
        let mut recent: VecDeque<Instant> = VecDeque::new();
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let ctx = app.state::<Ctx>();
            if running(&ctx).is_some() {
                was_running = true;
                continue;
            }
            // a server that exits with 75 while start() is still waiting for it (e.g. a rollback right at boot) was
            // consumed by start()'s own running() poll: its exit code is still pending, so handle that case too
            let pending = ctx.last_exit_code.lock().unwrap().is_some();
            if !was_running && !pending {
                continue;
            }
            // the server went away since the last tick: take its exit code (only once) and decide
            was_running = false;
            let code = ctx.last_exit_code.lock().unwrap().take();
            let stopping = *ctx.stopping.lock().unwrap();
            let quitting = *ctx.quitting.lock().unwrap();
            let now = Instant::now();
            while recent.front().is_some_and(|t| now.duration_since(*t) > RESTART_WINDOW) {
                recent.pop_front();
            }
            if should_restart(code, stopping, quitting, recent.len()) {
                recent.push_back(now);
                push_log(&ctx.logs, "--- 更新のためサーバーを再起動します ---".into());
                std::thread::sleep(Duration::from_secs(1));
                if let Err(e) = start(&app) {
                    push_log(&ctx.logs, format!("(再起動に失敗しました: {e})"));
                }
            }
        }
    });
}

/// Keeps the tray status line and tooltip in step with the server. Checked every 2 s; the menu and tooltip are only
/// touched when the text actually changed.
fn spawn_tray_status(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: (String, String) = (String::new(), String::new());
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let ctx = app.state::<Ctx>();
            let up = running(&ctx).is_some();
            let port = paths(&app).map(|p| effective_port(&app, &read_config(&p.config))).unwrap_or(DEFAULT_PORT);
            let ip = if up { lan_ip() } else { None };
            let texts = (background::tray_status_text(up, ip.as_deref(), port), background::tray_tooltip(up, port));
            if texts == last {
                continue;
            }
            if let Some(item) = ctx.tray_status.lock().unwrap().as_ref() {
                let _ = item.set_text(&texts.0);
            }
            if let Some(tray) = app.tray_by_id("main-tray") {
                let _ = tray.set_tooltip(Some(texts.1.as_str()));
            }
            last = texts;
        }
    });
}

fn pump<R: Read + Send + 'static>(r: R, logs: Arc<Mutex<VecDeque<String>>>) {
    std::thread::spawn(move || {
        for line in BufReader::new(r).lines().map_while(Result::ok) {
            push_log(&logs, line);
        }
    });
}

fn start(app: &AppHandle) -> Result<(), String> {
    let ctx = app.state::<Ctx>();
    let _starting = ctx.start_lock.lock().unwrap_or_else(|e| e.into_inner());
    if running(&ctx).is_some() {
        return Ok(());
    }
    *ctx.last_error.lock().unwrap() = None;
    *ctx.stopping.lock().unwrap() = false;
    let p = paths(app)?;
    ensure_default_config(&p)?;
    fs::create_dir_all(&p.data_dir).map_err(|e| e.to_string())?;
    if !p.server_dir.join("dist").join("index.js").exists() {
        let e = format!("サーバー本体が見つかりません: {}", p.server_dir.display());
        *ctx.last_error.lock().unwrap() = Some(e.clone());
        return Err(e);
    }
    // boot.js picks the bundle to run (an update may have staged a newer one); old bundles without it still start
    let entry = if p.server_dir.join("dist").join("boot.js").exists() { "dist/boot.js" } else { "dist/index.js" };
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = p.server_dir.join("runtime").join(node_name);
    let node: PathBuf = if bundled.exists() { bundled } else { PathBuf::from(node_name) };

    let cfg = read_config(&p.config);
    let configured = port_of(&cfg);
    let host = cfg_get(&cfg, "HOST").unwrap_or_else(|| "0.0.0.0".into());
    let mut port = configured;
    if healthy(port) {
        // a server left behind by a previous run of this app that was killed (crash, logout, task manager)?
        reap_stale(app, &p, port);
    }
    FALLBACK_PORT.store(0, std::sync::atomic::Ordering::Relaxed);
    if port_busy(port, &host) {
        // another program owns the configured port: start on the next free one instead of failing, so the admin UI
        // stays reachable and the port can then be changed in the settings
        let Some(free) = find_free_port(configured, &host) else {
            let e = format!("ポート {configured} は既に別のプログラムが使っており、空きポートも見つかりません");
            *ctx.last_error.lock().unwrap() = Some(e.clone());
            return Err(e);
        };
        push_log(&ctx.logs, format!("--- ポート {configured} は使用中のため、一時的にポート {free} で起動します ---"));
        port = free;
        FALLBACK_PORT.store(free, std::sync::atomic::Ordering::Relaxed);
    }

    let mut cmd = Command::new(&node);
    cmd.arg(entry).current_dir(&p.server_dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in &cfg {
        if !DENIED_ENV.iter().any(|d| d.eq_ignore_ascii_case(k)) {
            cmd.env(k, v);
        }
    }
    cmd.env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .env("DATA_DIR", &p.data_dir)
        .env("WEB_DIR", p.server_dir.join("web"))
        .env("OMNICHAT_INSTALL_TYPE", "server-app")
        .env("OMNICHAT_UPDATE_CHECK_HOURS", "0")
        .env("OMNICHAT_SUPERVISED", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| {
        let m = format!("サーバーを起動できません ({}): {e}", node.display());
        *ctx.last_error.lock().unwrap() = Some(m.clone());
        m
    })?;
    // the server dies with this app process (Windows Job Object); a failure here is harmless
    jobobj::assign_to_kill_on_close_job(&child);
    if let Some(o) = child.stdout.take() {
        pump(o, ctx.logs.clone());
    }
    if let Some(e) = child.stderr.take() {
        pump(e, ctx.logs.clone());
    }
    push_log(&ctx.logs, format!("--- サーバーを起動します (port {port}) ---"));
    let _ = fs::write(pid_file(&p), child.id().to_string());
    *ctx.last_exit_code.lock().unwrap() = None;
    *ctx.child.lock().unwrap() = Some(child);

    // wait until it answers (or dies)
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if running(&ctx).is_none() {
            let m = "サーバーが起動直後に終了しました。ログを確認してください".to_string();
            *ctx.last_error.lock().unwrap() = Some(m.clone());
            return Err(m);
        }
        if healthy(port) {
            return Ok(());
        }
        if Instant::now() > deadline {
            let m = "サーバーの起動がタイムアウトしました。ログを確認してください".to_string();
            *ctx.last_error.lock().unwrap() = Some(m.clone());
            return Err(m);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn pid_file(p: &Paths) -> PathBuf {
    p.data_dir.parent().unwrap_or(&p.data_dir).join("server.pid")
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    let _ = Command::new("kill").arg(pid.to_string()).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// Stops a server that this app started earlier and lost track of. Only the pid recorded in server.pid is touched,
/// and only while the port still answers; returns true when the port is free again.
fn reap_stale(app: &AppHandle, p: &Paths, port: u16) -> bool {
    let Some(pid) = fs::read_to_string(pid_file(p)).ok().and_then(|s| s.trim().parse::<u32>().ok()) else { return false };
    // our own server answers the local admin API with the token it wrote into our data directory
    if admin_call(app, "GET", "/local-admin/status", None).is_err() {
        return false;
    }
    push_log(&app.state::<Ctx>().logs, format!("--- 前回の終了時に残ったサーバー (pid {pid}) を停止します ---"));
    kill_pid(pid);
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if !healthy(port) {
            let _ = fs::remove_file(pid_file(p));
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn stop(app: &AppHandle) {
    let ctx = app.state::<Ctx>();
    *ctx.stopping.lock().unwrap() = true;
    *ctx.last_exit_code.lock().unwrap() = None;
    if let Ok(p) = paths(app) {
        let _ = fs::remove_file(pid_file(&p));
    }
    let child = ctx.child.lock().unwrap().take();
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
        push_log(&ctx.logs, "--- サーバーを停止しました ---".into());
    }
}

// ---------------------------------------------------------------------------------------------------------------
// commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateOut {
    running: bool,
    pid: Option<u32>,
    port: u16,
    /// the port from the settings; differs from `port` while the server runs on a fallback port
    configured_port: u16,
    port_fallback: bool,
    host: String,
    data_dir: String,
    config_path: String,
    version: String,
    user_count: Option<u64>,
    autostart: bool,
    lan_urls: Vec<String>,
    error: Option<String>,
}

fn lan_ip() -> Option<String> {
    // connecting a UDP socket sends nothing; it only makes the OS pick the outgoing interface
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

fn state(app: &AppHandle) -> Result<StateOut, String> {
    let ctx = app.state::<Ctx>();
    let p = paths(app)?;
    let cfg = read_config(&p.config);
    let configured_port = port_of(&cfg);
    let port = effective_port(app, &cfg);
    let host = cfg_get(&cfg, "HOST").unwrap_or_else(|| "0.0.0.0".into());
    let pid = running(&ctx);
    let user_count = if pid.is_some() {
        admin_call(app, "GET", "/local-admin/status", None).ok().and_then(|v| v.get("users").and_then(|u| u.as_u64()))
    } else {
        None
    };
    let lan_urls = if pid.is_some() && host != "127.0.0.1" {
        lan_ip().map(|ip| vec![format!("http://{ip}:{port}/")]).unwrap_or_default()
    } else {
        Vec::new()
    };
    let version = fs::read_to_string(p.server_dir.join("VERSION")).map(|s| s.trim().to_string()).unwrap_or_default();
    let error = ctx.last_error.lock().unwrap().clone();
    Ok(StateOut {
        running: pid.is_some(),
        pid,
        port,
        configured_port,
        port_fallback: pid.is_some() && port != configured_port,
        host,
        data_dir: p.data_dir.display().to_string(),
        config_path: p.config.display().to_string(),
        version,
        user_count,
        autostart: autostart::is_enabled(app),
        lan_urls,
        error,
    })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_state(app: AppHandle) -> Result<StateOut, String> {
    blocking(move || state(&app)).await
}

#[tauri::command]
async fn start_server(app: AppHandle) -> Result<StateOut, String> {
    blocking(move || {
        let r = start(&app);
        let s = state(&app)?;
        r.map(|_| s)
    })
    .await
}

#[tauri::command]
async fn stop_server(app: AppHandle) -> Result<StateOut, String> {
    blocking(move || {
        stop(&app);
        state(&app)
    })
    .await
}

#[tauri::command]
async fn restart_server(app: AppHandle) -> Result<StateOut, String> {
    blocking(move || {
        stop(&app);
        let r = start(&app);
        let s = state(&app)?;
        r.map(|_| s)
    })
    .await
}

#[tauri::command]
fn get_logs(app: AppHandle, limit: Option<usize>) -> Vec<String> {
    let ctx = app.state::<Ctx>();
    let l = ctx.logs.lock().unwrap();
    let n = limit.unwrap_or(500).min(LOG_CAP);
    l.iter().skip(l.len().saturating_sub(n)).cloned().collect()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigData {
    port: u16,
    host: String,
    allow_registration: bool,
    searxng_url: String,
}

#[tauri::command]
fn get_config(app: AppHandle) -> Result<ConfigData, String> {
    let p = paths(&app)?;
    ensure_default_config(&p)?;
    let cfg = read_config(&p.config);
    Ok(ConfigData {
        port: port_of(&cfg),
        host: cfg_get(&cfg, "HOST").filter(|h| h == "127.0.0.1").unwrap_or_else(|| "0.0.0.0".into()),
        allow_registration: matches!(cfg_get(&cfg, "ALLOW_REGISTRATION").as_deref(), Some("1") | Some("true")),
        searxng_url: cfg_get(&cfg, "SEARXNG_URL").unwrap_or_default(),
    })
}

#[tauri::command]
fn set_config(app: AppHandle, port: u16, host: String, allow_registration: bool, searxng_url: String) -> Result<Value, String> {
    if port < 1 {
        return Err("ポートは 1〜65535 で指定してください".into());
    }
    if host != "0.0.0.0" && host != "127.0.0.1" {
        return Err("host が不正です".into());
    }
    let searxng = searxng_url.trim().to_string();
    if !searxng.is_empty() && !(is_safe_value(&searxng) && (searxng.starts_with("http://") || searxng.starts_with("https://")) && !searxng.contains(char::is_whitespace)) {
        return Err("SearXNG の URL は http:// または https:// で始め、空白や引用符を含めないでください".into());
    }
    let p = paths(&app)?;
    ensure_default_config(&p)?;
    let before = read_config(&p.config);
    write_config(
        &p.config,
        &[
            ("PORT", port.to_string()),
            ("HOST", host.clone()),
            ("ALLOW_REGISTRATION", if allow_registration { "1" } else { "0" }.into()),
            ("SEARXNG_URL", searxng.clone()),
        ],
    )?;
    let changed = port_of(&before) != port
        || cfg_get(&before, "HOST").unwrap_or_else(|| "0.0.0.0".into()) != host
        || matches!(cfg_get(&before, "ALLOW_REGISTRATION").as_deref(), Some("1") | Some("true")) != allow_registration
        || cfg_get(&before, "SEARXNG_URL").unwrap_or_default() != searxng;
    let ctx = app.state::<Ctx>();
    Ok(json!({ "restartRequired": changed && running(&ctx).is_some() }))
}

#[tauri::command]
async fn list_users(app: AppHandle) -> Result<Value, String> {
    blocking(move || admin_call(&app, "GET", "/local-admin/users", None).map(|v| if v.is_array() { json!({ "users": v }) } else { v })).await
}

#[tauri::command]
async fn create_user(app: AppHandle, username: String, password: String, role: String) -> Result<(), String> {
    blocking(move || admin_call(&app, "POST", "/local-admin/users", Some(json!({ "username": username, "password": password, "role": role }))).map(|_| ())).await
}

#[tauri::command]
async fn set_role(app: AppHandle, id: String, role: String) -> Result<(), String> {
    blocking(move || admin_call(&app, "PATCH", &format!("/local-admin/users/{}", url_safe(&id)?), Some(json!({ "role": role }))).map(|_| ())).await
}

#[tauri::command]
async fn set_disabled(app: AppHandle, id: String, disabled: bool) -> Result<(), String> {
    blocking(move || admin_call(&app, "PATCH", &format!("/local-admin/users/{}", url_safe(&id)?), Some(json!({ "disabled": disabled }))).map(|_| ())).await
}

#[tauri::command]
async fn set_password(app: AppHandle, id: String, password: String) -> Result<(), String> {
    blocking(move || admin_call(&app, "POST", &format!("/local-admin/users/{}/password", url_safe(&id)?), Some(json!({ "password": password }))).map(|_| ())).await
}

/// Web search settings live in the server's database (PROTOCOL-v6.md 1.1b); the server must be running. API keys are
/// only ever sent to the server, never returned by it.
#[tauri::command]
async fn get_search_config(app: AppHandle) -> Result<Value, String> {
    blocking(move || admin_call(&app, "GET", "/local-admin/search/config", None)).await
}

#[tauri::command]
async fn set_search_config(app: AppHandle, config: Value) -> Result<Value, String> {
    if !config.is_object() {
        return Err("設定が不正です".into());
    }
    blocking(move || admin_call(&app, "PUT", "/local-admin/search/config", Some(config))).await
}

#[tauri::command]
async fn search_test(app: AppHandle, query: String, mode: Option<String>) -> Result<Value, String> {
    let mut body = json!({ "query": query });
    if let Some(m) = mode {
        body["mode"] = json!(m);
    }
    blocking(move || admin_call_secs(&app, "POST", "/local-admin/search/test", Some(body), 40)).await
}

/// User ids are UUIDs; refuse anything else so a value can never alter the request path.
fn url_safe(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(id)
    } else {
        Err("不正なユーザー ID です".into())
    }
}

#[tauri::command]
fn open_web_ui(app: AppHandle) -> Result<(), String> {
    let p = paths(&app)?;
    let port = effective_port(&app, &read_config(&p.config));
    app.opener().open_url(format!("http://127.0.0.1:{port}/"), None::<&str>).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------------------------
// window, tray, lifecycle

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn quit(app: &AppHandle) {
    *app.state::<Ctx>().quitting.lock().unwrap() = true;
    stop(app);
    app.exit(0);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "ウィンドウを開く").build(app)?;
    let status = MenuItemBuilder::with_id("status", "停止中").enabled(false).build(app)?;
    let restart = MenuItemBuilder::with_id("restart", "サーバーを再起動").build(app)?;
    let web = MenuItemBuilder::with_id("web", "Web 画面を開く").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "終了(サーバーも停止)").build(app)?;
    let menu = MenuBuilder::new(app).item(&open).item(&status).separator().item(&restart).item(&web).item(&quit_item).build()?;
    *app.state::<Ctx>().tray_status.lock().unwrap() = Some(status);
    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("OmniChat Server")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => show_main(app),
            "restart" => {
                let app = app.clone();
                std::thread::spawn(move || {
                    stop(&app);
                    let _ = start(&app);
                });
            }
            "web" => {
                let _ = open_web_ui(app.clone());
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        // VISIBLE is left out: a window restored as visible would ignore the background start decision
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .manage(Ctx::default())
        .invoke_handler(tauri::generate_handler![
            get_state,
            start_server,
            stop_server,
            restart_server,
            get_logs,
            get_config,
            set_config,
            list_users,
            create_user,
            set_role,
            set_disabled,
            set_password,
            autostart::autostart_get,
            autostart::autostart_set,
            background::background_get,
            background::background_set,
            sysinfo::network_info,
            sysinfo::open_folder,
            sysinfo::setup_done_get,
            sysinfo::setup_done_set,
            get_search_config,
            set_search_config,
            search_test,
            open_web_ui,
            extra::server_overview,
            extra::provider_add,
            extra::provider_delete,
            extra::maintenance_get,
            extra::maintenance_set,
            extra::shared_provider_set,
            extra::shared_providers_get,
            extra::provider_models_get,
            extra::user_grants_get,
            extra::user_grant_set,
            extra::user_grant_delete,
            extra::shared_settings_get,
            extra::shared_settings_set,
            extra::backups_list,
            extra::backup_create,
            extra::backup_delete,
            extra::backup_restore,
            extra::get_extra,
            extra::set_extra,
            extra::open_url,
            extra::attachments_get,
            extra::attachments_set,
            extra::plugins_get,
            extra::plugin_set_enabled,
            extra::plugin_delete,
            extra::plugin_inspect,
            extra::plugin_install,
            extra::plugin_check_update,
            extra::update_status,
            extra::update_check,
            extra::update_apply,
            extra::usage_users_get,
            extra::usage_daily_get,
            extra::quotas_get,
            extra::quotas_set,
            extra::quota_users_get,
            extra::quota_user_set,
            extra::quota_user_delete
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let launch = autostart::parse_args(std::env::args());
            // always created hidden so the webview loads; it is shown below only when the launch decision says so
            let win = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("OmniChat Server")
                .inner_size(980.0, 700.0)
                .min_inner_size(420.0, 520.0)
                .visible(false)
                .build()?;
            // closing the window keeps the server running in the tray
            let h = handle.clone();
            win.on_window_event(move |ev| {
                if let WindowEvent::CloseRequested { api, .. } = ev {
                    let ctx = h.state::<Ctx>();
                    if !*ctx.quitting.lock().unwrap() && *ctx.tray_ok.lock().unwrap() {
                        api.prevent_close();
                        if let Some(w) = h.get_webview_window(MAIN) {
                            let _ = w.hide();
                        }
                    }
                }
            });

            // The tray is optional: on Linux its library may be missing, and the loader panics instead of returning an error.
            let tray_app = handle.clone();
            let tray = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || build_tray(&tray_app)));
            let ok = matches!(tray, Ok(Ok(())));
            *handle.state::<Ctx>().tray_ok.lock().unwrap() = ok;
            if !ok {
                push_log(&handle.state::<Ctx>().logs, "(トレイアイコンを作れませんでした。ウィンドウを閉じるとサーバーも停止します)".into());
            }
            if ok {
                spawn_tray_status(handle.clone());
            }

            // Launch decision (background::should_show_window). Without a tray the window is always shown, because
            // closing it would quit the app.
            let prefs = background::load_prefs(&handle);
            let first_run = !sysinfo::is_setup_done(&handle);
            let show = background::should_show_window(
                first_run,
                launch.autostart,
                launch.background,
                prefs.start_in_background,
                prefs.always_hidden,
                false,
            );
            if show || !ok {
                show_main(&handle);
            }

            // restarts the server when it exits with RESTART_EXIT_CODE (update applied)
            spawn_monitor(handle.clone());

            // the server starts with the app
            std::thread::spawn(move || {
                if launch.autostart {
                    let logs = handle.state::<Ctx>().logs.clone();
                    autostart::wait_for_startup(launch.delay_secs, &|m| push_log(&logs, m));
                }
                let _ = start(&handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OmniChat Server");

    app.run(|handle, ev| match ev {
        // all windows closed (the window is only hidden, so this is a safety net): keep running in the tray
        RunEvent::ExitRequested { code: None, api, .. } => {
            let ctx = handle.state::<Ctx>();
            let keep = !*ctx.quitting.lock().unwrap() && *ctx.tray_ok.lock().unwrap();
            if keep {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => stop(handle),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("omni-sa-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.join("config.env")
    }

    #[test]
    fn config_roundtrip_keeps_comments_spaces_and_unknown_keys() {
        let p = tmp("rt");
        fs::write(&p, "# my notes\r\nPORT=9000\r\nDATA_DIR=/home/a b/data dir\nFOO=bar baz\n\nbad line\n").unwrap();
        write_config(&p, &[("PORT", "8788".into()), ("HOST", "127.0.0.1".into())]).unwrap();
        let text = fs::read_to_string(&p).unwrap();
        assert!(text.starts_with("# my notes\n"));
        assert!(text.contains("\nPORT=8788\n") && text.contains("\nHOST=127.0.0.1\n"));
        assert!(text.contains("DATA_DIR=/home/a b/data dir\n"), "internal spaces survive");
        let cfg = read_config(&p);
        assert_eq!(cfg_get(&cfg, "DATA_DIR").as_deref(), Some("/home/a b/data dir"));
        assert_eq!(cfg_get(&cfg, "FOO").as_deref(), Some("bar baz"));
        assert_eq!(port_of(&cfg), 8788);
        assert!(cfg_get(&cfg, "bad line").is_none());
    }

    #[test]
    fn utf8_bom_from_notepad_is_ignored() {
        let p = tmp("bom");
        fs::write(&p, "\u{feff}PORT=8812\r\nHOST=127.0.0.1\r\n").unwrap();
        assert_eq!(port_of(&read_config(&p)), 8812);
        write_config(&p, &[("PORT", "8813".into())]).unwrap();
        let text = fs::read_to_string(&p).unwrap();
        assert_eq!(text, "PORT=8813\nHOST=127.0.0.1\n");
    }

    #[test]
    fn busy_port_falls_back_to_the_next_free_one() {
        let l = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let busy = l.local_addr().unwrap().port();
        assert!(port_busy(busy, "0.0.0.0"));
        let free = find_free_port(busy, "0.0.0.0").expect("a free port");
        assert!(free > busy && free <= busy + 100);
        assert!(!port_busy(free, "0.0.0.0"));
    }

    #[test]
    fn port_defaults_when_missing_or_invalid() {
        assert_eq!(port_of(&[]), 8787);
        assert_eq!(port_of(&[("PORT".into(), "abc".into())]), 8787);
        assert_eq!(port_of(&[("PORT".into(), "0".into())]), 8787);
        assert_eq!(port_of(&[("PORT".into(), " 9001 ".into())]), 9001);
    }

    #[test]
    fn restarts_only_on_exit_75_when_not_stopped() {
        assert!(should_restart(Some(75), false, false, 0));
        for code in [Some(0), Some(1), Some(74), Some(76), None] {
            assert!(!should_restart(code, false, false, 0), "{code:?}");
        }
        assert!(!should_restart(Some(75), true, false, 0), "user stop must not restart");
        assert!(!should_restart(Some(75), false, true, 0), "quitting must not restart");
    }

    #[test]
    fn restart_loop_guard_allows_five_restarts_per_window() {
        assert!(should_restart(Some(75), false, false, MAX_RESTARTS - 1));
        assert!(!should_restart(Some(75), false, false, MAX_RESTARTS));
        assert!(!should_restart(Some(75), false, false, MAX_RESTARTS + 3));
    }

    #[test]
    fn values_and_ids_are_validated() {
        assert!(is_safe_value("http://localhost:8888"));
        for bad in ["a b\nc", "x\"y", "x'y", "x#y", "x=y"] {
            assert!(!is_safe_value(bad), "{bad}");
        }
        assert!(url_safe("3f2a-9c").is_ok());
        for bad in ["", "../x", "a/b", "a?b", "a b"] {
            assert!(url_safe(bad).is_err(), "{bad}");
        }
    }
}
