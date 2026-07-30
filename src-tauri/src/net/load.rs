//! Load, stress, spike and soak testing.
//!
//! A test is a list of phases; each phase runs `vus` concurrent workers that
//! send the request in a loop until the phase's duration elapses. Latencies are
//! collected per phase so the report can show how the service behaved as
//! pressure changed (the point of a spike or stress profile).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::net::http_client::{Header, HttpRequestSpec};

#[derive(Default)]
pub struct LoadState {
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadPhase {
    pub label: String,
    pub vus: usize,
    pub duration_secs: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadConfig {
    pub request: HttpRequestSpec,
    pub phases: Vec<LoadPhase>,
    /// Pause between a worker's requests, to model think time.
    #[serde(default)]
    pub think_time_ms: u64,
    /// Ceiling on requests per second across all workers. 0 means no cap.
    ///
    /// Virtual users measure "what happens with N concurrent clients"; an
    /// arrival rate measures "what happens at N requests a second", which is
    /// how capacity is usually specified.
    #[serde(default)]
    pub max_rps: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseReport {
    pub label: String,
    pub vus: usize,
    pub duration_secs: u64,
    pub requests: u64,
    pub failures: u64,
    /// Status code counts, as "200" → １, so the UI can show a breakdown.
    pub statuses: Vec<(u16, u64)>,
    /// Failure kind → count: timeout, connection, TLS, DNS, other.
    pub errors: Vec<(String, u64)>,
    pub avg_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub rps: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadReport {
    pub phases: Vec<PhaseReport>,
    pub total_requests: u64,
    pub total_failures: u64,
    pub duration_ms: u128,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadProgress {
    pub phase_index: usize,
    pub label: String,
    pub elapsed_secs: u64,
    pub duration_secs: u64,
    pub requests: u64,
    pub failures: u64,
    pub avg_ms: f64,
}

#[derive(Default)]
struct Samples {
    latencies: Vec<f64>,
    failures: u64,
    statuses: std::collections::HashMap<u16, u64>,
    /// Failure kind → count, so a report can say *why* it failed.
    errors: std::collections::HashMap<String, u64>,
}

fn percentile(sorted: &[f64], pct: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = (pct / 100.0) * (sorted.len() - 1) as f64;
    let low = rank.floor() as usize;
    let high = rank.ceil() as usize;
    if low == high {
        return sorted[low];
    }
    let weight = rank - low as f64;
    sorted[low] * (1.0 - weight) + sorted[high] * weight
}

fn summarize(phase: &LoadPhase, samples: Samples, elapsed: Duration) -> PhaseReport {
    let mut latencies = samples.latencies;
    latencies.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let requests = latencies.len() as u64 + samples.failures;
    let sum: f64 = latencies.iter().sum();
    let seconds = elapsed.as_secs_f64().max(0.001);

    let mut statuses: Vec<(u16, u64)> = samples.statuses.into_iter().collect();
    statuses.sort_by_key(|(status, _)| *status);

    // Commonest first: that is the one worth acting on.
    let mut errors: Vec<(String, u64)> = samples.errors.into_iter().collect();
    errors.sort_by(|a, b| b.1.cmp(&a.1));

    PhaseReport {
        label: phase.label.clone(),
        vus: phase.vus,
        duration_secs: phase.duration_secs,
        requests,
        failures: samples.failures,
        statuses,
        errors,
        avg_ms: if latencies.is_empty() {
            0.0
        } else {
            sum / latencies.len() as f64
        },
        min_ms: latencies.first().copied().unwrap_or(0.0),
        max_ms: latencies.last().copied().unwrap_or(0.0),
        p50_ms: percentile(&latencies, 50.0),
        p95_ms: percentile(&latencies, 95.0),
        p99_ms: percentile(&latencies, 99.0),
        rps: requests as f64 / seconds,
    }
}

fn build_client(spec: &HttpRequestSpec) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("APIKit/", env!("CARGO_PKG_VERSION")))
        // Connection reuse is what makes a load test measure the service
        // rather than TLS handshakes.
        .pool_max_idle_per_host(256);

    if let Some(ms) = spec.timeout_ms {
        builder = builder.timeout(Duration::from_millis(ms));
    }
    if spec.verify_tls == Some(false) {
        builder = builder.danger_accept_invalid_certs(true);
    }
    // The client is built once for the whole run, so a certificate that cannot
    // be loaded fails the test up front rather than every request in it.
    builder = crate::net::tls::apply(
        builder,
        spec.client_cert.as_ref(),
        spec.ca_cert_paths.as_deref().unwrap_or(&[]),
    )?;
    builder = match spec.http_version.as_deref() {
        Some("http1") => builder.http1_only(),
        Some("http2") => builder.http2_prior_knowledge(),
        _ => builder,
    };
    builder.build().map_err(|e| e.to_string())
}

/// Which kind of failure this was. "connection refused" and "timed out" call
/// for completely different fixes, and a bare failure count hides that.
fn classify(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "timeout".into();
    }
    if error.is_connect() {
        return "connection".into();
    }
    if error.is_redirect() {
        return "too many redirects".into();
    }
    if error.is_body() || error.is_decode() {
        return "bad response body".into();
    }
    // The cause is where TLS and DNS failures actually describe themselves.
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = source {
        let text = current.to_string().to_lowercase();
        if text.contains("certificate") || text.contains("tls") || text.contains("handshake") {
            return "TLS".into();
        }
        if text.contains("dns") || text.contains("resolve") {
            return "DNS".into();
        }
        source = current.source();
    }
    "other".into()
}

async fn one_request(
    client: &reqwest::Client,
    method: &reqwest::Method,
    url: &str,
    headers: &[Header],
    body: &Option<String>,
) -> Result<u16, String> {
    let mut request = client.request(method.clone(), url);
    for header in headers {
        if !header.name.trim().is_empty() {
            request = request.header(&header.name, &header.value);
        }
    }
    if let Some(body) = body {
        if !body.is_empty() {
            request = request.body(body.clone());
        }
    }
    let response = request.send().await.map_err(|e| classify(&e))?;
    let status = response.status().as_u16();
    // Drain the body so the connection can be reused.
    let _ = response.bytes().await;
    Ok(status)
}

#[tauri::command]
pub async fn run_load_test(
    app: AppHandle,
    state: State<'_, LoadState>,
    config: LoadConfig,
) -> Result<LoadReport, String> {
    let method = reqwest::Method::from_bytes(config.request.method.to_uppercase().as_bytes())
        .map_err(|e| format!("invalid HTTP method: {e}"))?;
    let client = build_client(&config.request)?;

    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::Relaxed);

    let started = Instant::now();
    let mut phases = Vec::new();

    for (index, phase) in config.phases.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let samples = Arc::new(Mutex::new(Samples::default()));
        let deadline = Instant::now() + Duration::from_secs(phase.duration_secs);
        let phase_started = Instant::now();
        // Requests admitted this phase, shared by its workers: the arrival-rate
        // cap is a schedule over the whole phase, not per worker.
        let sent_total = Arc::new(AtomicU64::new(0));

        let mut workers = Vec::with_capacity(phase.vus);
        for _ in 0..phase.vus.max(1) {
            let client = client.clone();
            let method = method.clone();
            let url = config.request.url.clone();
            let headers = config.request.headers.clone();
            let body = config.request.body.clone();
            let samples = samples.clone();
            let cancel = cancel.clone();
            let think = config.think_time_ms;
            let rate = config.max_rps;
            let started_at = phase_started;
            let counter = sent_total.clone();

            workers.push(tokio::spawn(async move {
                while Instant::now() < deadline && !cancel.load(Ordering::Relaxed) {
                    // Arrival-rate cap: a worker waits until the schedule has
                    // room for its request rather than firing immediately.
                    if rate > 0 {
                        let taken = counter.fetch_add(1, Ordering::Relaxed) + 1;
                        let due = Duration::from_secs_f64(taken as f64 / rate as f64);
                        let elapsed = started_at.elapsed();
                        if due > elapsed {
                            tokio::time::sleep(due - elapsed).await;
                        }
                    }
                    let sent = Instant::now();
                    let outcome = one_request(&client, &method, &url, &headers, &body).await;
                    let elapsed = sent.elapsed().as_secs_f64() * 1000.0;

                    {
                        let mut guard = samples.lock().unwrap();
                        match outcome {
                            Ok(status) => {
                                guard.latencies.push(elapsed);
                                *guard.statuses.entry(status).or_insert(0) += 1;
                                if status >= 500 {
                                    guard.failures += 1;
                                }
                            }
                            Err(kind) => {
                                guard.failures += 1;
                                *guard.errors.entry(kind).or_insert(0) += 1;
                            }
                        }
                    }

                    if think > 0 {
                        tokio::time::sleep(Duration::from_millis(think)).await;
                    }
                }
            }));
        }

        // Report progress while the phase runs.
        let reporter = {
            let samples = samples.clone();
            let app = app.clone();
            let label = phase.label.clone();
            let duration_secs = phase.duration_secs;
            let cancel = cancel.clone();
            tokio::spawn(async move {
                while Instant::now() < deadline && !cancel.load(Ordering::Relaxed) {
                    tokio::time::sleep(Duration::from_millis(500)).await;

                    // Scoped so the (non-Send) guard cannot be held across the
                    // next await.
                    let (count, failures, avg) = {
                        let guard = samples.lock().unwrap();
                        let count = guard.latencies.len() as u64;
                        let avg = if count == 0 {
                            0.0
                        } else {
                            guard.latencies.iter().sum::<f64>() / count as f64
                        };
                        (count, guard.failures, avg)
                    };

                    let _ = app.emit(
                        "load://progress",
                        LoadProgress {
                            phase_index: index,
                            label: label.clone(),
                            elapsed_secs: phase_started.elapsed().as_secs(),
                            duration_secs,
                            requests: count + failures,
                            failures,
                            avg_ms: avg,
                        },
                    );
                }
            })
        };

        for worker in workers {
            let _ = worker.await;
        }
        reporter.abort();

        let samples = Arc::try_unwrap(samples)
            .map(|mutex| mutex.into_inner().unwrap_or_default())
            .unwrap_or_default();
        phases.push(summarize(phase, samples, phase_started.elapsed()));
    }

    let total_requests = phases.iter().map(|p| p.requests).sum();
    let total_failures = phases.iter().map(|p| p.failures).sum();

    Ok(LoadReport {
        phases,
        total_requests,
        total_failures,
        duration_ms: started.elapsed().as_millis(),
        cancelled: cancel.load(Ordering::Relaxed),
    })
}

#[tauri::command]
pub fn stop_load_test(state: State<LoadState>) -> Result<(), String> {
    state.cancel.store(true, Ordering::Relaxed);
    Ok(())
}
