//! Aria host: runs the Aria voice server (a Python package in the folder the user points to) as a child process and
//! manages it: start/stop/restart, automatic restart after a crash, logs, settings (aria.json in the app data
//! directory), dependency checks, and a loopback-only proxy to Aria's /local-admin/voice/ API through the OmniChat
//! server's local admin API.
//!
//! Hosting is Windows only (the venv layout and the job object are Windows specific). On other platforms every start
//! is refused with a message; the settings and the checks still work there.

use std::net::TcpListener;
use std::sync::{MutexGuard, OnceLock};

use super::*;

/// Settings file in the app data directory (config.env belongs to the OmniChat server and is not touched here).
const SETTINGS_FILE: &str = "aria.json";
/// How long start waits for GET /health to answer ok or degraded; polled every START_POLL.
const START_TIMEOUT: Duration = Duration::from_secs(90);
const START_POLL: Duration = Duration::from_millis(500);
/// Timeout of one /health call (start polling and the state refresh).
const HEALTH_TIMEOUT_SECS: u64 = 2;
/// Loop guard: at most this many automatic restarts within RESTART_WINDOW.
const MAX_RESTARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(300);
/// Pause before each automatic restart; a stop pressed during it cancels the restart.
const RESTART_DELAY: Duration = Duration::from_secs(5);
/// Pause between the stop and the start of aria_restart.
const RESTART_STOP_WAIT: Duration = Duration::from_secs(3);
/// Limit for one `auth create` call.
const TOKEN_TIMEOUT: Duration = Duration::from_secs(20);
/// Environment for the Aria process that the app always sets. They are added after the user's env, so they win.
const EXTRA_ENV: &[(&str, &str)] = &[("PYTHONUNBUFFERED", "1"), ("PYTHONUTF8", "1"), ("PYTHONIOENCODING", "utf-8")];
/// Python variables that would change which modules Aria imports; refused on top of DENIED_ENV.
const DENIED_PY_ENV: &[&str] = &["PYTHONHOME", "PYTHONPATH"];
/// Variables the app sets for Aria itself (data folder, Aivis URL); aria.json may not set them.
const OWN_ENV: &[&str] = &["ARIA_DATA_DIR", "AIVIS_URL"];
/// The only text a failed token creation reports. It never contains the output of the auth command.
const TOKEN_FAIL: &str = "トークンの発行に失敗しました(Aria の auth コマンドの出力を確認してください)";
/// The only prefix voice_admin may reach on the OmniChat server's admin API.
const VOICE_PREFIX: &str = "/local-admin/voice/";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------------------------------------------
// settings (aria.json)

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AriaConfig {
    /// the Aria checkout folder (contains aria_core/)
    pub aria_dir: String,
    /// empty = <aria_dir>\venv\Scripts\python.exe, then <aria_dir>\.venv\Scripts\python.exe
    pub python_path: String,
    /// 0 = a free port is picked at every start
    pub port: u16,
    pub autostart: bool,
    /// URL of the Aivis server, passed to Aria as AIVIS_URL. Empty = not set.
    pub aivis_url: String,
    pub env: Vec<EnvPair>,
}

/// No Debug derive on purpose: values may hold tokens and must not end up in a log line.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnvPair {
    pub key: String,
    pub value: String,
}

/// Keys that may not be set from aria.json (the OmniChat list, the Python path variables and the app's own variables).
fn env_allowed(key: &str) -> bool {
    !DENIED_ENV.iter().any(|d| d.eq_ignore_ascii_case(key))
        && !DENIED_PY_ENV.iter().any(|d| d.eq_ignore_ascii_case(key))
        && !OWN_ENV.iter().any(|d| d.eq_ignore_ascii_case(key))
}

/// Checks everything that can be checked without touching the disk. Only key names appear in messages, never values.
fn validate_config(cfg: &AriaConfig) -> Result<(), String> {
    if [&cfg.aria_dir, &cfg.python_path].iter().any(|t| t.contains(['\n', '\r', '\0'])) {
        return Err("Aria のフォルダと Python のパスに改行は使えません".into());
    }
    if !cfg.aivis_url.is_empty() {
        let u = cfg.aivis_url.as_str();
        let scheme_ok = u.starts_with("http://") || u.starts_with("https://");
        if !scheme_ok || u.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\'') {
            return Err("Aivis の URL は http:// か https:// で始まり、空白や引用符を含まない値にしてください".into());
        }
    }
    for pair in &cfg.env {
        let key = pair.key.as_str();
        let ok = !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !ok {
            return Err(format!("環境変数名 \"{key}\" が不正です(英数字と _ のみ使えます)"));
        }
        if !env_allowed(key) {
            return Err(format!("環境変数 \"{key}\" は設定できません"));
        }
        if pair.value.contains(['\n', '\r', '\0']) {
            return Err(format!("環境変数 \"{key}\" の値に改行は使えません"));
        }
    }
    Ok(())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(SETTINGS_FILE))
}

/// A missing file means the defaults. A file that cannot be read or parsed is an error, so save never silently
/// replaces it.
fn load_config(app: &AppHandle) -> Result<AriaConfig, String> {
    let path = settings_path(app)?;
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(AriaConfig::default()),
        Err(e) => return Err(e.to_string()),
    };
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| "aria.json の形式が正しくありません".to_string())
}

fn save_config(app: &AppHandle, cfg: &AriaConfig) -> Result<(), String> {
    validate_config(cfg)?;
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text + "\n").map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------------------------
// pure helpers (launch, paths, ports, environment)

/// Windows only for hosting: the venv layout and the job object are Windows specific.
pub fn supported() -> bool {
    cfg!(windows)
}

/// The Aria folder as a directory, or the message the user should see.
fn aria_dir_check(aria_dir: &str) -> Result<PathBuf, String> {
    let dir = aria_dir.trim();
    if dir.is_empty() {
        return Err("Aria のフォルダが設定されていません。設定でフォルダを指定してください".into());
    }
    let p = PathBuf::from(dir);
    if !p.is_dir() {
        return Err(format!("Aria のフォルダが見つかりません: {}", p.display()));
    }
    Ok(p)
}

/// Python used to run Aria: the configured path as given, else the venv inside the Aria folder (venv first, then .venv).
fn resolve_python(aria_dir: &Path, python_path: &str) -> Result<PathBuf, String> {
    let configured = python_path.trim();
    if !configured.is_empty() {
        return Ok(PathBuf::from(configured));
    }
    for venv in ["venv", ".venv"] {
        let py = aria_dir.join(venv).join("Scripts").join("python.exe");
        if py.is_file() {
            return Ok(py);
        }
    }
    Err("Python が見つかりません。Aria のフォルダで仮想環境を作り requirements-core.txt をインストールしてください(または Python のパスを設定してください)。依存のインストールはユーザーが行います".into())
}

/// The port for this start: the configured one when it is free, else a free one picked by the OS (0 in the settings).
fn resolve_port(configured: u16) -> Result<u16, String> {
    if configured == 0 {
        // the listener is dropped at the end of this block, which frees the port for Aria
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("空きポートを確保できません: {e}"))?;
        return Ok(listener.local_addr().map_err(|e| e.to_string())?.port());
    }
    TcpListener::bind(("127.0.0.1", configured))
        .map(|_| configured)
        .map_err(|_| format!("ポート {configured} は使用中です。別のポートを指定するか、0(自動)にしてください"))
}

/// GET /health on loopback. Some(status) when Aria answers 200 with the JSON status "ok" or "degraded"; None otherwise.
fn probe_health(port: u16, secs: u64) -> Option<String> {
    let mut resp = agent_secs(secs).get(&format!("http://127.0.0.1:{port}/health")).call().ok()?;
    if resp.status().as_u16() != 200 {
        return None;
    }
    let v: Value = resp.body_mut().read_json().ok()?;
    match v.get("status").and_then(Value::as_str) {
        Some(s @ ("ok" | "degraded")) => Some(s.to_string()),
        _ => None,
    }
}

/// Arguments after the Python executable: uvicorn serves main:app on loopback at the given port.
fn launch_args(port: u16) -> Vec<String> {
    vec!["-m".into(), "uvicorn".into(), "main:app".into(), "--host".into(), "127.0.0.1".into(), "--port".into(), port.to_string()]
}

/// Environment for the Aria process: ARIA_DATA_DIR and AIVIS_URL (set by the app), then the user's env from aria.json
/// (denied and reserved keys dropped), then the fixed extras, which win over everything before them.
fn child_env(cfg: &AriaConfig, data_dir: &Path) -> Vec<(String, String)> {
    let mut env = vec![("ARIA_DATA_DIR".to_string(), data_dir.to_string_lossy().into_owned())];
    if !cfg.aivis_url.is_empty() {
        env.push(("AIVIS_URL".to_string(), cfg.aivis_url.clone()));
    }
    env.extend(cfg.env.iter().filter(|p| env_allowed(&p.key)).map(|p| (p.key.clone(), p.value.clone())));
    env.extend(EXTRA_ENV.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    env
}

/// Aria's data folder (ARIA_DATA_DIR) inside the app data directory, created on demand.
fn aria_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = paths(app)?.data_dir.join("aria");
    fs::create_dir_all(&dir).map_err(|e| format!("Aria のデータフォルダを作成できません: {e}"))?;
    Ok(dir)
}

/// Hides the console window of a child process on Windows (no-op elsewhere).
fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Pure decision used by the monitor: restart only when the user did not stop Aria and the loop guard allows it.
fn should_restart(stopping: bool, recent: usize) -> bool {
    !stopping && recent < MAX_RESTARTS
}

/// Only paths of Aria's voice API, with no traversal and no characters that could change the request.
fn check_voice_path(path: &str) -> Result<(), String> {
    let ok = path.starts_with(VOICE_PREFIX) && !path.contains("..") && !path.contains('\\') && path.chars().all(|c| c.is_ascii_graphic());
    if ok {
        Ok(())
    } else {
        Err("このパスは呼び出せません".into())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// dependency check (nothing is installed here)

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    pub id: &'static str,
    pub ok: bool,
    pub message: String,
}

/// Looks at the Aria folder, the Python that would run it and the aria_core package. Installs nothing.
pub fn check_dir(aria_dir: &str, python_path: &str) -> Vec<CheckItem> {
    let mut items = Vec::new();

    let dir = aria_dir_check(aria_dir);
    let dir_ok = dir.is_ok();
    let base = dir.clone().unwrap_or_default();
    items.push(CheckItem {
        id: "dir",
        ok: dir_ok,
        message: match &dir {
            Ok(_) => "Aria のフォルダを確認しました".into(),
            Err(e) => e.clone(),
        },
    });

    // without a folder, the venv locations would be relative to the current directory: only an explicit path is tried
    let python = match (&dir, python_path.trim().is_empty()) {
        (Err(_), true) => Err("Aria のフォルダを確認してから Python を確認してください".to_string()),
        _ => resolve_python(&base, python_path),
    };
    let (python_ok, python_message) = match python {
        Err(e) => (false, e),
        Ok(py) => {
            let mut cmd = Command::new(&py);
            cmd.arg("--version").stdin(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            match cmd.output() {
                Ok(out) if out.status.success() => {
                    let raw = if out.stdout.is_empty() { &out.stderr } else { &out.stdout };
                    let version = String::from_utf8_lossy(raw).trim().to_string();
                    (true, format!("Python を確認しました ({version})"))
                }
                Ok(_) => (false, format!("Python を実行できません: {}。Aria のフォルダで仮想環境を作り直してください", py.display())),
                Err(e) => (false, format!("Python を実行できません ({}): {e}", py.display())),
            }
        }
    };
    items.push(CheckItem { id: "python", ok: python_ok, message: python_message });

    let pkg = base.join("aria_core");
    let pkg_ok = dir_ok && (pkg.is_dir() || pkg.join("__init__.py").is_file());
    items.push(CheckItem {
        id: "package",
        ok: pkg_ok,
        message: if pkg_ok {
            "aria_core を確認しました".into()
        } else {
            "aria_core が見つかりません。Aria のフォルダで仮想環境を作り、requirements-core.txt(音声を使うなら requirements-audio.txt)をインストールしてください。依存のインストールはこのアプリでは行わず、ユーザーが行います".into()
        },
    });

    let main_ok = dir_ok && base.join("main.py").is_file();
    items.push(CheckItem {
        id: "main",
        ok: main_ok,
        message: if main_ok {
            "main.py を確認しました".into()
        } else {
            "main.py が見つかりません。Aria のフォルダを確認してください(起動に main.py が必要です)".into()
        },
    });
    items
}

// ---------------------------------------------------------------------------------------------------------------
// token setup: `aria_core.auth create` twice, then the tokens go to the OmniChat voice config

/// The token from the output of `aria_core.auth create --json`: the last non-empty line is a JSON object with a
/// "token" string. Errors use TOKEN_FAIL only, so the output (which holds the token) never reaches a message.
fn parse_token_line(output: &str) -> Result<String, String> {
    let line = output.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    let token = serde_json::from_str::<Value>(line.trim()).ok().and_then(|v| v.get("token").and_then(Value::as_str).map(str::to_owned));
    match token {
        Some(t) if !t.is_empty() => Ok(t),
        _ => Err(TOKEN_FAIL.into()),
    }
}

/// Runs a command and returns its stdout when it exits 0 within the limit. Stderr is discarded on purpose: it is never
/// logged, so a token cannot leak through it. stdout is read on its own thread so a full pipe cannot stall the child.
fn run_capture(mut cmd: Command, limit: Duration) -> Option<String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + limit;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let buf = reader.join().ok()?;
    if ok {
        Some(String::from_utf8_lossy(&buf).into_owned())
    } else {
        None
    }
}

/// One `python -m aria_core.auth create <name> --scopes <scopes> --json`, run in the Aria folder with the launch env.
fn create_token(python: &Path, dir: &Path, env: &[(String, String)], name: &str, scopes: &str) -> Result<String, String> {
    let mut cmd = Command::new(python);
    cmd.args(["-m", "aria_core.auth", "create", name, "--scopes", scopes, "--json"]).current_dir(dir);
    for (k, v) in env {
        cmd.env(k, v);
    }
    hide_window(&mut cmd);
    let out = run_capture(cmd, TOKEN_TIMEOUT).ok_or_else(|| TOKEN_FAIL.to_string())?;
    parse_token_line(&out)
}

/// Creates the chat and admin tokens for Aria and stores them in the OmniChat voice config. The tokens are never
/// logged or returned to the UI.
fn setup_tokens(app: &AppHandle) -> Result<(), String> {
    if !supported() {
        return Err("Aria のホストは Windows のみ対応です".into());
    }
    let cfg = load_config(app)?;
    validate_config(&cfg)?;
    let dir = aria_dir_check(&cfg.aria_dir)?;
    let python = resolve_python(&dir, &cfg.python_path)?;
    let env = child_env(&cfg, &aria_data_dir(app)?);

    let chat = create_token(&python, &dir, &env, "omnichat-chat", "chat")?;
    let admin = create_token(&python, &dir, &env, "omnichat-admin", "admin")?;
    admin_call(app, "PUT", "/local-admin/voice/config", Some(json!({ "chatToken": chat, "adminToken": admin })))
        .map_err(|e| format!("OmniChat に設定を保存できません: {e}"))?;
    push_log(&host().logs, "--- Aria の接続トークンを発行し、OmniChat に設定しました ---".into());
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// host state (module-level, so lib.rs's Ctx stays untouched)

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Stopped,
    Starting,
    Running,
    Failed,
}

#[derive(Default)]
struct AriaHost {
    child: Mutex<Option<Child>>,
    logs: Arc<Mutex<VecDeque<String>>>,
    status: Mutex<Status>,
    last_error: Mutex<Option<String>>,
    /// the port the running (or starting) Aria listens on; 0 when none
    port: Mutex<u16>,
    /// "ok" or "degraded" from the last successful /health answer; None when there is none
    health: Mutex<Option<String>>,
    /// set by stop_aria (user stop or app exit); cleared by a user start. A stopped Aria is never auto-restarted.
    stopping: Mutex<bool>,
    /// times of the automatic restarts (pruned to RESTART_WINDOW)
    restarts: Mutex<VecDeque<Instant>>,
    /// held for the whole of a start or stop; the monitor takes it for each decision. Lock order: start_lock, then child.
    start_lock: Mutex<()>,
}

static HOST: OnceLock<AriaHost> = OnceLock::new();

fn host() -> &'static AriaHost {
    HOST.get_or_init(AriaHost::default)
}

/// Poison-tolerant lock: a panic in one thread must not make every later call panic.
fn guard<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Some(exit code) once the child has exited (or is gone), None while it still runs. An exited child is dropped.
fn take_exit(h: &AriaHost) -> Option<Option<i32>> {
    let mut g = guard(&h.child);
    let Some(c) = g.as_mut() else { return Some(None) };
    match c.try_wait() {
        Ok(None) => None,
        Ok(Some(status)) => {
            *g = None;
            Some(status.code())
        }
        Err(_) => {
            *g = None;
            Some(None)
        }
    }
}

/// Kills and reaps the child if there is one. Returns true when a child was stopped.
fn kill_child(h: &AriaHost) -> bool {
    let child = guard(&h.child).take();
    match child {
        Some(mut c) => {
            let _ = c.kill();
            let _ = c.wait();
            true
        }
        None => false,
    }
}

/// Number of automatic restarts inside RESTART_WINDOW (old entries are dropped).
fn recent_restarts(h: &AriaHost, now: Instant) -> usize {
    let mut r = guard(&h.restarts);
    while r.front().is_some_and(|t| now.duration_since(*t) > RESTART_WINDOW) {
        r.pop_front();
    }
    r.len()
}

/// Starts Aria and waits until GET /health answers ok or degraded. Caller holds start_lock.
fn start_inner(app: &AppHandle, h: &AriaHost) -> Result<(), String> {
    let cfg = load_config(app)?;
    validate_config(&cfg)?;
    let dir = aria_dir_check(&cfg.aria_dir)?;
    let python = resolve_python(&dir, &cfg.python_path)?;
    let port = resolve_port(cfg.port)?;
    let data_dir = aria_data_dir(app)?;

    let mut cmd = Command::new(&python);
    cmd.args(launch_args(port)).current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in child_env(&cfg, &data_dir) {
        cmd.env(k, v);
    }
    hide_window(&mut cmd);
    push_log(&h.logs, format!("--- Aria を起動します (port {port}) ---"));
    let mut child = cmd.spawn().map_err(|e| format!("Aria を起動できません ({}): {e}", python.display()))?;
    // Aria dies with this app process (Windows Job Object); a failure here is harmless
    jobobj::assign_to_kill_on_close_job(&child);
    if let Some(o) = child.stdout.take() {
        pump(o, h.logs.clone());
    }
    if let Some(e) = child.stderr.take() {
        pump(e, h.logs.clone());
    }
    *guard(&h.port) = port;
    *guard(&h.child) = Some(child);

    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if *guard(&h.stopping) {
            kill_child(h);
            return Err("停止しました".into());
        }
        if take_exit(h).is_some() {
            return Err("Aria が起動直後に終了しました。ログを確認してください".into());
        }
        if let Some(health) = probe_health(port, HEALTH_TIMEOUT_SECS) {
            *guard(&h.health) = Some(health);
            return Ok(());
        }
        if Instant::now() > deadline {
            kill_child(h);
            return Err("Aria の起動がタイムアウトしました。ログを確認してください".into());
        }
        std::thread::sleep(START_POLL);
    }
}

/// Start with the state the UI relies on: Starting while it waits, Running once /health answers, Stopped when a
/// stop interrupted it, Failed (with the message) otherwise. Caller holds start_lock.
fn start_locked(app: &AppHandle, h: &AriaHost) -> Result<(), String> {
    *guard(&h.last_error) = None;
    *guard(&h.health) = None;
    *guard(&h.status) = Status::Starting;
    let outcome = match start_inner(app, h) {
        Ok(()) => {
            *guard(&h.status) = Status::Running;
            Ok(())
        }
        Err(e) => {
            if *guard(&h.stopping) {
                *guard(&h.status) = Status::Stopped;
            } else {
                *guard(&h.last_error) = Some(e.clone());
                *guard(&h.status) = Status::Failed;
            }
            Err(e)
        }
    };
    if outcome.is_ok() {
        // tell the OmniChat server where Aria is (loopback only; a failure is logged and the app keeps running)
        let port = *guard(&h.port);
        let body = json!({ "mode": "hosted", "baseUrl": format!("http://127.0.0.1:{port}") });
        if let Err(e) = admin_call(app, "PUT", "/local-admin/voice/config", Some(body)) {
            push_log(&h.logs, format!("(OmniChat への Aria 接続設定に失敗しました: {e})"));
        }
    }
    outcome
}

/// User start: clears the stop flag, then starts unless Aria already runs.
fn start_aria(app: &AppHandle) -> Result<(), String> {
    if !supported() {
        return Err("Aria のホストは Windows のみ対応です".into());
    }
    let h = host();
    let _starting = guard(&h.start_lock);
    if *guard(&h.status) == Status::Running && take_exit(h).is_none() {
        return Ok(());
    }
    *guard(&h.stopping) = false;
    start_locked(app, h)
}

/// Stops Aria for good. A start still in progress notices the flag and gives up before this returns.
fn stop_aria(h: &AriaHost) {
    *guard(&h.stopping) = true;
    let _starting = guard(&h.start_lock);
    if kill_child(h) {
        push_log(&h.logs, "--- Aria を停止しました ---".into());
    }
    *guard(&h.port) = 0;
    *guard(&h.last_error) = None;
    *guard(&h.health) = None;
    *guard(&h.status) = Status::Stopped;
}

/// One monitor step, called with start_lock held. Returns true when Aria exited on its own and should be restarted.
fn monitor_tick(h: &AriaHost) -> bool {
    if *guard(&h.status) != Status::Running {
        return false;
    }
    let Some(code) = take_exit(h) else { return false };
    let stopping = *guard(&h.stopping);
    if stopping {
        // a user stop is in progress: stop_aria sets the final state
        return false;
    }
    let now = Instant::now();
    let recent = recent_restarts(h, now);
    if should_restart(stopping, recent) {
        guard(&h.restarts).push_back(now);
        *guard(&h.status) = Status::Starting;
        let code_text = code.map_or("不明".to_string(), |c| c.to_string());
        push_log(&h.logs, format!("--- Aria が終了しました (終了コード: {code_text})。再起動します ---"));
        return true;
    }
    let msg = if recent >= MAX_RESTARTS {
        "Aria が短時間に繰り返し終了したため、自動再起動を停止しました。ログを確認してください"
    } else {
        "Aria が予期せず終了しました。ログを確認してください"
    };
    *guard(&h.last_error) = Some(msg.into());
    *guard(&h.status) = Status::Failed;
    false
}

/// Automatic restart after the monitor decided on it and the RESTART_DELAY pause. Skips when the user stopped Aria or
/// started it again in the meantime.
fn restart_by_monitor(app: &AppHandle) {
    let h = host();
    let _starting = guard(&h.start_lock);
    if *guard(&h.stopping) || take_exit(h).is_none() {
        return;
    }
    if let Err(e) = start_locked(app, h) {
        push_log(&h.logs, format!("(自動再起動に失敗しました: {e})"));
    }
}

/// Watches the Aria child every second (exit only, no polling): after an unexpected exit it restarts Aria after
/// RESTART_DELAY (at most MAX_RESTARTS within RESTART_WINDOW) and otherwise leaves the state Failed with the reason.
pub fn spawn_monitor(app: AppHandle) {
    std::thread::spawn(move || {
        let h = host();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let restart = {
                let _starting = guard(&h.start_lock);
                monitor_tick(h)
            };
            if restart {
                // the pause lets the old process release its port and files; a stop during it cancels the restart
                std::thread::sleep(RESTART_DELAY);
                restart_by_monitor(&app);
            }
        }
    });
}

/// Starts Aria at app launch when aria.json asks for it. A failure is kept in the state (aria_get shows it).
pub fn autostart_if_configured(app: &AppHandle) {
    if !supported() {
        return;
    }
    let Ok(cfg) = load_config(app) else { return };
    if !cfg.autostart || cfg.aria_dir.trim().is_empty() {
        return;
    }
    let _ = start_aria(app);
}

/// Stops Aria for good (app exit). Safe to call when nothing runs.
pub fn stop_all(app: &AppHandle) {
    let _ = app;
    stop_aria(host());
}

// ---------------------------------------------------------------------------------------------------------------
// commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AriaStateOut {
    supported: bool,
    config: AriaConfig,
    status: Status,
    port: u16,
    pid: Option<u32>,
    error: Option<String>,
    /// automatic restarts within the last RESTART_WINDOW
    restarts: usize,
    /// "ok" or "degraded" while running (from Aria's /health); None otherwise
    health: Option<String>,
}

fn state_out(app: &AppHandle) -> Result<AriaStateOut, String> {
    let h = host();
    let status = *guard(&h.status);
    Ok(AriaStateOut {
        supported: supported(),
        config: load_config(app)?,
        status,
        port: *guard(&h.port),
        pid: guard(&h.child).as_ref().map(|c| c.id()),
        error: guard(&h.last_error).clone(),
        restarts: recent_restarts(h, Instant::now()),
        health: if status == Status::Running { guard(&h.health).clone() } else { None },
    })
}

/// One quick /health call (2s) for the UI, only while Aria is running. Only the health field changes: the status stays
/// as the start and the monitor left it.
fn refresh_health() {
    let h = host();
    let port = *guard(&h.port);
    if *guard(&h.status) != Status::Running || port == 0 {
        return;
    }
    *guard(&h.health) = probe_health(port, HEALTH_TIMEOUT_SECS);
}

#[tauri::command]
pub async fn aria_get(app: AppHandle) -> Result<AriaStateOut, String> {
    blocking(move || {
        refresh_health();
        state_out(&app)
    })
    .await
}

#[tauri::command]
pub async fn aria_set_config(app: AppHandle, config: AriaConfig) -> Result<AriaStateOut, String> {
    blocking(move || {
        let mut config = config;
        config.aria_dir = config.aria_dir.trim().to_string();
        config.python_path = config.python_path.trim().to_string();
        config.aivis_url = config.aivis_url.trim().to_string();
        save_config(&app, &config)?;
        state_out(&app)
    })
    .await
}

#[tauri::command]
pub async fn aria_start(app: AppHandle) -> Result<AriaStateOut, String> {
    blocking(move || {
        let r = start_aria(&app);
        let s = state_out(&app)?;
        r.map(|_| s)
    })
    .await
}

#[tauri::command]
pub async fn aria_stop(app: AppHandle) -> Result<AriaStateOut, String> {
    blocking(move || {
        stop_aria(host());
        state_out(&app)
    })
    .await
}

#[tauri::command]
pub async fn aria_restart(app: AppHandle) -> Result<AriaStateOut, String> {
    blocking(move || {
        stop_aria(host());
        // the old process needs a moment to release its port and files
        std::thread::sleep(RESTART_STOP_WAIT);
        let r = start_aria(&app);
        let s = state_out(&app)?;
        r.map(|_| s)
    })
    .await
}

#[tauri::command]
pub fn aria_logs(_app: AppHandle, tail: Option<usize>) -> Vec<String> {
    let logs = guard(&host().logs);
    let n = tail.unwrap_or(logs.len()).min(logs.len());
    logs.iter().skip(logs.len() - n).cloned().collect()
}

#[tauri::command]
pub async fn aria_check(app: AppHandle) -> Result<Vec<CheckItem>, String> {
    blocking(move || {
        let cfg = load_config(&app)?;
        Ok(check_dir(&cfg.aria_dir, &cfg.python_path))
    })
    .await
}

/// Creates Aria's chat and admin tokens and stores them in the OmniChat voice config. Returns nothing: the tokens never
/// reach the UI.
#[tauri::command]
pub async fn aria_setup_tokens(app: AppHandle) -> Result<(), String> {
    blocking(move || setup_tokens(&app)).await
}

/// Calls Aria's /local-admin/voice/ API through the OmniChat server's local admin API (loopback, token-authenticated).
#[tauri::command]
pub async fn voice_admin(app: AppHandle, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    blocking(move || {
        check_voice_path(&path)?;
        let method = method.to_ascii_uppercase();
        if !matches!(method.as_str(), "GET" | "PUT" | "POST" | "DELETE") {
            return Err("このメソッドは使えません".into());
        }
        // admin_call needs a body for POST and PUT; an empty object is sent when the caller gave none
        let body = match (method.as_str(), body) {
            ("POST" | "PUT", None) => Some(json!({})),
            (_, b) => b,
        };
        admin_call_secs(&app, &method, &path, body, 30)
    })
    .await
}

// ---------------------------------------------------------------------------------------------------------------
// tests

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("omni-aria-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn pair(key: &str, value: &str) -> EnvPair {
        EnvPair { key: key.into(), value: value.into() }
    }

    fn cfg_with_env(pairs: Vec<EnvPair>) -> AriaConfig {
        AriaConfig { env: pairs, ..Default::default() }
    }

    #[test]
    fn config_rejects_bad_env_keys() {
        for bad in ["", "A-B", "A B", "A=B", "ÄB"] {
            assert!(validate_config(&cfg_with_env(vec![pair(bad, "x")])).is_err(), "{bad:?}");
        }
        assert!(validate_config(&cfg_with_env(vec![pair("ARIA_TOKEN_2", "x")])).is_ok());
    }

    #[test]
    fn config_rejects_denied_keys_in_any_case() {
        for bad in ["PATH", "path", "NODE_OPTIONS", "PYTHONPATH", "pythonpath", "PYTHONHOME", "LD_PRELOAD", "ARIA_DATA_DIR", "aivis_url"] {
            assert!(validate_config(&cfg_with_env(vec![pair(bad, "x")])).is_err(), "{bad}");
        }
        assert!(env_allowed("ARIA_LANG"));
        assert!(!env_allowed("PythonPath"));
    }

    #[test]
    fn config_rejects_newlines_in_values_and_paths() {
        assert!(validate_config(&cfg_with_env(vec![pair("K", "a\nb")])).is_err());
        assert!(validate_config(&cfg_with_env(vec![pair("K", "a\rb")])).is_err());
        assert!(validate_config(&cfg_with_env(vec![pair("K", "a\0b")])).is_err());
        let cfg = AriaConfig { aria_dir: "C:\\aria\nx".into(), ..Default::default() };
        assert!(validate_config(&cfg).is_err());
        assert!(validate_config(&cfg_with_env(vec![pair("K", "a b=c\"d")])).is_ok());
    }

    #[test]
    fn aivis_url_must_be_a_plain_http_url() {
        let with = |u: &str| AriaConfig { aivis_url: u.into(), ..Default::default() };
        assert!(validate_config(&with("")).is_ok(), "empty means not set");
        assert!(validate_config(&with("http://127.0.0.1:9000")).is_ok());
        assert!(validate_config(&with("https://aivis.example/api")).is_ok());
        for bad in ["127.0.0.1:9000", "ftp://x", "http://a b", "http://a\"b", "http://a'b", "http://a\nb", "http://a\0"] {
            assert!(validate_config(&with(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn child_env_sets_data_dir_and_aivis_then_extras_last() {
        let cfg = AriaConfig {
            aivis_url: "http://127.0.0.1:9000".into(),
            env: vec![pair("ARIA_LANG", "ja"), pair("PATH", "x"), pair("PYTHONUTF8", "0"), pair("ARIA_DATA_DIR", "evil")],
            ..Default::default()
        };
        let env = child_env(&cfg, Path::new("D/aria"));
        let get = |k: &str| env.iter().rev().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("ARIA_DATA_DIR"), Some("D/aria"), "the app's value wins over aria.json");
        assert_eq!(get("AIVIS_URL"), Some("http://127.0.0.1:9000"));
        assert_eq!(get("ARIA_LANG"), Some("ja"));
        assert_eq!(get("PATH"), None);
        assert_eq!(get("PYTHONUTF8"), Some("1"));
    }

    #[test]
    fn child_env_leaves_aivis_url_out_when_empty() {
        let env = child_env(&AriaConfig::default(), Path::new("D/aria"));
        assert!(!env.iter().any(|(k, _)| k == "AIVIS_URL"));
        assert!(env.iter().any(|(k, _)| k == "ARIA_DATA_DIR"));
    }

    #[test]
    fn old_aria_json_without_aivis_url_still_loads() {
        let cfg: AriaConfig = serde_json::from_str(r#"{"ariaDir":"C:/aria","port":8123}"#).unwrap();
        assert_eq!(cfg.aria_dir, "C:/aria");
        assert_eq!(cfg.port, 8123);
        assert!(cfg.aivis_url.is_empty());
    }

    #[test]
    fn token_line_is_read_from_the_last_json_line() {
        let out = "warning: something\n\n{\"name\":\"omnichat-chat\",\"scopes\":[\"chat\"],\"token\":\"tok-123\"}\n\n";
        assert_eq!(parse_token_line(out).unwrap(), "tok-123");
    }

    #[test]
    fn token_line_garbage_or_missing_token_fails_without_the_output() {
        for bad in ["", "   \n", "not json", "{\"name\":\"omnichat-chat\"}", "{\"token\":\"\"}", "{\"token\":5}"] {
            assert_eq!(parse_token_line(bad).unwrap_err(), TOKEN_FAIL, "{bad:?}");
        }
    }

    #[test]
    fn child_env_drops_denied_keys_and_adds_extras_last() {
        let cfg = cfg_with_env(vec![pair("ARIA_LANG", "ja"), pair("PATH", "x"), pair("PYTHONUTF8", "0")]);
        let env = child_env(&cfg, Path::new("D/aria"));
        assert!(env.iter().any(|(k, v)| k == "ARIA_LANG" && v == "ja"));
        assert!(!env.iter().any(|(k, _)| k == "PATH"));
        let last_utf8 = env.iter().rev().find(|(k, _)| k == "PYTHONUTF8").map(|(_, v)| v.as_str());
        assert_eq!(last_utf8, Some("1"));
    }

    #[test]
    fn restarts_only_when_not_stopped_and_under_the_limit() {
        assert!(should_restart(false, 0));
        assert!(should_restart(false, MAX_RESTARTS - 1));
        assert!(!should_restart(false, MAX_RESTARTS));
        assert!(!should_restart(false, MAX_RESTARTS + 2));
        assert!(!should_restart(true, 0));
    }

    #[test]
    fn voice_paths_are_limited_to_the_voice_api() {
        for good in ["/local-admin/voice/config", "/local-admin/voice/sessions/abc?limit=5"] {
            assert!(check_voice_path(good).is_ok(), "{good}");
        }
        for bad in [
            "/local-admin/providers",
            "/local-admin/voice",
            "/local-admin/voice/../providers",
            "/local-admin/voice/x/..%2F..",
            "/local-admin/voice/a\\b",
            "/local-admin/voice/a b",
            "http://example.com/local-admin/voice/x",
            "",
        ] {
            assert!(check_voice_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn python_is_resolved_from_the_venv_folders_in_order() {
        let d = tmp_dir("py");
        assert!(resolve_python(&d, "").is_err());
        assert_eq!(resolve_python(&d, "  C:/py/python.exe ").unwrap(), PathBuf::from("C:/py/python.exe"));

        let dot_py = d.join(".venv").join("Scripts").join("python.exe");
        fs::create_dir_all(dot_py.parent().unwrap()).unwrap();
        fs::write(&dot_py, "").unwrap();
        assert_eq!(resolve_python(&d, "").unwrap(), dot_py, ".venv is used when it is the only one");

        let venv_py = d.join("venv").join("Scripts").join("python.exe");
        fs::create_dir_all(venv_py.parent().unwrap()).unwrap();
        fs::write(&venv_py, "").unwrap();
        assert_eq!(resolve_python(&d, "").unwrap(), venv_py, "venv is preferred over .venv");
    }

    #[test]
    fn launch_args_run_uvicorn_on_loopback_and_the_given_port() {
        let args = launch_args(8123);
        assert_eq!(&args[..3], ["-m", "uvicorn", "main:app"]);
        let pos = args.iter().position(|a| a == "--port").expect("--port");
        assert_eq!(args[pos + 1], "8123");
        let host = args.iter().position(|a| a == "--host").expect("--host");
        assert_eq!(args[host + 1], "127.0.0.1");
    }

    #[test]
    fn fixed_port_must_be_free() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy = l.local_addr().unwrap().port();
        assert!(resolve_port(busy).is_err());
        assert!(resolve_port(0).unwrap() > 0);
    }

    #[test]
    fn check_reports_a_missing_folder_and_package() {
        let items = check_dir("", "");
        assert_eq!(items[0].id, "dir");
        assert!(!items[0].ok);
        assert!(!items[2].ok);
        assert_eq!(items[3].id, "main");
        assert!(!items[3].ok);

        let d = tmp_dir("check");
        let items = check_dir(&d.display().to_string(), "");
        assert!(items[0].ok);
        assert!(!items[1].ok, "no venv in an empty folder");
        assert!(!items[2].ok, "no aria_core in an empty folder");
        assert!(!items[3].ok, "no main.py in an empty folder");

        fs::write(d.join("main.py"), "").unwrap();
        assert!(check_dir(&d.display().to_string(), "").last().unwrap().ok, "main.py present");
    }
}
