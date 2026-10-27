mod vpn;

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
        .manage(vpn::VpnState::default())
        .invoke_handler(tauri::generate_handler![
            vpn::vpn_set_profile,
            vpn::vpn_clear_profile,
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
