mod background;
mod github;
mod http_client;
mod load;
mod mock;
mod proxy;
mod secrets;
mod store;
mod sync;
mod stream;

use background::BackgroundMode;
use load::LoadState;
use mock::MockState;
use proxy::ProxyState;
use stream::StreamState;
use sync::SyncState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install a process-wide rustls crypto provider so both the request client
    // and the proxy agree on one. Ignoring the error covers the "already set"
    // case on hot-reload.
    let _ = hudsucker::rustls::crypto::aws_lc_rs::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(ProxyState::default())
        .manage(MockState::default())
        .manage(StreamState::default())
        .manage(LoadState::default())
        .manage(BackgroundMode::default())
        .manage(SyncState::default())
        .setup(|app| {
            let db = store::init(app.handle())?;
            app.manage(db);
            background::init_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // With background mode on, closing the window keeps the process
            // (and therefore the monitor scheduler) alive.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.state::<BackgroundMode>().enabled() {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            http_client::send_request,
            store::list_workspaces,
            store::create_workspace,
            store::rename_workspace,
            store::delete_workspace,
            store::load_workspace_data,
            store::save_tree,
            store::save_environments,
            store::save_tabs,
            store::save_mock_routes,
            store::save_monitors,
            store::record_monitor_run,
            store::clear_monitor_runs,
            store::load_history,
            store::record_history,
            store::delete_history_entry,
            store::clear_history,
            store::save_comment,
            store::delete_comment,
            store::sync_snapshot,
            store::sync_apply,
            sync::start_sync_server,
            sync::stop_sync_server,
            sync::sync_server_status,
            sync::ping_peer,
            sync::sync_with_peer,
            sync::list_peer_workspaces,
            sync::diagnose_peer,
            sync::notify_local_change,
            sync::sync_watch_peer,
            sync::sync_unwatch_peer,
            store::local_change_stamp,
            github::github_pull,
            github::github_push,
            github::github_check,
            github::write_text_file,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            store::set_setting,
            background::set_background_mode,
            background::background_mode,
            mock::start_mock_server,
            mock::stop_mock_server,
            mock::mock_status,
            mock::apply_mock_routes,
            stream::stream_connect,
            stream::stream_send,
            stream::stream_disconnect,
            load::run_load_test,
            load::stop_load_test,
            proxy::start_proxy,
            proxy::stop_proxy,
            proxy::proxy_status,
            proxy::get_flows,
            proxy::clear_flows,
            proxy::get_ca_certificate_pem,
            proxy::ca_certificate_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
