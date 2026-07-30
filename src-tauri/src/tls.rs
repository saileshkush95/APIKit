//! Client certificates and private certificate authorities.
//!
//! Two different problems, both about a TLS handshake this app cannot otherwise
//! complete:
//!
//!   * mutual TLS, where the *server* demands a certificate from us. Common in
//!     banking, healthcare and anything behind an enterprise gateway.
//!   * a server whose certificate is signed by a private CA. The usual
//!     workaround is to switch certificate verification off entirely, which
//!     stops verifying the identity of everything else too. Trusting the one CA
//!     that actually signed it keeps the rest of the check intact.
//!
//! PEM only. `Identity::from_pkcs12_der` — the `.p12`/`.pfx` route — exists in
//! reqwest but requires the `native-tls` feature, and enabling that would pull
//! OpenSSL in on Linux and undo this app's rustls-everywhere position. Users
//! with a `.p12` convert it once with openssl; the UI gives the command.
//!
//! Only paths are stored, never key material: the settings live in the
//! workspace database, which export and sync both read.

use serde::Deserialize;

/// Where to find a client certificate, and which hosts it is for.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClientCertSpec {
    /// A PEM certificate. May also hold the private key, in which case
    /// `key_path` is left empty.
    pub cert_path: String,
    /// A separate PKCS#8 private key, when it is not in the certificate file.
    #[serde(default)]
    pub key_path: String,
}

fn read(path: &str, what: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("cannot read the {what} at `{path}`: {e}"))
}

/// rustls will not decrypt a passphrase-protected key, and the failure it
/// reports says only that no key was found — which sends people looking in the
/// wrong place. Naming it is the whole value of this check.
fn reject_encrypted_key(pem: &[u8], path: &str) -> Result<(), String> {
    let text = String::from_utf8_lossy(pem);
    if text.contains("ENCRYPTED PRIVATE KEY") || text.contains("Proc-Type: 4,ENCRYPTED") {
        return Err(format!(
            "the private key at `{path}` is passphrase-protected, which rustls cannot read. \
             Decrypt it first:\n\n    openssl pkcs8 -topk8 -nocrypt -in {path} -out decrypted-key.pem"
        ));
    }
    Ok(())
}

/// Builds the TLS identity for a client certificate.
pub fn identity(spec: &ClientCertSpec) -> Result<reqwest::Identity, String> {
    if spec.cert_path.trim().is_empty() {
        return Err("no client certificate path set".into());
    }

    let cert = read(&spec.cert_path, "client certificate")?;

    if spec.key_path.trim().is_empty() {
        // A combined file: certificate and key in one PEM, which is what most
        // tools emit and what `openssl pkcs12 -nodes` produces.
        reject_encrypted_key(&cert, &spec.cert_path)?;
        if !String::from_utf8_lossy(&cert).contains("PRIVATE KEY") {
            return Err(format!(
                "`{}` holds no private key. Either add the key to that file, or \
                 set a separate key file.",
                spec.cert_path
            ));
        }
        return reqwest::Identity::from_pem(&cert).map_err(|e| {
            format!("`{}` is not a usable certificate/key pair: {e}", spec.cert_path)
        });
    }

    let key = read(&spec.key_path, "private key")?;
    reject_encrypted_key(&key, &spec.key_path)?;

    // `from_pem` wants both in one buffer, which is what a combined file is —
    // so two files are joined rather than needing a separate constructor.
    // (`from_pkcs8_pem` exists but is behind a feature this build does not
    // enable.) A newline between them guards against a file with no trailing
    // one, which would otherwise splice the two PEM blocks into a single
    // unparseable line.
    let mut combined = Vec::with_capacity(cert.len() + key.len() + 1);
    combined.extend_from_slice(&cert);
    if !cert.ends_with(b"\n") {
        combined.push(b'\n');
    }
    combined.extend_from_slice(&key);

    reqwest::Identity::from_pem(&combined).map_err(|e| {
        format!(
            "`{}` and `{}` are not a usable certificate/key pair: {e}",
            spec.cert_path, spec.key_path
        )
    })
}

/// Every certificate in a PEM file, so a chain or a bundle works as one entry.
pub fn root_certificates(path: &str) -> Result<Vec<reqwest::Certificate>, String> {
    let pem = read(path, "CA certificate")?;
    reqwest::Certificate::from_pem_bundle(&pem)
        .map_err(|e| format!("`{path}` is not a readable PEM certificate: {e}"))
}

/// Applies both to a client builder.
///
/// Errors rather than carrying on: a request that silently went out without the
/// certificate it was configured with would come back as an opaque handshake
/// failure from the server, and the cause would not be visible anywhere.
pub fn apply(
    mut builder: reqwest::ClientBuilder,
    client_cert: Option<&ClientCertSpec>,
    ca_paths: &[String],
) -> Result<reqwest::ClientBuilder, String> {
    if let Some(spec) = client_cert {
        if !spec.cert_path.trim().is_empty() {
            builder = builder.identity(identity(spec)?);
        }
    }
    for path in ca_paths {
        if path.trim().is_empty() {
            continue;
        }
        for certificate in root_certificates(path)? {
            builder = builder.add_root_certificate(certificate);
        }
    }
    Ok(builder)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_encrypted_key_is_named_rather_than_guessed_at() {
        let encrypted = b"-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----";
        let error = reject_encrypted_key(encrypted, "/tmp/k.pem").unwrap_err();
        assert!(error.contains("passphrase-protected"));
        // The fix is in the message, not left to be looked up.
        assert!(error.contains("openssl pkcs8"));

        let legacy = b"-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n";
        assert!(reject_encrypted_key(legacy, "/tmp/k.pem").is_err());

        let plain = b"-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----";
        assert!(reject_encrypted_key(plain, "/tmp/k.pem").is_ok());
    }

    #[test]
    fn a_missing_file_says_which_file_and_what_it_was_for() {
        let error = identity(&ClientCertSpec {
            cert_path: "/nonexistent/client.pem".into(),
            key_path: String::new(),
        })
        .unwrap_err();
        assert!(error.contains("client certificate"));
        assert!(error.contains("/nonexistent/client.pem"));
    }

    #[test]
    fn an_empty_path_is_not_treated_as_a_certificate() {
        assert!(identity(&ClientCertSpec::default()).is_err());
    }

    #[test]
    fn a_certificate_without_a_key_is_reported_as_such() {
        let dir = std::env::temp_dir().join("apikit-tls-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cert-only.pem");
        std::fs::write(
            &path,
            "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        )
        .unwrap();

        let error = identity(&ClientCertSpec {
            cert_path: path.to_string_lossy().into(),
            key_path: String::new(),
        })
        .unwrap_err();
        // Not "invalid certificate": the file is fine, it is just incomplete.
        assert!(error.contains("holds no private key"), "{error}");

        let _ = std::fs::remove_file(&path);
    }
}
