import { useEffect, useMemo, useState } from "react";
import { Input, Labelled } from "../../shared/components/Field";
import { Toggle } from "../../shared/components/Toggle";
import {
  clearCookies,
  deleteCookie,
  listCookies,
  putCookie,
} from "../../shared/lib/api";
import { notify, notifyError } from "../../shared/lib/notify";
import { useConfirm } from "../../shared/state/confirm";
import type { Cookie } from "../../shared/types";

function expiryLabel(cookie: Cookie): string {
  if (cookie.expiresMs === null) return "Session";
  const days = Math.round((cookie.expiresMs - Date.now()) / 86_400_000);
  if (days <= 0) return "Expiring today";
  if (days === 1) return "Tomorrow";
  if (days < 90) return `${days} days`;
  return new Date(cookie.expiresMs).toLocaleDateString();
}

const BLANK: Cookie = {
  domain: "",
  path: "/",
  name: "",
  value: "",
  expiresMs: null,
  secure: false,
  httpOnly: false,
  sameSite: "",
};

/**
 * The cookie jar, grouped by domain.
 *
 * Cookies are set by servers and read by the client without anyone asking, so
 * the whole point of this panel is to make an invisible thing visible — and
 * editable, since pasting in a session from a browser is often the fastest way
 * to start testing an authenticated API.
 */
export function CookieManager() {
  const [cookies, setCookies] = useState<Cookie[]>([]);
  const [draft, setDraft] = useState<Cookie | null>(null);
  const confirm = useConfirm();

  async function refresh() {
    try {
      setCookies(await listCookies());
    } catch (e) {
      notifyError("Could not read cookies", e);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const byDomain = useMemo(() => {
    const groups = new Map<string, Cookie[]>();
    for (const cookie of cookies) {
      const list = groups.get(cookie.domain) ?? [];
      list.push(cookie);
      groups.set(cookie.domain, list);
    }
    return [...groups.entries()];
  }, [cookies]);

  async function save() {
    if (!draft) return;
    try {
      await putCookie(draft);
      setDraft(null);
      await refresh();
    } catch (e) {
      notifyError("Could not save the cookie", e);
    }
  }

  async function removeOne(cookie: Cookie) {
    try {
      await deleteCookie(cookie.domain, cookie.path, cookie.name);
      await refresh();
    } catch (e) {
      notifyError("Could not delete the cookie", e);
    }
  }

  async function removeDomain(domain: string) {
    const ok = await confirm({
      title: `Clear cookies for ${domain}?`,
      body: "Any session they hold will end on the next request.",
      confirmLabel: "Clear",
      danger: true,
    });
    if (!ok) return;
    try {
      await clearCookies(domain);
      await refresh();
    } catch (e) {
      notifyError("Could not clear cookies", e);
    }
  }

  async function removeAll() {
    const ok = await confirm({
      title: "Clear every cookie?",
      body: `This removes all ${cookies.length} cookie${
        cookies.length === 1 ? "" : "s"
      } across every domain.`,
      confirmLabel: "Clear all",
      danger: true,
    });
    if (!ok) return;
    try {
      await clearCookies();
      await refresh();
      notify("success", "Cookie jar cleared");
    } catch (e) {
      notifyError("Could not clear cookies", e);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setDraft({ ...BLANK })}
          className="rounded border border-edge px-2 py-1 text-[11px] text-ink hover:bg-elevated"
        >
          Add a cookie
        </button>
        <button
          onClick={refresh}
          className="rounded border border-edge px-2 py-1 text-[11px] text-muted hover:bg-elevated hover:text-ink"
        >
          Refresh
        </button>
        <button
          onClick={removeAll}
          disabled={cookies.length === 0}
          className="rounded border border-edge px-2 py-1 text-[11px] text-muted hover:bg-elevated hover:text-err disabled:opacity-40"
        >
          Clear all
        </button>
      </div>

      {draft && (
        <div className="flex flex-col gap-2 rounded-md border border-edge bg-elevated/40 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Labelled label="Domain">
              <Input
                value={draft.domain}
                size="compact"
                placeholder="api.example.com"
                onChange={(e) => setDraft({ ...draft, domain: e.target.value })}
              />
            </Labelled>
            <Labelled label="Path">
              <Input
                value={draft.path}
                size="compact"
                onChange={(e) => setDraft({ ...draft, path: e.target.value })}
              />
            </Labelled>
            <Labelled label="Name">
              <Input
                value={draft.name}
                size="compact"
                placeholder="session"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Labelled>
            <Labelled label="Value">
              <Input
                value={draft.value}
                size="compact"
                mono
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              />
            </Labelled>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Toggle
              checked={draft.secure}
              onChange={(secure) => setDraft({ ...draft, secure })}
              label="Secure"
            />
            <Toggle
              checked={draft.httpOnly}
              onChange={(httpOnly) => setDraft({ ...draft, httpOnly })}
              label="HttpOnly"
            />
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => setDraft(null)}
                className="rounded border border-edge px-2 py-1 text-[11px] text-muted hover:bg-elevated hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={!draft.name.trim() || !draft.domain.trim()}
                className="rounded bg-brand px-2 py-1 text-[11px] font-semibold text-white hover:bg-brand-bright disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>
          <p className="text-[11px] text-muted">
            Saved without an expiry, so it lasts until you quit — the same as a
            session cookie from a server.
          </p>
        </div>
      )}

      {cookies.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted">
          No cookies yet. Any a server sets on a response is stored here and
          sent back automatically on matching requests.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {byDomain.map(([domain, list]) => (
            <div
              key={domain}
              className="overflow-hidden rounded-md border border-edge"
            >
              <div className="flex items-center gap-2 border-b border-edge bg-elevated/40 px-2.5 py-1.5">
                <span className="font-mono text-[11px] font-semibold text-ink">
                  {domain}
                </span>
                <span className="text-[11px] text-muted">
                  {list.length} cookie{list.length === 1 ? "" : "s"}
                </span>
                <button
                  onClick={() => removeDomain(domain)}
                  className="ml-auto text-[11px] text-muted hover:text-err"
                >
                  Clear
                </button>
              </div>
              {list.map((cookie) => (
                <div
                  key={`${cookie.path}:${cookie.name}`}
                  className="group flex items-center gap-2 border-b border-edge px-2.5 py-1.5 text-[11px] last:border-b-0"
                >
                  <span className="w-36 flex-none truncate font-mono text-brand">
                    {cookie.name}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-ink"
                    title={cookie.value}
                  >
                    {cookie.value}
                  </span>
                  <span className="flex-none text-muted">{cookie.path}</span>
                  {cookie.secure && (
                    <span className="flex-none text-ok" title="HTTPS only">
                      secure
                    </span>
                  )}
                  {cookie.httpOnly && (
                    <span
                      className="flex-none text-muted"
                      title="Not readable by page scripts"
                    >
                      httpOnly
                    </span>
                  )}
                  <span className="w-24 flex-none text-right text-muted">
                    {expiryLabel(cookie)}
                  </span>
                  <button
                    onClick={() => removeOne(cookie)}
                    className="flex-none px-1 text-muted opacity-0 group-hover:opacity-100 hover:text-err"
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
