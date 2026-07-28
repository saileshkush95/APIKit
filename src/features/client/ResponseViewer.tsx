import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { saveBinaryFile, writeTextFile } from "../../shared/lib/api";
import {
  extensionForContentType,
  guessViewMode,
  mapJsonLines,
  parseCookies,
  renderBody,
  VIEW_MODES,
  type ViewMode,
} from "../../shared/lib/format";
import { renderLine, type HighlightLanguage } from "../../shared/lib/highlight";
import { notify, notifyError, notifySuccess } from "../../shared/lib/notify";
import { formatBytes, methodColor, statusColor } from "../../shared/lib/ui";
import { Toggle } from "../../shared/components/Toggle";
import { useHandoff } from "../../shared/state/handoff";
import {
  defaultConfig,
  type AssertionResult,
  type HttpResponseData,
  type ResponseTabKey,
  type SentRequest,
} from "../../shared/types";

interface Props {
  response: HttpResponseData;
  results: AssertionResult[];
  /** What actually went over the wire, for the Request tab. */
  sent: SentRequest | null;
  activeTab: ResponseTabKey;
  onTabChange: (tab: ResponseTabKey) => void;
}

function Tab({
  active,
  onClick,
  children,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs ${
        active ? "bg-elevated font-medium text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {children}
      {badge}
    </button>
  );
}

/** Line height in px, matching `text-[12.5px] leading-relaxed`. */
const LINE_HEIGHT = 20;
/** Rows drawn above and below the viewport, so scrolling stays smooth. */
const OVERSCAN = 20;
/** Past this, the body is treated as "large": no auto-format, no auto-render. */
const LARGE_BODY_BYTES = 2_000_000;

/** View modes that have a syntax colouring, mapped to their tokenizer. */
const MODE_LANGUAGE: Partial<Record<ViewMode, HighlightLanguage>> = {
  json: "json",
  xml: "markup",
  html: "markup",
  yaml: "yaml",
  javascript: "javascript",
};

export function ResponseViewer({
  response,
  results,
  sent,
  activeTab,
  onTabChange,
}: Props) {
  const contentType = response.headers.find(
    (h) => h.name.toLowerCase() === "content-type",
  )?.value;

  const [mode, setMode] = useState<ViewMode>(() =>
    guessViewMode(contentType, response.body),
  );
  const [preview, setPreview] = useState(false);
  const [wrap, setWrap] = useState(true);
  // Off by default, and reset per response: this runs code from the server
  // under test, so it must be a deliberate choice each time.
  const [interactive, setInteractive] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [modeMenu, setModeMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Formatting a very large body blocks the main thread, so it is opt-in.
  const isLarge = response.body.length > LARGE_BODY_BYTES;
  const [formatLarge, setFormatLarge] = useState(false);

  // An image body renders as an actual image. Binary formats use the exact
  // bytes; SVG arrives as text and is encoded on the spot.
  const imageSrc = useMemo(() => {
    const mime = contentType?.split(";")[0].trim().toLowerCase() ?? "";
    if (!mime.startsWith("image/")) return null;
    if (response.bodyBase64) return `data:${mime};base64,${response.bodyBase64}`;
    try {
      const bytes = new TextEncoder().encode(response.body);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return `data:${mime};base64,${btoa(binary)}`;
    } catch {
      return null;
    }
  }, [contentType, response]);

  // A new response may be a different content type than the last one.
  // Images open straight into their preview.
  useEffect(() => {
    setMode(guessViewMode(contentType, response.body));
    setPreview(
      (contentType?.split(";")[0].trim().toLowerCase() ?? "").startsWith(
        "image/",
      ),
    );
    setFormatLarge(false);
  }, [response]);

  useEffect(() => {
    if (!modeMenu) return;
    function onClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setModeMenu(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [modeMenu]);

  const rendered = useMemo(
    () =>
      isLarge && !formatLarge && mode !== "raw"
        ? response.body
        : renderBody(response.body, mode),
    [response.body, mode, isLarge, formatLarge],
  );
  const lines = useMemo(() => rendered.split("\n"), [rendered]);

  const unformatted = isLarge && !formatLarge;
  const lang: HighlightLanguage = unformatted
    ? "none"
    : (MODE_LANGUAGE[mode] ?? "none");

  // Line → JSON subtree, so a click on a line can copy that node and a
  // container line can collapse. Only when the shown text really is our own
  // re-serialization of a successful parse.
  const jsonMap = useMemo(() => {
    if (mode !== "json" || unformatted) return null;
    try {
      return mapJsonLines(JSON.parse(response.body));
    } catch {
      return null;
    }
  }, [response.body, mode, unformatted]);
  // Any drift between the mapper and the serializer must fail safe.
  const copyMap =
    jsonMap && jsonMap.nodes.length === lines.length ? jsonMap : null;

  /**
   * The http(s) URL a copied value is, or contains. Trailing punctuation is
   * dropped so a link at the end of a sentence still opens.
   */
  function urlIn(text: string): string | null {
    const match = /https?:\/\/[^\s"'<>\\]+/.exec(text);
    if (!match) return null;
    return match[0].replace(/[.,;:)\]}]+$/, "");
  }

  /**
   * The preview document. `srcDoc` has no URL of its own, so every relative
   * asset — `/_next/static/…`, `styles.css` — would resolve against nothing
   * and 404. A `<base>` pointing at the request URL fixes that.
   */
  // With a URL to load from, the page runs at its real origin — the only way
  // one that needs cookies or its own API can work. Without one, scripts still
  // run against the captured HTML, which is the best that can be done.
  const livePreview = interactive && Boolean(sent?.url);

  const previewDocument = useMemo(() => {
    if (!sent?.url) return response.body;
    if (/<base\b/i.test(response.body)) return response.body;
    const tag = `<base href="${sent.url.replace(/"/g, "&quot;")}">`;
    // After <head> when there is one, otherwise at the very top.
    return /<head[^>]*>/i.test(response.body)
      ? response.body.replace(/<head[^>]*>/i, (head) => `${head}${tag}`)
      : `${tag}${response.body}`;
  }, [response.body, sent?.url]);

  /** Host plus last path segment, so the tab is recognisable but not a wall. */
  function linkLabel(link: string): string {
    try {
      const parsed = new URL(link);
      const last = parsed.pathname.split("/").filter(Boolean).pop();
      return last ? `${parsed.host}/${last}` : parsed.host;
    } catch {
      return link.slice(0, 40);
    }
  }

  async function copyNode(line: number, wantPath = false) {
    if (!copyMap) return;
    // Clicking the property name copies where the value lives; clicking the
    // value copies the value itself.
    if (wantPath) {
      const path = copyMap.paths[line];
      if (path) {
        try {
          await navigator.clipboard.writeText(path);
          notifySuccess(`Copied path ${path}`);
        } catch {
          /* clipboard access can be denied */
        }
        return;
      }
    }
    const node = copyMap.nodes[line];
    const text =
      typeof node === "string" ? node : JSON.stringify(node, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      // A link is worth more than a copy: offer to follow it, since a URL in a
      // response is usually there to be visited (redirects, hosted pages).
      const link = urlIn(text);
      if (link) {
        // The key it was found under names the tab far better than the URL —
        // "redirectUrl" beats "test-gateway.tillpayments.com/NGQxZWIy…".
        const key = copyMap.paths[line]?.split(/[.[]/).filter(Boolean).pop();
        const tabName = key
          ? key.replace(/["\]]/g, "")
          : linkLabel(link);
        notify("success", "Copied the link", {
          detail: link,
          timeoutMs: 10_000,
          actions: [
            {
              // As a request here, which is usually the point of finding a URL
              // in a response — inspect it rather than just visit it.
              label: "Open in new tab",
              run: () =>
                useHandoff.getState().hand({
                  kind: "draft",
                  name: tabName,
                  draft: {
                    method: "GET",
                    url: link,
                    headers: [],
                    body: "",
                    tests: [],
                    config: defaultConfig(),
                  },
                  save: false,
                }),
            },
            {
              label: "Open in browser",
              run: () => {
                openUrl(link).catch((e) => notifyError("Could not open it", e));
              },
            },
          ],
        });
        return;
      }
      notifySuccess(
        `Copied ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`,
      );
    } catch {
      /* clipboard access can be denied; the click simply does nothing */
    }
  }
  const matches = useMemo(() => {
    if (search === "") return 0;
    return lines.reduce(
      (total, line) =>
        total + line.toLowerCase().split(search.toLowerCase()).length - 1,
      0,
    );
  }, [lines, search]);

  const cookies = useMemo(
    () => parseCookies(response.headers),
    [response.headers],
  );
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const previewable =
    mode === "html" || mode === "markdown" || imageSrc !== null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(rendered);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard access can be denied; the button simply does nothing */
    }
  }

  /** Best filename to offer: the server's, else from the URL, else by type. */
  function suggestedFileName(): string {
    const disposition = response.headers.find(
      (h) => h.name.toLowerCase() === "content-disposition",
    )?.value;
    const fromServer = disposition
      ? /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1]
      : undefined;
    if (fromServer) {
      try {
        return decodeURIComponent(fromServer.replace(/"/g, "").trim());
      } catch {
        return fromServer.replace(/"/g, "").trim();
      }
    }
    try {
      const last = new URL(response.finalUrl).pathname
        .split("/")
        .filter(Boolean)
        .pop();
      if (last && /\.[a-z0-9]{1,5}$/i.test(last)) return last;
    } catch {
      /* not a parseable URL; fall through to the content type */
    }
    return `response${extensionForContentType(contentType, Boolean(response.bodyBase64))}`;
  }

  async function saveBody() {
    try {
      const path = await save({
        defaultPath: suggestedFileName(),
        title: "Save response body",
      });
      if (!path) return;
      // Binary bodies are written from their original bytes; the displayed
      // text is a lossy rendering and would corrupt a PDF or spreadsheet.
      if (response.bodyBase64) await saveBinaryFile(path, response.bodyBase64);
      else await writeTextFile(path, response.body);
      notifySuccess(`Saved ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      notifyError("Could not save the response", e);
    }
  }

  const currentMode = VIEW_MODES.find((m) => m.value === mode);

  return (
    <>
      {/* Tabs + status */}
      <div className="flex flex-none items-center gap-3 px-2 py-1">
        <div className="flex gap-0.5">
          <Tab
            active={activeTab === "body"}
            onClick={() => onTabChange("body")}
          >
            Body
          </Tab>
          <Tab
            active={activeTab === "cookies"}
            onClick={() => onTabChange("cookies")}
            badge={
              cookies.length > 0 ? (
                <span className="text-[10px] text-muted">{cookies.length}</span>
              ) : null
            }
          >
            Cookies
          </Tab>
          <Tab
            active={activeTab === "request"}
            onClick={() => onTabChange("request")}
            badge={
              sent ? (
                <span className="text-[10px] text-muted">
                  {sent.headers.length}
                </span>
              ) : null
            }
          >
            Request
          </Tab>
          <Tab
            active={activeTab === "headers"}
            onClick={() => onTabChange("headers")}
            badge={
              <span className="text-[10px] text-muted">
                {response.headers.length}
              </span>
            }
          >
            Headers
          </Tab>
          <Tab
            active={activeTab === "tests"}
            onClick={() => onTabChange("tests")}
            badge={
              results.length > 0 ? (
                <span
                  className={`rounded-full px-1.5 text-[10px] ${
                    failed > 0 ? "bg-err/20 text-err" : "bg-ok/20 text-ok"
                  }`}
                >
                  {passed}/{results.length}
                </span>
              ) : null
            }
          >
            Test Results
          </Tab>
        </div>

        <div className="ml-auto flex items-center gap-3 pr-1 font-mono text-xs">
          <span
            className={`rounded px-1.5 py-0.5 font-bold ${statusColor(
              response.status,
            )}`}
          >
            {response.status} {response.statusText}
          </span>
          <span className="text-muted">·</span>
          <span className="text-muted">{response.timeMs} ms</span>
          <span className="text-muted">·</span>
          <span className="text-muted">{formatBytes(response.sizeBytes)}</span>
          <span className="text-muted" title="Negotiated protocol">
            {response.httpVersion}
          </span>
        </div>
      </div>

      {/* Body toolbar */}
      {activeTab === "body" && (
        <div className="flex flex-none items-center gap-2 border-t border-edge px-3 py-1.5">
          <div ref={menuRef} className="relative">
            <button
              onClick={() => setModeMenu((prev) => !prev)}
              className="flex items-center gap-1.5 rounded-md bg-elevated px-2 py-1 text-xs text-ink"
            >
              <span className="font-mono text-[10px] text-muted">
                {currentMode?.icon}
              </span>
              {currentMode?.label}
              <span className="text-[9px] text-muted">▼</span>
            </button>
            {modeMenu && (
              <div className="absolute left-0 z-50 mt-1 w-44 overflow-hidden rounded-md border border-edge bg-elevated py-1 shadow-xl">
                {VIEW_MODES.map((option, i) => (
                  <div key={option.value}>
                    {/* Raw / Hex / Base64 are encodings, not languages. */}
                    {i === 6 && <div className="my-1 border-t border-edge" />}
                    <button
                      onClick={() => {
                        setMode(option.value);
                        setPreview(false);
                        setModeMenu(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-ink hover:bg-panel"
                    >
                      <span className="w-6 flex-none font-mono text-[10px] text-muted">
                        {option.icon}
                      </span>
                      {option.label}
                      {mode === option.value && (
                        <span className="ml-auto text-brand">✓</span>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {previewable && (
            <button
              onClick={() => setPreview((prev) => !prev)}
              className={`rounded-md px-2 py-1 text-xs ${
                preview ? "bg-elevated text-ink" : "text-muted hover:text-ink"
              }`}
            >
              ▷ Preview
            </button>
          )}

          {/* Sits with Preview because it is what Preview does, not a
              separate mode: off renders the captured HTML inertly, on loads
              the page for real. */}
          {previewable && preview && !imageSrc && (
            <Toggle
              checked={interactive}
              onChange={setInteractive}
              label="Interactive"
              title={
                sent?.url
                  ? "Loads the page from its own URL and runs its scripts, so it behaves as in a browser. Off, the captured HTML is shown without executing anything. Turning this on re-sends the request."
                  : "Runs the page's scripts. Off, the captured HTML is shown without executing anything."
              }
            />
          )}

          {previewable && preview && sent?.url && (
            <button
              onClick={() =>
                openUrl(sent.url).catch((e) =>
                  notifyError("Could not open it", e),
                )
              }
              className="rounded-md px-2 py-1 text-xs text-muted hover:text-ink"
              title="Open this page in your browser — the right place for anything that needs a real session"
            >
              ↗ Browser
            </button>
          )}

          <div className="ml-auto flex items-center gap-1">
            {searchOpen && (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={search}
                  spellCheck={false}
                  placeholder="Find in body"
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setSearch("");
                      setSearchOpen(false);
                    }
                  }}
                  className="w-44 rounded border border-edge bg-panel px-2 py-0.5 text-xs text-ink outline-none focus:border-brand"
                />
                <span className="w-16 text-[11px] text-muted">
                  {search ? `${matches} found` : ""}
                </span>
              </div>
            )}
            <button
              onClick={() => setSearchOpen((prev) => !prev)}
              className="rounded px-1.5 py-1 text-xs text-muted hover:bg-elevated hover:text-ink"
              title="Search in body"
            >
              ⌕
            </button>
            <button
              onClick={() => setWrap((prev) => !prev)}
              className={`rounded px-1.5 py-1 text-xs hover:bg-elevated ${
                wrap ? "text-ink" : "text-muted"
              }`}
              title={wrap ? "Disable line wrap" : "Wrap lines"}
            >
              ⏎
            </button>
            <button
              onClick={copy}
              className="rounded px-1.5 py-1 text-xs text-muted hover:bg-elevated hover:text-ink"
              title="Copy body"
            >
              {copied ? "✓" : "⧉"}
            </button>
            <button
              onClick={saveBody}
              className="rounded px-1.5 py-1 text-xs text-muted hover:bg-elevated hover:text-ink"
              title="Save response to a file"
            >
              ⭳
            </button>
          </div>
        </div>
      )}

      {activeTab === "body" && isLarge && !formatLarge && mode !== "raw" && (
        <div className="flex flex-none items-center gap-2 border-t border-edge bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
          <span>
            {formatBytes(response.sizeBytes)} response — shown unformatted to
            keep the app responsive.
          </span>
          <button
            onClick={() => setFormatLarge(true)}
            className="rounded border border-warn/50 px-2 py-0.5 hover:bg-warn/10"
          >
            Format anyway
          </button>
        </div>
      )}

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-auto border-t border-edge">
        {activeTab === "body" &&
          (preview && imageSrc ? (
            <div className="flex h-full items-center justify-center overflow-auto p-4">
              <img
                src={imageSrc}
                alt="Response image"
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : preview ? (
            <div className="flex h-full flex-col">
              {livePreview ? (
                <iframe
                  // Loaded from its own URL rather than as srcDoc, so the page
                  // runs at its real origin: its scripts, cookies, API calls
                  // and relative assets all work as they do in a browser.
                  // allow-same-origin is scoped to *that* origin, not ours.
                  key={sent?.url}
                  src={sent?.url}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                  title="Live page"
                  className="min-h-0 w-full flex-1 border-0 bg-white"
                />
              ) : (
                <iframe
                  // Without allow-same-origin the frame gets an opaque origin,
                  // so even with scripts on it cannot reach this app.
                  sandbox={
                    interactive ? "allow-scripts allow-forms allow-popups" : ""
                  }
                  srcDoc={previewDocument}
                  title="Response preview"
                  className="min-h-0 w-full flex-1 border-0 bg-white"
                />
              )}
            </div>
          ) : (
            <VirtualBody
              lines={lines}
              wrap={wrap}
              search={search}
              lang={lang}
              spans={copyMap?.spans ?? null}
              canCopyNodes={copyMap !== null}
              onCopyNode={copyNode}
            />
          ))}

        {activeTab === "cookies" &&
          (cookies.length === 0 ? (
            <p className="p-6 text-center text-muted">
              This response did not set any cookies.
            </p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-[11px] text-muted">
                  <th className="p-2">Name</th>
                  <th className="p-2">Value</th>
                  <th className="p-2">Domain</th>
                  <th className="p-2">Path</th>
                  <th className="p-2">Expires</th>
                  <th className="p-2">Flags</th>
                </tr>
              </thead>
              <tbody>
                {cookies.map((cookie, i) => (
                  <tr key={i} className="border-b border-edge align-top">
                    <td className="p-2 font-mono text-brand">{cookie.name}</td>
                    <td className="max-w-64 break-all p-2 font-mono">
                      {cookie.value}
                    </td>
                    <td className="p-2 font-mono text-muted">
                      {cookie.domain || "—"}
                    </td>
                    <td className="p-2 font-mono text-muted">
                      {cookie.path || "—"}
                    </td>
                    <td className="p-2 font-mono text-muted">
                      {cookie.expires || "session"}
                    </td>
                    <td className="p-2 text-muted">
                      {[
                        cookie.httpOnly && "HttpOnly",
                        cookie.secure && "Secure",
                        cookie.sameSite && `SameSite=${cookie.sameSite}`,
                      ]
                        .filter(Boolean)
                        .join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}

        {activeTab === "headers" && (
          <table className="w-full border-collapse">
            <tbody>
              {response.headers.map((header, i) => (
                <tr key={i} className="border-b border-edge align-top">
                  <td className="whitespace-nowrap px-3 py-1 font-mono text-xs text-brand">
                    {header.name}
                  </td>
                  <td className="break-all px-3 py-1 font-mono text-xs">
                    {header.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {activeTab === "request" &&
          (sent ? (
            <div className="flex flex-col gap-4 p-3 text-xs">
              <div>
                <div className="mb-1 text-[11px] font-semibold text-muted">
                  Sent
                </div>
                <div className="rounded border border-edge bg-panel p-2 font-mono break-all">
                  <span className={`font-bold ${methodColor(sent.method)}`}>
                    {sent.method}
                  </span>{" "}
                  {sent.url}
                </div>
                {response.finalUrl !== sent.url && (
                  <div className="mt-1 text-[11px] text-muted">
                    Redirected to{" "}
                    <span className="font-mono">{response.finalUrl}</span>
                  </div>
                )}
              </div>

              <div>
                <div className="mb-1 text-[11px] font-semibold text-muted">
                  Headers — as sent, including any added by auth
                </div>
                {sent.headers.length === 0 ? (
                  <p className="text-muted">No headers.</p>
                ) : (
                  <table className="w-full border-collapse">
                    <tbody>
                      {sent.headers.map((header, i) => (
                        <tr key={i} className="border-b border-edge align-top">
                          <td className="whitespace-nowrap px-2 py-1 font-mono text-brand">
                            {header.name}
                          </td>
                          <td className="px-2 py-1 font-mono break-all">
                            {header.value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {sent.parts && sent.parts.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold text-muted">
                    Body — multipart
                  </div>
                  <table className="w-full border-collapse">
                    <tbody>
                      {sent.parts.map((part, i) => (
                        <tr key={i} className="border-b border-edge align-top">
                          <td className="whitespace-nowrap px-2 py-1 font-mono text-brand">
                            {part.name}
                          </td>
                          <td className="px-2 py-1 font-mono break-all">
                            {part.fileName ? (
                              <span className="text-muted">
                                file: {part.fileName}
                              </span>
                            ) : (
                              part.value
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {!sent.parts && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold text-muted">
                    Body
                  </div>
                  {sent.body.trim() === "" ? (
                    <p className="text-muted">No body.</p>
                  ) : (
                    <pre className="overflow-auto rounded border border-edge bg-panel p-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">
                      {sent.body}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="p-6 text-center text-muted">
              Nothing sent yet.
            </p>
          ))}

        {activeTab === "tests" && (
          <div className="flex flex-col gap-1 p-3">
            {results.length === 0 ? (
              <p className="text-xs text-muted">
                No assertions defined for this request.
              </p>
            ) : (
              results.map((result, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 rounded border px-2.5 py-1.5 text-xs ${
                    result.passed
                      ? "border-ok/30 bg-ok/5"
                      : "border-err/40 bg-err/5"
                  }`}
                >
                  <span
                    className={`font-mono font-bold ${
                      result.passed ? "text-ok" : "text-err"
                    }`}
                  >
                    {result.passed ? "PASS" : "FAIL"}
                  </span>
                  <span className="min-w-0 flex-1 break-words">
                    {result.message}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Renders only the lines in view. A large response is thousands of rows, and
 * one DOM node per line (twice, with the gutter) is what made the viewer stall.
 */
function VirtualBody({
  lines,
  wrap,
  search,
  lang,
  spans,
  canCopyNodes,
  onCopyNode,
}: {
  lines: string[];
  wrap: boolean;
  search: string;
  lang: HighlightLanguage;
  /** JSON bodies: for a container-opening line, its closing line. */
  spans: (number | null)[] | null;
  /** JSON bodies: clicking a line copies the node on it. */
  canCopyNodes: boolean;
  onCopyNode: (line: number, wantPath: boolean) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  // Opening lines whose container is folded away.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // A new response (or view mode) is a new set of lines; nothing it shows
  // corresponds to the previous folds.
  useEffect(() => {
    setCollapsed(new Set());
  }, [lines]);

  function toggle(line: number) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  }

  // Actual line index of each visible row; null while nothing is collapsed,
  // so the common case stays allocation-free.
  const visible = useMemo(() => {
    if (!spans || collapsed.size === 0) return null;
    const result: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      result.push(i);
      const close = spans[i];
      // Jumping to the closing line hides it and everything in between —
      // the folded row shows the closer inline instead.
      if (close !== null && collapsed.has(i)) i = close;
    }
    return result;
  }, [lines, spans, collapsed]);

  const rowCount = visible ? visible.length : lines.length;

  // Wrapped lines can exceed one row, so wrapping falls back to plain layout
  // for bodies small enough to afford it.
  const canVirtualize = !wrap || rowCount > 500;

  const first = canVirtualize
    ? Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN)
    : 0;
  const visibleCount = canVirtualize
    ? Math.ceil(height / LINE_HEIGHT) + OVERSCAN * 2
    : rowCount;
  const rows = Array.from(
    { length: Math.min(visibleCount, rowCount - first) },
    (_, i) => (visible ? visible[first + i] : first + i),
  );
  const gutterWidth = `${String(lines.length).length + 1}ch`;

  /**
   * One logical line. `wrapped` lines have no fixed height — a long value can
   * occupy several visual rows, and forcing the height made it overflow onto
   * the line below.
   */
  function lineContent(actual: number, wrapped: boolean) {
    const close = spans?.[actual] ?? null;
    const isCollapsed = close !== null && collapsed.has(actual);
    return (
      <div
        style={wrapped ? undefined : { height: LINE_HEIGHT }}
        // pl-3 reserves the caret's column: absolutely positioned, it would
        // otherwise sit on top of the line's first characters.
        className={`relative min-w-0 flex-1 pr-3 pl-3 ${
          wrapped ? "break-words whitespace-pre-wrap" : "whitespace-pre"
        } ${canCopyNodes ? "cursor-pointer hover:bg-elevated/60" : ""}`}
        title={
          canCopyNodes
            ? "Click the value to copy it, or the key to copy its path"
            : undefined
        }
        onClick={(event) => {
          if (!canCopyNodes) return;
          // A drag to select text must never trigger a copy.
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) return;
          const target = event.target as HTMLElement;
          onCopyNode(actual, target.dataset.token === "key");
        }}
      >
        {close !== null && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggle(actual);
            }}
            style={{ height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
            className="absolute top-0 left-0 w-3 text-center text-[9px] text-muted select-none hover:text-ink"
            title={isCollapsed ? "Expand" : "Collapse"}
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
        )}
        {renderLine(lines[actual], lang, search)}
        {isCollapsed && (
          <span className="text-muted select-none">
            {" … "}
            {lines[close].trim()}
          </span>
        )}
      </div>
    );
  }

  const gutterCell = (actual: number) => (
    <div
      aria-hidden
      style={{ width: gutterWidth }}
      className="flex-none border-r border-edge bg-elevated/40 px-2 text-right text-muted select-none"
    >
      {actual + 1}
    </div>
  );

  // Wrapped bodies pair each number with its own line, so a value spanning
  // several visual rows cannot drift out of step with the gutter.
  if (!canVirtualize) {
    return (
      <div
        ref={viewportRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="h-full overflow-auto font-mono text-[12.5px]"
        style={{ lineHeight: `${LINE_HEIGHT}px` }}
      >
        {rows.map((actual) => (
          <div key={actual} className="flex items-stretch">
            {gutterCell(actual)}
            {lineContent(actual, wrap)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="h-full overflow-auto font-mono text-[12.5px]"
      style={{ lineHeight: `${LINE_HEIGHT}px` }}
    >
      <div style={{ height: rowCount * LINE_HEIGHT, position: "relative" }}>
        <div style={{ transform: `translateY(${first * LINE_HEIGHT}px)` }}>
          {rows.map((actual) => (
            <div key={actual} className="flex items-stretch">
              {gutterCell(actual)}
              {lineContent(actual, false)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
