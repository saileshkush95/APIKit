//! Which application made a proxied request.
//!
//! The proxy sees a TCP connection, not a program, so the client's source port
//! is mapped back to the process that owns it. That lookup shells out, so
//! results are cached per port — a browser opens hundreds of connections and
//! each would otherwise cost a process spawn.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;

use crate::proc::command;

/// port → application name. Ports are reused over time, but only after the
/// original connection is long gone, so a stale hit is rare and harmless.
static CACHE: Mutex<Option<HashMap<u16, String>>> = Mutex::new(None);

#[cfg(target_os = "macos")]
fn owner_of(port: u16) -> Option<String> {
    // -Fc prints one line per field; the command name line starts with 'c'.
    let output = command("lsof")
        .args(["-nP", "-Fc", &format!("-iTCP:{port}")])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('c').map(|name| name.to_owned()))
}

#[cfg(target_os = "windows")]
fn owner_of(port: u16) -> Option<String> {
    // netstat -ano maps the port to a PID; tasklist turns that into a name.
    let output = command("netstat").args(["-ano", "-p", "TCP"]).output().ok()?;
    let listing = String::from_utf8_lossy(&output.stdout);
    let needle = format!(":{port} ");
    let pid = listing
        .lines()
        .find(|line| line.contains(&needle))
        .and_then(|line| line.split_whitespace().last())?
        .to_owned();

    let output = command("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .ok()?;
    let row = String::from_utf8_lossy(&output.stdout);
    row.split('"').nth(1).map(|name| name.to_owned())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn owner_of(port: u16) -> Option<String> {
    let output = command("ss")
        .args(["-tnp", &format!("sport = :{port}")])
        .output()
        .ok()?;
    // …users:(("firefox",pid=1234,fd=56))
    let listing = String::from_utf8_lossy(&output.stdout);
    let start = listing.find("((\"")? + 3;
    let rest = &listing[start..];
    rest.find('"').map(|end| rest[..end].to_owned())
}

/// A label for whoever opened this connection: the local application's name,
/// or the device address when the client is elsewhere on the network.
pub fn describe(client: SocketAddr) -> String {
    let local = match client.ip() {
        IpAddr::V4(ip) => ip.is_loopback(),
        IpAddr::V6(ip) => ip.is_loopback(),
    };
    if !local {
        return client.ip().to_string();
    }

    let port = client.port();
    if let Some(hit) = CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.as_ref()?.get(&port).cloned())
    {
        return hit;
    }

    let name = owner_of(port).unwrap_or_else(|| "Unknown".to_owned());
    if let Ok(mut guard) = CACHE.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        // Bounded: ports churn constantly and this is only a lookup shortcut.
        if cache.len() > 512 {
            cache.clear();
        }
        cache.insert(port, name.clone());
    }
    name
}
