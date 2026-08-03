//! Syncing a workspace to a GitHub repository with a personal access token.
//!
//! This is deliberately file-based rather than a second sync protocol: the
//! workspace is written as one JSON document at a path in the repo, so it
//! diffs and reviews like any other file. GitHub's Contents API needs the
//! current blob SHA to update a file, which doubles as conflict detection —
//! pushing with a stale SHA fails instead of overwriting someone's commit.
//!
//! Calls go through Rust so the token never has to sit in a webview fetch.

use serde::{Deserialize, Serialize};

const API: &str = "https://api.github.com";
const USER_AGENT: &str = concat!("APIKit/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubConfig {
    /// "owner/repo".
    pub repo: String,
    pub branch: String,
    /// Path of the document inside the repository.
    pub path: String,
    pub token: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubFile {
    pub content: String,
    /// Blob SHA, needed to update the file without clobbering newer commits.
    pub sha: Option<String>,
    pub exists: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubPushResult {
    pub sha: String,
    pub commit_url: String,
}

/// A repository the token can push to, for the picker.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepo {
    pub full_name: String,
    pub default_branch: String,
    pub private: bool,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .unwrap_or_default()
}

fn contents_url(config: &GithubConfig) -> String {
    let repo = config.repo.trim().trim_matches('/');
    let path = config.path.trim().trim_start_matches('/');
    format!("{API}/repos/{repo}/contents/{path}")
}

fn describe(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("message")?.as_str().map(str::to_string))
        .unwrap_or_else(|| body.chars().take(200).collect());

    match status.as_u16() {
        401 => "GitHub rejected the token — check it has not expired".to_string(),
        403 => format!("GitHub refused the request: {detail}"),
        404 => {
            "Not found — check the repository, branch and that the token has `repo` scope"
                .to_string()
        }
        409 => "The file changed on GitHub since your last pull — pull first".to_string(),
        422 => format!("GitHub could not apply the change: {detail}"),
        _ => format!("GitHub returned {status}: {detail}"),
    }
}

/// Reads the document. A missing file is not an error — it means "first push".
#[tauri::command]
pub async fn github_pull(config: GithubConfig) -> Result<GithubFile, String> {
    let response = client()
        .get(contents_url(&config))
        .bearer_auth(&config.token)
        .header("accept", "application/vnd.github+json")
        .query(&[("ref", config.branch.trim())])
        .send()
        .await
        .map_err(|e| format!("cannot reach GitHub: {e}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(GithubFile {
            content: String::new(),
            sha: None,
            exists: false,
        });
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(describe(status, &body));
    }

    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("malformed reply: {e}"))?;

    // The Contents API base64-encodes with newlines every 60 characters.
    let encoded: String = value
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let decoded = base64_decode(&encoded)?;

    Ok(GithubFile {
        content: String::from_utf8_lossy(&decoded).into_owned(),
        sha: value
            .get("sha")
            .and_then(|s| s.as_str())
            .map(str::to_string),
        exists: true,
    })
}

#[tauri::command]
pub async fn github_push(
    config: GithubConfig,
    content: String,
    sha: Option<String>,
    message: String,
) -> Result<GithubPushResult, String> {
    let mut payload = serde_json::json!({
        "message": message,
        "content": base64_encode(content.as_bytes()),
        "branch": config.branch.trim(),
    });
    // Omitted on the first push, required on every update.
    if let Some(sha) = sha.filter(|value| !value.is_empty()) {
        payload["sha"] = serde_json::Value::String(sha);
    }

    let response = client()
        .put(contents_url(&config))
        .bearer_auth(&config.token)
        .header("accept", "application/vnd.github+json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("cannot reach GitHub: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(describe(status, &body));
    }

    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("malformed reply: {e}"))?;

    Ok(GithubPushResult {
        sha: value
            .pointer("/content/sha")
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string(),
        commit_url: value
            .pointer("/commit/html_url")
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Confirms the token works and reports what it can reach.
#[tauri::command]
pub async fn github_check(config: GithubConfig) -> Result<String, String> {
    let repo = config.repo.trim().trim_matches('/');
    let response = client()
        .get(format!("{API}/repos/{repo}"))
        .bearer_auth(&config.token)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("cannot reach GitHub: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(describe(status, &body));
    }

    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("malformed reply: {e}"))?;
    let permissions = value.get("permissions");
    let writable = permissions
        .and_then(|p| p.get("push"))
        .and_then(|p| p.as_bool())
        .unwrap_or(false);

    if !writable {
        return Err("the token can read this repository but not write to it".into());
    }
    Ok(format!(
        "{} · default branch {}",
        value.get("full_name").and_then(|v| v.as_str()).unwrap_or(repo),
        value
            .get("default_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("main")
    ))
}

/// Runs `gh` and returns its stdout on success, or an `Err` with a sentence a
/// person can act on. Used instead of pasting a token: the token comes from the
/// account you have already signed into with the GitHub CLI, so the app never
/// asks you to paste a credential into it.
fn gh_output(args: &[&str]) -> std::io::Result<std::process::Output> {
    std::process::Command::new("gh").args(args).output()
}

/// Asks the GitHub CLI for its current access token. Tautologically `gh` must
/// be installed and logged in first — the error message says exactly that.
#[tauri::command]
pub fn github_gh_token() -> Result<String, String> {
    // `gh --version` runs whether or not the user is signed in, so it is the
    // cheap existence check before the call that needs an account.
    match gh_output(&["--version"]) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(
                "The GitHub CLI (gh) is not installed. Install it from cli.github.com, then run `gh auth login`. You can also paste a personal access token below instead."
                    .into(),
            );
        }
        Err(error) => return Err(format!("cannot run the GitHub CLI: {error}")),
        Ok(_) => {}
    }

    let output =
        gh_output(&["auth", "token"]).map_err(|e| format!("cannot run the GitHub CLI: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() { "" } else { &stderr };
        return Err(format!(
            "The GitHub CLI is not logged in. Run `gh auth login` and try again — the CLI said: {detail}"
        ));
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err(
            "The GitHub CLI returned an empty token. Run `gh auth login` and try again.".into(),
        );
    }
    Ok(token)
}

/// Lists the repositories the token can push to, newest first — the picker a
/// user reaches for instead of typing `owner/repo` by hand.
#[tauri::command]
pub async fn github_list_repos(config: GithubConfig) -> Result<Vec<GithubRepo>, String> {
    let response = client()
        .get(format!("{API}/user/repos"))
        .bearer_auth(&config.token)
        .header("accept", "application/vnd.github+json")
        .query(&[
            ("affiliation", "owner,collaborator,organization_member"),
            ("sort", "updated"),
            ("per_page", "100"),
        ])
        .send()
        .await
        .map_err(|e| format!("cannot reach GitHub: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(describe(status, &body));
    }

    let value: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("malformed reply: {e}"))?;

    Ok(value
        .into_iter()
        .filter_map(|repo| {
            let full_name = repo.get("full_name")?.as_str()?.to_string();
            Some(GithubRepo {
                full_name,
                default_branch: repo
                    .get("default_branch")
                    .and_then(|branch| branch.as_str())
                    .unwrap_or("main")
                    .to_string(),
                private: repo.get("private").and_then(|p| p.as_bool()).unwrap_or(false),
            })
        })
        .collect())
}

/// Creates a repository under the account and returns its `owner/name`, so the
/// user never has to leave the app to set one up.
#[tauri::command]
pub async fn github_create_repo(
    config: GithubConfig,
    name: String,
    description: String,
    private: bool,
) -> Result<String, String> {
    let mut payload = serde_json::json!({
        "name": name.trim(),
        "private": private,
    });
    if !description.trim().is_empty() {
        payload["description"] = serde_json::Value::String(description.trim().to_string());
    }

    let response = client()
        .post(format!("{API}/user/repos"))
        .bearer_auth(&config.token)
        .header("accept", "application/vnd.github+json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("cannot reach GitHub: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(describe(status, &body));
    }

    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("malformed reply: {e}"))?;
    value
        .get("full_name")
        .and_then(|entry| entry.as_str())
        .map(str::to_string)
        .ok_or_else(|| "created the repository, but could not read its name".into())
}

/// Writes a document to disk, used by the export action.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("cannot write {path}: {e}"))
}

/// Writes a base64-encoded body to disk, byte-exact — how binary responses
/// (PDFs, spreadsheets, images) are saved.
#[tauri::command]
pub fn save_binary_file(path: String, contents_base64: String) -> Result<(), String> {
    let bytes = base64_decode(&contents_base64)?;
    std::fs::write(&path, bytes).map_err(|e| format!("cannot write {path}: {e}"))
}

// --- base64 -------------------------------------------------------------------
// Small enough not to justify a dependency, and only ever used on our own JSON.

const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
        out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut lookup = [255u8; 256];
    for (index, byte) in ALPHABET.iter().enumerate() {
        lookup[*byte as usize] = index as u8;
    }

    let cleaned: Vec<u8> = input.bytes().filter(|b| *b != b'=').collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        let mut n = 0u32;
        for (index, byte) in chunk.iter().enumerate() {
            let value = lookup[*byte as usize];
            if value == 255 {
                return Err("not valid base64".into());
            }
            n |= (value as u32) << (18 - 6 * index);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips() {
        for sample in ["", "a", "ab", "abc", "{\"ok\":true}", "héllo — wörld"] {
            let encoded = base64_encode(sample.as_bytes());
            let decoded = base64_decode(&encoded).expect("decodes");
            assert_eq!(String::from_utf8(decoded).unwrap(), sample);
        }
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
