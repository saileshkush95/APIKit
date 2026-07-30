//! Tokens kept in the operating system's keychain rather than the database.
//!
//! The sync pairing token and a GitHub personal access token are credentials:
//! storing them in `settings` would put them in plaintext next to the
//! collection, and any export or backup of that file would carry them along.
//! These commands keep them in the macOS Keychain, Windows Credential Manager
//! or the Linux Secret Service instead.

const SERVICE: &str = "com.sandeep.apikit";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| format!("keychain unavailable: {e}"))
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    let entry = entry(&key)?;
    if value.is_empty() {
        // Clearing a field should remove the credential, not store an empty one.
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("cannot clear {key}: {e}")),
        };
    }
    entry
        .set_password(&value)
        .map_err(|e| format!("cannot store {key}: {e}"))
}

/// Returns an empty string when nothing is stored, so callers need no special
/// case for "never set".
#[tauri::command]
pub fn secret_get(key: String) -> Result<String, String> {
    match entry(&key)?.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("cannot read {key}: {e}")),
    }
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("cannot delete {key}: {e}")),
    }
}
