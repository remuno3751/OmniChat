//! OmniChat desktop: a thin launcher shell.
//!
//! The main webview first shows a tiny local launcher page (../launcher). Once the user
//! has entered a server URL and it has been verified (GET {url}/version), the same
//! webview is navigated to the server, so the UI always matches the server version and
//! there is no cross-origin / mixed-content problem. Remote pages get NO Tauri IPC.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

mod updater;

const CONFIG_FILE: &str = "server.json";
const MAIN: &str = "main";
/// Where Tauri serves the bundled launcher page (Windows/Android use an http origin).
#[cfg(any(windows, target_os = "android"))]
const LAUNCHER_URL: &str = "http://tauri.localhost/";
#[cfg(not(any(windows, target_os = "android")))]
const LAUNCHER_URL: &str = "tauri://localhost/";
/// The remote web UI has no IPC, so it picks an app icon by navigating to
/// https://omnichat-desktop.invalid/icon/<id>, which on_navigation intercepts.
const ICON_HOST: &str = "omnichat-desktop.invalid";
/// The bundled icon; on macOS choosing it restores the bundle's Dock icon.
#[cfg(target_os = "macos")]
const DEFAULT_ICON: &str = "simple-contrast";

macro_rules! icons {
    ($($id:literal),*) => {
        [$(($id, include_bytes!(concat!("../icons/variants/", $id, ".png")) as &[u8])),*]
    };
}
const ICONS: [(&str, &[u8]); 8] = icons!(
    "simple-light",
    "simple-dark",
    "simple-sepia",
    "simple-contrast",
    "frontier-light",
    "frontier-dark",
    "astral-light",
    "astral-dark"
);

/// Hidden frame page of the app's own origin that opens the loopback socket to the DSH plugin (pairing requests; see launcher/dsh-bridge-frame.js).
/// WebView2 serves app assets from http://tauri.localhost, the other platforms from tauri://localhost.
#[cfg(target_os = "windows")]
const DSH_FRAME_URL: &str = "http://tauri.localhost/dsh-bridge-frame.html";
#[cfg(not(target_os = "windows"))]
const DSH_FRAME_URL: &str = "tauri://localhost/dsh-bridge-frame.html";

/// Keyboard reload for Windows/Linux (no native menu there). macOS keeps its Cmd+R menu item.
#[cfg(not(target_os = "macos"))]
const RELOAD_KEYS_JS: &str = "window.addEventListener('keydown',function(e){\
if(e.key==='F5'||((e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&(e.key==='r'||e.key==='R'))){e.preventDefault();location.reload();}\
else if((e.ctrlKey||e.metaKey)&&e.shiftKey&&!e.altKey&&(e.key==='s'||e.key==='S')){e.preventDefault();location.href='https://omnichat-desktop.invalid/change-server';}},true);";
#[cfg(target_os = "macos")]
const RELOAD_KEYS_JS: &str = "";

#[derive(Default)]
struct State {
    /// Configured server URL (e.g. "http://192.168.1.5:8787"). Mirrors serverUrl in server.json;
    /// set at startup (setup) and on every connect, so it is never missing when navigating.
    server: Mutex<Option<Url>>,
    /// Server base URL currently shown in the window (None while the launcher is shown).
    active: Mutex<Option<String>>,
}

#[derive(Serialize)]
struct CheckOk {
    url: String,
    version: String,
    web_ui: bool,
}

#[derive(Serialize)]
struct CheckErr {
    /// invalid_url | unreachable | tls | wrong_server | mixed_content | http_<status>
    code: String,
    detail: String,
}

fn err(code: &str, detail: impl Into<String>) -> CheckErr {
    CheckErr {
        code: code.into(),
        detail: detail.into(),
    }
}

/// Normalise user input into a base URL without trailing slash.
fn normalize(input: &str) -> Result<Url, CheckErr> {
    let s = input.trim();
    if s.is_empty() {
        return Err(err("invalid_url", "empty"));
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        // No scheme: plain http for LAN style hosts (IP, localhost, *.local, host:port), https otherwise.
        let host = s.split(['/', ':']).next().unwrap_or("");
        let lan = s.contains(':')
            || host == "localhost"
            || host.ends_with(".local")
            || host.chars().all(|c| c.is_ascii_digit() || c == '.');
        format!("{}://{}", if lan { "http" } else { "https" }, s)
    };
    let mut u = Url::parse(&with_scheme).map_err(|e| err("invalid_url", e.to_string()))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(err("invalid_url", "only http/https"));
    }
    if u.host_str().is_none() {
        return Err(err("invalid_url", "no host"));
    }
    u.set_query(None);
    u.set_fragment(None);
    let p = u.path().trim_end_matches('/').to_string();
    u.set_path(&p);
    Ok(u)
}

fn base_string(u: &Url) -> String {
    u.as_str().trim_end_matches('/').to_string()
}

fn http_agent() -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig};
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .http_status_as_error(false)
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into()
}

fn check_blocking(input: &str) -> Result<CheckOk, CheckErr> {
    use ureq::ResponseExt;
    let base = normalize(input)?;
    let endpoint = format!("{}/version", base_string(&base));
    let mut resp = http_agent().get(&endpoint).call().map_err(|e| {
        let d = format!("{e:?}").to_lowercase();
        if d.contains("certificate")
            || d.contains("tls")
            || d.contains("unknownissuer")
            || d.contains("pki")
            || d.contains("invalidcert")
        {
            err("tls", e.to_string())
        } else {
            err("unreachable", e.to_string())
        }
    })?;
    if base.scheme() == "https" && resp.get_uri().scheme_str() == Some("http") {
        return Err(err("mixed_content", resp.get_uri().to_string()));
    }
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(err(&format!("http_{status}"), endpoint));
    }
    let body = resp
        .body_mut()
        .with_config()
        .limit(64 * 1024)
        .read_to_string()
        .map_err(|e| err("wrong_server", e.to_string()))?;
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| err("wrong_server", "not json"))?;
    if v.get("name").and_then(|x| x.as_str()) != Some("omnichat-server") {
        return Err(err("wrong_server", "name mismatch"));
    }
    Ok(CheckOk {
        url: base_string(&base),
        version: v
            .get("version")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        web_ui: v.get("webUi").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

fn config_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(CONFIG_FILE))
}

fn load_config(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn load_key(app: &AppHandle, key: &str) -> Option<String> {
    load_config(app).get(key)?.as_str().map(|s| s.to_string())
}

/// Read-modify-write so serverUrl and appIcon survive each other. None removes the key.
fn save_key(app: &AppHandle, key: &str, value: Option<&str>) {
    let Some(p) = config_path(app) else { return };
    let mut cfg = load_config(app);
    match value {
        Some(v) => cfg.insert(key.into(), v.into()),
        None => cfg.remove(key),
    };
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(p, serde_json::Value::Object(cfg).to_string());
}

fn load_saved(app: &AppHandle) -> Option<String> {
    load_key(app, "serverUrl")
}

fn save_server(app: &AppHandle, url: &str) {
    save_key(app, "serverUrl", Some(url));
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn js_replace(w: &WebviewWindow, target: &str) {
    let lit = serde_json::to_string(target).unwrap_or_default();
    let _ = w.eval(format!("location.replace({lit})"));
}

fn go_launcher(app: &AppHandle, query: &str) {
    let st = app.state::<State>();
    *st.active.lock().unwrap() = None;
    if let (Some(w), Ok(mut u)) = (main_window(app), Url::parse(LAUNCHER_URL)) {
        u.set_query(if query.is_empty() { None } else { Some(query) });
        js_replace(&w, u.as_str());
    }
}

#[tauri::command]
fn get_saved_server(app: AppHandle) -> Option<String> {
    load_saved(&app)
}

#[tauri::command]
async fn check_server(url: String) -> Result<CheckOk, CheckErr> {
    tauri::async_runtime::spawn_blocking(move || check_blocking(&url))
        .await
        .map_err(|e| err("unreachable", e.to_string()))?
}

/// Verify, remember and navigate the main webview to the server.
#[tauri::command]
async fn connect(app: AppHandle, url: String) -> Result<CheckOk, CheckErr> {
    let ok = check_server(url).await?;
    save_server(&app, &ok.url);
    {
        let st = app.state::<State>();
        *st.server.lock().unwrap() = Url::parse(&ok.url).ok();
        *st.active.lock().unwrap() = Some(ok.url.clone());
    }
    if let Some(w) = main_window(&app) {
        js_replace(&w, &format!("{}/", ok.url));
    }
    Ok(ok)
}

#[tauri::command]
fn forget_server(app: AppHandle) {
    save_key(&app, "serverUrl", None);
    *app.state::<State>().server.lock().unwrap() = None;
}

/// The configured server, from memory or (if memory was never filled) from the saved config.
fn current_server(app: &AppHandle) -> Option<Url> {
    let cached = app.state::<State>().server.lock().unwrap().clone();
    cached.or_else(|| load_saved(app).and_then(|s| Url::parse(&s).ok()))
}

/// Windows/Linux: replace the main window's icon (taskbar / title bar).
#[cfg(not(target_os = "macos"))]
fn apply_icon(app: &AppHandle, _id: &str, png: &'static [u8]) {
    if let (Some(w), Ok(img)) = (main_window(app), tauri::image::Image::from_bytes(png)) {
        let _ = w.set_icon(img);
    }
}

/// macOS has no window icons: swap the Dock icon (None restores the bundle icon).
#[cfg(target_os = "macos")]
fn apply_icon(app: &AppHandle, id: &str, png: &'static [u8]) {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    let default = id == DEFAULT_ICON;
    let _ = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let img = if default {
            None
        } else {
            NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png))
        };
        // SAFETY: on the main thread; a None image is allowed.
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(img.as_deref()) };
    });
}

/// Apply and remember an icon by id; unknown ids are ignored.
fn set_app_icon(app: &AppHandle, id: &str, persist: bool) {
    let Some(&(id, png)) = ICONS.iter().find(|(k, _)| *k == id) else {
        return;
    };
    apply_icon(app, id, png);
    if persist {
        save_key(app, "appIcon", Some(id));
    }
}

/// Handle signals from the web UI on https://omnichat-desktop.invalid/...
/// /icon/<id> sets the icon; /change-server returns to the launcher. Returns true if the URL was ours.
fn handle_desktop_url(app: &AppHandle, u: &Url) -> bool {
    if u.host_str() != Some(ICON_HOST) {
        return false;
    }
    if u.path() == "/change-server" {
        go_launcher(app, "change=1");
    } else if let Some(id) = u.path().strip_prefix("/icon/") {
        set_app_icon(app, id, true);
    }
    true
}

/// Loopback names that reach the same machine count as one host.
fn canon_host(h: &str) -> &str {
    match h {
        "localhost" | "127.0.0.1" | "[::1]" | "::1" => "loopback",
        other => other,
    }
}

/// Same host as the configured server, over http or https, on any port. The server's own
/// redirects (http->https, port or loopback-name changes) therefore stay in the window.
fn is_server_host(u: &Url, server: &Url) -> bool {
    matches!(u.scheme(), "http" | "https")
        && u.host_str().is_some()
        && u.host_str().map(canon_host) == server.host_str().map(canon_host)
}

fn is_internal(u: &Url, server: Option<&Url>) -> bool {
    if matches!(
        u.scheme(),
        "tauri" | "ipc" | "about" | "blob" | "data" | "asset"
    ) {
        return true;
    }
    // Windows/Android serve the launcher from http(s)://tauri.localhost
    if matches!(
        u.host_str(),
        Some("tauri.localhost") | Some("ipc.localhost") | Some("asset.localhost")
    ) {
        return true;
    }
    server.is_some_and(|s| is_server_host(u, s))
}

fn open_external(app: &AppHandle, u: &Url) {
    if matches!(u.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(u.as_str(), None::<&str>);
    }
}

/// macOS only: the native menu bar (needed for Cmd+C/V/Q etc.). Windows/Linux get no menu bar,
/// because the native one is not themed; reload (F5/Ctrl+R) and Change server are in-app instead.
fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(not(target_os = "macos"))]
    {
        app.remove_menu()?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let change = MenuItemBuilder::with_id("change_server", "Change server… / サーバーを変更…")
            .accelerator("CmdOrCtrl+Shift+S")
            .build(app)?;
        let reload = MenuItemBuilder::with_id("reload", "Reload / 再読み込み")
            .accelerator("CmdOrCtrl+R")
            .build(app)?;
        let appm = SubmenuBuilder::new(app, "OmniChat")
            .about(None)
            .separator()
            .item(&change)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let edit = SubmenuBuilder::new(app, "Edit / 編集")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        let view = SubmenuBuilder::new(app, "View / 表示")
            .item(&reload)
            .fullscreen()
            .build()?;
        let window = SubmenuBuilder::new(app, "Window / ウィンドウ")
            .minimize()
            .maximize()
            .close_window()
            .build()?;
        let menu = MenuBuilder::new(app)
            .item(&appm)
            .item(&edit)
            .item(&view)
            .item(&window)
            .build()?;
        app.set_menu(menu)?;
        Ok(())
    }
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// Background watchdog: if the server stays unreachable while its UI is shown, swap in the
/// local retry page (Retry / Change server) instead of a browser error page.
fn spawn_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        let mut fails = 0u32;
        loop {
            std::thread::sleep(Duration::from_secs(10));
            let active = app.state::<State>().active.lock().unwrap().clone();
            let Some(url) = active else {
                fails = 0;
                continue;
            };
            match check_blocking(&url) {
                Err(e) if e.code == "unreachable" => {
                    fails += 1;
                    if fails >= 3 {
                        fails = 0;
                        go_launcher(&app, &format!("retry=1&url={}", urlencode(&url)));
                    }
                }
                _ => fails = 0,
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = main_window(app) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .manage(State::default())
        .manage(updater::UpdateCtx::default())
        .invoke_handler(tauri::generate_handler![
            get_saved_server,
            check_server,
            connect,
            forget_server,
            updater::update_info,
            updater::update_skip,
            updater::update_later,
            updater::update_install
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            build_menu(&handle)?;
            app.on_menu_event(|app, ev| match ev.id().as_ref() {
                "change_server" => go_launcher(app, "change=1"),
                "reload" => {
                    if let Some(w) = main_window(app) {
                        let _ = w.eval("location.reload()");
                    }
                }
                _ => {}
            });

            // Remember the configured server before any navigation, so the origin check never
            // lacks it (e.g. auto-connect at startup, or a server saved by an earlier version).
            if let Some(s) = load_saved(&handle).and_then(|s| Url::parse(&s).ok()) {
                *handle.state::<State>().server.lock().unwrap() = Some(s);
            }

            let nav_app = handle.clone();
            let win_app = handle.clone();
            WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("OmniChat")
                .inner_size(1100.0, 760.0)
                .min_inner_size(420.0, 480.0)
                .initialization_script(format!(
                    "window.__OMNICHAT_DESKTOP__ = {{ appIcon: 1, version: \"{ver}\", dshFrame: \"{frame}\" }};{RELOAD_KEYS_JS}",
                    ver = env!("CARGO_PKG_VERSION"),
                    frame = DSH_FRAME_URL
                ))
                .on_navigation(move |u| {
                    // Signals from the web UI (icon, change server): handled, never navigated.
                    if handle_desktop_url(&nav_app, u) {
                        return false;
                    }
                    if is_internal(u, current_server(&nav_app).as_ref()) {
                        true
                    } else {
                        open_external(&nav_app, u);
                        false
                    }
                })
                .on_new_window(move |u, _features| {
                    if !handle_desktop_url(&win_app, &u) {
                        if is_internal(&u, current_server(&win_app).as_ref()) {
                            // A popup on the server (e.g. a login window) stays in this window.
                            if let Some(w) = main_window(&win_app) {
                                js_replace(&w, u.as_str());
                            }
                        } else {
                            open_external(&win_app, &u);
                        }
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            if let Some(id) = load_key(&handle, "appIcon") {
                set_app_icon(&handle, &id, false);
            }
            spawn_watchdog(handle.clone());
            updater::spawn_check(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OmniChat");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_host_matching() {
        let server = Url::parse("http://192.168.1.5:8787").unwrap();
        let ok = |s: &str| is_server_host(&Url::parse(s).unwrap(), &server);
        assert!(ok("http://192.168.1.5:8787/"));
        assert!(ok("https://192.168.1.5/login"));
        assert!(!ok("https://accounts.example.com/"));
        assert!(!ok("file:///192.168.1.5/x"));
        let loop_server = Url::parse("http://localhost:8787").unwrap();
        assert!(is_server_host(&Url::parse("http://127.0.0.1:8787/").unwrap(), &loop_server));
    }
}
