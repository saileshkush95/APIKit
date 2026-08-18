//! Child processes that stay out of the user's way.
//!
//! Several lookups shell out — which app owns a port, what the system proxy is
//! set to, whether a certificate is trusted. On Windows every one of those
//! spawns pops a console window for the few milliseconds it runs, and the
//! per-port app lookup runs often enough that the screen flickers continuously
//! while the proxy is capturing. `CREATE_NO_WINDOW` is the documented way to
//! ask for a console-less child; it has no equivalent or need elsewhere.

use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `Command` that will not flash a console window on Windows.
pub(crate) fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
