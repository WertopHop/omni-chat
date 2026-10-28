//! Embedded VPN: renders a tunnel config from the profile handed out by the
//! server and runs the bundled engine as a sidecar.
//!
//! Two modes share the same VLESS+Reality outbound. Proxy mode keeps the engine
//! on loopback inbounds and flips the system proxy, so it needs no administrator
//! rights. Full tunnel mode creates a Wintun adapter and routes the whole
//! machine into it, which does: the tunnel is started from an elevated
//! PowerShell wrapper (one UAC prompt) that watches this process and is
//! stopped through a stop file, because a non-elevated app cannot kill it.

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
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

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_LOG_LINES: usize = 200;
const PROFILE_FILE: &str = "vpn-profile.json";
const SETTINGS_FILE: &str = "vpn-settings.json";
const CONFIG_FILE: &str = "tunnel.json";
const LOG_FILE: &str = "tunnel.log";
/// Must match `bundle.externalBin`: the engine is third-party, the name we ship
/// it under is ours.
const SIDECAR: &str = "tunnel-core";
const PID_FILE: &str = "tun.pid";
const STOP_FILE: &str = "tun-stop";
const WRAPPER_FILE: &str = "tun-elevated.ps1";
const TUN_NAME: &str = "omni-chat";
const TUN_MTU: u16 = 1500;
/// Resolvers handed to the TUN adapter: they sit inside the routed prefixes,
/// so their queries travel through the tunnel instead of the provider link.
const TUN_DNS: [&str; 1] = ["1.1.1.1"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum VpnMode {
    #[default]
    Proxy,
    Tun,
}

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
    /// Mode selected by the user, kept even while the tunnel is off.
    pub mode: VpnMode,
    /// Mode of the tunnel that is currently up.
    pub active_mode: Option<VpnMode>,
    /// True when the tunnel runs outside of this process' token.
    pub elevated: bool,
    pub tun_name: Option<String>,
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
    mode: VpnMode,
    settings_loaded: bool,
    child: Option<tauri_plugin_shell::process::CommandChild>,
    running_mode: Option<VpnMode>,
    elevated: bool,
    connected_at: Option<u64>,
    error: Option<String>,
    logs: VecDeque<String>,
    previous_proxy: Option<String>,
    proxy_was_enabled: bool,
    proxy_active: bool,
    log_path: Option<PathBuf>,
    log_offset: u64,
    stop_file: Option<PathBuf>,
}

impl VpnState {
    fn push_log(&self, line: String) {
        let mut inner = self.inner.lock().unwrap();
        if inner.logs.len() == MAX_LOG_LINES {
            inner.logs.pop_front();
        }
        inner.logs.push_back(line);
    }

    fn is_running(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.child.is_some() || inner.elevated
    }

    /// The reader thread reports the exit; only an unexpected one becomes an
    /// error, because `vpn_stop` clears the handle before killing it.
    fn mark_stopped(&self, reason: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        let unexpected = inner.child.is_some() || inner.elevated;
        inner.child = None;
        inner.elevated = false;
        inner.running_mode = None;
        inner.connected_at = None;
        inner.log_path = None;
        inner.log_offset = 0;
        if unexpected {
            inner.error = reason;
        }
    }

    fn log_tail(&self, limit: usize) -> Vec<String> {
        let inner = self.inner.lock().unwrap();
        inner.logs.iter().rev().take(limit).rev().cloned().collect()
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

/// Directory that holds the app binary; Tauri copies the sidecar there, so the
/// elevated wrapper and Wintun look for the engine in the same place.
fn binary_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("current exe: {error}"))?;
    let dir = exe
        .parent()
        .ok_or("current exe has no parent")?
        .to_path_buf();
    // Tests run from `target/debug/deps`, one level below the binaries.
    Ok(if dir.ends_with("deps") {
        dir.parent().map(Path::to_path_buf).unwrap_or(dir)
    } else {
        dir
    })
}

/// File name the sidecar gets inside the bundle.
fn sidecar_file_name() -> &'static str {
    if cfg!(windows) {
        "tunnel-core.exe"
    } else {
        "tunnel-core"
    }
}

fn port_open(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if port_open(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    false
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

/// Builds the engine config. Private ranges go direct to avoid loops; the rest
/// uses the VLESS+Reality outbound from the profile. In TUN mode a Wintun
/// inbound captures the whole machine, and the engine binds its own uplink to
/// the physical interface (`autoOutboundsInterface` is implied by the routes), so
/// it does not send itself into the tunnel.
fn render_config(profile: &Profile, mode: VpnMode, error_log: Option<&Path>) -> Value {
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

    let log = match error_log {
        // An elevated tunnel has no stdout we can read, so it writes to a file.
        Some(path) => json!({
            "loglevel": "warning",
            "error": path.to_string_lossy()
        }),
        None => json!({ "loglevel": "warning" }),
    };

    let mut inbounds = vec![
        json!({
            "tag": "socks",
            "listen": "127.0.0.1",
            "port": SOCKS_PORT,
            "protocol": "socks",
            "settings": { "auth": "noauth", "udp": false }
        }),
        json!({
            "tag": "http",
            "listen": "127.0.0.1",
            "port": HTTP_PORT,
            "protocol": "http"
        }),
    ];

    if mode == VpnMode::Tun {
        inbounds.push(json!({
            "tag": "tun",
            "port": 0,
            "protocol": "tun",
            "settings": {
                "name": TUN_NAME,
                "desc": "Wintun",
                "mtu": TUN_MTU,
                "dns": TUN_DNS,
                "autoSystemRoutingTable": ["0.0.0.0/0", "::/0"],
                // Windows keeps asking the resolvers of the physical adapters;
                // this filter keeps every query but the engine's own inside it.
                "autoSystemWfpBlockLeak": ["dns"]
            }
        }));
    }

    json!({
        "log": log,
        "inbounds": inbounds,
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

// ---- platform helpers --------------------------------------------------

/// `net session` fails without administrator rights; a false negative only
/// costs one extra UAC prompt, which Windows answers without asking anyway.
#[cfg(windows)]
fn is_elevated() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    std::process::Command::new("net")
        .arg("session")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_elevated() -> bool {
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

    /// Returns the previous ProxyServer value and whether the proxy was on, so
    /// both can be restored when the tunnel stops.
    pub fn enable(proxy_server: &str) -> Result<(Option<String>, bool), String> {
        let previous = read_value("ProxyServer");
        let was_enabled = is_enabled();
        reg(&["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"])
            .ok_or("reg add ProxyEnable failed")?;
        reg(&["add", KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", proxy_server, "/f"])
            .ok_or("reg add ProxyServer failed")?;
        reg(&[
            "add", KEY, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", "localhost;127.*;<local>", "/f",
        ])
        .ok_or("reg add ProxyOverride failed")?;
        Ok((previous, was_enabled))
    }

    pub fn disable(previous: Option<&str>, was_enabled: bool) {
        let enabled = if was_enabled { "1" } else { "0" };
        let _ = reg(&["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", enabled, "/f"]);
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

    pub fn enable(_proxy_server: &str) -> Result<(Option<String>, bool), String> {
        Err("the system proxy is managed automatically on this platform".into())
    }

    pub fn disable(_previous: Option<&str>, _was_enabled: bool) {}
}

// ---- elevation ---------------------------------------------------------

/// Wintun is loaded from the directory of the engine binary, which is the app's
/// own directory. Installed builds get the DLL from `bundle.resources`; a dev run
/// finds it in `src-tauri/binaries` and copies it next to the sidecar.
fn ensure_wintun(app: &AppHandle) -> Result<(), String> {
    let target = binary_dir()?.join("wintun.dll");
    if target.exists() {
        return Ok(());
    }

    let mut sources: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        sources.push(dir.join("wintun.dll"));
        sources.push(dir.join("binaries").join("wintun.dll"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        sources.push(cwd.join("src-tauri").join("binaries").join("wintun.dll"));
        sources.push(cwd.join("binaries").join("wintun.dll"));
    }

    let source = sources
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or("wintun.dll is missing: run `npm run fetch:tunnel`")?;
    std::fs::copy(&source, &target).map_err(|error| format!("wintun.dll: {error}"))?;
    Ok(())
}

#[cfg(windows)]
fn ps_literal(value: &Path) -> String {
    value.to_string_lossy().replace('\'', "''")
}

/// The wrapper owns the elevated engine: it reports the PID, waits until the
/// stop file appears or this process disappears, then kills the tunnel. That
/// keeps the app able to stop a process it has no rights over, and prevents an
/// orphaned tunnel when the app crashes.
#[cfg(windows)]
fn write_wrapper(
    dir: &Path,
    engine: &Path,
    config: &Path,
    stop_file: &Path,
) -> Result<PathBuf, String> {
    let script_path = dir.join(WRAPPER_FILE);
    let script = format!(
        r#"# Started by omni-chat: keeps the tunnel alive and stops it on request.
$ErrorActionPreference = 'Stop'
$core = '{engine}'
$config = '{config}'
$pidFile = '{pid_file}'
$stopFile = '{stop_file}'
$appPid = {app_pid}

Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $core -ArgumentList @('-c', $config) -PassThru -WindowStyle Hidden
Set-Content -LiteralPath $pidFile -Value $tunnel.Id -Encoding ascii

try {{
    while (-not (Test-Path -LiteralPath $stopFile)) {{
        if ($tunnel.HasExited) {{ break }}
        if (-not (Get-Process -Id $appPid -ErrorAction SilentlyContinue)) {{ break }}
        Start-Sleep -Milliseconds 400
    }}
}} finally {{
    if (-not $tunnel.HasExited) {{
        Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
    }}
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
}}
"#,
        engine = ps_literal(engine),
        config = ps_literal(config),
        pid_file = ps_literal(&dir.join(PID_FILE)),
        stop_file = ps_literal(stop_file),
        app_pid = std::process::id(),
    );
    std::fs::write(&script_path, script).map_err(|error| format!("elevation script: {error}"))?;
    Ok(script_path)
}

#[cfg(windows)]
fn spawn_elevated(config_path: &Path, stop_file: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let dir = config_path
        .parent()
        .ok_or("config path has no parent")?;
    let engine = binary_dir()?.join(sidecar_file_name());
    if !engine.exists() {
        return Err(format!(
            "the tunnel engine is missing next to the app: {}",
            engine.display()
        ));
    }

    let script = write_wrapper(dir, &engine, config_path, stop_file)?;
    let arguments = format!(
        "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{}\"",
        script.display()
    );
    let command = format!(
        "$ErrorActionPreference='Stop'; try {{ Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList '{}' | Out-Null }} catch {{ Write-Error $_.Exception.Message; exit 1 }}",
        arguments.replace('\'', "''")
    );

    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", &command])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("powershell: {error}"))?;
    if output.status.success() {
        return Ok(());
    }

    let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if reason.is_empty() {
        "full tunnel mode needs administrator rights".to_string()
    } else {
        format!("full tunnel mode needs administrator rights: {reason}")
    })
}

#[cfg(not(windows))]
fn spawn_elevated(_config_path: &Path, _stop_file: &Path) -> Result<(), String> {
    Err("full tunnel mode is supported on Windows only".into())
}

// ---- sidecar logs ------------------------------------------------------

/// Reads what the elevated tunnel appended to its log file. Complete lines are
/// pushed to the UI log; a half-written line waits for the next poll.
fn tail_log(state: &VpnState) {
    let path = match state.inner.lock().unwrap().log_path.clone() {
        Some(path) => path,
        None => return,
    };
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(_) => return,
    };
    let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let offset = state.inner.lock().unwrap().log_offset;
    let start = if length < offset { 0 } else { offset };
    if length == start {
        return;
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }

    let mut buffer = String::new();
    if (&mut file)
        .take(length - start)
        .read_to_string(&mut buffer)
        .is_err()
    {
        return;
    }

    let complete = buffer.rfind('\n').map(|index| index + 1).unwrap_or(0);
    if complete == 0 {
        return;
    }
    for line in buffer[..complete].lines() {
        let text = line.trim_end().to_string();
        if !text.is_empty() {
            state.push_log(text);
        }
    }
    state.inner.lock().unwrap().log_offset = start + complete as u64;
}

/// Detects a tunnel that died on its own and keeps the log tail fresh.
fn refresh(state: &VpnState) {
    let (remotely_running, has_log) = {
        let inner = state.inner.lock().unwrap();
        (
            inner.elevated && inner.running_mode.is_some(),
            inner.log_path.is_some(),
        )
    };

    if has_log {
        tail_log(state);
    }
    if remotely_running && !port_open(SOCKS_PORT) {
        state.push_log("the engine is no longer running".to_string());
        state.mark_stopped(Some("tunnel stopped".into()));
    }
}

// ---- persistence -------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct Settings {
    mode: VpnMode,
}

fn save_profile(dir: &Path, profile: &Profile) -> Result<(), String> {
    let encoded =
        serde_json::to_vec_pretty(profile).map_err(|error| format!("profile: {error}"))?;
    std::fs::write(dir.join(PROFILE_FILE), encoded).map_err(|error| format!("profile: {error}"))
}

fn save_settings(dir: &Path, mode: VpnMode) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(&Settings { mode })
        .map_err(|error| format!("settings: {error}"))?;
    std::fs::write(dir.join(SETTINGS_FILE), encoded).map_err(|error| format!("settings: {error}"))
}

fn load_settings(dir: &Path) -> VpnMode {
    std::fs::read(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        .map(|settings| settings.mode)
        .unwrap_or_default()
}

/// Reads the persisted mode once, before the UI asks for the status.
fn load_mode(app: &AppHandle, state: &VpnState) {
    let mut inner = state.inner.lock().unwrap();
    if inner.settings_loaded {
        return;
    }
    inner.settings_loaded = true;
    if let Ok(dir) = vpn_dir(app) {
        inner.mode = load_settings(&dir);
    }
}

// ---- commands -----------------------------------------------------------

fn to_status(inner: &Inner) -> VpnStatus {
    let running = inner.child.is_some() || inner.elevated;
    VpnStatus {
        running,
        mode: inner.mode,
        active_mode: if running { inner.running_mode } else { None },
        elevated: inner.elevated,
        tun_name: match inner.running_mode {
            Some(VpnMode::Tun) if running => Some(TUN_NAME.to_string()),
            _ => None,
        },
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
pub fn vpn_status(app: AppHandle, state: State<'_, VpnState>) -> VpnStatus {
    load_mode(&app, &state);
    refresh(&state);
    to_status(&state.inner.lock().unwrap())
}

#[tauri::command]
pub fn vpn_set_mode(
    app: AppHandle,
    state: State<'_, VpnState>,
    mode: VpnMode,
) -> Result<VpnStatus, String> {
    load_mode(&app, &state);
    let current = state.inner.lock().unwrap().mode;
    if current != mode {
        // Routes and the system proxy belong to the mode, so switch cleanly.
        stop_inner(&state);
        save_settings(&vpn_dir(&app)?, mode)?;
        let mut inner = state.inner.lock().unwrap();
        inner.mode = mode;
        inner.error = None;
        inner.logs.clear();
    }
    Ok(to_status(&state.inner.lock().unwrap()))
}

fn spawn_sidecar(app: &AppHandle, state: &VpnState, config_path: &Path) -> Result<(), String> {
    let command = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|error| format!("sidecar: {error}"))?
        .args(["-c".to_string(), config_path.to_string_lossy().into_owned()]);
    let (mut receiver, child) = command
        .spawn()
        .map_err(|error| format!("engine: {error}"))?;
    state.inner.lock().unwrap().child = Some(child);

    let log_app = app.clone();
    std::thread::spawn(move || loop {
        match receiver.try_recv() {
            Ok(CommandEvent::Stdout(line)) | Ok(CommandEvent::Stderr(line)) => {
                let text = String::from_utf8_lossy(&line).trim().to_string();
                if !text.is_empty() {
                    log_app.state::<VpnState>().push_log(text);
                }
            }
            Ok(CommandEvent::Terminated(payload)) => {
                let state = log_app.state::<VpnState>();
                state.push_log(format!("engine exited: {:?}", payload.code));
                state.mark_stopped(Some("tunnel stopped".into()));
                break;
            }
            Ok(CommandEvent::Error(error)) => {
                let state = log_app.state::<VpnState>();
                state.push_log(format!("engine error: {error}"));
                break;
            }
            Ok(_) => {}
            Err(_) => std::thread::sleep(Duration::from_millis(150)),
        }
    });
    Ok(())
}

#[tauri::command]
pub fn vpn_start(app: AppHandle, state: State<'_, VpnState>) -> Result<VpnStatus, String> {
    if state.is_running() {
        return Ok(to_status(&state.inner.lock().unwrap()));
    }

    load_mode(&app, &state);
    let dir = vpn_dir(&app)?;

    let (profile, mode) = {
        let mut inner = state.inner.lock().unwrap();
        inner.error = None;
        inner.logs.clear();
        let profile = match inner.profile.clone() {
            Some(profile) => profile,
            None => {
                let path = dir.join(PROFILE_FILE);
                let encoded = std::fs::read(&path)
                    .map_err(|_| "VPN profile is missing: sign in again".to_string())?;
                let profile: Profile = serde_json::from_slice(&encoded)
                    .map_err(|error| format!("profile: {error}"))?;
                inner.profile = Some(profile.clone());
                profile
            }
        };
        (profile, inner.mode)
    };

    if mode == VpnMode::Tun {
        ensure_wintun(&app)?;
    }

    // Without elevation the tunnel cannot touch routes, so it is started
    // through the wrapper and reports through a log file instead of stdout.
    let remote = mode == VpnMode::Tun && !is_elevated();
    let error_log = if remote { Some(dir.join(LOG_FILE)) } else { None };
    if let Some(path) = &error_log {
        let _ = std::fs::remove_file(path);
    }

    let config_path = dir.join(CONFIG_FILE);
    let config = render_config(&profile, mode, error_log.as_deref());
    std::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("config: {error}"))?;

    if remote {
        let stop_file = dir.join(STOP_FILE);
        let _ = std::fs::remove_file(&stop_file);
        spawn_elevated(&config_path, &stop_file)?;
        state.push_log(format!(
            "full tunnel '{TUN_NAME}' starting with administrator rights"
        ));
    } else {
        spawn_sidecar(&app, &state, &config_path)?;
    }

    {
        let mut inner = state.inner.lock().unwrap();
        inner.running_mode = Some(mode);
        inner.elevated = remote;
        inner.log_path = error_log;
        inner.log_offset = 0;
        inner.stop_file = if remote {
            Some(dir.join(STOP_FILE))
        } else {
            None
        };
    }

    if !wait_for_port(SOCKS_PORT, STARTUP_TIMEOUT) {
        tail_log(&state);
        let tail = state.log_tail(5);
        stop_inner(&state);
        let message = if tail.is_empty() {
            "the engine did not open the local port".to_string()
        } else {
            format!("the engine failed to start: {}", tail.join(" | "))
        };
        state.inner.lock().unwrap().error = Some(message.clone());
        return Err(message);
    }

    if mode == VpnMode::Proxy {
        match proxy::enable(&format!("127.0.0.1:{HTTP_PORT}")) {
            Ok((previous, was_enabled)) => {
                {
                    let mut inner = state.inner.lock().unwrap();
                    inner.previous_proxy = previous;
                    inner.proxy_was_enabled = was_enabled;
                    inner.proxy_active = true;
                }
                state.push_log(format!("system proxy: 127.0.0.1:{HTTP_PORT}"));
            }
            Err(error) => state.push_log(format!("system proxy: {error}")),
        }
    } else {
        state.push_log(format!(
            "full tunnel is up: IPv4 and IPv6 go through '{TUN_NAME}'"
        ));
    }

    let mut inner = state.inner.lock().unwrap();
    inner.connected_at = Some(now_ms());
    Ok(to_status(&inner))
}

fn stop_inner(state: &VpnState) {
    let (child, previous, was_enabled, proxy_active, stop_file) = {
        let mut inner = state.inner.lock().unwrap();
        (
            inner.child.take(),
            inner.previous_proxy.take(),
            std::mem::take(&mut inner.proxy_was_enabled),
            std::mem::take(&mut inner.proxy_active),
            inner.stop_file.take(),
        )
    };

    if let Some(child) = child {
        let _ = child.kill();
    }

    if let Some(path) = stop_file {
        // The wrapper stopped the elevated engine as soon as this file appears;
        // waiting for the port to close is how we confirm it actually happened.
        let _ = std::fs::write(&path, b"stop");
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline && port_open(SOCKS_PORT) {
            std::thread::sleep(Duration::from_millis(150));
        }
        let _ = std::fs::remove_file(&path);
        if port_open(SOCKS_PORT) {
            // Staying silent would tell the user the tunnel is off while it is
            // still rewriting routes, so report it instead.
            let message = "the elevated tunnel is still running: stop it by hand";
            state.push_log(message.to_string());
            state.inner.lock().unwrap().error = Some(message.to_string());
        }
    }

    if proxy_active {
        proxy::disable(previous.as_deref(), was_enabled);
    }

    let mut inner = state.inner.lock().unwrap();
    inner.connected_at = None;
    inner.running_mode = None;
    inner.elevated = false;
    inner.log_path = None;
    inner.log_offset = 0;
}

#[tauri::command]
pub fn vpn_stop(state: State<'_, VpnState>) -> VpnStatus {
    stop_inner(&state);
    let inner = state.inner.lock().unwrap();
    to_status(&inner)
}

/// Called from the app exit hook so no orphaned engine process survives.
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
        let config = render_config(&sample(), VpnMode::Proxy, None);
        let inbounds = config["inbounds"].as_array().expect("inbounds");
        assert_eq!(inbounds.len(), 2);
        for inbound in inbounds {
            assert_eq!(inbound["listen"], "127.0.0.1");
        }
        assert_eq!(inbounds[0]["port"], SOCKS_PORT);
        assert_eq!(inbounds[1]["port"], HTTP_PORT);
    }

    #[test]
    fn tun_mode_adds_wintun_inbound() {
        let log = Path::new("C:/tmp/tunnel.log");
        let config = render_config(&sample(), VpnMode::Tun, Some(log));
        let inbounds = config["inbounds"].as_array().expect("inbounds");
        let tun = inbounds
            .iter()
            .find(|inbound| inbound["protocol"] == "tun")
            .expect("tun inbound");

        assert_eq!(tun["port"], 0);
        assert_eq!(tun["settings"]["name"], TUN_NAME);
        assert_eq!(tun["settings"]["mtu"], TUN_MTU);
        assert_eq!(tun["settings"]["autoSystemRoutingTable"][0], "0.0.0.0/0");
        assert_eq!(tun["settings"]["autoSystemWfpBlockLeak"][0], "dns");
        assert_eq!(tun["settings"]["dns"], json!(TUN_DNS));
        assert_eq!(config["log"]["error"], "C:/tmp/tunnel.log");
    }

    #[test]
    fn proxy_mode_has_no_tun_inbound() {
        let config = render_config(&sample(), VpnMode::Proxy, None);
        let inbounds = config["inbounds"].as_array().expect("inbounds");
        assert!(inbounds.iter().all(|inbound| inbound["protocol"] != "tun"));
        assert!(config["log"]["error"].is_null());
    }

    /// The wrapper is generated with `format!`, so a stray brace or an
    /// unescaped quote would only show up on the user's machine at connect
    /// time. Let PowerShell parse it instead.
    #[cfg(windows)]
    #[test]
    fn elevation_wrapper_parses() {
        let dir = std::env::temp_dir().join(format!("omni-vpn-wrapper-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let script = write_wrapper(
            &dir,
            Path::new(r"C:\Program Files\omni chat\tunnel-core.exe"),
            Path::new(r"C:\Users\Ann O'Neil\vpn\tunnel.json"),
            &dir.join(STOP_FILE),
        )
        .expect("wrapper");

        let check = format!(
            "$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('{}', [ref]$null, [ref]$errors); if ($errors.Count -gt 0) {{ $errors | ForEach-Object {{ Write-Error $_.Message }}; exit 1 }}",
            script.display().to_string().replace('\'', "''")
        );
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &check])
            .output()
            .expect("powershell");
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn config_targets_profile_outbound() {
        let config = render_config(&sample(), VpnMode::Proxy, None);
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
