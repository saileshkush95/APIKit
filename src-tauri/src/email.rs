//! Outgoing email over SMTP, for monitor notifications.
//!
//! The SMTP password never reaches this module from the database — the
//! frontend reads it from the OS keychain (`secrets`) and passes it per call.

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Address, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpSpec {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    /// "ssl" (implicit TLS, usually 465), "starttls" (usually 587) or "none".
    pub security: String,
    /// The From address; also the default To for test messages.
    pub from: String,
    /// Display name shown next to the From address, e.g. "APIKit".
    #[serde(default)]
    pub from_name: String,
}

fn mailbox(address: &str) -> Result<Mailbox, String> {
    address
        .trim()
        .parse()
        .map_err(|e| format!("invalid email address `{}`: {e}", address.trim()))
}

fn transport(smtp: &SmtpSpec) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let host = smtp.host.trim();
    if host.is_empty() {
        return Err("SMTP host is not configured".into());
    }

    let mut builder = match smtp.security.as_str() {
        "ssl" => AsyncSmtpTransport::<Tokio1Executor>::relay(host),
        "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host),
        _ => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(
            host,
        )),
    }
    .map_err(|e| format!("invalid SMTP host: {e}"))?
    .port(smtp.port)
    .timeout(Some(std::time::Duration::from_secs(20)));

    if !smtp.username.trim().is_empty() {
        builder = builder.credentials(Credentials::new(
            smtp.username.trim().to_owned(),
            smtp.password.clone(),
        ));
    }

    Ok(builder.build())
}

/// Connects, greets and authenticates without sending anything, so settings
/// can be verified before a monitor depends on them.
#[tauri::command]
pub async fn smtp_check(smtp: SmtpSpec) -> Result<(), String> {
    match transport(&smtp)?.test_connection().await {
        Ok(true) => Ok(()),
        Ok(false) => Err("the server accepted the connection but rejected the handshake".into()),
        Err(e) => Err(format!("connection failed: {e}")),
    }
}

/// Sends a plain-text email. `to` may hold several addresses, comma-separated.
#[tauri::command]
pub async fn send_email(
    smtp: SmtpSpec,
    to: String,
    subject: String,
    body: String,
) -> Result<(), String> {
    let from_address: Address = smtp
        .from
        .trim()
        .parse()
        .map_err(|e| format!("invalid From address `{}`: {e}", smtp.from.trim()))?;
    let from_name = smtp.from_name.trim();
    let from = Mailbox::new(
        (!from_name.is_empty()).then(|| from_name.to_owned()),
        from_address,
    );

    let mut message = Message::builder().from(from);
    let mut recipients = 0;
    for address in to.split(',').filter(|part| !part.trim().is_empty()) {
        message = message.to(mailbox(address)?);
        recipients += 1;
    }
    if recipients == 0 {
        return Err("no recipient address".into());
    }
    let message = message
        .subject(subject)
        .body(body)
        .map_err(|e| format!("could not build the email: {e}"))?;

    transport(&smtp)?
        .send(message)
        .await
        .map(|_| ())
        .map_err(|e| format!("SMTP send failed: {e}"))
}
