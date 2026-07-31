import { useMemo } from "react";
import { Toggle } from "../../shared/components/Toggle";
import { defaultsChain, inheritedHeaders } from "../../shared/lib/inherit";
import { useCollection } from "../../shared/state/collection";
import type { Header, RequestConfig } from "../../shared/types";

interface Props {
  /** Id of the saved request, which is what places it in the tree. */
  sourceId: string | null;
  headers: Header[];
  config: RequestConfig;
  onConfigChange: (patch: Partial<RequestConfig>) => void;
}

const NOTE: Record<string, string> = {
  excluded: "excluded here",
  overridden: "set below",
  off: "inheritance off",
};

/**
 * What this request picks up from the workspace and the folders above it.
 *
 * Shown rather than merged into the grid below: these headers are not the
 * request's to edit, and a row that silently reappeared after being deleted
 * would be worse than no inheritance at all. Unchecking one records the name
 * in `excludedHeaders`, so the exclusion belongs to this request and the rest
 * of the collection keeps the header.
 */
export function InheritedHeaders({
  sourceId,
  headers,
  config,
  onConfigChange,
}: Props) {
  const { tree, collectionDefaults } = useCollection();

  const rows = useMemo(
    () =>
      inheritedHeaders(defaultsChain(tree, sourceId, collectionDefaults), {
        headers,
        config,
      }),
    [tree, sourceId, collectionDefaults, headers, config],
  );

  if (rows.length === 0) return null;

  const excluded = new Set(
    (config.excludedHeaders ?? []).map((name) => name.toLowerCase()),
  );

  function setExcluded(name: string, drop: boolean) {
    const key = name.toLowerCase();
    const next = (config.excludedHeaders ?? []).filter(
      (entry) => entry.toLowerCase() !== key,
    );
    onConfigChange({ excludedHeaders: drop ? [...next, key] : next });
  }

  return (
    <div className="mb-2 rounded-md border border-edge">
      <div className="flex items-center gap-2 border-b border-edge px-2 py-1.5">
        <span className="text-[11px] font-semibold text-muted">
          Inherited
          <span className="ml-1.5 font-normal">
            {rows.filter((row) => row.applied).length} of {rows.length} sent
          </span>
        </span>
        <span className="ml-auto">
          <Toggle
            checked={config.inheritHeaders}
            onChange={(inheritHeaders) => onConfigChange({ inheritHeaders })}
            label="Inherit"
            title="Take headers from the workspace and this request's folders"
          />
        </span>
      </div>

      <div className="divide-y divide-edge">
        {rows.map((row) => {
          const key = row.name.toLowerCase();
          const locked = row.reason === "overridden";
          return (
            <div
              key={key}
              className={`flex items-center gap-2 px-2 py-1 text-[11px] ${
                row.applied ? "" : "opacity-60"
              }`}
            >
              <input
                type="checkbox"
                className="wrk-check"
                checked={!excluded.has(key)}
                disabled={locked || !config.inheritHeaders}
                onChange={(event) => setExcluded(row.name, !event.target.checked)}
                title={
                  locked
                    ? "This request sets the same header itself"
                    : "Send this header with the request"
                }
              />
              <span
                className={`w-44 flex-none truncate font-mono ${
                  row.applied ? "text-ink" : "text-muted line-through"
                }`}
                title={row.name}
              >
                {row.name}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-muted" title={row.value}>
                {row.value}
              </span>
              <span className="flex-none text-muted">{row.source}</span>
              {row.reason && (
                <span className="flex-none text-warn">{NOTE[row.reason]}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
