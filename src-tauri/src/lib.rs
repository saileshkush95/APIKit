// Grouped by what the code is for, not by what it happens to import.
//
//   net    — making a request: HTTP, gRPC, streams, load, TLS, cookies
//   auth   — obtaining credentials, and keeping them in the OS keychain
//   proxy  — the MITM engine, the OS proxy settings, the app-name lookup
//   sync   — moving a workspace between machines: LAN peers and GitHub
//   app    — desktop shell concerns: the tray, monitor email
//
// `store` and `mock` stay at the top level: the database is used by everything,
// and the mock server is a single file with nothing to group it with.
mod app;
mod auth;
mod mock;
mod net;
mod proxy;
mod store;
mod sync;

use app::background::BackgroundMode;
use mock::MockState;
use net::cookies::CookieState;
use net::load::LoadState;
use net::stream::StreamState;
use proxy::ProxyState;
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
        .manage(net::http_client::CancelState::default())
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
                net::cookies::restore(&app.state::<CookieState>().0, &conn);
            }
            app.manage(db);
            app::background::init_tray(app.handle())?;
            proxy::system::heal_on_startup(app.handle());

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
            net::http_client::send_request,
            net::http_client::cancel_request,
            net::cookies::list_cookies,
            net::cookies::cookies_enabled,
            net::cookies::set_cookies_enabled,
            net::cookies::put_cookie,
            net::cookies::delete_cookie,
            net::cookies::clear_cookies,
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
            sync::github::github_pull,
            sync::github::github_push,
            sync::github::github_check,
            sync::github::write_text_file,
            sync::github::read_text_file,
            sync::github::save_binary_file,
            auth::secrets::secret_set,
            auth::secrets::secret_get,
            auth::secrets::secret_delete,
            app::email::send_email,
            app::email::smtp_check,
            store::set_setting,
            app::background::set_background_mode,
            app::background::background_mode,
            mock::start_mock_server,
            mock::stop_mock_server,
            mock::mock_status,
            mock::apply_mock_routes,
            net::stream::stream_connect,
            net::stream::stream_send,
            net::stream::stream_disconnect,
            net::load::run_load_test,
            net::load::stop_load_test,
            auth::oauth::oauth_token,
            auth::oauth::oauth_authorize,
            auth::oauth::oauth_device_start,
            auth::oauth::oauth_device_poll,
            net::grpc::grpc_call,
            net::grpc::grpc_methods,
            net::grpc::grpc_services,
            proxy::start_proxy,
            proxy::stop_proxy,
            proxy::system::set_system_proxy,
            proxy::system::ca_trusted,
            proxy::system::trust_ca_certificate,
            proxy::proxy_status,
            proxy::get_flows,
            proxy::clear_flows,
            proxy::set_intercept,
            proxy::resume_request,
            proxy::get_ca_certificate_pem,
            proxy::ca_certificate_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Whatever ends the process, the OS must not be left pointing at a
            // proxy that no longer exists.
            if let tauri::RunEvent::Exit = event {
                proxy::system::restore_on_exit(app);
            }
        });
}
