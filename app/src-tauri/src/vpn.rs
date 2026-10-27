//! Embedded VPN: renders an Xray config from the profile handed out by the
//! server and runs the bundled `xray` sidecar.

use std::collections::VecDeque;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

pub const SOCKS_PORT: u16 = 10808;
pub const HTTP_PORT: u16 = 10809;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_LOG_LINES: usize = 200;
const PROFILE_FILE: &str = "vpn-profile.json";
const CONFIG_FILE: &str = "xray.json";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Profile {
    #[serde(default)]
    pub name: String,
    pub host: String,
    pub port: u16,
    pub uuid: String,
    #[serde(default)]
    pub flow: String,
    pub reality: Reality,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Reality {
    #[serde(default, rename = "serverName")]
    pub server_name: String,
    #[serde(default, rename = "publicKey")]
    pub public_key: String,
    #[serde(default, rename = "shortId")]
    pub short_id: String,
    #[serde(default)]
    pub fingerprint: String,
}

#[derive(Serialize)]
pub struct VpnStatus {
    pub running: bool,
    pub socks_port: u16,
    pub http_port: u16,
    pub connected_at: Option<u64>,
    pub name: Option<String>,
    pub host: Option<String>,
    pub error: Option<String>,
    pub system_proxy: bool,
    pub log: Vec<String>,
}

/// Shared between the UI, the sidecar log reader and the exit hook.
#[derive(Default)]
pub struct VpnState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    profile: Option<Profile>,
    child: Option<tauri_plugin_shell::process::CommandChild>,
    connected_at: Option<u64>,
    error: Option<String>,
    logs: VecDeque<String>,
    previous_proxy: Option<String>,
}

impl VpnState {
    fn push_log(&self, line: String) {
        let mut inner = self.inner.lock().unwrap();
        if inner.logs.len() == MAX_LOG_LINES {
            inner.logs.pop_front();
        }
        inner.logs.push_back(line);
    }

    /// The reader thread reports the exit; only an unexpected one becomes an
    /// error, because `vpn_stop` clears the child before killing it.
    fn mark_stopped(&self, reason: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        let unexpected = inner.child.is_some();
        inner.child = None;
        inner.connected_at = None;
        if unexpected {
            inner.error = reason;
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

fn vpn_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("config dir: {error}"))?
        .join("vpn");
    std::fs::create_dir_all(&dir).map_err(|error| format!("config dir: {error}"))?;
    Ok(dir)
}

/// Loopback and LAN stay outside the tunnel: routing them through it would
/// loop the chat connection and break local services. Listed explicitly
/// instead of `geoip:private`, because the sidecar ships without `geoip.dat`.
const PRIVATE_CIDRS: [&str; 8] = [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
];

/// Builds the Xray config. Private ranges go direct to avoid loops; the rest
/// uses the VLESS+Reality outbound from the profile.
fn render_config(profile: &Profile) -> Value {
    let flow = if profile.flow.is_empty() {
        Value::Null
    } else {
        Value::String(profile.flow.clone())
    };
    let fingerprint = if profile.reality.fingerprint.is_empty() {
        "chrome".to_string()
    } else {
        profile.reality.fingerprint.clone()
    };

    json!({
        "log": { "loglevel": "warning" },
        "inbounds": [
            {
                "tag": "socks",
                "listen": "127.0.0.1",
                "port": SOCKS_PORT,
                "protocol": "socks",
                "settings": { "auth": "noauth", "udp": false }
            },
            {
                "tag": "http",
                "listen": "127.0.0.1",
                "port": HTTP_PORT,
                "protocol": "http"
            }
        ],
        "outbounds": [
            {
                "tag": "proxy",
                "protocol": "vless",
                "settings": {
                    "vnext": [{
                        "address": profile.host,
                        "port": profile.port,
                        "users": [{
                            "id": profile.uuid,
                            "encryption": "none",
                            "flow": flow
                        }]
                    }]
                },
                "streamSettings": {
                    "network": "tcp",
                    "security": "reality",
                    "realitySettings": {
                        "serverName": profile.reality.server_name,
                        "fingerprint": fingerprint,
                        "publicKey": profile.reality.public_key,
                        "shortId": profile.reality.short_id
                    }
                }
            },
            { "tag": "direct", "protocol": "freedom" },
            { "tag": "block", "protocol": "blackhole" }
        ],
        "routing": {
            "domainStrategy": "AsIs",
            "rules": [
                { "type": "field", "ip": PRIVATE_CIDRS, "outboundTag": "direct" }
            ]
        }
    })
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    false
}

// ---- system proxy -------------------------------------------------------

#[cfg(windows)]
mod proxy {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    fn reg(args: &[&str]) -> Option<String> {
        let output = Command::new("reg")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn read_value(name: &str) -> Option<String> {
        let output = reg(&["query", KEY, "/v", name])?;
        output
            .lines()
            .find(|line| line.contains(name))
            .and_then(|line| line.split_whitespace().last())
            .map(str::to_string)
    }

    pub fn is_enabled() -> bool {
        read_value("ProxyEnable").as_deref() == Some("0x1")
    }

    /// Returns the previous ProxyServer value so it can be restored later.
    pub fn enable(proxy_server: &str) -> Result<Option<String>, String> {
        let previous = read_value("ProxyServer");
        reg(&["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"])
            .ok_or("reg add ProxyEnable failed")?;
        reg(&["add", KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", proxy_server, "/f"])
            .ok_or("reg add ProxyServer failed")?;
        reg(&[
            "add", KEY, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", "localhost;127.*;<local>", "/f",
        ])
        .ok_or("reg add ProxyOverride failed")?;
        Ok(previous)
    }

    pub fn disable(previous: Option<&str>) {
        let _ = reg(&["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"]);
        if let Some(value) = previous {
            let _ = reg(&["add", KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", value, "/f"]);
        }
    }
}

#[cfg(not(windows))]
mod proxy {
    pub fn is_enabled() -> bool {
        false
    }

    pub fn enable(_proxy_server: &str) -> Result<Option<String>, String> {
        Err("system proxy is managed automatically on this platform yet".into())
    }

    pub fn disable(_previous: Option<&str>) {}
}

// ---- commands -----------------------------------------------------------

fn to_status(inner: &Inner) -> VpnStatus {
    VpnStatus {
        running: inner.child.is_some(),
        socks_port: SOCKS_PORT,
        http_port: HTTP_PORT,
        connected_at: inner.connected_at,
        name: inner.profile.as_ref().map(|profile| profile.name.clone()),
        host: inner.profile.as_ref().map(|profile| profile.host.clone()),
        error: inner.error.clone(),
        system_proxy: proxy::is_enabled(),
        log: inner.logs.iter().cloned().collect(),
    }
}

fn save_profile(dir: &Path, profile: &Profile) -> Result<(), String> {
    let encoded =
        serde_json::to_vec_pretty(profile).map_err(|error| format!("profile: {error}"))?;
    std::fs::write(dir.join(PROFILE_FILE), encoded).map_err(|error| format!("profile: {error}"))
}

#[tauri::command]
pub fn vpn_set_profile(
    app: AppHandle,
    state: State<'_, VpnState>,
    profile: Profile,
) -> Result<(), String> {
    save_profile(&vpn_dir(&app)?, &profile)?;
    state.inner.lock().unwrap().profile = Some(profile);
    Ok(())
}

#[tauri::command]
pub fn vpn_clear_profile(app: AppHandle, state: State<'_, VpnState>) -> Result<(), String> {
    let dir = vpn_dir(&app)?;
    let _ = std::fs::remove_file(dir.join(PROFILE_FILE));
    let mut inner = state.inner.lock().unwrap();
    inner.profile = None;
    inner.error = None;
    Ok(())
}

#[tauri::command]
pub fn vpn_status(state: State<'_, VpnState>) -> VpnStatus {
    to_status(&state.inner.lock().unwrap())
}

#[tauri::command]
pub fn vpn_start(app: AppHandle, state: State<'_, VpnState>) -> Result<VpnStatus, String> {
    if let Ok(inner) = state.inner.lock() {
        if inner.child.is_some() {
            return Ok(to_status(&inner));
        }
    }

    let profile = {
        let mut inner = state.inner.lock().unwrap();
        inner.error = None;
        match inner.profile.clone() {
            Some(profile) => profile,
            None => {
                let path = vpn_dir(&app)?.join(PROFILE_FILE);
                let encoded = std::fs::read(&path)
                    .map_err(|_| "VPN profile is missing: sign in again".to_string())?;
                let profile: Profile = serde_json::from_slice(&encoded)
                    .map_err(|error| format!("profile: {error}"))?;
                inner.profile = Some(profile.clone());
                profile
            }
        }
    };

    let dir = vpn_dir(&app)?;
    let config_path = dir.join(CONFIG_FILE);
    let config = render_config(&profile);
    std::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("config: {error}"))?;

    let command = app
        .shell()
        .sidecar("xray")
        .map_err(|error| format!("sidecar: {error}"))?
        .args(["-c".to_string(), config_path.to_string_lossy().into_owned()]);
    let (mut receiver, child) = command.spawn().map_err(|error| format!("xray: {error}"))?;

    {
        let mut inner = state.inner.lock().unwrap();
        inner.child = Some(child);
        inner.logs.clear();
    }

    let log_app = app.clone();
    std::thread::spawn(move || {
        loop {
            match receiver.try_recv() {
                Ok(CommandEvent::Stdout(line)) | Ok(CommandEvent::Stderr(line)) => {
                    let text = String::from_utf8_lossy(&line).trim().to_string();
                    if !text.is_empty() {
                        log_app.state::<VpnState>().push_log(text);
                    }
                }
                Ok(CommandEvent::Terminated(payload)) => {
                    let state = log_app.state::<VpnState>();
                    state.push_log(format!("xray exited: {:?}", payload.code));
                    state.mark_stopped(Some("tunnel stopped".into()));
                    break;
                }
                Ok(CommandEvent::Error(error)) => {
                    let state = log_app.state::<VpnState>();
                    state.push_log(format!("xray error: {error}"));
                    break;
                }
                Ok(_) => {}
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(150));
                }
            }
        }
    });

    if !wait_for_port(SOCKS_PORT, STARTUP_TIMEOUT) {
        let tail = {
            let inner = state.inner.lock().unwrap();
            inner.logs.iter().rev().take(5).cloned().collect::<Vec<_>>()
        };
        stop_inner(&state);
        let message = if tail.is_empty() {
            "xray did not open the local proxy port".to_string()
        } else {
            format!("xray failed to start: {}", tail.join(" | "))
        };
        state.inner.lock().unwrap().error = Some(message.clone());
        return Err(message);
    }

    match proxy::enable(&format!("127.0.0.1:{HTTP_PORT}")) {
        Ok(previous) => {
            state.inner.lock().unwrap().previous_proxy = previous;
            state
                .push_log(format!("system proxy: 127.0.0.1:{HTTP_PORT}"));
        }
        Err(error) => state.push_log(format!("system proxy: {error}")),
    }

    let mut inner = state.inner.lock().unwrap();
    inner.connected_at = Some(now_ms());
    Ok(to_status(&inner))
}

fn stop_inner(state: &VpnState) {
    let (child, previous) = {
        let mut inner = state.inner.lock().unwrap();
        (inner.child.take(), inner.previous_proxy.take())
    };
    if let Some(child) = child {
        let _ = child.kill();
    }
    if previous.is_some() || proxy::is_enabled() {
        proxy::disable(previous.as_deref());
    }
    state.inner.lock().unwrap().connected_at = None;
}

#[tauri::command]
pub fn vpn_stop(state: State<'_, VpnState>) -> VpnStatus {
    stop_inner(&state);
    let inner = state.inner.lock().unwrap();
    to_status(&inner)
}

/// Called from the app exit hook so no orphaned `xray.exe` survives.
pub fn shutdown(state: &VpnState) {
    stop_inner(state);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Profile {
        serde_json::from_value(json!({
            "name": "omni-chat",
            "host": "chat.example.com",
            "port": 443,
            "uuid": "11111111-2222-3333-4444-555555555555",
            "flow": "xtls-rprx-vision",
            "reality": {
                "serverName": "chat.example.com",
                "publicKey": "PUBKEY",
                "shortId": "abcd1234",
                "fingerprint": "chrome"
            }
        }))
        .expect("profile fixture")
    }

    #[test]
    fn profile_matches_server_template() {
        let profile = sample();
        assert_eq!(profile.reality.server_name, "chat.example.com");
        assert_eq!(profile.reality.short_id, "abcd1234");
    }

    #[test]
    fn config_keeps_inbounds_on_loopback() {
        let config = render_config(&sample());
        let inbounds = config["inbounds"].as_array().expect("inbounds");
        assert_eq!(inbounds.len(), 2);
        for inbound in inbounds {
            assert_eq!(inbound["listen"], "127.0.0.1");
        }
        assert_eq!(inbounds[0]["port"], SOCKS_PORT);
        assert_eq!(inbounds[1]["port"], HTTP_PORT);
    }

    #[test]
    fn config_targets_profile_outbound() {
        let config = render_config(&sample());
        let outbound = &config["outbounds"][0];
        assert_eq!(outbound["protocol"], "vless");
        assert_eq!(outbound["settings"]["vnext"][0]["address"], "chat.example.com");
        assert_eq!(outbound["settings"]["vnext"][0]["port"], 443);
        assert_eq!(outbound["settings"]["vnext"][0]["users"][0]["flow"], "xtls-rprx-vision");
        assert_eq!(
            outbound["streamSettings"]["realitySettings"]["publicKey"],
            "PUBKEY"
        );
        assert_eq!(outbound["streamSettings"]["realitySettings"]["serverName"], "chat.example.com");
        assert_eq!(config["routing"]["rules"][0]["outboundTag"], "direct");
    }
}
