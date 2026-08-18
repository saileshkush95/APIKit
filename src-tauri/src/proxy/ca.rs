//! Leaf certificates that Apple platforms will accept.
//!
//! hudsucker's built-in authority signs each leaf with nothing but a subject
//! alternative name, and leaves the validity window at rcgen's default of
//! several centuries. Android, curl and desktop browsers accept that. Apple's
//! published requirements for TLS server certificates ask for more: an extended
//! key usage of `id-kp-serverAuth`, and a validity window no longer than 398
//! days.
//!
//! Whether any given Apple client enforces those rules for a user-installed
//! root was not established here — a failing iPhone turned out to have a
//! different cause. What is certain is that the built-in leaves do not meet the
//! documented requirements and these do, which is the cheaper side to be on
//! when the failure it would produce is an untrusted-certificate error that
//! points squarely at the CA and says nothing about the leaf.
//!
//! Otherwise this mirrors the built-in authority: one cached leaf per host,
//! signed by the CA the app generated on first run.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use hudsucker::certificate_authority::CertificateAuthority;
use hudsucker::hyper::http::uri::Authority;
use hudsucker::rustls::crypto::CryptoProvider;
use hudsucker::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use hudsucker::rustls::ServerConfig;
use rcgen::{
    Certificate, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose,
    Ia5String, IsCa, KeyPair, KeyUsagePurpose, SanType,
};
use time::{Duration, OffsetDateTime};

/// How long a signed leaf is valid. Apple caps TLS server certificates at 398
/// days and rejects anything longer outright, so this is not a free knob.
const LEAF_DAYS: i64 = 365;

/// Clock skew allowance. A device whose clock runs a little fast would
/// otherwise reject a certificate minted moments ago as not yet valid.
const NOT_BEFORE_SKEW: i64 = 60;

/// Signs a leaf certificate per host, on demand, from the app's own CA.
pub struct SigningAuthority {
    key_pair: KeyPair,
    ca_cert: Certificate,
    private_key: PrivateKeyDer<'static>,
    provider: Arc<CryptoProvider>,
    /// host → rustls config. A browser opens many connections to the same host
    /// and signing is the expensive part.
    cache: Mutex<HashMap<String, Arc<ServerConfig>>>,
    cache_size: usize,
    /// Serial numbers have to differ between certificates from one issuer;
    /// clients cache by (issuer, serial) and will reuse a stale entry.
    serial: AtomicU64,
}

impl SigningAuthority {
    pub fn new(
        key_pair: KeyPair,
        ca_cert: Certificate,
        cache_size: usize,
        provider: CryptoProvider,
    ) -> Self {
        let private_key = PrivateKeyDer::from(PrivatePkcs8KeyDer::from(key_pair.serialize_der()));
        // Seeded from the clock so a restart does not reissue serial 1 for a
        // host a client still has cached under that number.
        let seed = OffsetDateTime::now_utc().unix_timestamp() as u64;
        Self {
            key_pair,
            ca_cert,
            private_key,
            provider: Arc::new(provider),
            cache: Mutex::new(HashMap::new()),
            cache_size,
            serial: AtomicU64::new(seed),
        }
    }

    fn sign(&self, host: &str) -> Result<CertificateDer<'static>, rcgen::Error> {
        let mut params = CertificateParams::default();
        params.serial_number = Some(self.serial.fetch_add(1, Ordering::Relaxed).into());

        let not_before = OffsetDateTime::now_utc() - Duration::seconds(NOT_BEFORE_SKEW);
        params.not_before = not_before;
        params.not_after = not_before + Duration::days(LEAF_DAYS);

        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, host);
        params.distinguished_name = name;

        // Apple stopped reading the common name years ago; the name that counts
        // is here. An address has to be an IpAddress entry — a dotted quad in a
        // dNSName matches nothing.
        params.subject_alt_names.push(match host.parse::<IpAddr>() {
            Ok(ip) => SanType::IpAddress(ip),
            Err(_) => SanType::DnsName(Ia5String::try_from(host)?),
        });

        // Required of a TLS server certificate by Apple's rules, and harmless
        // everywhere else.
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.is_ca = IsCa::ExplicitNoCa;

        Ok(params
            .signed_by(&self.key_pair, &self.ca_cert, &self.key_pair)?
            .into())
    }

    fn config_for(&self, host: &str) -> Arc<ServerConfig> {
        if let Some(hit) = self.cache.lock().unwrap().get(host) {
            return Arc::clone(hit);
        }

        let config = self.build(host);

        let mut cache = self.cache.lock().unwrap();
        // Bounded rather than evicted one by one: leaves are cheap to remint
        // and a proxy session rarely revisits a host after this many others.
        if cache.len() >= self.cache_size {
            cache.clear();
        }
        cache.insert(host.to_owned(), Arc::clone(&config));
        config
    }

    fn build(&self, host: &str) -> Arc<ServerConfig> {
        let mut config = match self.sign(host) {
            Ok(leaf) => ServerConfig::builder_with_provider(Arc::clone(&self.provider))
                .with_safe_default_protocol_versions()
                .expect("rustls supports its own default protocol versions")
                .with_no_client_auth()
                .with_single_cert(vec![leaf], self.private_key.clone_key()),
            // A host we cannot mint a name for — an empty authority, a name too
            // long for an Ia5String. Falling back to an empty chain fails this
            // one handshake instead of taking the proxy down.
            Err(_) => ServerConfig::builder_with_provider(Arc::clone(&self.provider))
                .with_safe_default_protocol_versions()
                .expect("rustls supports its own default protocol versions")
                .with_no_client_auth()
                .with_single_cert(Vec::new(), self.private_key.clone_key()),
        }
        .unwrap_or_else(|_| {
            panic!("rustls rejected a certificate this authority just signed")
        });

        // Only HTTP/1.1: the proxy is built without hudsucker's http2 feature,
        // so offering h2 here would have clients speak a protocol the other
        // side of the proxy cannot.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Arc::new(config)
    }
}

impl CertificateAuthority for SigningAuthority {
    async fn gen_server_config(&self, authority: &Authority) -> Arc<ServerConfig> {
        self.config_for(authority.host())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hudsucker::rustls::crypto::aws_lc_rs;

    fn authority() -> SigningAuthority {
        let (cert_pem, key_pem) = crate::proxy::generate_ca().expect("generates a CA");
        let key_pair = KeyPair::from_pem(&key_pem).expect("parses the key");
        let ca_cert = CertificateParams::from_ca_cert_pem(&cert_pem)
            .expect("parses the CA")
            .self_signed(&key_pair)
            .expect("re-signs the CA");
        SigningAuthority::new(key_pair, ca_cert, 8, aws_lc_rs::default_provider())
    }

    fn parsed(host: &str) -> x509_parser::certificate::X509Certificate<'static> {
        let der = authority().sign(host).expect("signs");
        let bytes: &'static [u8] = Box::leak(der.to_vec().into_boxed_slice());
        x509_parser::parse_x509_certificate(bytes).expect("parses").1
    }

    #[test]
    fn a_leaf_declares_itself_a_tls_server() {
        // Without this extension Safari rejects the connection and blames the
        // CA, which sends you chasing the wrong problem entirely.
        let cert = parsed("example.com");
        let eku = cert
            .extended_key_usage()
            .expect("readable")
            .expect("present");
        assert!(eku.value.server_auth, "id-kp-serverAuth must be present");
    }

    #[test]
    fn a_leaf_stays_inside_apples_validity_cap() {
        // Apple rejects TLS server certificates valid for more than 398 days.
        let cert = parsed("example.com");
        let span = cert.validity().not_after.timestamp() - cert.validity().not_before.timestamp();
        let days = span / 86_400;
        assert!(days <= 398, "leaf valid for {days} days");
        assert!(days >= 364, "leaf valid for only {days} days");
    }

    #[test]
    fn a_hostname_becomes_a_dns_name() {
        let cert = parsed("api.example.com");
        let san = cert
            .subject_alternative_name()
            .expect("readable")
            .expect("present");
        let names: Vec<_> = san.value.general_names.iter().collect();
        assert!(
            names.iter().any(|n| matches!(
                n,
                x509_parser::extensions::GeneralName::DNSName("api.example.com")
            )),
            "{names:?}"
        );
    }

    #[test]
    fn an_address_becomes_an_ip_entry_not_a_dns_name() {
        // A dotted quad in a dNSName matches nothing; intercepting an address
        // needs an iPAddress entry.
        let cert = parsed("192.168.1.5");
        let san = cert
            .subject_alternative_name()
            .expect("readable")
            .expect("present");
        assert!(
            san.value
                .general_names
                .iter()
                .any(|n| matches!(n, x509_parser::extensions::GeneralName::IPAddress(_))),
            "expected an iPAddress entry"
        );
    }

    #[test]
    fn a_leaf_is_not_a_certificate_authority() {
        let cert = parsed("example.com");
        let basic = cert.basic_constraints().expect("readable").expect("present");
        assert!(!basic.value.ca);
    }

    #[test]
    fn every_leaf_gets_its_own_serial_number() {
        // Clients cache by issuer and serial; a repeat would serve a stale
        // certificate for a different host.
        let ca = authority();
        let mut seen = std::collections::HashSet::new();
        for host in ["a.example.com", "b.example.com", "c.example.com"] {
            let der = ca.sign(host).expect("signs");
            let bytes = der.to_vec();
            let (_, cert) = x509_parser::parse_x509_certificate(&bytes).expect("parses");
            assert!(seen.insert(cert.raw_serial().to_vec()), "{host} reused a serial");
        }
    }

    #[test]
    fn a_repeat_host_is_served_from_cache() {
        let ca = authority();
        let first = ca.config_for("example.com");
        let second = ca.config_for("example.com");
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn the_cache_stays_bounded() {
        let ca = authority();
        for i in 0..40 {
            ca.config_for(&format!("host{i}.example.com"));
        }
        assert!(ca.cache.lock().unwrap().len() <= 8);
    }

    #[test]
    fn only_http1_is_offered() {
        // hudsucker is built without its http2 feature here, so advertising h2
        // would have clients speak a protocol the far side cannot.
        let ca = authority();
        let config = ca.config_for("example.com");
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }
}
