import { useEffect, useMemo, useRef, useState } from "react";
import {
  guessViewMode,
  parseCookies,
  renderBody,
  VIEW_MODES,
  type ViewMode,
} from "../../shared/lib/format";
import { formatBytes, statusColor } from "../../shared/lib/ui";
import type {
  AssertionResult,
  HttpResponseData,
  ResponseTabKey,
} from "../../shared/types";

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

  // Formatting a very large body blocks the main thread, so it is opt-in.
  const isLarge = response.body.length > LARGE_BODY_BYTES;
  const [formatLarge, setFormatLarge] = useState(false);

  // A new response may be a different content type than the last one.
  useEffect(() => {
    setMode(guessViewMode(contentType, response.body));
    setPreview(false);
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
            <VirtualBody lines={lines} wrap={wrap} search={search} />
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

/**
 * Renders only the lines in view. A large response is thousands of rows, and
 * one DOM node per line (twice, with the gutter) is what made the viewer stall.
 */
function VirtualBody({
  lines,
  wrap,
  search,
}: {
  lines: string[];
  wrap: boolean;
  search: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Wrapped lines can exceed one row, so wrapping falls back to plain layout
  // for bodies small enough to afford it.
  const canVirtualize = !wrap || lines.length > 500;

  const first = canVirtualize
    ? Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN)
    : 0;
  const visibleCount = canVirtualize
    ? Math.ceil(height / LINE_HEIGHT) + OVERSCAN * 2
    : lines.length;
  const slice = lines.slice(first, first + visibleCount);
  const gutterWidth = `${String(lines.length).length + 1}ch`;

  return (
    <div
      ref={viewportRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="h-full overflow-auto font-mono text-[12.5px]"
      style={{ lineHeight: `${LINE_HEIGHT}px` }}
    >
      <div
        style={{
          height: canVirtualize ? lines.length * LINE_HEIGHT : undefined,
          position: "relative",
        }}
      >
        <div
          style={{
            transform: canVirtualize
              ? `translateY(${first * LINE_HEIGHT}px)`
              : undefined,
          }}
          className="flex"
        >
          <div
            aria-hidden
            style={{ width: gutterWidth }}
            className="flex-none border-r border-edge bg-elevated/40 px-2 text-right text-muted select-none"
          >
            {slice.map((_, i) => (
              <div key={first + i}>{first + i + 1}</div>
            ))}
          </div>
          <div
            className={`min-w-0 flex-1 px-3 ${
              wrap && !canVirtualize
                ? "break-words whitespace-pre-wrap"
                : "whitespace-pre"
            }`}
          >
            {slice.map((line, i) => (
              <div key={first + i} style={{ height: LINE_HEIGHT }}>
                {highlight(line, search) || " "}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
