//! Background start and tray status text. The decisions and texts are pure functions (unit-tested); the preferences are
//! stored in `background.json` next to `autostart.json` and read tolerantly (missing or broken file -> defaults).

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundPrefs {
    pub start_in_background: bool,
    pub always_hidden: bool,
}

impl Default for BackgroundPrefs {
    fn default() -> Self {
        Self { start_in_background: true, always_hidden: false }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// pure parts

/// Whether the main window is shown at launch. First match wins:
/// second instance -> show; first run -> show; always hidden -> hide; `--background` -> hide;
/// autostart launch with "start in background" -> hide; otherwise show.
pub fn should_show_window(
    first_run: bool,
    autostart_flag: bool,
    background_flag: bool,
    opt_start_in_background: bool,
    opt_always_hidden: bool,
    is_second_instance: bool,
) -> bool {
    if is_second_instance {
        return true;
    }
    if first_run {
        return true;
    }
    if opt_always_hidden {
        return false;
    }
    if background_flag {
        return false;
    }
    if autostart_flag && opt_start_in_background {
        return false;
    }
    true
}

/// Tolerant parse: anything that is not a JSON object, and any key that is missing or not a bool, keeps its default.
pub fn parse_prefs(text: &str) -> BackgroundPrefs {
    let mut p = BackgroundPrefs::default();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return p };
    if let Some(b) = v.get("startInBackground").and_then(|x| x.as_bool()) {
        p.start_in_background = b;
    }
    if let Some(b) = v.get("alwaysHidden").and_then(|x| x.as_bool()) {
        p.always_hidden = b;
    }
    p
}

pub fn prefs_json(p: &BackgroundPrefs) -> String {
    serde_json::to_string(p).unwrap_or_else(|_| "{}".into())
}

/// Running -> "Running — http://{ip}:{port}" (ip falls back to "localhost"); stopped -> "Stopped".
pub fn tray_status_text(running: bool, ip: Option<&str>, port: u16) -> String {
    if running {
        let host = ip.filter(|s| !s.is_empty()).unwrap_or("localhost");
        format!("Running — http://{host}:{port}")
    } else {
        "Stopped".into()
    }
}

pub fn tray_tooltip(running: bool, port: u16) -> String {
    if running {
        format!("OmniChat Server — running on port {port}")
    } else {
        "OmniChat Server — stopped".into()
    }
}

// ---------------------------------------------------------------------------------------------------------------
// settings and commands

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("background.json"))
}

pub fn load_prefs(app: &AppHandle) -> BackgroundPrefs {
    prefs_path(app).and_then(|p| fs::read_to_string(p).ok()).map(|t| parse_prefs(&t)).unwrap_or_default()
}

#[tauri::command]
pub fn background_get(app: AppHandle) -> BackgroundPrefs {
    load_prefs(&app)
}

#[tauri::command]
pub fn background_set(app: AppHandle, start_in_background: bool, always_hidden: bool) -> Result<BackgroundPrefs, String> {
    let p = BackgroundPrefs { start_in_background, always_hidden };
    let path = prefs_path(&app).ok_or("no app data dir")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, prefs_json(&p) + "\n").map_err(|e| e.to_string())?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_visibility_table() {
        // (first_run, autostart, background_flag, start_in_background, always_hidden, second_instance, expected)
        let table: &[(bool, bool, bool, bool, bool, bool, bool)] = &[
            // second instance always shows, whatever else is set
            (false, false, false, false, false, true, true),
            (true, true, true, true, true, true, true),
            // first run always shows
            (true, false, false, true, false, false, true),
            (true, true, true, true, true, false, true),
            // always hidden hides
            (false, false, false, false, true, false, false),
            (false, true, false, false, true, false, false),
            // --background hides
            (false, false, true, false, false, false, false),
            // autostart hides only when start-in-background is on
            (false, true, false, true, false, false, false),
            (false, true, false, false, false, false, true),
            // interactive start shows
            (false, false, false, true, false, false, true),
            (false, false, false, false, false, false, true),
        ];
        for &(first, auto, bg, sib, hidden, second, want) in table {
            assert_eq!(should_show_window(first, auto, bg, sib, hidden, second), want, "{:?}", (first, auto, bg, sib, hidden, second));
        }
    }

    #[test]
    fn precedence_holds_for_all_64_combinations() {
        for bits in 0u8..64 {
            let b = |i: u8| bits & (1 << i) != 0;
            let (first, auto, bg, sib, hidden, second) = (b(0), b(1), b(2), b(3), b(4), b(5));
            let got = should_show_window(first, auto, bg, sib, hidden, second);
            let ctx = (first, auto, bg, sib, hidden, second);
            if second {
                assert!(got, "second instance must show: {ctx:?}");
            } else if first {
                assert!(got, "first run must show: {ctx:?}");
            } else if hidden {
                assert!(!got, "always hidden must hide: {ctx:?}");
            } else if bg {
                assert!(!got, "--background must hide: {ctx:?}");
            } else if auto && sib {
                assert!(!got, "autostart + start-in-background must hide: {ctx:?}");
            } else {
                assert!(got, "default must show: {ctx:?}");
            }
        }
    }

    #[test]
    fn prefs_defaults() {
        let d = BackgroundPrefs::default();
        assert!(d.start_in_background);
        assert!(!d.always_hidden);
        assert_eq!(parse_prefs(""), d);
        assert_eq!(parse_prefs("{}"), d);
        assert_eq!(parse_prefs("null"), d);
        assert_eq!(parse_prefs("[1,2]"), d);
    }

    #[test]
    fn prefs_partial_and_wrong_types() {
        let p = parse_prefs(r#"{"alwaysHidden":true}"#);
        assert!(p.start_in_background && p.always_hidden);
        let p = parse_prefs(r#"{"startInBackground":false}"#);
        assert!(!p.start_in_background && !p.always_hidden);
        let p = parse_prefs(r#"{"startInBackground":"no","alwaysHidden":1}"#);
        assert_eq!(p, BackgroundPrefs::default());
    }

    #[test]
    fn prefs_garbage_gives_defaults() {
        for bad in ["{", "garbage", "\u{0}\u{1}", "{\"startInBackground\":", "\u{feff}"] {
            assert_eq!(parse_prefs(bad), BackgroundPrefs::default(), "{bad:?}");
        }
    }

    #[test]
    fn prefs_json_roundtrip_uses_camel_case() {
        let p = BackgroundPrefs { start_in_background: false, always_hidden: true };
        let s = prefs_json(&p);
        assert_eq!(s, r#"{"startInBackground":false,"alwaysHidden":true}"#);
        assert_eq!(parse_prefs(&s), p);
    }

    #[test]
    fn tray_texts() {
        assert_eq!(tray_status_text(true, Some("192.168.0.10"), 8787), "Running — http://192.168.0.10:8787");
        assert_eq!(tray_status_text(true, None, 9000), "Running — http://localhost:9000");
        assert_eq!(tray_status_text(true, Some(""), 9000), "Running — http://localhost:9000");
        assert_eq!(tray_status_text(false, Some("192.168.0.10"), 8787), "Stopped");
        assert_eq!(tray_tooltip(true, 8787), "OmniChat Server — running on port 8787");
        assert_eq!(tray_tooltip(false, 8787), "OmniChat Server — stopped");
    }
}
