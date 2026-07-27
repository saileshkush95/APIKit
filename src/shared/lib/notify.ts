// A tiny pub/sub for user-visible notices.
//
// It lives outside React so non-component code — persistence hooks, the sync
// layer, state providers — can report a failure without prop-drilling a
// callback. The `Toaster` component is the only subscriber.

export type NoticeLevel = "info" | "success" | "error";

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface Notice {
  id: string;
  level: NoticeLevel;
  message: string;
  /** Secondary line, usually the underlying error. */
  detail?: string;
  action?: NoticeAction;
  /** 0 keeps the notice until it is dismissed. */
  timeoutMs: number;
}

type Listener = (notice: Notice) => void;

const listeners = new Set<Listener>();
let counter = 0;

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(notice: Notice): string {
  for (const listener of listeners) listener(notice);
  return notice.id;
}

interface Options {
  detail?: unknown;
  action?: NoticeAction;
  timeoutMs?: number;
}

function describe(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (detail instanceof Error) return detail.message;
  const text = String(detail);
  return text === "" ? undefined : text;
}

export function notify(
  level: NoticeLevel,
  message: string,
  options: Options = {},
): string {
  return emit({
    id: `notice-${(counter += 1)}`,
    level,
    message,
    detail: describe(options.detail),
    action: options.action,
    // Errors and anything actionable stay long enough to be read and acted on.
    timeoutMs:
      options.timeoutMs ??
      (options.action ? 10_000 : level === "error" ? 8_000 : 3_500),
  });
}

export const notifyError = (message: string, detail?: unknown) =>
  notify("error", message, { detail });

export const notifySuccess = (message: string, detail?: unknown) =>
  notify("success", message, { detail });
