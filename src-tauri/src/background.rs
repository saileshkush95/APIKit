//! Keeping the app alive after the window is closed.
//!
//! Monitors run in the webview, so they only tick while the process is alive.
//! With background mode on, closing the window hides it instead of quitting —
//! the scheduler keeps running and the tray icon brings the window back.
//!
//! The scheduler compares wall-clock timestamps rather than counting ticks, so
//! if the OS throttles timers for a hidden window a check is delayed, never
//! skipped.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct BackgroundMode(pub AtomicBool);

impl BackgroundMode {
    pub fn enabled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Builds the tray icon. Its menu is the only way back to the window once it is
/// hidden, so it is always installed — background mode only changes what
/// closing the window does.
pub fn init_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Open WebRequestKit", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("WebRequestKit — monitors running")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    Ok(())
}

#[tauri::command]
pub fn set_background_mode(state: State<BackgroundMode>, enabled: bool) -> Result<(), String> {
    state.0.store(enabled, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn background_mode(state: State<BackgroundMode>) -> Result<bool, String> {
    Ok(state.enabled())
}
