import { useEffect, useMemo, useRef, useState } from "react";
import {
  guessViewMode,
  parseCookies,
  renderBody,
  VIEW_MODES,
  type ViewMode,
} from "../lib/format";
import { formatBytes, statusColor } from "../lib/ui";
import type {
  AssertionResult,
  HttpResponseData,
  ResponseTabKey,
} from "../types";

interface Props {
  response: HttpResponseData;
  results: AssertionResult[];
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
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs ${
        active ? "bg-elevated font-medium text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {children}
      {badge}
    </button>
  );
}

/** Splits a line around search matches so they can be highlighted. */
function highlight(line: string, needle: string): React.ReactNode {
  if (needle === "") return line;
  const parts: React.ReactNode[] = [];
  const lower = line.toLowerCase();
  const target = needle.toLowerCase();
  let index = 0;
  let key = 0;
  while (index < line.length) {
    const hit = lower.indexOf(target, index);
    if (hit === -1) {
      parts.push(line.slice(index));
      break;
    }
    if (hit > index) parts.push(line.slice(index, hit));
    parts.push(
      <mark key={key++} className="rounded bg-warn/40 text-ink">
        {line.slice(hit, hit + needle.length)}
      </mark>,
    );
    index = hit + needle.length;
  }
  return parts;
}

export function ResponseViewer({
  response,
  results,
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
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [modeMenu, setModeMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // A new response may be a different content type than the last one.
  useEffect(() => {
    setMode(guessViewMode(contentType, response.body));
    setPreview(false);
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
    () => renderBody(response.body, mode),
    [response.body, mode],
  );
  const lines = useMemo(() => rendered.split("\n"), [rendered]);
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
  const previewable = mode === "html" || mode === "markdown";

  async function copy() {
    try {
      await navigator.clipboard.writeText(rendered);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard access can be denied; the button simply does nothing */
    }
  }

  const currentMode = VIEW_MODES.find((m) => m.value === mode);

  return (
    <>
      {/* Tabs + status */}
      <div className="flex flex-none items-center gap-3 px-3 py-1.5">
        <div className="flex gap-1">
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
          </div>
        </div>
      )}

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-auto border-t border-edge">
        {activeTab === "body" &&
          (preview ? (
            <iframe
              // Sandboxed with no allow-scripts: previewing a response must
              // never execute code from the server under test.
              sandbox=""
              srcDoc={response.body}
              title="Response preview"
              className="h-full w-full border-0 bg-white"
            />
          ) : (
            <div className="flex min-h-full font-mono text-[12.5px] leading-relaxed">
              <div className="flex-none select-none border-r border-edge bg-elevated/40 px-2 py-2 text-right text-muted">
                {lines.map((_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              <div
                className={`min-w-0 flex-1 px-3 py-2 ${
                  wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre"
                }`}
              >
                {lines.map((line, i) => (
                  <div key={i}>{highlight(line, search) || " "}</div>
                ))}
              </div>
            </div>
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
