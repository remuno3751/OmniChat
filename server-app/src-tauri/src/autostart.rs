//! Autostart with a delayed start. Per OS (all per-user, no admin):
//! - Windows: Scheduled Task with a logon trigger + delay (fallback: HKCU Run key + internal `--autostart-delay`)
//! - Linux: systemd --user unit with ExecStartPre sleep (fallback: ~/.config/autostart .desktop with sleep)
//!
//! The pure parts (XML / unit generation, delay parsing, arg parsing, network readiness) are unit-tested.
#![allow(dead_code)]

use std::fs;
use std::net::IpAddr;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

pub const DEFAULT_DELAY: u32 = 30;
pub const MAX_DELAY: u32 = 300;
pub const NET_WAIT_MAX: Duration = Duration::from_secs(120);
const TASK_NAME: &str = "OmniChat Server Autostart";
const RUN_VALUE: &str = "OmniChatServer";
const UNIT_NAME: &str = "omnichat-server.service";
const DESKTOP_NAME: &str = "omnichat-server.desktop";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AutostartInfo {
    pub supported: bool,
    pub enabled: bool,
    pub delay_secs: u32,
    /// "task" | "run-key" | "systemd" | "desktop" | "none"
    pub mechanism: String,
    pub wait_network: bool,
}

// ---------------------------------------------------------------------------------------------------------------
// pure parts

/// Tolerant parse: "45", " 45 ", "45s", "1e2" -> default; clamps to 0..=300.
pub fn parse_delay(s: &str) -> u32 {
    let t = s.trim().trim_end_matches(|c: char| c == 's' || c == 'S').trim();
    match t.parse::<i64>() {
        Ok(n) => n.clamp(0, MAX_DELAY as i64) as u32,
        Err(_) => DEFAULT_DELAY,
    }
}

pub fn clamp_delay(n: u32) -> u32 {
    n.min(MAX_DELAY)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// Task Scheduler XML (schema 1.2): logon trigger for `user` with a delay, runs `exe --minimized --autostart`.
pub fn task_xml(exe: &str, user: &str, delay_secs: u32) -> String {
    let exe = xml_escape(exe);
    let user = xml_escape(user);
    let delay = clamp_delay(delay_secs);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Start OmniChat Server when you log in</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
      <Delay>PT{delay}S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>--minimized --autostart</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

/// UTF-16LE with BOM, as schtasks expects for `encoding="UTF-16"`.
pub fn utf16le_bom(s: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for u in s.encode_utf16() {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

/// systemd ExecStart quoting: wrap in double quotes, escape `\`, `"`, and `%` (specifier).
fn systemd_quote(s: &str) -> String {
    let e = s.replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%").replace('$', "$$");
    format!("\"{e}\"")
}

pub fn systemd_unit(exe: &str, delay_secs: u32) -> String {
    let d = clamp_delay(delay_secs);
    format!(
        "[Unit]\nDescription=OmniChat Server (autostart)\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStartPre=/bin/sleep {d}\nExecStart={} --minimized --autostart\nRestart=no\n\n[Install]\nWantedBy=default.target\n",
        systemd_quote(exe)
    )
}

/// .desktop `Exec` value: the whole command is one shell string, itself quoted for the desktop-entry rules.
pub fn desktop_entry(exe: &str, delay_secs: u32) -> String {
    let d = clamp_delay(delay_secs);
    // shell-quote exe with single quotes
    let sh_exe = format!("'{}'", exe.replace('\'', "'\\''"));
    let cmd = format!("sleep {d}; exec {sh_exe} --minimized --autostart");
    // desktop-entry Exec quoting: inside double quotes escape " ` $ \ ; and % as %%
    let q = cmd.replace('\\', "\\\\").replace('"', "\\\"").replace('`', "\\`").replace('$', "\\$").replace('%', "%%");
    let q = q.replace('\\', "\\\\"); // the string-level escaping of backslashes (desktop spec double-unescape)
    format!(
        "[Desktop Entry]\nType=Application\nName=OmniChat Server\nComment=Start OmniChat Server when you log in\nExec=sh -c \"{q}\"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
    )
}

#[derive(Debug, Default, PartialEq)]
pub struct LaunchArgs {
    /// kept for the existing autostart entries; visibility is decided by background::should_show_window
    pub minimized: bool,
    pub autostart: bool,
    /// `--background`: start hidden in the tray
    pub background: bool,
    pub delay_secs: u32,
}

pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> LaunchArgs {
    let mut a = LaunchArgs::default();
    for s in args {
        match s.as_str() {
            "--minimized" => a.minimized = true,
            "--autostart" => a.autostart = true,
            "--background" => a.background = true,
            _ => {
                if let Some(v) = s.strip_prefix("--autostart-delay=") {
                    a.delay_secs = parse_delay(v);
                    a.autostart = true;
                }
            }
        }
    }
    a
}

/// Network is "ready" when there is a Tailscale address (100.64.0.0/10) or any usable non-loopback/link-local address
/// together with a default route.
pub fn is_tailscale_v4(ip: &IpAddr) -> bool {
    matches!(ip, IpAddr::V4(v) if { let o = v.octets(); o[0] == 100 && (64..=127).contains(&o[1]) })
}

pub fn network_ready(local_ips: &[IpAddr], has_default_route: bool) -> bool {
    if local_ips.iter().any(is_tailscale_v4) {
        return true;
    }
    has_default_route
        && local_ips.iter().any(|ip| match ip {
            IpAddr::V4(v) => !v.is_loopback() && !v.is_link_local() && !v.is_unspecified(),
            IpAddr::V6(_) => false,
        })
}

pub fn parse_proc_net_route_has_default(text: &str) -> bool {
    text.lines().skip(1).any(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        f.len() > 2 && f[1] == "00000000" && f[2] != "00000000"
    })
}

// ---------------------------------------------------------------------------------------------------------------
// settings (autostart.json next to config.env)

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("autostart.json"))
}

fn read_delay(app: &AppHandle) -> u32 {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| match v.get("delay_secs") {
            Some(serde_json::Value::Number(n)) => n.as_u64().map(|n| clamp_delay(n.min(u32::MAX as u64) as u32)),
            Some(serde_json::Value::String(s)) => Some(parse_delay(s)),
            _ => None,
        })
        .unwrap_or(DEFAULT_DELAY)
}

fn write_delay(app: &AppHandle, d: u32) -> Result<(), String> {
    let p = settings_path(app).ok_or("no app data dir")?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(p, format!("{{\"delay_secs\":{d}}}\n")).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------------------------
// OS backends

fn exe_str() -> Result<String, String> {
    std::env::current_exe().map_err(|e| e.to_string())?.to_str().map(|s| s.to_string()).ok_or_else(|| "exe path is not UTF-8".to_string())
}

#[cfg(windows)]
mod os {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const NO_WINDOW: u32 = 0x0800_0000;
    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

    fn run(cmd: &str, args: &[&str]) -> Option<std::process::Output> {
        Command::new(cmd).args(args).creation_flags(NO_WINDOW).output().ok()
    }
    fn ok(o: &Option<std::process::Output>) -> bool {
        o.as_ref().map(|o| o.status.success()).unwrap_or(false)
    }

    pub fn mechanism() -> &'static str {
        if ok(&run("schtasks", &["/Query", "/TN", TASK_NAME])) {
            "task"
        } else if ok(&run("reg", &["query", RUN_KEY, "/v", RUN_VALUE])) {
            "run-key"
        } else {
            "none"
        }
    }

    pub fn enable(delay: u32) -> Result<&'static str, String> {
        let exe = exe_str()?;
        let user = std::env::var("USERDOMAIN").ok().zip(std::env::var("USERNAME").ok()).map(|(d, u)| format!("{d}\\{u}")).or_else(|| std::env::var("USERNAME").ok()).unwrap_or_default();
        let xml = task_xml(&exe, &user, delay);
        let tmp = std::env::temp_dir().join(format!("omnichat-task-{}.xml", std::process::id()));
        fs::write(&tmp, utf16le_bom(&xml)).map_err(|e| e.to_string())?;
        let r = run("schtasks", &["/Create", "/TN", TASK_NAME, "/XML", tmp.to_str().unwrap_or(""), "/F"]);
        let _ = fs::remove_file(&tmp);
        if ok(&r) {
            let _ = run("reg", &["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
            return Ok("task");
        }
        let val = format!("\"{exe}\" --minimized --autostart --autostart-delay={delay}");
        if ok(&run("reg", &["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &val, "/f"])) {
            Ok("run-key")
        } else {
            Err("自動起動を登録できませんでした".into())
        }
    }

    pub fn disable() -> Result<(), String> {
        let _ = run("schtasks", &["/Delete", "/TN", TASK_NAME, "/F"]);
        let _ = run("reg", &["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
        if mechanism() == "none" { Ok(()) } else { Err("自動起動を解除できませんでした".into()) }
    }

    pub fn supported() -> bool {
        true
    }
}

#[cfg(not(windows))]
mod os {
    use super::*;
    use std::process::Command;

    fn home() -> Option<PathBuf> {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    fn config_home() -> Option<PathBuf> {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).or_else(|| home().map(|h| h.join(".config")))
    }
    fn unit_path() -> Option<PathBuf> {
        config_home().map(|c| c.join("systemd/user").join(UNIT_NAME))
    }
    fn desktop_path() -> Option<PathBuf> {
        config_home().map(|c| c.join("autostart").join(DESKTOP_NAME))
    }
    fn systemctl(args: &[&str]) -> bool {
        Command::new("systemctl").arg("--user").args(args).output().map(|o| o.status.success()).unwrap_or(false)
    }
    fn systemd_usable() -> bool {
        systemctl(&["show-environment"])
    }

    pub fn supported() -> bool {
        cfg!(target_os = "linux") && config_home().is_some()
    }

    pub fn mechanism() -> &'static str {
        if unit_path().map(|p| p.exists()).unwrap_or(false) {
            "systemd"
        } else if desktop_path().map(|p| p.exists()).unwrap_or(false) {
            "desktop"
        } else {
            "none"
        }
    }

    pub fn enable(delay: u32) -> Result<&'static str, String> {
        if !supported() {
            return Err("この OS では自動起動に対応していません".into());
        }
        let exe = exe_str()?;
        let (u, d) = (unit_path().unwrap(), desktop_path().unwrap());
        if systemd_usable() {
            fs::create_dir_all(u.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::write(&u, systemd_unit(&exe, delay)).map_err(|e| e.to_string())?;
            let _ = systemctl(&["daemon-reload"]);
            if systemctl(&["enable", UNIT_NAME]) {
                let _ = fs::remove_file(&d);
                return Ok("systemd");
            }
            let _ = fs::remove_file(&u);
            let _ = systemctl(&["daemon-reload"]);
        }
        fs::create_dir_all(d.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&d, desktop_entry(&exe, delay)).map_err(|e| e.to_string())?;
        Ok("desktop")
    }

    pub fn disable() -> Result<(), String> {
        if let Some(u) = unit_path() {
            if u.exists() {
                let _ = systemctl(&["disable", UNIT_NAME]);
                let _ = fs::remove_file(&u);
                let _ = systemctl(&["daemon-reload"]);
            }
        }
        if let Some(d) = desktop_path() {
            let _ = fs::remove_file(d);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// commands

pub fn info(app: &AppHandle) -> AutostartInfo {
    let m = os::mechanism();
    AutostartInfo { supported: os::supported(), enabled: m != "none", delay_secs: read_delay(app), mechanism: m.into(), wait_network: true }
}

pub fn is_enabled(app: &AppHandle) -> bool {
    info(app).enabled
}

#[tauri::command]
pub async fn autostart_get(app: AppHandle) -> Result<AutostartInfo, String> {
    tauri::async_runtime::spawn_blocking(move || info(&app)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn autostart_set(app: AppHandle, enabled: bool, delay_secs: Option<u32>) -> Result<AutostartInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let delay = match delay_secs {
            Some(d) => {
                let d = clamp_delay(d);
                write_delay(&app, d)?;
                d
            }
            None => read_delay(&app),
        };
        if enabled {
            os::enable(delay)?;
        } else {
            os::disable()?;
        }
        Ok(info(&app))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------------------------------------------
// startup wait (used when launched with --autostart)

fn local_ips() -> Vec<IpAddr> {
    let mut v = Vec::new();
    for ni in crate::sysinfo::list_addrs() {
        if let Ok(ip) = ni.ip.parse::<IpAddr>() {
            v.push(ip);
        }
    }
    v
}

fn default_route() -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Ok(t) = fs::read_to_string("/proc/net/route") {
            return parse_proc_net_route_has_default(&t);
        }
    }
    // generic: a UDP "connect" succeeds only when the OS has a route
    std::net::UdpSocket::bind("0.0.0.0:0").and_then(|s| s.connect("192.0.2.1:9").map(|_| ())).is_ok()
}

/// Sleep `delay_secs`, then wait (max 120 s) for a default route or a Tailscale address. Logs progress.
pub fn wait_for_startup(delay_secs: u32, log: &dyn Fn(String)) {
    if delay_secs > 0 {
        log(format!("(自動起動: {delay_secs} 秒待ってから起動します)"));
        std::thread::sleep(Duration::from_secs(delay_secs as u64));
    }
    let t0 = Instant::now();
    loop {
        if network_ready(&local_ips(), default_route()) {
            log("(自動起動: ネットワークを確認しました)".into());
            return;
        }
        if t0.elapsed() >= NET_WAIT_MAX {
            log("(自動起動: ネットワークを待ちきれなかったため、そのまま起動します)".into());
            return;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_parsing() {
        assert_eq!(parse_delay("45"), 45);
        assert_eq!(parse_delay(" 45s "), 45);
        assert_eq!(parse_delay("9999"), 300);
        assert_eq!(parse_delay("-5"), 0);
        assert_eq!(parse_delay("abc"), 30);
        assert_eq!(parse_delay(""), 30);
    }

    #[test]
    fn task_xml_has_delay_args_and_escapes() {
        let x = task_xml(r"C:\Users\a&b\OmniChat Server.exe", r"PC\a<b", 45);
        assert!(x.contains("<Delay>PT45S</Delay>"));
        assert!(x.contains("<Arguments>--minimized --autostart</Arguments>"));
        assert!(x.contains(r"C:\Users\a&amp;b\OmniChat Server.exe"));
        assert!(x.contains(r"PC\a&lt;b"));
        assert!(x.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(x.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(x.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(task_xml("x", "u", 5000).contains("PT300S"));
    }

    #[test]
    fn utf16_has_bom() {
        assert_eq!(utf16le_bom("a"), vec![0xFF, 0xFE, b'a', 0]);
    }

    #[test]
    fn unit_and_desktop_generation() {
        let u = systemd_unit("/opt/Omni Chat/bin%x", 30);
        assert!(u.contains("ExecStartPre=/bin/sleep 30\n"));
        assert!(u.contains("ExecStart=\"/opt/Omni Chat/bin%%x\" --minimized --autostart\n"));
        assert!(u.contains("WantedBy=default.target"));
        let d = desktop_entry("/opt/o'c/bin", 7);
        assert!(d.contains("sleep 7;"));
        assert!(d.contains("--minimized --autostart"));
        assert!(d.lines().any(|l| l.starts_with("Exec=sh -c \"")));
    }

    #[test]
    fn args() {
        let a = parse_args(["x", "--minimized", "--autostart"].map(String::from));
        assert!(a.minimized && a.autostart && !a.background && a.delay_secs == 0);
        let c = parse_args(["--background", "--autostart"].map(String::from));
        assert!(c.background && c.autostart && !c.minimized);
        let b = parse_args(["--autostart-delay=20".to_string()]);
        assert!(b.autostart && b.delay_secs == 20);
        assert_eq!(parse_args(Vec::<String>::new()), LaunchArgs::default());
    }

    #[test]
    fn readiness() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(!network_ready(&[], true));
        assert!(!network_ready(&[ip("127.0.0.1"), ip("169.254.1.2")], true));
        assert!(!network_ready(&[ip("192.168.1.5")], false));
        assert!(network_ready(&[ip("192.168.1.5")], true));
        assert!(network_ready(&[ip("100.101.2.3")], false));
        assert!(!is_tailscale_v4(&ip("100.128.0.1")));
        assert!(parse_proc_net_route_has_default("Iface\tDestination\tGateway\neth0\t00000000\t0102A8C0\n"));
        assert!(!parse_proc_net_route_has_default("Iface\tDestination\tGateway\neth0\t0002A8C0\t00000000\n"));
    }
}
