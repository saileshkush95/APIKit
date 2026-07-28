//! Points the operating system's HTTP/HTTPS proxy at the local MITM proxy and
//! back again, so "capture this computer's traffic" is one checkbox instead of
//! a trip through system preferences.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

/// Whether this process turned the system proxy on, so exit can turn it back
/// off — a machine left pointing at a dead proxy has no working network.
static ENABLED_BY_US: AtomicBool = AtomicBool::new(false);

/// On disk while the system proxy points at us, so even a killed process
/// (crash, force quit, dev-server rebuild) gets cleaned up on the next launch.
fn marker(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("system-proxy-active"))
}

/// Called on app exit; a no-op unless we changed the system.
pub fn restore_on_exit(app: &tauri::AppHandle) {
    if ENABLED_BY_US.swap(false, Ordering::SeqCst) {
        let _ = apply(false, 0);
        if let Some(path) = marker(app) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Called on app start: if a previous run died with the system proxy on, turn
/// it off now rather than leaving the machine without a working network.
pub fn heal_on_startup(app: &tauri::AppHandle) {
    if let Some(path) = marker(app) {
        if path.exists() {
            let _ = apply(false, 0);
            let _ = std::fs::remove_file(path);
        }
    }
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("could not run {program}: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

#[cfg(target_os = "macos")]
fn apply(enable: bool, port: u16) -> Result<(), String> {
    let output = Command::new("networksetup")
        .arg("-listallnetworkservices")
        .output()
        .map_err(|e| format!("could not run networksetup: {e}"))?;
    let listing = String::from_utf8_lossy(&output.stdout);
    // The first line is an explanation; a leading asterisk marks a disabled
    // service.
    let services: Vec<&str> = listing
        .lines()
        .skip(1)
        .filter(|line| !line.trim().is_empty() && !line.starts_with('*'))
        .collect();
    if services.is_empty() {
        return Err("no active network services found".into());
    }

    let port = port.to_string();
    let mut applied = 0;
    let mut last_error = String::new();
    for service in services {
        let result = if enable {
            run("networksetup", &["-setwebproxy", service, "127.0.0.1", &port]).and_then(|()| {
                run(
                    "networksetup",
                    &["-setsecurewebproxy", service, "127.0.0.1", &port],
                )
            })
        } else {
            run("networksetup", &["-setwebproxystate", service, "off"]).and_then(|()| {
                run("networksetup", &["-setsecurewebproxystate", service, "off"])
            })
        };
        match result {
            Ok(()) => applied += 1,
            Err(e) => last_error = format!("{service}: {e}"),
        }
    }
    if applied == 0 {
        Err(format!("could not change any network service — {last_error}"))
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn apply(enable: bool, port: u16) -> Result<(), String> {
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    if enable {
        run(
            "reg",
            &[
                "add", KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d",
                &format!("127.0.0.1:{port}"), "/f",
            ],
        )?;
        run(
            "reg",
            &["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"],
        )
    } else {
        run(
            "reg",
            &["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"],
        )
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn apply(enable: bool, port: u16) -> Result<(), String> {
    // GNOME's gsettings is the one broadly scriptable desktop proxy store;
    // elsewhere the user sets the proxy by hand.
    let set = |schema: &str, key: &str, value: &str| {
        run("gsettings", &["set", schema, key, value])
    };
    if enable {
        set("org.gnome.system.proxy.http", "host", "127.0.0.1")?;
        set("org.gnome.system.proxy.http", "port", &port.to_string())?;
        set("org.gnome.system.proxy.https", "host", "127.0.0.1")?;
        set("org.gnome.system.proxy.https", "port", &port.to_string())?;
        set("org.gnome.system.proxy", "mode", "manual")
    } else {
        set("org.gnome.system.proxy", "mode", "none")
    }
    .map_err(|e| {
        format!("automatic setup needs a GNOME desktop (gsettings): {e}")
    })
}

/// Routes (or stops routing) this computer's HTTP/HTTPS traffic through the
/// local proxy.
#[tauri::command]
pub fn set_system_proxy(
    app: tauri::AppHandle,
    enable: bool,
    port: u16,
) -> Result<(), String> {
    apply(enable, port)?;
    ENABLED_BY_US.store(enable, Ordering::SeqCst);
    if let Some(path) = marker(&app) {
        if enable {
            let _ = std::fs::write(&path, port.to_string());
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}
