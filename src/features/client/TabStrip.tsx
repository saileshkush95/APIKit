import { methodColor, requestLabel } from "../../shared/lib/ui";
import type { RequestTab } from "../../shared/types";

interface Props {
  tabs: RequestTab[];
  activeId: string;
  dirtyIds: Set<string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

/** Postman-style strip of open requests above the builder. */
export function TabStrip({
  tabs,
  activeId,
  dirtyIds,
  onSelect,
  onClose,
  onNew,
}: Props) {
  return (
    <div className="flex flex-none items-stretch overflow-x-auto border-b border-edge bg-panel">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const dirty = dirtyIds.has(tab.id);
        return (
          <div
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(tab.id);
            }}
            className={`group flex max-w-52 min-w-36 flex-none cursor-default items-center gap-2 border-r border-edge px-3 py-2 text-xs ${
              active
                ? "border-t-2 border-t-brand bg-canvas text-ink"
                : "border-t-2 border-t-transparent text-muted hover:bg-elevated/60"
            }`}
            title={`${tab.method} ${tab.url}`}
          >
            <span
              className={`flex-none font-mono text-[10px] font-bold ${methodColor(
                tab.method,
              )}`}
            >
              {tab.method.toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {tab.name ?? requestLabel(tab.url)}
            </span>
            {dirty ? (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className="flex-none text-brand group-hover:hidden"
                title="Unsaved changes"
              >
                •
              </span>
            ) : null}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className={`flex-none text-sm leading-none text-muted hover:text-ink ${
                dirty ? "hidden group-hover:block" : ""
              }`}
              title="Close tab"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        onClick={onNew}
        className="flex-none px-3 text-base text-muted hover:text-ink"
        title="New tab (⌘T)"
      >
        +
      </button>
    </div>
  );
}
