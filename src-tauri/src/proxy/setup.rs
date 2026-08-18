//! The site the proxy serves on its own behalf, at `http://apikit.setup`.
//!
//! Installing the CA is the one step of MITM setup that cannot itself go
//! through the MITM: a phone will not trust an HTTPS connection signed by a
//! certificate it has not installed yet. But any client already pointed at the
//! proxy can make a plain HTTP request, so the proxy answers one hostname for
//! itself and hands out the certificate there. Without this the user has to
//! stand up a second file server just to move 600 bytes onto a phone.
//!
//! The same page answers a direct hit on the proxy's own address, so the
//! certificate can be fetched *before* the proxy is configured — useful when a
//! phone's browser turns a bare `apikit.setup` into a search instead of a
//! request.

use std::sync::Arc;

use bytes::Bytes;
use http_body_util::Full;
use hudsucker::{
    hyper::{header, Response, StatusCode},
    Body,
};
use rcgen::{CertificateParams, DnType, DnValue};
use sha2::{Digest, Sha256};

/// The hostname the proxy claims for itself. Anything else is forwarded.
const SETUP_HOST: &str = "apikit.setup";

/// Paths that return the certificate rather than the page. Several spellings,
/// because the extension decides whether a phone offers to install the file:
/// Android's picker filters for `.crt` and ignores `.pem`.
const CERT_PATHS: [&str; 4] = [
    "/apikit-ca.crt",
    "/apikit-ca.pem",
    "/ca.crt",
    "/ca",
];

/// The download name. `.crt` because that is the extension Android will open.
const CERT_FILENAME: &str = "apikit-ca.crt";

/// Everything the setup page needs, resolved once when the proxy starts so a
/// request never pays for certificate parsing or an interface lookup.
#[derive(Clone)]
pub struct SetupSite {
    pem: Arc<str>,
    /// Common name of the CA — what the user has to find in a list of
    /// hundreds on the device.
    name: Arc<str>,
    /// SHA-256 of the DER, so the certificate offered over plain HTTP can be
    /// checked against the one the app shows.
    fingerprint: Arc<str>,
    /// Host header values that mean "this proxy", not a site to forward to.
    self_hosts: Arc<[String]>,
    /// The address to tell the user to configure, e.g. `192.168.1.5:8080`.
    address: Arc<str>,
}

impl SetupSite {
    pub fn new(pem: &str, port: u16) -> Self {
        let addresses = crate::sync::local_addresses();
        let mut self_hosts: Vec<String> = Vec::new();
        for address in &addresses {
            self_hosts.push(format!("{address}:{port}"));
        }
        self_hosts.push(format!("localhost:{port}"));

        // The address a phone can reach; loopback only when there is nothing
        // else, in which case no phone can reach us anyway.
        let reachable = addresses
            .iter()
            .find(|a| a.as_str() != "127.0.0.1")
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_string());

        Self {
            pem: pem.into(),
            name: common_name(pem).into(),
            fingerprint: fingerprint(pem).into(),
            self_hosts: self_hosts.into(),
            address: format!("{reachable}:{port}").into(),
        }
    }

    /// Whether this request is for the proxy itself.
    ///
    /// `absolute` distinguishes the two ways a request arrives: proxied
    /// requests carry a full URL, while a browser typing our address straight
    /// into the bar sends only a path. MITM'd HTTPS also arrives path-only,
    /// which is why the host has to match one of our own addresses and not
    /// merely the port — no real site is served from this machine's IP on the
    /// proxy port.
    pub fn claims(&self, host: &str, absolute: bool) -> bool {
        let bare = host.split(':').next().unwrap_or(host);
        if bare.eq_ignore_ascii_case(SETUP_HOST) {
            return true;
        }
        !absolute && self.self_hosts.iter().any(|known| known == host)
    }

    pub fn respond(&self, path: &str, user_agent: &str) -> Response<Body> {
        let path = path.split('?').next().unwrap_or(path);
        if CERT_PATHS.contains(&path) {
            return self.certificate(is_apple(user_agent));
        }
        self.page()
    }

    /// `apple` decides whether the file is offered as a download.
    ///
    /// Safari hands an `application/x-x509-ca-cert` body straight to the
    /// configuration-profile installer — the "Profile Downloaded" prompt the
    /// whole iOS flow depends on — but only when nothing tells it to save the
    /// file instead. `Content-Disposition: attachment` is exactly that
    /// instruction: with it the certificate lands silently in Files, no profile
    /// is ever offered, and every later HTTPS request fails as untrusted with
    /// no hint that the install never happened.
    ///
    /// Android needs the opposite. Chrome downloads the file, and the header is
    /// what gives it the `.crt` name that Android's certificate picker filters
    /// for — a `.pem` is invisible in that picker.
    fn certificate(&self, apple: bool) -> Response<Body> {
        let mut builder = Response::builder()
            .status(StatusCode::OK)
            // The MIME type is what makes a phone treat this as a certificate
            // to install rather than a text file to display.
            .header(header::CONTENT_TYPE, "application/x-x509-ca-cert")
            .header(header::CACHE_CONTROL, "no-store");
        if !apple {
            builder = builder.header(
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{CERT_FILENAME}\""),
            );
        }
        builder
            .body(Body::from(Full::new(Bytes::from(self.pem.to_string()))))
            .expect("static certificate response")
    }

    fn page(&self) -> Response<Body> {
        let html = page_html(&self.name, &self.fingerprint, &self.address);
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(Full::new(Bytes::from(html))))
            .expect("static setup page response")
    }
}

/// Whether this client is an Apple platform, which needs the certificate handed
/// to the profile installer rather than saved as a file.
fn is_apple(user_agent: &str) -> bool {
    let ua = user_agent.to_ascii_lowercase();
    // "Mac" would also match Android tablets claiming "Macintosh" in a desktop
    // request, but a desktop Mac wants the profile handling too, so the looser
    // match is the right one here.
    ua.contains("iphone") || ua.contains("ipad") || ua.contains("ipod") || ua.contains("mac os")
}

/// The answer to a `CONNECT` for the setup host.
///
/// Deliberately not a 2xx: a client reads any 2xx as "the tunnel is open" and
/// starts a TLS handshake, which is exactly the dead end this avoids. A plain
/// refusal is what makes a browser that guessed HTTPS drop back to HTTP.
pub fn refuse_tunnel() -> Response<Body> {
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(Full::new(Bytes::from(
            "This address serves the APIKit CA certificate over plain HTTP. \
Nothing here can be served over HTTPS yet, because the certificate that would \
sign it is the one you are here to install. Open http://apikit.setup instead.",
        ))))
        .expect("static refusal response")
}

/// Read the CA's common name back out of its own certificate, so the page
/// names whatever is actually installed. Certificates generated before a
/// rename keep their old name on disk forever, and telling the user to look
/// for a name that is not in the list is worse than not naming it at all.
fn common_name(pem: &str) -> String {
    let fallback = "APIKit CA".to_string();
    let Ok(params) = CertificateParams::from_ca_cert_pem(pem) else {
        return fallback;
    };
    match params.distinguished_name.get(&DnType::CommonName) {
        Some(DnValue::Utf8String(name)) => name.clone(),
        Some(DnValue::PrintableString(name)) => name.as_str().to_string(),
        Some(DnValue::Ia5String(name)) => name.as_str().to_string(),
        _ => fallback,
    }
}

/// Colon-separated SHA-256 of the DER, the form every certificate viewer uses.
fn fingerprint(pem: &str) -> String {
    let Some(der) = der_from_pem(pem) else {
        return String::new();
    };
    let digest = Sha256::digest(&der);
    digest
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn der_from_pem(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .skip_while(|line| !line.starts_with("-----BEGIN"))
        .skip(1)
        .take_while(|line| !line.starts_with("-----END"))
        .collect();
    if body.is_empty() {
        return None;
    }
    crate::sync::github::base64_decode(&body).ok()
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A self-contained page: the device fetching it is behind a proxy whose
/// certificate it does not trust yet, so anything loaded from elsewhere would
/// fail. No external stylesheet, font, or script.
fn page_html(name: &str, fingerprint: &str, address: &str) -> String {
    let name = escape(name);
    let fingerprint = escape(fingerprint);
    let address = escape(address);
    format!(
        r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>APIKit proxy setup</title>
<style>
  :root {{ color-scheme: light dark; --bg:#fff; --fg:#16181d; --muted:#5c6370;
           --line:#e3e5ea; --card:#f7f8fa; --brand:#2f6df6; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#15171c; --fg:#e8eaf0; --muted:#9aa1ae; --line:#2a2e37;
             --card:#1c1f26; --brand:#6f9bff; }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; padding:24px 20px 56px; background:var(--bg); color:var(--fg);
         font:16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }}
  main {{ max-width: 34rem; margin: 0 auto; }}
  h1 {{ font-size:1.4rem; margin:0 0 4px; }}
  p.lead {{ margin:0 0 20px; color:var(--muted); }}
  a.get {{ display:block; text-align:center; background:var(--brand); color:#fff;
           text-decoration:none; font-weight:600; padding:15px 18px; border-radius:12px;
           margin: 0 0 8px; }}
  .hint {{ font-size:.82rem; color:var(--muted); text-align:center; margin:0 0 24px; }}
  section {{ background:var(--card); border:1px solid var(--line); border-radius:12px;
             padding:14px 16px; margin:0 0 14px; }}
  h2 {{ font-size:.78rem; text-transform:uppercase; letter-spacing:.06em;
        color:var(--muted); margin:0 0 10px; font-weight:600; }}
  ol {{ margin:0; padding-left:1.15rem; }}
  li {{ margin:0 0 8px; }}
  li:last-child {{ margin-bottom:0; }}
  code {{ font:.85rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
          background:var(--bg); border:1px solid var(--line); border-radius:5px;
          padding:1px 5px; word-break:break-all; }}
  .fp {{ font:.72rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         color:var(--muted); word-break:break-all; }}
  .warn {{ font-size:.82rem; color:var(--muted); border-left:3px solid var(--line);
           padding-left:12px; margin-top:22px; }}
  a.jump {{ display:block; text-align:center; text-decoration:none; font-weight:600;
            color:var(--brand); border:1px solid var(--brand); border-radius:9px;
            padding:11px 14px; margin:0 0 12px; }}
  .why {{ font-size:.8rem; color:var(--muted); margin:12px 0 0; }}
  [hidden] {{ display:none !important; }}
</style>
</head>
<body>
<main>
  <h1>Install the {name}</h1>
  <p class="lead">Your device is talking to APIKit at <code>{address}</code>. Adding this
  certificate lets APIKit read HTTPS traffic from this device.</p>

  <a class="get" id="get" href="/{filename}" download="{filename}">Download the certificate</a>
  <p class="hint" id="hint">The download should start on its own. Tap above if it doesn&rsquo;t.</p>

  <section id="android" hidden>
    <h2>Install it on Android</h2>
    <a class="jump" href="intent:#Intent;action=android.settings.SECURITY_SETTINGS;end">
      Open security settings</a>
    <ol>
      <li>Tap <b>Install a certificate</b> &rarr; <b>CA certificate</b> &rarr; <b>Install anyway</b>.
          On some phones it is under <b>Encryption &amp; credentials</b>; searching Settings for
          <b>certificate</b> finds it on any of them.</li>
      <li>Pick <code>{filename}</code> from <b>Downloads</b>.</li>
      <li>Look for <b>{name}</b> under trusted credentials &rarr; User.</li>
    </ol>
    <p class="why">Android will not let a web page install a CA for you &mdash; since Android 11
    that has to be a deliberate trip through Settings. The download and the shortcut above are
    as far as any tool can take it.</p>
  </section>

  <section id="ios" hidden>
    <h2>Install it on iPhone or iPad</h2>
    <ol>
      <li><b>Settings</b> &rarr; <b>Profile Downloaded</b> &rarr; <b>Install</b>, then enter your passcode.</li>
      <li><b>Settings</b> &rarr; <b>General</b> &rarr; <b>About</b> &rarr; scroll to the bottom &rarr;
          <b>Certificate Trust Settings</b>.</li>
      <li>Turn the switch <b>on</b> for <b>{name}</b>. Until you do, every HTTPS request still fails.</li>
    </ol>
  </section>

  <section id="desktop" hidden>
    <h2>Install it on this computer</h2>
    <ol>
      <li><b>macOS:</b> open the file, add it to the login keychain, then double-click
          <b>{name}</b> &rarr; Trust &rarr; <b>Always Trust</b>.</li>
      <li><b>Windows:</b> open the file &rarr; Install Certificate &rarr; Local Machine &rarr;
          <b>Trusted Root Certification Authorities</b>.</li>
      <li><b>Linux:</b> copy it into <code>/usr/local/share/ca-certificates/</code> and run
          <code>sudo update-ca-certificates</code>.</li>
    </ol>
  </section>

  <section>
    <h2>Check you got the right one</h2>
    <p class="fp">SHA-256<br>{fingerprint}</p>
  </section>

  <p class="warn">Only do this on a device you own or are authorised to test, and remove the
  certificate when you are finished &mdash; a trusted CA someone else holds the key to can
  read everything this device sends.</p>
</main>
<script>
  var ua = navigator.userAgent;
  var os = /Android/i.test(ua) ? "android"
         : /iPhone|iPad|iPod/i.test(ua) ? "ios"
         : "desktop";
  document.getElementById(os).hidden = false;

  // Saving the file is the part that can be automated; installing it is not.
  // Both mobile systems require the user to walk into Settings themselves, on
  // purpose, so the page can only get the file onto the device and then say
  // where to go next.
  window.addEventListener("load", function () {{
    try {{ document.getElementById("get").click(); }} catch (e) {{}}
  }});
</script>
</body>
</html>
"##,
        name = name,
        address = address,
        fingerprint = fingerprint,
        filename = CERT_FILENAME,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A CA generated the same way the proxy generates its own.
    fn ca() -> String {
        crate::proxy::generate_ca().expect("generates a CA").0
    }

    fn site() -> SetupSite {
        SetupSite::new(&ca(), 8080)
    }

    #[test]
    fn claims_its_own_hostname_however_it_arrives() {
        let site = site();
        for host in ["apikit.setup", "apikit.setup:80", "APIKit.Setup"] {
            assert!(site.claims(host, true), "proxied {host}");
            assert!(site.claims(host, false), "direct {host}");
        }
    }

    #[test]
    fn forwards_everything_else() {
        let site = site();
        for host in ["example.com", "api.example.com:443", "apikit.setup.evil.com"] {
            assert!(!site.claims(host, true), "{host}");
            assert!(!site.claims(host, false), "{host}");
        }
    }

    #[test]
    fn answers_a_direct_hit_on_its_own_address_but_never_a_tunnelled_one() {
        let site = site();
        let own = site.self_hosts.first().expect("at least loopback").clone();
        // Typed into a browser on this machine: no scheme, our address.
        assert!(site.claims(&own, false));
        // The same name inside a MITM'd HTTPS tunnel is real traffic for a
        // server that happens to live here, and must be forwarded.
        assert!(!site.claims(&own, true));
    }

    #[test]
    fn safari_is_never_told_to_save_the_file() {
        // An attachment disposition makes Safari file the certificate away
        // instead of offering to install it, and nothing on screen says the
        // install never happened.
        let site = site();
        let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) \
AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1";
        let res = site.respond("/apikit-ca.crt", ua);
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/x-x509-ca-cert"
        );
        assert!(res.headers().get(header::CONTENT_DISPOSITION).is_none());
    }

    #[test]
    fn android_still_gets_a_named_download() {
        // Android's certificate picker filters on the .crt extension, so the
        // filename in this header is what makes the file selectable at all.
        let site = site();
        let ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/126 Mobile Safari/537.36";
        let res = site.respond("/apikit-ca.crt", ua);
        let disposition = res
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .expect("named download")
            .to_str()
            .unwrap();
        assert!(disposition.contains(CERT_FILENAME), "{disposition}");
    }

    #[test]
    fn apple_clients_are_recognised() {
        for ua in [
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
            "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        ] {
            assert!(is_apple(ua), "{ua}");
        }
        for ua in [
            "Mozilla/5.0 (Linux; Android 14; Pixel 8)",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "curl/8.7.1",
            "",
        ] {
            assert!(!is_apple(ua), "{ua}");
        }
    }

    #[test]
    fn a_refused_tunnel_is_never_a_success_status() {
        // Any 2xx here reads as "tunnel open" and leaves the client
        // handshaking against a web page — the failure this exists to avoid.
        let res = refuse_tunnel();
        assert!(!res.status().is_success(), "{}", res.status());
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn a_site_on_our_ip_at_another_port_is_not_us() {
        let site = SetupSite::new(&ca(), 8080);
        assert!(!site.claims("127.0.0.1:3000", false));
    }

    #[test]
    fn serves_the_certificate_at_every_spelling() {
        let pem = ca();
        let site = SetupSite::new(&pem, 8080);
        for path in CERT_PATHS {
            let res = site.respond(path, "");
            assert_eq!(
                res.headers().get(header::CONTENT_TYPE).unwrap(),
                "application/x-x509-ca-cert",
                "{path}"
            );
            let disposition = res
                .headers()
                .get(header::CONTENT_DISPOSITION)
                .unwrap()
                .to_str()
                .unwrap();
            assert!(disposition.contains(CERT_FILENAME), "{path}");
        }
    }

    #[test]
    fn a_query_string_still_reaches_the_certificate() {
        let site = site();
        let res = site.respond("/apikit-ca.crt?v=2", "");
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/x-x509-ca-cert"
        );
    }

    #[test]
    fn any_other_path_gets_the_page() {
        let site = site();
        for path in ["/", "/anything", "/favicon.ico"] {
            let res = site.respond(path, "");
            let kind = res.headers().get(header::CONTENT_TYPE).unwrap();
            assert_eq!(kind, "text/html; charset=utf-8", "{path}");
        }
    }

    #[test]
    fn the_page_names_the_certificate_actually_on_disk() {
        // A CA generated before a rename keeps its old common name forever, so
        // the page reads the name back out rather than hard-coding today's.
        let pem = ca();
        let name = common_name(&pem);
        assert_eq!(name, "APIKit CA");
        let html = page_html(&name, "AA:BB", "192.168.1.5:8080");
        assert!(html.contains("APIKit CA"));
        assert!(html.contains("192.168.1.5:8080"));
        assert!(html.contains(CERT_FILENAME));
    }

    #[test]
    fn an_unreadable_certificate_still_produces_a_page() {
        assert_eq!(common_name("not a certificate"), "APIKit CA");
        assert_eq!(fingerprint("not a certificate"), "");
    }

    #[test]
    fn the_fingerprint_is_a_sha256_of_the_der() {
        let pem = ca();
        let der = der_from_pem(&pem).expect("decodes");
        let expected: String = Sha256::digest(&der)
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":");
        assert_eq!(fingerprint(&pem), expected);
        assert_eq!(fingerprint(&pem).split(':').count(), 32);
    }

    #[test]
    fn the_page_carries_no_external_references() {
        // The device reading this page is behind a proxy it does not trust
        // yet; anything fetched from elsewhere would fail to load.
        let html = page_html("APIKit CA", "AA:BB", "10.0.0.2:8080");
        assert!(!html.contains("http://"), "no absolute http references");
        assert!(!html.contains("https://"), "no absolute https references");
    }

    #[test]
    fn html_special_characters_in_a_name_are_escaped() {
        let html = page_html("<script>x</script>", "AA", "10.0.0.2:8080");
        assert!(!html.contains("<script>x</script>"));
        assert!(html.contains("&lt;script&gt;"));
    }
}

