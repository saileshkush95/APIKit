// Small UI helpers shared across components.

/** Tailwind text-color class for an HTTP status code. */
export function statusColor(status: number | null): string {
  if (status === null) return "text-muted";
  if (status >= 500) return "text-err";
  if (status >= 400) return "text-warn";
  if (status >= 300) return "text-redirect";
  if (status >= 200) return "text-ok";
  return "text-muted";
}

const METHOD_COLORS: Record<string, string> = {
  GET: "text-method-get",
  POST: "text-method-post",
  PUT: "text-method-put",
  PATCH: "text-method-patch",
  DELETE: "text-method-delete",
};

/** Postman-style per-verb colouring. */
export function methodColor(method: string): string {
  return METHOD_COLORS[method.toUpperCase()] ?? "text-muted";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** A short label for a request tab, derived from the URL when unnamed. */
export function requestLabel(url: string, fallback = "Untitled Request"): string {
  const trimmed = url.trim();
  if (trimmed === "") return fallback;
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return trimmed.replace(/^https?:\/\//, "");
  }
}
