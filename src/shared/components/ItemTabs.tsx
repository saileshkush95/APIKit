export interface TabItem {
  id: string;
  /** Small coloured prefix — a method, a test type. */
  prefix?: string;
  prefixClass?: string;
  label: string;
}

interface Props {
  tabs: TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew?: () => void;
  newTitle?: string;
}

/**
 * The strip of open items above an editor — the same shape as the client's
 * request tabs, for panels whose items are not requests.
 */
export function ItemTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  newTitle = "New",
}: Props) {
  return (
    <div className="flex flex-none items-stretch overflow-x-auto border-b border-edge bg-panel">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            onAuxClick={(e) => {
              // Middle-click closes, as in a browser.
              if (e.button === 1) onClose(tab.id);
            }}
            className={`group flex max-w-52 min-w-36 flex-none cursor-default items-center gap-2 border-r border-edge px-3 py-2 text-xs ${
              active
                ? "border-t-2 border-t-brand bg-canvas text-ink"
                : "border-t-2 border-t-transparent text-muted hover:bg-elevated/60"
            }`}
            title={tab.label}
          >
            {tab.prefix && (
              <span
                className={`flex-none font-mono text-[10px] font-bold ${
                  tab.prefixClass ?? ""
                }`}
              >
                {tab.prefix}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{tab.label}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className={`flex-none rounded px-1 leading-none hover:text-err ${
                active ? "text-muted" : "text-transparent group-hover:text-muted"
              }`}
              title="Close"
            >
              ×
            </button>
          </div>
        );
      })}
      {onNew && (
        <button
          onClick={onNew}
          className="flex-none px-3 text-base leading-none text-muted hover:bg-elevated hover:text-ink"
          title={newTitle}
        >
          +
        </button>
      )}
    </div>
  );
}
