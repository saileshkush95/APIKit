# APIKit

A desktop API tool built with Tauri (Rust) + React + TypeScript. One app for
composing requests, intercepting live traffic, serving mocks, load testing and
monitoring.

## What it does

- **Client** — REST, GraphQL, gRPC, WebSocket, SSE, Socket.IO, MQTT and WebRTC,
  over HTTP/1.1, HTTP/2 or HTTP/3. Collections in folders, environments,
  pre-request and post-response scripts, declarative assertions including JSON
  Schema, and code generation for a dozen languages.
- **Proxy** — a local intercepting proxy that captures traffic from any app
  pointed at it, with breakpoints that pause a request or response mid-flight so
  it can be edited. TLS interception uses a CA generated on first run.
- **Mock server** — routes in folders with static, templated, sequenced, proxied
  and SSE responses, plus request matching and injected failures.
- **Load** — phased load tests with an arrival-rate cap, percentile latencies and
  comparison against the previous run.
- **Runner** — runs a collection or folder with concurrency, data files and JUnit
  XML output. Also available as a [command-line runner](#command-line-runner).
- **Monitors** — scheduled runs with email notification.
- **Sync** — LAN sync between your own machines, or a workspace committed to a
  GitHub repository.

Authorization covers bearer, basic, API key and OAuth 2.0 — authorization code
with PKCE, client credentials, password and device code — plus client
certificates for mutual TLS.

## Prerequisites

- Rust (stable) + Cargo
- [Bun](https://bun.sh)
- Platform toolchain for Tauri (Xcode CLT on macOS)

No `protoc` is needed for gRPC: `.proto` files are compiled in-process.

## Run in development

```bash
bun install
bun run tauri dev
```

## Build a release bundle

```bash
bun run tauri build
```

Checks without a full build, which is usually what you want:

```bash
bunx tsc --noEmit                          # frontend
cd src-tauri && cargo check && cargo test  # backend
```

## Command-line runner

Runs an exported workspace and exits non-zero if anything failed, so a
collection can gate a pipeline. Download `apikit-run.js` from a
[release](https://github.com/saileshkush95/APIKit/releases) — it is plain JS and
needs only node.

```bash
node apikit-run.js workspace.json --env Staging --env-var API_TOKEN --junit results.xml
```

| | |
|---|---|
| `--folder <name>` | Run only this folder, at any depth |
| `--env <name>` | Use this environment's variables |
| `--var name=value` | Set or override one variable; repeatable |
| `--env-var NAME` | Take a variable from the process environment |
| `--iterations <n>` | Run the selection n times |
| `--delay <ms>` | Wait between requests |
| `--timeout <ms>` | Per-request timeout |
| `--bail` | Stop at the first failure |
| `--junit <path>` | Write a JUnit XML report |

Exports redact credentials on purpose, so secrets come from the environment
rather than the file — which is where CI keeps them anyway. An `--env-var` that
is not set is a hard failure rather than an empty value: silently sending no
token is how a green pipeline ends up testing nothing.

The CLI shares its execution path with the app, so a run here means what a run
there means. It cannot do mutual TLS, and it reports the other per-request
options `fetch` has no answer for rather than ignoring them.

## Layout

```
src/
  features/          one folder per screen: client, proxy, mock, load, runner,
                     monitor, sync, settings, environments, console
  shared/
    lib/             request building, scripts, assertions, variables,
                     import/export, OAuth, certificates, JUnit
    components/      form primitives, key/value grid, code editor
    state/           zustand stores
  routes/            TanStack Router routes

cli/                 the command-line runner

src-tauri/src/
  net/               making a request: http_client, grpc, stream, load,
                     tls, cookies
  auth/              OAuth 2.0 grants, and the OS keychain tokens go into
  proxy/             the MITM engine, OS proxy settings, app-name lookup
  sync/              LAN peers and GitHub
  app/               tray, monitor email
  store.rs           SQLite workspace storage
  mock.rs            the mock server
```

## A few decisions worth knowing

**Credentials never sit beside the collection.** OAuth tokens go to the OS
keychain, and both the file export and the GitHub sync document strip
credentials typed into auth fields. A value that is only a `{{variable}}`
reference survives, because it points at a credential rather than being one.

**One execution path.** `shared/lib/execute.ts` holds the single build →
pre-script → send → post-script → assertions sequence, used by the client, the
monitors, the runner and the CLI. Only the transport is injected, so the four
cannot drift apart.

**gRPC runs on tonic rather than hand-rolled framing.** `grpc-status` arrives in
HTTP/2 trailers for every call that is not an immediate failure, and the HTTP
client does not expose trailers — so a call that failed partway through used to
look like a success with a short reply.

**Installers are unsigned; updates are signed.** The first launch needs the usual
OS override, but the updater verifies a minisign signature before applying
anything.

## Intercepting HTTPS

Trust the CA APIKit generates on first run — the **Certificate…** panel in the
Proxy tab has the on-disk path and per-platform instructions (macOS: Keychain →
System → *Always Trust*).

- [Proxy setup for iOS and Android](docs/proxy-setup.md)
- [LAN sync](docs/lan-sync.md)
