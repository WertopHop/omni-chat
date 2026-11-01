mod vpn;

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::Manager;

// Background tasks (VPN sidecar) must not outlive the window.
#[cfg(desktop)]
fn stop_background_tasks(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<vpn::VpnState>() {
        vpn::shutdown(&state);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        // Voice needs the microphone; the webview asks the host once and would
        // otherwise leave the request unanswered. Everything else keeps the
        // default behaviour so the page cannot grant itself more than a
        // browser would hand it.
        .on_permission_request(|_webview, permission| match permission {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .manage(vpn::VpnState::default())
        .invoke_handler(tauri::generate_handler![
            vpn::vpn_set_profile,
            vpn::vpn_clear_profile,
            vpn::vpn_set_mode,
            vpn::vpn_set_apps,
            vpn::vpn_list_processes,
            vpn::vpn_start,
            vpn::vpn_stop,
            vpn::vpn_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = event {
                stop_background_tasks(app);
            }
        });
}
