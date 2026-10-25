//! Desktop pet window (v0.5.6): a small, transparent, always-on-top window on the OS desktop that shows
//! the pet from the server's web UI (`/?desktopPet=1`).
//!
//! Signals arrive as navigations to https://omnichat-desktop.invalid/pet/<op>?id=<n>[&x=<int>&y=<int>],
//! from the main window (show / hide / status) or from the pet window itself (drag / hide / focus). The pet
//! window has no IPC and no capability; its URL is built here from the stored server URL, never by the page.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Once;
use std::time::Duration;

use serde_json::json;
use tauri::{
    AppHandle, Manager, PhysicalPosition, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

pub const PET_LABEL: &str = "pet";
const PET_FILE: &str = "pet-window.json";
/// Logical size of the pet window.
const PET_W: f64 = 320.0;
const PET_H: f64 = 360.0;
/// At least this many px (per axis) of the window must stay on some monitor.
const MIN_VISIBLE: i32 = 80;
/// Default distance from the primary monitor's work area corner, in logical px.
const MARGIN: f64 = 24.0;
/// Position saves wait this long after the last Moved event.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);
/// Largest accepted coordinate (absolute value), physical px.
const COORD_LIMIT: i32 = 100_000;

/// Pet bridge for the pet window's own page (initialization script). Drag and hide are fire-and-forget;
/// focus answers via `__resolve(id, result)`, which the shell evals on the pet window (see `reply_pet`).
pub const PET_BRIDGE_JS: &str = "(function(){var d=window.__OMNICHAT_DESKTOP__||(window.__OMNICHAT_DESKTOP__={});var n=0,P={};\
function go(p){location.href='https://omnichat-desktop.invalid/pet/'+p+'?id='+(++n);}\
d.__resolve=function(id,v){var p=P[id];if(p){delete P[id];clearTimeout(p.t);p.r(v);}};\
d.pet=true;d.petDrag=function(){go('drag');};d.petHide=function(){go('hide');};\
d.petFocusApp=function(){return new Promise(function(res){var id=String(++n);\
P[id]={r:res,t:setTimeout(function(){if(P[id]){delete P[id];res({ok:false});}},3000)};\
location.href='https://omnichat-desktop.invalid/pet/focus?id='+id;});};})();";

/// A parsed /pet/... signal.
#[derive(Debug, PartialEq)]
pub enum PetCall {
    Show { id: String, pos: Option<(i32, i32)> },
    Hide { id: String },
    Status { id: String },
    Drag { id: String },
    Focus { id: String },
}

/// Which side may send a call: drag and focus come from the pet window only, show and status from the main
/// window only, and hide from either.
pub fn allowed_from(call: &PetCall, from_pet: bool) -> bool {
    match call {
        PetCall::Drag { .. } | PetCall::Focus { .. } => from_pet,
        PetCall::Show { .. } | PetCall::Status { .. } => !from_pet,
        PetCall::Hide { .. } => true,
    }
}

fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit())
}

fn parse_coord(s: &str) -> Option<i32> {
    let v: i32 = s.parse().ok()?;
    (v.abs() <= COORD_LIMIT).then_some(v)
}

/// `/pet/show` takes both x and y or neither; a malformed position rejects the whole call.
pub fn parse_pet_call(u: &Url) -> Option<PetCall> {
    let op = u.path().strip_prefix("/pet/")?;
    let mut id = None;
    let mut x = None;
    let mut y = None;
    for (k, val) in u.query_pairs() {
        match k.as_ref() {
            "id" => id = Some(val.to_string()),
            "x" => x = Some(val.to_string()),
            "y" => y = Some(val.to_string()),
            _ => {}
        }
    }
    let id = id.filter(|s| valid_id(s))?;
    match op {
        "show" => {
            let pos = match (x, y) {
                (None, None) => None,
                (Some(x), Some(y)) => Some((parse_coord(&x)?, parse_coord(&y)?)),
                _ => return None,
            };
            Some(PetCall::Show { id, pos })
        }
        "hide" => Some(PetCall::Hide { id }),
        "status" => Some(PetCall::Status { id }),
        "drag" => Some(PetCall::Drag { id }),
        "focus" => Some(PetCall::Focus { id }),
        _ => None,
    }
}

/// A rectangle in physical px.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn right(&self) -> i32 {
        self.x + self.w
    }
    fn bottom(&self) -> i32 {
        self.y + self.h
    }
    fn overlap(&self, o: &Rect) -> i64 {
        let w = (self.right().min(o.right()) - self.x.max(o.x)).max(0) as i64;
        let h = (self.bottom().min(o.bottom()) - self.y.max(o.y)).max(0) as i64;
        w * h
    }
    /// Squared distance between centers, in doubled coordinates (no halves).
    fn center_dist2(&self, o: &Rect) -> i64 {
        let dx = (self.x * 2 + self.w - (o.x * 2 + o.w)) as i64;
        let dy = (self.y * 2 + self.h - (o.y * 2 + o.h)) as i64;
        dx * dx + dy * dy
    }
}

/// Moves a `w` x `h` window at (x, y) so that at least 80x80 px of it (or all of it, if smaller) lie inside
/// one of `areas`: the area with the largest overlap, or the nearest one when nothing overlaps.
pub fn fit_position(x: i32, y: i32, w: i32, h: i32, areas: &[Rect]) -> Option<(i32, i32)> {
    let win = Rect { x, y, w, h };
    let a = areas
        .iter()
        .min_by_key(|a| (-a.overlap(&win), a.center_dist2(&win)))?;
    let mw = MIN_VISIBLE.min(w);
    let mh = MIN_VISIBLE.min(h);
    let lo_x = a.x + mw - w;
    let hi_x = a.right() - mw;
    let lo_y = a.y + mh - h;
    let hi_y = a.bottom() - mh;
    Some((x.max(lo_x).min(hi_x), y.max(lo_y).min(hi_y)))
}

/// Bottom-right corner of `work` with `margin` px to the edges.
pub fn default_position(work: Rect, w: i32, h: i32, margin: i32) -> (i32, i32) {
    (work.right() - w - margin, work.bottom() - h - margin)
}

/// Reads `{"x":<int>,"y":<int>}` from pet-window.json; anything else is None.
pub fn parse_saved(s: &str) -> Option<(i32, i32)> {
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    let x = i32::try_from(v.get("x")?.as_i64()?).ok()?;
    let y = i32::try_from(v.get("y")?.as_i64()?).ok()?;
    (x.abs() <= COORD_LIMIT && y.abs() <= COORD_LIMIT).then_some((x, y))
}

fn pet_url(app: &AppHandle) -> Option<Url> {
    let server = crate::current_server(app)?;
    Url::parse(&format!("{}/?desktopPet=1", server.origin().ascii_serialization())).ok()
}

fn config_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(PET_FILE))
}

fn load_pos(app: &AppHandle) -> Option<(i32, i32)> {
    parse_saved(&std::fs::read_to_string(config_file(app)?).ok()?)
}

fn write_pos(app: &AppHandle, x: i32, y: i32) {
    let Some(p) = config_file(app) else { return };
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(p, json!({ "x": x, "y": y }).to_string());
}

/// Work areas of all monitors, physical px.
fn work_areas(app: &AppHandle) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let r = m.work_area();
            Rect {
                x: r.position.x,
                y: r.position.y,
                w: r.size.width as i32,
                h: r.size.height as i32,
            }
        })
        .collect()
}

/// The pet window should be on screen (set by show, cleared by close). The keep-alive thread brings it back when the
/// window is gone or hidden (e.g. the main window was minimized) while this is set.
static WANT: AtomicBool = AtomicBool::new(false);
static KEEPALIVE: Once = Once::new();
const KEEPALIVE_EVERY: Duration = Duration::from_secs(2);

/// Starts (once) the thread that keeps the pet window visible and on top while it is wanted.
fn spawn_keepalive(app: &AppHandle) {
    let app = app.clone();
    KEEPALIVE.call_once(move || {
        std::thread::spawn(move || loop {
            std::thread::sleep(KEEPALIVE_EVERY);
            if !WANT.load(Ordering::SeqCst) {
                continue;
            }
            match app.get_webview_window(PET_LABEL) {
                Some(w) => {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                    let _ = w.set_always_on_top(true);
                }
                None => {
                    // only while the main window still exists: the pet must not keep a closing app alive
                    if app.get_webview_window("main").is_some() {
                        show(&app, None);
                    }
                }
            }
        });
    });
}

/// Latest Moved event wins: each one bumps the sequence, and only the last save after the debounce writes.
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

fn schedule_save(app: &AppHandle, x: i32, y: i32) {
    let seq = SAVE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_DEBOUNCE);
        if SAVE_SEQ.load(Ordering::SeqCst) == seq {
            write_pos(&app, x, y);
        }
    });
}

/// Shows the pet window, creating it if needed. Runs on a worker thread (window creation must not block the
/// navigation handler). Returns whether the window is shown.
fn show(app: &AppHandle, pos: Option<(i32, i32)>) -> bool {
    let Some(url) = pet_url(app) else { return false };
    let primary = app.primary_monitor().ok().flatten();
    let scale = primary.as_ref().map_or(1.0, |m| m.scale_factor());
    let w = (PET_W * scale).round() as i32;
    let h = (PET_H * scale).round() as i32;
    let areas = work_areas(app);
    let default = primary.map(|m| {
        let r = m.work_area();
        let work = Rect {
            x: r.position.x,
            y: r.position.y,
            w: r.size.width as i32,
            h: r.size.height as i32,
        };
        default_position(work, w, h, (MARGIN * scale).round() as i32)
    });
    let target = pos
        .or_else(|| load_pos(app))
        .or(default)
        .and_then(|(x, y)| fit_position(x, y, w, h, &areas));

    WANT.store(true, Ordering::SeqCst);
    spawn_keepalive(app);
    if let Some(existing) = app.get_webview_window(PET_LABEL) {
        // Moving only when a position was asked for: otherwise keep where it is now.
        if let (Some((x, y)), Some(_)) = (target, pos) {
            let _ = existing.set_position(PhysicalPosition::new(x, y));
        }
        return existing.show().is_ok();
    }

    let app_move = app.clone();
    let app_nav = app.clone();
    let app_new = app.clone();
    let built = WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::External(url))
        .title("OmniChat Pet")
        .inner_size(PET_W, PET_H)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible_on_all_workspaces(true)
        .visible(false)
        .initialization_script(PET_BRIDGE_JS)
        .on_navigation(move |u| navigation(&app_nav, u))
        .on_new_window(move |u, _features| {
            if !crate::handle_desktop_url(&app_new, &u, true) {
                crate::open_external(&app_new, &u);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build();
    let Ok(win) = built else { return false };
    win.on_window_event(move |ev| {
        if let WindowEvent::Moved(p) = ev {
            schedule_save(&app_move, p.x, p.y);
        }
    });
    if let Some((x, y)) = target {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    win.show().is_ok()
}

/// Closes the pet window (if any). Also used when the main window goes away.
pub fn close(app: &AppHandle) {
    WANT.store(false, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(PET_LABEL) {
        let _ = w.close();
    }
}

fn visible(app: &AppHandle) -> bool {
    app.get_webview_window(PET_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// Navigation policy for the pet window: our signals are handled and cancelled; the server and about:blank load;
/// any other http(s) link opens in the browser and is cancelled.
fn navigation(app: &AppHandle, u: &Url) -> bool {
    if crate::handle_desktop_url(app, u, true) {
        return false;
    }
    let ours = u.as_str() == "about:blank"
        || crate::current_server(app).is_some_and(|s| crate::is_server_host(u, &s));
    if !ours {
        crate::open_external(app, u);
    }
    ours
}

/// Answers a request from the pet window: evals `__resolve(id, result)` on the pet page (see PET_BRIDGE_JS).
fn reply_pet(app: &AppHandle, id: &str, result: serde_json::Value) {
    if let Some(w) = app.get_webview_window(PET_LABEL) {
        let _ = w.eval(format!(
            "(function(){{var d=window.__OMNICHAT_DESKTOP__;if(d&&d.__resolve)d.__resolve(\"{id}\",{result});}})();"
        ));
    }
}

/// Shows, unminimizes and focuses the main window. Best effort: the OS may refuse focus stealing.
fn focus_main(app: &AppHandle) -> bool {
    let Some(w) = app.get_webview_window("main") else { return false };
    let shown = w.show().is_ok();
    let _ = w.unminimize();
    let focused = w.set_focus().is_ok();
    shown && focused
}

/// Runs a /pet/... signal. `from_pet` is true for requests from the pet window itself (see `allowed_from`).
pub fn handle(app: &AppHandle, call: PetCall, from_pet: bool) {
    if !allowed_from(&call, from_pet) {
        return;
    }
    let app = app.clone();
    match call {
        PetCall::Drag { .. } => {
            std::thread::spawn(move || {
                if let Some(w) = app.get_webview_window(PET_LABEL) {
                    let _ = w.start_dragging();
                }
            });
        }
        PetCall::Focus { id } => {
            std::thread::spawn(move || {
                let ok = focus_main(&app);
                reply_pet(&app, &id, json!({ "ok": ok }));
            });
        }
        PetCall::Show { id, pos } => {
            std::thread::spawn(move || {
                let ok = show(&app, pos);
                crate::reply_update(&app, &id, json!({ "ok": ok }));
            });
        }
        PetCall::Status { id } => {
            std::thread::spawn(move || {
                let v = visible(&app);
                crate::reply_update(&app, &id, json!({ "visible": v }));
            });
        }
        PetCall::Hide { id } => {
            std::thread::spawn(move || {
                close(&app);
                if !from_pet {
                    crate::reply_update(&app, &id, json!({ "ok": true }));
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn pet_call_parsing() {
        let p = |s: &str| parse_pet_call(&Url::parse(s).unwrap());
        let h = "https://omnichat-desktop.invalid/pet";
        assert_eq!(p(&format!("{h}/show?id=3")), Some(PetCall::Show { id: "3".into(), pos: None }));
        assert_eq!(
            p(&format!("{h}/show?id=3&x=-10&y=200")),
            Some(PetCall::Show { id: "3".into(), pos: Some((-10, 200)) })
        );
        assert_eq!(p(&format!("{h}/show?id=3&x=5")), None);
        assert_eq!(p(&format!("{h}/show?id=3&x=5&y=x")), None);
        assert_eq!(p(&format!("{h}/show?id=3&x=100001&y=0")), None);
        assert!(p(&format!("{h}/show?id=3&x=99999&y=-99999")).is_some());
        assert_eq!(p(&format!("{h}/show")), None);
        assert_eq!(p(&format!("{h}/show?id=x")), None);
        assert_eq!(p(&format!("{h}/show?id=1234567890")), None);
        assert_eq!(p(&format!("{h}/hide?id=4")), Some(PetCall::Hide { id: "4".into() }));
        assert_eq!(p(&format!("{h}/status?id=5")), Some(PetCall::Status { id: "5".into() }));
        assert_eq!(p(&format!("{h}/drag?id=6")), Some(PetCall::Drag { id: "6".into() }));
        assert_eq!(p(&format!("{h}/drag")), None);
        assert_eq!(p(&format!("{h}/focus?id=7")), Some(PetCall::Focus { id: "7".into() }));
        assert_eq!(p(&format!("{h}/focus?id=x")), None);
        assert_eq!(p(&format!("{h}/focus")), None);
        assert_eq!(p(&format!("{h}/focus?id=1234567890")), None);
        assert_eq!(p(&format!("{h}/nope?id=1")), None);
        assert_eq!(p("https://omnichat-desktop.invalid/update/check?id=1"), None);
    }

    #[test]
    fn focus_is_only_allowed_from_the_pet_window() {
        let focus = PetCall::Focus { id: "1".into() };
        assert!(allowed_from(&focus, true));
        assert!(!allowed_from(&focus, false));
        let drag = PetCall::Drag { id: "1".into() };
        assert!(allowed_from(&drag, true));
        assert!(!allowed_from(&drag, false));
        let show = PetCall::Show { id: "1".into(), pos: None };
        assert!(!allowed_from(&show, true));
        assert!(allowed_from(&show, false));
        let hide = PetCall::Hide { id: "1".into() };
        assert!(allowed_from(&hide, true));
        assert!(allowed_from(&hide, false));
    }

    #[test]
    fn fit_keeps_visible_window_as_is() {
        let areas = [r(0, 0, 1920, 1040)];
        assert_eq!(fit_position(100, 100, 320, 360, &areas), Some((100, 100)));
    }

    #[test]
    fn fit_pulls_offscreen_windows_back() {
        let areas = [r(0, 0, 1920, 1040)];
        // Far right: at least 80 px must remain inside.
        assert_eq!(fit_position(5000, 100, 320, 360, &areas), Some((1840, 100)));
        // Far left: 80 px of the window (its right edge) must remain inside.
        assert_eq!(fit_position(-5000, 100, 320, 360, &areas), Some((-240, 100)));
        // Far below.
        assert_eq!(fit_position(100, 5000, 320, 360, &areas), Some((100, 1040 - 80)));
        // Far above.
        assert_eq!(fit_position(100, -5000, 320, 360, &areas), Some((100, -280)));
    }

    #[test]
    fn fit_uses_the_monitor_with_most_overlap() {
        let areas = [r(0, 0, 1920, 1040), r(1920, 0, 1920, 1080)];
        // Mostly on the second monitor: stays.
        assert_eq!(fit_position(2000, 100, 320, 360, &areas), Some((2000, 100)));
        // Straddling: the second monitor has more of it, and the window already fits there.
        assert_eq!(fit_position(1800, 100, 320, 360, &areas), Some((1800, 100)));
    }

    #[test]
    fn fit_handles_monitors_at_negative_coordinates_and_gaps() {
        let areas = [r(-1920, 0, 1920, 1040)];
        assert_eq!(fit_position(-1000, 10, 320, 360, &areas), Some((-1000, 10)));
        assert_eq!(fit_position(3000, 10, 320, 360, &areas), Some((-80, 10)));
        // Nothing overlaps (the monitor it was saved on is gone): the nearest monitor wins and the window is pulled in.
        let far = [r(0, 0, 1000, 1000), r(5000, 5000, 1000, 1000)];
        assert_eq!(fit_position(4000, 4000, 320, 360, &far), Some((4760, 4720)));
    }

    #[test]
    fn fit_without_monitors_is_none() {
        assert_eq!(fit_position(0, 0, 320, 360, &[]), None);
    }

    #[test]
    fn default_is_bottom_right_with_margin() {
        assert_eq!(default_position(r(0, 0, 1920, 1040), 320, 360, 24), (1576, 656));
        assert_eq!(default_position(r(1920, 40, 1920, 1000), 320, 360, 36), (3484, 644));
    }

    #[test]
    fn saved_position_parsing() {
        assert_eq!(parse_saved(r#"{"x":10,"y":-20}"#), Some((10, -20)));
        assert_eq!(parse_saved(r#"{"x":10}"#), None);
        assert_eq!(parse_saved(r#"{"x":"10","y":5}"#), None);
        assert_eq!(parse_saved(r#"{"x":10.5,"y":5}"#), None);
        assert_eq!(parse_saved(r#"{"x":9999999999,"y":5}"#), None);
        assert_eq!(parse_saved(r#"{"x":500000,"y":5}"#), None);
        assert_eq!(parse_saved("not json"), None);
    }
}
