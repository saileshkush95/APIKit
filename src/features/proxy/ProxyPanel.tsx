import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  caCertificatePath,
  caTrusted,
  clearFlows,
  getCaCertificatePem,
  getFlows,
  onProxyFlow,
  proxyStatus,
  setSystemProxy,
  startProxy,
  stopProxy,
  trustCaCertificate,
} from "../../shared/lib/api";
import { Input, Select } from "../../shared/components/Field";
import { ProxySetupGuide } from "./ProxySetupGuide";
import type { Flow, Header, ProxyStatus } from "../../shared/types";
import { generateCode } from "../../shared/lib/codegen";
import { flowLabel, flowToDraft } from "../../shared/lib/flow";
import { notify, notifyError } from "../../shared/lib/notify";
import { statusColor } from "../../shared/lib/ui";
import { useHandoff } from "../../shared/state/handoff";

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Path without the query, plus the query as pairs — long URLs are unreadable
 *  as one string but perfectly clear as a path and a table. */
function splitUrl(url: string): {
  origin: string;
  path: string;
  params: Header[];
} {
  try {
    const u = new URL(url);
    return {
      origin: u.origin,
      path: u.pathname,
      params: Array.from(u.searchParams, ([name, value]) => ({ name, value })),
    };
  } catch {
    return { origin: "", path: url, params: [] };
  }
}

function HeaderTable({ headers }: { headers: Header[] }) {
  if (headers.length === 0)
    return <div className="p-2 text-muted">None</div>;
  return (
    <table className="w-full border-collapse">
      <tbody>
        {headers.map((h, i) => (
          <tr key={i} className="border-b border-edge align-top">
            <td className="whitespace-nowrap px-2 py-1 font-mono text-xs text-brand">
              {h.name}
            </td>
            <td className="break-all px-2 py-1 font-mono text-xs">{h.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProxyPanel() {
  const [status, setStatus] = useState<ProxyStatus>({
    running: false,
    port: null,
    flowCount: 0,
    addresses: [],
  });
  const [port, setPort] = useState(8080);
  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState("");
  const [methodFilter, setMethodFilter] = useState("");
  const [hostFilter, setHostFilter] = useState("");
  const [detailTab, setDetailTab] = useState<
    "query" | "reqHeaders" | "reqBody" | "resHeaders" | "resBody"
  >("reqHeaders");
  // Percentage of the width given to the flow list, remembered across sessions.
  const [split, setSplit] = useState(() => {
    const stored = Number(localStorage.getItem("proxySplit"));
    return stored >= 20 && stored <= 80 ? stored : 58;
  });
  const dragging = useRef(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [selected, setSelected] = useState<Flow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [certPath, setCertPath] = useState("");
  const [certPem, setCertPem] = useState("");
  const [showCert, setShowCert] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  const navigate = useNavigate();
  const hand = useHandoff((s) => s.hand);

  /** Sends a captured flow to the client, either as a tab or as a saved request. */
  function handOff(flow: Flow, save: boolean) {
    hand({
      kind: "draft",
      name: flowLabel(flow),
      draft: flowToDraft(flow),
      save,
    });
    navigate({ to: "/client" });
  }

  async function copyAsCurl(flow: Flow) {
    const draft = flowToDraft(flow);
    try {
      await navigator.clipboard.writeText(
        generateCode(
          {
            method: draft.method,
            url: draft.url,
            headers: draft.headers,
            body: draft.body,
          },
          "curl",
        ),
      );
      notify("success", "Copied as cURL");
    } catch (e) {
      notifyError("Could not copy", e);
    }
  }

  useEffect(() => {
    proxyStatus().then(setStatus).catch(() => {});
    getFlows().then(setFlows).catch(() => {});

    const unlistenPromise = onProxyFlow((flow) => {
      setFlows((prev) => [...prev, flow]);
      setStatus((s) => ({ ...s, flowCount: s.flowCount + 1 }));
    });

    return () => {
      unlistenPromise.then((un) => un());
    };
  }, []);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (status.running) {
        await stopProxy();
        // Losing the OS setting matters more than how the stop went: a
        // machine left pointing at a dead proxy has no working network.
        await setSystemProxy(false, port).catch((e) =>
          notifyError("Could not restore the system proxy", e),
        );
      } else {
        // Always on the LAN too, so phones on the network can point at us.
        await startProxy(port, true);
        // This computer is configured automatically. HTTPS only survives
        // interception if the OS trusts our CA, so that is ensured first.
        try {
          const certPath = await caCertificatePath();
          if (!(await caTrusted(certPath))) {
            notify(
              "info",
              "Approve the system prompt so HTTPS keeps working while the proxy runs",
            );
            await trustCaCertificate(certPath);
          }
          await setSystemProxy(true, port);
          notify("success", "This computer now routes through APIKit");
        } catch (e) {
          notifyError(
            "Proxy is running, but this computer could not be configured automatically",
            e,
          );
        }
      }
      setStatus(await proxyStatus());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadCert() {
    try {
      const [path, pem] = await Promise.all([
        caCertificatePath(),
        getCaCertificatePem(),
      ]);
      setCertPath(path);
      setCertPem(pem);
      setShowCert(true);
    } catch (e) {
      setError(String(e));
    }
  }

  // Each dropdown offers what has actually been captured, rather than a fixed
  // list that is mostly empty.
  const unique = (values: string[]) =>
    Array.from(new Set(values.filter(Boolean))).sort();
  const apps = unique(flows.map((flow) => flow.app));
  const methods = unique(flows.map((flow) => flow.method));
  const hosts = unique(flows.map((flow) => flow.host));

  const needle = query.trim().toLowerCase();
  const visible = flows.filter((flow) => {
    if (appFilter && flow.app !== appFilter) return false;
    if (methodFilter && flow.method !== methodFilter) return false;
    if (hostFilter && flow.host !== hostFilter) return false;
    if (needle === "") return true;
    return (
      flow.url.toLowerCase().includes(needle) ||
      flow.host.toLowerCase().includes(needle) ||
      flow.method.toLowerCase().includes(needle) ||
      String(flow.status ?? "").includes(needle)
    );
  });

  // Drag the divider. Listeners live on the window so the pointer can leave
  // the handle mid-drag without the split sticking.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current || !splitRef.current) return;
      // A selection begun before the drag would otherwise keep extending.
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      const box = splitRef.current.getBoundingClientRect();
      const percent = ((e.clientX - box.left) / box.width) * 100;
      setSplit(Math.min(80, Math.max(20, percent)));
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.body.style.webkitUserSelect = "";
      setSplit((current) => {
        localStorage.setItem("proxySplit", String(Math.round(current)));
        return current;
      });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  async function onClear() {
    await clearFlows();
    setFlows([]);
    setSelected(null);
    setStatus((s) => ({ ...s, flowCount: 0 }));
  }

  return (
    <div className="flex min-h-0 w-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-none items-center gap-3 border-b border-edge p-3 px-4">
        <button
          onClick={toggle}
          disabled={busy}
          className={`rounded-md px-4 py-2 font-semibold text-white disabled:opacity-50 ${
            status.running ? "bg-err" : "bg-brand hover:bg-brand-bright"
          }`}
        >
          {status.running ? "Stop proxy" : "Start proxy"}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Port
          <input
            type="number"
            value={port}
            disabled={status.running}
            onChange={(e) => setPort(Number(e.target.value))}
            className="w-[70px] rounded-md border border-edge bg-elevated px-2 py-1.5 font-mono text-ink outline-none focus:border-brand disabled:opacity-60"
          />
        </label>
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            status.running ? "bg-ok shadow-[0_0_8px_var(--color-ok)]" : "bg-muted"
          }`}
        />
        <span className="font-mono text-xs text-muted">
          {status.running
            ? `Listening on ${(status.addresses.length > 0
                ? status.addresses
                : ["127.0.0.1"]
              )
                .map((address) => `${address}:${status.port}`)
                .join("  ·  ")}`
            : "Stopped"}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setShowSetup((prev) => !prev)}
          className={`rounded-md border px-3 py-1.5 ${
            showSetup
              ? "border-brand bg-elevated text-ink"
              : "border-edge bg-elevated hover:border-brand"
          }`}
        >
          Setup guide
        </button>
        <button
          onClick={loadCert}
          className="rounded-md border border-edge bg-elevated px-3 py-1.5 hover:border-brand"
        >
          Certificate…
        </button>
        <button
          onClick={onClear}
          disabled={flows.length === 0}
          className="rounded-md border border-edge bg-elevated px-3 py-1.5 hover:border-brand disabled:opacity-45"
        >
          Clear ({flows.length})
        </button>
      </div>

      {error && (
        <div className="m-3 whitespace-pre-wrap rounded-md border border-err bg-err/10 p-3 font-mono text-xs text-red-300">
          {error}
        </div>
      )}

      {showCert && (
        <div className="m-4 rounded-lg border border-edge bg-panel p-4">
          <div className="flex items-center justify-between">
            <strong>Trust the APIKit CA to intercept HTTPS</strong>
            <button
              onClick={() => setShowCert(false)}
              className="px-1.5 text-lg text-muted hover:text-err"
            >
              ×
            </button>
          </div>
          <ol className="my-2 list-decimal pl-5 leading-7 text-muted">
            <li>
              Point your browser/system HTTP proxy at{" "}
              <code className="rounded bg-elevated px-1.5 font-mono text-ink">
                {(status.addresses.length > 0
                  ? status.addresses
                  : ["127.0.0.1"]
                )
                  .map((address) => `${address}:${port}`)
                  .join(" or ")}
              </code>
              .
            </li>
            <li>
              Install &amp; trust the CA certificate on disk at:
              <br />
              <code className="rounded bg-elevated px-1.5 font-mono text-ink">
                {certPath}
              </code>
            </li>
            <li>
              Per-platform instructions (macOS, Windows, Linux, Android, iOS)
              are in the <strong>Setup guide</strong>.
            </li>
          </ol>
          <details>
            <summary className="cursor-pointer">Show PEM</summary>
            <pre className="mt-2 max-h-[300px] overflow-auto rounded-md border border-edge bg-panel p-2 font-mono text-[11.5px]">
              {certPem}
            </pre>
          </details>
        </div>
      )}

      {showSetup ? (
        <ProxySetupGuide
          host={
            status.addresses.find((address) => address !== "127.0.0.1") ??
            "127.0.0.1"
          }
          port={status.port ?? port}
        />
      ) : (
      /* Flow list + detail */
      <div
        ref={splitRef}
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: `${split}% 0.25rem 1fr` }}
      >
        <div className="flex min-h-0 flex-col">
          {/* Filters */}
          <div className="flex flex-none items-center gap-2 border-b border-edge px-2 py-1.5">
            <Input
              size="compact"
              mono
              value={query}
              placeholder="Filter by URL, host, method or status…"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Select
              size="compact"
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
              className="w-28 flex-none cursor-pointer"
            >
              <option value="">All methods</option>
              {methods.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </Select>
            <Select
              size="compact"
              value={hostFilter}
              onChange={(e) => setHostFilter(e.target.value)}
              className="w-44 flex-none cursor-pointer"
            >
              <option value="">All hosts</option>
              {hosts.map((host) => (
                <option key={host} value={host}>
                  {host}
                </option>
              ))}
            </Select>
            <Select
              size="compact"
              value={appFilter}
              onChange={(e) => setAppFilter(e.target.value)}
              className="w-36 flex-none cursor-pointer"
            >
              <option value="">All apps</option>
              {apps.map((app) => (
                <option key={app} value={app}>
                  {app}
                </option>
              ))}
            </Select>
            {(needle !== "" ||
              appFilter !== "" ||
              methodFilter !== "" ||
              hostFilter !== "") && (
              <button
                onClick={() => {
                  setQuery("");
                  setAppFilter("");
                  setMethodFilter("");
                  setHostFilter("");
                }}
                className="rounded px-1.5 py-1 text-[11px] text-muted hover:text-ink"
                title="Clear filters"
              >
                ✕ {visible.length}/{flows.length}
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-[11px] font-medium text-muted">
                {["#", "App", "Method", "Host", "Path", "Status", "Time"].map((h) => (
                  <th
                    key={h}
                    className="sticky top-0 border-b border-edge bg-panel p-2"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-muted">
                    {flows.length > 0
                      ? "No flows match the filter."
                      : status.running
                        ? "Waiting for traffic…"
                        : "Start the proxy and route traffic through it."}
                  </td>
                </tr>
              )}
              {visible.map((f) => (
                <tr
                  key={f.id}
                  onClick={() => setSelected(f)}
                  className={`cursor-pointer border-b border-edge text-xs hover:bg-elevated ${
                    selected?.id === f.id ? "bg-brand/15" : ""
                  }`}
                >
                  <td className="p-2">{f.id}</td>
                  <td
                    className="max-w-[120px] truncate p-2 text-muted"
                    title={f.app}
                  >
                    {f.app || "—"}
                  </td>
                  <td className="p-2 font-mono">{f.method}</td>
                  <td className="max-w-[180px] truncate p-2 font-mono">
                    {f.host}
                  </td>
                  <td className="max-w-[180px] truncate p-2 font-mono">
                    {shortPath(f.url)}
                  </td>
                  <td className={`p-2 font-mono font-bold ${statusColor(f.status)}`}>
                    {f.status ?? "—"}
                  </td>
                  <td className="p-2">{f.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>

        <div
          onMouseDown={(e) => {
            // Without this the drag starts a text selection in the table.
            e.preventDefault();
            dragging.current = true;
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            // WKWebView still wants the prefixed property.
            document.body.style.webkitUserSelect = "none";
          }}
          onDoubleClick={() => {
            setSplit(58);
            localStorage.setItem("proxySplit", "58");
          }}
          className="cursor-col-resize border-x border-edge bg-transparent transition-colors hover:bg-brand/40"
          title="Drag to resize — double-click to reset"
        />

        <div className="flex min-h-0 flex-col">
          {!selected ? (
            <div className="p-6 text-center text-muted">
              Select a request to inspect it.
            </div>
          ) : (
            <>
              <div className="flex-none border-b border-edge p-3">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="font-mono text-[13px] font-bold text-brand">
                    {selected.method}
                  </span>
                  <span
                    className="min-w-0 truncate font-mono text-[11px] text-muted"
                    title={selected.url}
                  >
                    {splitUrl(selected.url).origin}
                  </span>
                </div>
                <h3
                  className="mb-2 line-clamp-2 font-mono text-[12.5px] font-semibold break-all"
                  title={selected.url}
                >
                  {splitUrl(selected.url).path}
                </h3>
                <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
                  <span
                    className={`font-mono font-bold ${statusColor(
                      selected.status,
                    )}`}
                  >
                    {selected.status ?? "—"} {selected.statusText}
                  </span>
                  <span>·</span>
                  <span>{selected.durationMs} ms</span>
                  {selected.app && (
                    <>
                      <span>·</span>
                      <span className="truncate">{selected.app}</span>
                    </>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => handOff(selected, false)}
                    className="rounded border border-edge px-2 py-1 text-[11px] text-ink hover:bg-elevated"
                    title="Open this request in the client, ready to edit and resend"
                  >
                    Open in client
                  </button>
                  <button
                    onClick={() => handOff(selected, true)}
                    className="rounded border border-edge px-2 py-1 text-[11px] text-ink hover:bg-elevated"
                    title="Add this request to the collection"
                  >
                    Save to collection
                  </button>
                  <button
                    onClick={() => copyAsCurl(selected)}
                    className="rounded border border-edge px-2 py-1 text-[11px] text-ink hover:bg-elevated"
                  >
                    Copy as cURL
                  </button>
                </div>
              </div>

              {/* Request / response split into tabs, so a long header list
                  never buries the body. */}
              <div className="flex flex-none items-center gap-1 border-b border-edge px-2 py-1">
                {(
                  [
                    ["query", "Query", splitUrl(selected.url).params.length],
                    ["reqHeaders", "Headers", selected.requestHeaders.length],
                    ["reqBody", "Body", selected.requestBody ? 1 : 0],
                    ["resHeaders", "Resp. headers", selected.responseHeaders.length],
                    ["resBody", "Resp. body", selected.responseBody ? 1 : 0],
                  ] as const
                ).map(([key, label, count]) => (
                  <button
                    key={key}
                    onClick={() => setDetailTab(key)}
                    className={`rounded px-2 py-1 text-[11px] ${
                      detailTab === key
                        ? "bg-elevated font-medium text-ink"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    {label}
                    {count > 1 && (
                      <span className="ml-1 text-[10px] text-muted">
                        {count}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="min-h-0 flex-1 overflow-auto p-3">
                {detailTab === "query" &&
                  (splitUrl(selected.url).params.length > 0 ? (
                    <HeaderTable headers={splitUrl(selected.url).params} />
                  ) : (
                    <div className="p-4 text-center text-xs text-muted">
                      No query parameters.
                    </div>
                  ))}
                {detailTab === "reqHeaders" && (
                  <HeaderTable headers={selected.requestHeaders} />
                )}
                {detailTab === "reqBody" &&
                  (selected.requestBody ? (
                    <BodyBlock text={selected.requestBody} />
                  ) : (
                    <div className="p-4 text-center text-xs text-muted">
                      No request body.
                    </div>
                  ))}
                {detailTab === "resHeaders" && (
                  <HeaderTable headers={selected.responseHeaders} />
                )}
                {detailTab === "resBody" &&
                  (selected.responseBody ? (
                    <BodyBlock text={selected.responseBody} />
                  ) : (
                    <div className="p-4 text-center text-xs text-muted">
                      No response body.
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}


function BodyBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-[300px] overflow-auto rounded-md border border-edge bg-panel p-2 font-mono text-[11.5px]">
      {text}
    </pre>
  );
}
