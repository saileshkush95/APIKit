# WebRequestKit

A desktop **API testing tool with a built-in MITM proxy interceptor**, built
with Tauri (Rust) + React + TypeScript.

Two modes in one app:

- **API Client** — compose HTTP requests (method, URL, headers, body), send
  them, and inspect the response (status, timing, size, headers, body).
- **Proxy** — a local intercepting proxy that captures live HTTP/HTTPS traffic
  from any app configured to use it, with per-request inspection of headers and
  bodies. TLS interception uses a locally generated CA you install and trust.

## Prerequisites

- Rust (stable) + Cargo
- [Bun](https://bun.sh)
- Platform toolchain for Tauri (Xcode CLT on macOS)

## Run in development

```bash
bun install
bun run tauri dev
```

## Build a release bundle

```bash
bun run tauri build
```

## How it works

```
src/                     React frontend
  components/
    ApiClient.tsx        Request builder + response viewer
    ProxyPanel.tsx       Proxy controls + live traffic table + inspector
    HeaderEditor.tsx     Key/value header editor
  lib/api.ts             Typed wrappers over Tauri commands + event stream
  types.ts               Shared types (mirror the Rust structs)

src-tauri/src/
  http_client.rs         `send_request` — reqwest-backed request sender
  proxy.rs               hudsucker MITM proxy, CA management, flow capture
  lib.rs                 Command registration + shared state
```

### Request flow (API Client)

The frontend calls the `send_request` command with a `HttpRequestSpec`. The Rust
side performs the request with `reqwest` and returns status, headers, body,
round-trip time and size.

### Proxy interception

`start_proxy(port)` boots a [`hudsucker`](https://crates.io/crates/hudsucker)
proxy on `127.0.0.1:<port>`. Every request/response pair is captured into a
`Flow`, stored in shared state, and emitted to the UI as a `proxy://flow` event
for a live view.

To intercept HTTPS you must trust the CA that WebRequestKit generates on first
run. Open the **Certificate…** panel in the Proxy tab for the on-disk path and
install instructions (macOS: add to Keychain → System → *Always Trust*).

## Roadmap / next steps

- Persist request collections & environments to disk
- Breakpoints: pause and edit requests/responses in-flight
- Replay & edit captured proxy flows in the API Client
- Response assertions / test scripts
- Mock/stub rules and request rewriting
- Syntax-highlighted editor (Monaco) for bodies
