mod background;
mod cookies;
mod email;
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
use cookies::CookieState;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(http_client::CancelState::default())
        .manage(ProxyState::default())
        .manage(MockState::default())
        .manage(StreamState::default())
        .manage(LoadState::default())
        .manage(BackgroundMode::default())
        .manage(SyncState::default())
        .manage(CookieState::default())
        .setup(|app| {
            let db = store::init(app.handle())?;
            // Cookies are restored before the window can send anything, so the
            // first request of a session already carries them.
            {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                cookies::restore(&app.state::<CookieState>().0, &conn);
            }
            app.manage(db);
            background::init_tray(app.handle())?;

            // Insurance against a hidden main window. The frontend normally
            // reveals it as soon as the workspace opens; if that never happens
            // — a bundle that fails to load, a capability that got dropped —
            // an app with no window and no way to get one is unrecoverable.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                if let Some(window) = handle.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        return;
                    }
                    let _ = window.show();
                    let _ = window.set_focus();
                    // Same repaint nudge as the frontend reveal: macOS can
                    // leave a hidden-then-shown window uncomposited.
                    if let Ok(size) = window.inner_size() {
                        let _ = window
                            .set_size(tauri::PhysicalSize::new(size.width, size.height + 1));
                        let _ = window.set_size(size);
                    }
                }
                if let Some(splash) = handle.get_webview_window("splash") {
                    let _ = splash.destroy();
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // With background mode on, closing the window keeps the process
            // (and therefore the monitor scheduler) alive.
            // The splash window is closed programmatically and must never be
            // caught by background mode, which would hide it instead.
            if window.label() != "main" {
                return;
            }
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
            http_client::cancel_request,
            cookies::list_cookies,
            cookies::cookies_enabled,
            cookies::set_cookies_enabled,
            cookies::put_cookie,
            cookies::delete_cookie,
            cookies::clear_cookies,
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
            github::save_binary_file,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            email::send_email,
            email::smtp_check,
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
