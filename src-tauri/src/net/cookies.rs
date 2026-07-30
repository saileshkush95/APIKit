//! A cookie jar shared by every request, inspectable and editable from the UI.
//!
//! reqwest can keep cookies itself, but its built-in jar cannot be enumerated —
//! and a cookie you cannot see is exactly the thing that makes an API session
//! mysterious. So the store is implemented here against reqwest's
//! `CookieStore` trait: reqwest still drives it (which is what keeps cookies
//! correct across a redirect chain), while the contents stay ours to list,
//! edit, delete and persist.

use std::sync::{Arc, Mutex};

use reqwest::header::HeaderValue;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;
use url::Url;

use crate::store::{Db, GLOBAL_SCOPE};

/// Settings key holding the persisted jar, as JSON, at global scope.
///
/// Global rather than per-workspace, and never in a syncable table: a session
/// cookie is a credential for this machine, and shipping it to a peer would
/// hand them the session.
const COOKIES_KEY: &str = "cookieJar";
const ENABLED_KEY: &str = "cookieJarEnabled";

/// One stored cookie, in the shape the frontend shows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    /// Host this cookie belongs to. A leading dot means subdomains match too.
    pub domain: String,
    pub path: String,
    pub name: String,
    pub value: String,
    /// Unix milliseconds. `None` is a session cookie: dropped on quit.
    pub expires_ms: Option<i64>,
    pub secure: bool,
    pub http_only: bool,
    /// "Strict", "Lax", "None", or empty when the server did not say.
    #[serde(default)]
    pub same_site: String,
}

impl Cookie {
    /// Identity per RFC 6265: replacing a cookie means matching these three.
    fn same_slot(&self, other: &Cookie) -> bool {
        self.name == other.name
            && self.domain.eq_ignore_ascii_case(&other.domain)
            && self.path == other.path
    }

    fn expired(&self, now_ms: i64) -> bool {
        self.expires_ms.is_some_and(|at| at <= now_ms)
    }

    /// Whether this cookie should be sent to `url`.
    fn matches(&self, url: &Url) -> bool {
        let Some(host) = url.host_str() else {
            return false;
        };
        if self.secure && url.scheme() != "https" {
            return false;
        }
        domain_matches(host, &self.domain) && path_matches(url.path(), &self.path)
    }
}

/// Host match: an exact hit, or a suffix match for a domain cookie.
///
/// The dot before the suffix matters. Without it `evilexample.com` would match
/// a cookie scoped to `example.com`.
fn domain_matches(host: &str, domain: &str) -> bool {
    let host = host.trim_start_matches('.').to_lowercase();
    let domain = domain.trim_start_matches('.').to_lowercase();
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// Path match per RFC 6265 §5.1.4: a prefix that ends on a path boundary.
fn path_matches(request_path: &str, cookie_path: &str) -> bool {
    if cookie_path.is_empty() || cookie_path == "/" {
        return true;
    }
    if request_path == cookie_path {
        return true;
    }
    if let Some(rest) = request_path.strip_prefix(cookie_path) {
        return cookie_path.ends_with('/') || rest.starts_with('/');
    }
    false
}

/// The default path for a cookie the server did not scope: the directory of
/// the request, per RFC 6265 §5.1.4.
fn default_path(url: &Url) -> String {
    let path = url.path();
    if !path.starts_with('/') {
        return "/".to_string();
    }
    match path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(at) => path[..at].to_string(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parses one `Set-Cookie` header value.
///
/// Returns `None` for a header with no `name=value` pair, which is the only
/// part a server cannot omit.
pub fn parse_set_cookie(header: &str, url: &Url) -> Option<Cookie> {
    let mut parts = header.split(';');
    let pair = parts.next()?.trim();
    let (name, value) = pair.split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }

    let mut cookie = Cookie {
        domain: url.host_str().unwrap_or_default().to_string(),
        path: default_path(url),
        name: name.to_string(),
        value: value.trim().to_string(),
        expires_ms: None,
        secure: false,
        http_only: false,
        same_site: String::new(),
    };

    // Max-Age wins over Expires when both are present, per RFC 6265 §5.3.
    let mut max_age: Option<i64> = None;
    let mut expires: Option<i64> = None;

    for attribute in parts {
        let attribute = attribute.trim();
        let (key, val) = match attribute.split_once('=') {
            Some((k, v)) => (k.trim().to_lowercase(), v.trim().to_string()),
            None => (attribute.to_lowercase(), String::new()),
        };
        match key.as_str() {
            "domain" if !val.is_empty() => {
                cookie.domain = val.trim_start_matches('.').to_string();
            }
            "path" if val.starts_with('/') => cookie.path = val,
            "secure" => cookie.secure = true,
            "httponly" => cookie.http_only = true,
            "samesite" => cookie.same_site = val,
            "max-age" => {
                if let Ok(seconds) = val.parse::<i64>() {
                    max_age = Some(now_ms() + seconds * 1000);
                }
            }
            "expires" => expires = parse_http_date(&val),
            _ => {}
        }
    }
    cookie.expires_ms = max_age.or(expires);

    Some(cookie)
}

/// Parses an HTTP date into Unix milliseconds.
fn parse_http_date(value: &str) -> Option<i64> {
    let parsed = httpdate::parse_http_date(value).ok()?;
    match parsed.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => Some(d.as_millis() as i64),
        // A date before 1970 is how servers delete a cookie; treat it as long
        // expired rather than discarding the attribute.
        Err(_) => Some(0),
    }
}

/// Managed state: an `Arc` because reqwest wants ownership of the provider.
#[derive(Clone)]
pub struct CookieState(pub Arc<CookieJar>);

impl Default for CookieState {
    fn default() -> Self {
        Self(Arc::new(CookieJar::new()))
    }
}

/// The shared jar. Cheap to clone-by-Arc into every client that is built.
#[derive(Debug, Default)]
pub struct CookieJar {
    cookies: Mutex<Vec<Cookie>>,
    /// When off, cookies are neither stored nor sent. Requests stay stateless.
    enabled: Mutex<bool>,
}

impl CookieJar {
    pub fn new() -> Self {
        Self {
            cookies: Mutex::new(Vec::new()),
            enabled: Mutex::new(true),
        }
    }

    pub fn is_enabled(&self) -> bool {
        *self.enabled.lock().unwrap()
    }

    pub fn set_enabled(&self, enabled: bool) {
        *self.enabled.lock().unwrap() = enabled;
    }

    /// Every unexpired cookie, newest domains first for a stable UI order.
    pub fn list(&self) -> Vec<Cookie> {
        let now = now_ms();
        let mut cookies: Vec<Cookie> = self
            .cookies
            .lock()
            .unwrap()
            .iter()
            .filter(|c| !c.expired(now))
            .cloned()
            .collect();
        cookies.sort_by(|a, b| {
            a.domain
                .cmp(&b.domain)
                .then(a.path.cmp(&b.path))
                .then(a.name.cmp(&b.name))
        });
        cookies
    }

    /// Adds a cookie, replacing any that occupies the same name/domain/path.
    pub fn put(&self, cookie: Cookie) {
        let mut cookies = self.cookies.lock().unwrap();
        // An already-expired cookie is a delete instruction, not a value.
        if cookie.expired(now_ms()) {
            cookies.retain(|existing| !existing.same_slot(&cookie));
            return;
        }
        match cookies.iter_mut().find(|existing| existing.same_slot(&cookie)) {
            Some(existing) => *existing = cookie,
            None => cookies.push(cookie),
        }
    }

    pub fn remove(&self, domain: &str, path: &str, name: &str) {
        self.cookies.lock().unwrap().retain(|c| {
            !(c.name == name && c.path == path && c.domain.eq_ignore_ascii_case(domain))
        });
    }

    /// Clears everything, or just one domain (and its subdomains).
    pub fn clear(&self, domain: Option<&str>) {
        let mut cookies = self.cookies.lock().unwrap();
        match domain {
            None => cookies.clear(),
            Some(domain) => cookies.retain(|c| !domain_matches(&c.domain, domain)),
        }
    }

    pub fn replace_all(&self, replacement: Vec<Cookie>) {
        *self.cookies.lock().unwrap() = replacement;
    }

    /// The `Cookie` header value for `url`, or `None` when nothing matches.
    fn header_for(&self, url: &Url) -> Option<String> {
        let now = now_ms();
        let cookies = self.cookies.lock().unwrap();
        let mut matching: Vec<&Cookie> = cookies
            .iter()
            .filter(|c| !c.expired(now) && c.matches(url))
            .collect();
        if matching.is_empty() {
            return None;
        }
        // Longest path first, per RFC 6265 §5.4: the most specific cookie wins
        // for servers that read only the first value they see.
        matching.sort_by(|a, b| b.path.len().cmp(&a.path.len()));
        Some(
            matching
                .iter()
                .map(|c| format!("{}={}", c.name, c.value))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }
}

impl reqwest::cookie::CookieStore for CookieJar {
    fn set_cookies(
        &self,
        headers: &mut dyn Iterator<Item = &HeaderValue>,
        url: &Url,
    ) {
        if !self.is_enabled() {
            return;
        }
        for header in headers {
            let Ok(text) = header.to_str() else { continue };
            let Some(cookie) = parse_set_cookie(text, url) else {
                continue;
            };
            // A response may not set a cookie for an unrelated domain.
            if let Some(host) = url.host_str() {
                if !domain_matches(host, &cookie.domain) {
                    continue;
                }
            }
            self.put(cookie);
        }
    }

    fn cookies(&self, url: &Url) -> Option<HeaderValue> {
        if !self.is_enabled() {
            return None;
        }
        HeaderValue::from_str(&self.header_for(url)?).ok()
    }
}


// --- Persistence and commands -------------------------------------------------

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE scope = ?1 AND key = ?2",
        params![GLOBAL_SCOPE, key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (scope, key, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
        params![GLOBAL_SCOPE, key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Loads the jar at startup, dropping anything that expired while we were shut.
pub fn restore(jar: &CookieJar, conn: &Connection) {
    if let Some(raw) = read_setting(conn, ENABLED_KEY) {
        jar.set_enabled(raw != "false");
    }
    let Some(raw) = read_setting(conn, COOKIES_KEY) else {
        return;
    };
    let Ok(stored) = serde_json::from_str::<Vec<Cookie>>(&raw) else {
        return;
    };
    let now = now_ms();
    jar.replace_all(stored.into_iter().filter(|c| !c.expired(now)).collect());
}

/// Writes the jar back to the database.
///
/// Session cookies are deliberately dropped: a cookie with no expiry is
/// defined to last for the browsing session, and restoring one after a restart
/// would resurrect a session the server may already consider closed.
fn persist(jar: &CookieJar, db: &State<Db>) -> Result<(), String> {
    let durable: Vec<Cookie> = jar
        .list()
        .into_iter()
        .filter(|c| c.expires_ms.is_some())
        .collect();
    let json = serde_json::to_string(&durable).map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    write_setting(&conn, COOKIES_KEY, &json)
}

#[tauri::command]
pub fn list_cookies(state: State<CookieState>) -> Vec<Cookie> {
    state.0.list()
}

#[tauri::command]
pub fn cookies_enabled(state: State<CookieState>) -> bool {
    state.0.is_enabled()
}

#[tauri::command]
pub fn set_cookies_enabled(
    state: State<CookieState>,
    db: State<Db>,
    enabled: bool,
) -> Result<(), String> {
    state.0.set_enabled(enabled);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    write_setting(&conn, ENABLED_KEY, if enabled { "true" } else { "false" })
}

/// Adds or replaces a cookie by hand — the way you paste in a session you got
/// from a browser, without having to log in through the API first.
#[tauri::command]
pub fn put_cookie(
    state: State<CookieState>,
    db: State<Db>,
    cookie: Cookie,
) -> Result<(), String> {
    if cookie.name.trim().is_empty() || cookie.domain.trim().is_empty() {
        return Err("a cookie needs a name and a domain".into());
    }
    state.0.put(cookie);
    persist(&state.0, &db)
}

#[tauri::command]
pub fn delete_cookie(
    state: State<CookieState>,
    db: State<Db>,
    domain: String,
    path: String,
    name: String,
) -> Result<(), String> {
    state.0.remove(&domain, &path, &name);
    persist(&state.0, &db)
}

/// Clears the whole jar, or one domain when `domain` is given.
#[tauri::command]
pub fn clear_cookies(
    state: State<CookieState>,
    db: State<Db>,
    domain: Option<String>,
) -> Result<(), String> {
    state.0.clear(domain.as_deref());
    persist(&state.0, &db)
}

/// Called after each request so cookies the server set survive a restart.
pub fn persist_after_request(state: &State<CookieState>, db: &State<Db>) {
    // A failure here costs a persisted cookie, not the request that just
    // succeeded — so it is logged rather than surfaced.
    if let Err(e) = persist(&state.0, db) {
        eprintln!("could not persist cookies: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::cookie::CookieStore;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn parses_attributes() {
        let cookie = parse_set_cookie(
            "sid=abc123; Domain=.example.com; Path=/api; Secure; HttpOnly; SameSite=Lax",
            &url("https://www.example.com/login"),
        )
        .unwrap();
        assert_eq!(cookie.name, "sid");
        assert_eq!(cookie.value, "abc123");
        assert_eq!(cookie.domain, "example.com");
        assert_eq!(cookie.path, "/api");
        assert!(cookie.secure);
        assert!(cookie.http_only);
        assert_eq!(cookie.same_site, "Lax");
    }

    #[test]
    fn defaults_path_to_the_request_directory() {
        let cookie =
            parse_set_cookie("a=1", &url("https://example.com/v1/users/42")).unwrap();
        assert_eq!(cookie.path, "/v1/users");
        let root = parse_set_cookie("a=1", &url("https://example.com/login")).unwrap();
        assert_eq!(root.path, "/");
    }

    #[test]
    fn a_subdomain_does_not_match_a_lookalike_domain() {
        assert!(domain_matches("api.example.com", "example.com"));
        assert!(domain_matches("example.com", "example.com"));
        assert!(!domain_matches("evilexample.com", "example.com"));
    }

    #[test]
    fn path_matching_respects_boundaries() {
        assert!(path_matches("/api/users", "/api"));
        assert!(path_matches("/api", "/api"));
        assert!(!path_matches("/apidocs", "/api"));
        assert!(path_matches("/anything", "/"));
    }

    #[test]
    fn max_age_wins_over_expires() {
        let cookie = parse_set_cookie(
            "a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=3600",
            &url("https://example.com/"),
        )
        .unwrap();
        assert!(cookie.expires_ms.unwrap() > now_ms());
    }

    #[test]
    fn a_past_expiry_deletes_the_cookie() {
        let jar = CookieJar::new();
        jar.put(Cookie {
            domain: "example.com".into(),
            path: "/".into(),
            name: "sid".into(),
            value: "keep".into(),
            expires_ms: None,
            secure: false,
            http_only: false,
            same_site: String::new(),
        });
        assert_eq!(jar.list().len(), 1);

        jar.set_cookies(
            &mut [HeaderValue::from_static(
                "sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
            )]
            .iter(),
            &url("https://example.com/"),
        );
        assert!(jar.list().is_empty());
    }

    #[test]
    fn replacing_a_cookie_does_not_duplicate_it() {
        let jar = CookieJar::new();
        for value in ["one", "two"] {
            jar.set_cookies(
                &mut [HeaderValue::from_str(&format!("sid={value}")).unwrap()].iter(),
                &url("https://example.com/"),
            );
        }
        let all = jar.list();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].value, "two");
    }

    #[test]
    fn sends_only_matching_cookies() {
        let jar = CookieJar::new();
        jar.set_cookies(
            &mut [
                HeaderValue::from_static("a=1; Domain=example.com; Path=/"),
                HeaderValue::from_static("b=2; Domain=example.com; Path=/admin"),
                HeaderValue::from_static("c=3; Domain=example.com; Secure"),
            ]
            .iter(),
            &url("https://example.com/"),
        );

        let sent = jar.cookies(&url("http://example.com/public")).unwrap();
        let sent = sent.to_str().unwrap();
        assert!(sent.contains("a=1"));
        // Wrong path.
        assert!(!sent.contains("b=2"));
        // Secure cookie over plain HTTP.
        assert!(!sent.contains("c=3"));

        let secure = jar.cookies(&url("https://example.com/admin")).unwrap();
        let secure = secure.to_str().unwrap();
        assert!(secure.contains("b=2"));
        assert!(secure.contains("c=3"));
    }

    #[test]
    fn a_response_cannot_set_a_cookie_for_another_domain() {
        let jar = CookieJar::new();
        jar.set_cookies(
            &mut [HeaderValue::from_static("evil=1; Domain=example.com")].iter(),
            &url("https://attacker.test/"),
        );
        assert!(jar.list().is_empty());
    }

    #[test]
    fn disabling_the_jar_stops_both_directions() {
        let jar = CookieJar::new();
        jar.set_cookies(
            &mut [HeaderValue::from_static("a=1")].iter(),
            &url("https://example.com/"),
        );
        jar.set_enabled(false);
        assert!(jar.cookies(&url("https://example.com/")).is_none());

        jar.set_cookies(
            &mut [HeaderValue::from_static("b=2")].iter(),
            &url("https://example.com/"),
        );
        jar.set_enabled(true);
        // The cookie stored before it was disabled is still there; the one
        // offered while disabled was never taken.
        let names: Vec<String> = jar.list().into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["a"]);
    }

    #[test]
    fn clear_can_target_one_domain() {
        let jar = CookieJar::new();
        jar.set_cookies(
            &mut [HeaderValue::from_static("a=1")].iter(),
            &url("https://api.example.com/"),
        );
        jar.set_cookies(
            &mut [HeaderValue::from_static("b=2")].iter(),
            &url("https://other.test/"),
        );

        jar.clear(Some("example.com"));
        let names: Vec<String> = jar.list().into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["b"]);
    }
}
