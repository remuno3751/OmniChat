//! Small system helpers for the UI: network addresses, open data/config folder, first-run marker.

use std::fs;
use std::net::Ipv4Addr;
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Addr {
    pub name: String,
    pub ip: String,
}

#[derive(Serialize, Default)]
pub struct NetworkInfo {
    pub lan: Vec<Addr>,
    pub tailscale: Vec<Addr>,
}

/// Classify and filter: skips loopback, link-local, unspecified and docker's default bridge (172.17.x).
pub fn classify(addrs: Vec<Addr>) -> NetworkInfo {
    let mut n = NetworkInfo::default();
    for a in addrs {
        let Ok(ip) = a.ip.parse::<Ipv4Addr>() else { continue };
        let o = ip.octets();
        if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || (o[0] == 172 && o[1] == 17) {
            continue;
        }
        if o[0] == 100 && (64..=127).contains(&o[1]) {
            n.tailscale.push(a);
        } else {
            n.lan.push(a);
        }
    }
    n
}

/// `ip -o -4 addr show` lines: "2: eth0    inet 192.168.1.5/24 brd ..."
pub fn parse_ip_addr(text: &str) -> Vec<Addr> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let i = f.iter().position(|x| *x == "inet")?;
            let ip = f.get(i + 1)?.split('/').next()?.to_string();
            let name = f.get(1)?.trim_end_matches(':').to_string();
            Some(Addr { name, ip })
        })
        .collect()
}

/// The first valid IPv4 address inside `v` (digits and dots only; anything else, including garbled text, ends a candidate).
fn first_ipv4(v: &str) -> Option<String> {
    v.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|t| t.trim_matches('.'))
        .find(|t| t.parse::<Ipv4Addr>().is_ok())
        .map(|t| t.to_string())
}

/// Lines "<adapter>|<ipv4>" (PowerShell Get-NetIPAddress output).
pub fn parse_alias_ip_lines(text: &str) -> Vec<Addr> {
    text.lines()
        .filter_map(|l| {
            let (name, ip) = l.trim().rsplit_once('|')?;
            let ip = ip.trim();
            ip.parse::<Ipv4Addr>().ok()?;
            Some(Addr { name: name.trim().to_string(), ip: ip.to_string() })
        })
        .collect()
}

/// `ipconfig` text (any language): adapter headers end with ':' at column 0; IPv4 lines contain a dotted quad after ':'.
pub fn parse_ipconfig(text: &str) -> Vec<Addr> {
    let mut out = Vec::new();
    let mut adapter = String::new();
    for l in text.lines() {
        if !l.starts_with(' ') && l.trim_end().ends_with(':') {
            adapter = l.trim().trim_end_matches(':').to_string();
        } else if l.starts_with(' ') && l.contains("IPv4") {
            // the value is "192.168.0.10", "192.168.0.10(Preferred)" or a localized suffix such as "(優先)" that arrives as
            // garbage when the console code page was not UTF-8: take the first valid dotted quad after the last ':'
            if let Some(v) = l.rsplit(':').next() {
                if let Some(ip) = first_ipv4(v) {
                    out.push(Addr { name: adapter.clone(), ip });
                }
            }
        }
    }
    out
}

pub fn list_addrs() -> Vec<Addr> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // PowerShell with a UTF-8 console gives clean adapter names on any language of Windows. (ipconfig prints the
        // OEM/ANSI code page even after chcp 65001, so Japanese adapter names turn into mojibake there.)
        let ps = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { $_.InterfaceAlias + '|' + $_.IPAddress }",
            ])
            .creation_flags(0x0800_0000)
            .output()
            .map(|o| parse_alias_ip_lines(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default();
        if !ps.is_empty() {
            return ps;
        }
        let o = Command::new("ipconfig").creation_flags(0x0800_0000).output();
        o.map(|o| parse_ipconfig(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        Command::new("ip").args(["-o", "-4", "addr", "show"]).output().map(|o| parse_ip_addr(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default()
    }
}

#[tauri::command]
pub async fn network_info() -> Result<NetworkInfo, String> {
    tauri::async_runtime::spawn_blocking(|| classify(list_addrs())).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_folder(app: AppHandle, which: String) -> Result<(), String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let target = match which.as_str() {
        "data" => base.join("data"),
        "backups" => base.join("data").join("backups"),
        "config" => base.clone(),
        _ => return Err("invalid folder".into()),
    };
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    app.opener().open_path(target.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

fn marker(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("setup-done"))
}

/// True once the setup wizard has been completed (the marker file exists).
pub fn is_setup_done(app: &AppHandle) -> bool {
    marker(app).map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
pub fn setup_done_get(app: AppHandle) -> bool {
    is_setup_done(&app)
}

#[tauri::command]
pub fn setup_done_set(app: AppHandle, done: bool) -> Result<(), String> {
    let p = marker(&app)?;
    if done {
        if let Some(d) = p.parent() {
            fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        fs::write(p, "1\n").map_err(|e| e.to_string())
    } else {
        let _ = fs::remove_file(p);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ip_addr() {
        let t = "1: lo    inet 127.0.0.1/8 scope host lo\n2: eth0    inet 192.168.1.5/24 brd 192.168.1.255 scope global eth0\n3: tailscale0    inet 100.101.2.3/32 scope global tailscale0\n4: docker0    inet 172.17.0.1/16 scope global docker0\n";
        let n = classify(parse_ip_addr(t));
        assert_eq!(n.lan, vec![Addr { name: "eth0".into(), ip: "192.168.1.5".into() }]);
        assert_eq!(n.tailscale.len(), 1);
        assert_eq!(n.tailscale[0].ip, "100.101.2.3");
    }

    #[test]
    fn parses_powershell_alias_lines() {
        let t = "イーサネット|192.168.0.10\r\nTailscale|100.101.2.3\r\nLoopback Pseudo-Interface 1|127.0.0.1\r\nbad line\r\n";
        let n = classify(parse_alias_ip_lines(t));
        assert_eq!(n.lan, vec![Addr { name: "イーサネット".into(), ip: "192.168.0.10".into() }]);
        assert_eq!(n.tailscale.len(), 1);
    }

    #[test]
    fn ipconfig_survives_garbled_localized_suffix() {
        // CP932 "(優先)" read as UTF-8 becomes replacement characters; the address must still be found
        let t = "Ethernet adapter Ethernet:\r\n\r\n   IPv4 \u{FFFD}A\u{FFFD}h\u{FFFD}\u{FFFD}\u{FFFD}X . . . . : 192.168.0.10(\u{FFFD}D\u{FFFD}\u{FFFD})\r\n";
        let a = parse_ipconfig(t);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].ip, "192.168.0.10");
        assert_eq!(first_ipv4("100.101.2.3"), Some("100.101.2.3".to_string()));
        assert_eq!(first_ipv4(" abc"), None);
    }

    #[test]
    fn parses_ipconfig() {
        let t = "Windows IP Configuration\r\n\r\nEthernet adapter Ethernet:\r\n\r\n   IPv4 Address. . . . . . . . . . . : 192.168.0.10\r\n   Subnet Mask . . . . : 255.255.255.0\r\n\r\nUnknown adapter Tailscale:\r\n\r\n   IPv4 Address. . . . . . . . . . . : 100.64.1.1\r\n";
        let a = parse_ipconfig(t);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].name, "Ethernet adapter Ethernet");
        let n = classify(a);
        assert_eq!(n.lan.len(), 1);
        assert_eq!(n.tailscale.len(), 1);
    }
}
