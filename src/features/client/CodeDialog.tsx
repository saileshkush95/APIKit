import { useEffect, useMemo, useState } from "react";
import {
  CODE_LANGUAGE,
  CODE_TARGETS,
  generateCode,
  type CodeTarget,
} from "../../shared/lib/codegen";
import { renderLine } from "../../shared/lib/highlight";
import type { WireRequest } from "../../shared/lib/vars";

interface Props {
  request: WireRequest;
  onClose: () => void;
}

/** Shows the current request as client code, ready to copy. */
export function CodeDialog({ request, onClose }: Props) {
  const [target, setTarget] = useState<CodeTarget>("curl");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const code = useMemo(() => generateCode(request, target), [request, target]);
  // Highlighting is line-oriented, and `code` is short enough to tokenize whole.
  const lines = useMemo(() => code.split("\n"), [code]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard access can be denied */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        className="flex h-[30rem] w-[52rem] overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex w-56 flex-none flex-col border-r border-edge">
          <div className="border-b border-edge px-3 py-2 text-xs font-semibold text-muted">
            Generate code
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {CODE_TARGETS.map((option) => (
              <button
                key={option.value}
                onClick={() => setTarget(option.value)}
                className={`block w-full px-3 py-1.5 text-left text-xs ${
                  target === option.value
                    ? "bg-elevated text-ink"
                    : "text-muted hover:bg-elevated/60 hover:text-ink"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-none items-center gap-2 border-b border-edge px-3 py-2">
            <span className="text-xs text-muted">
              Variables are already resolved for the active environment.
            </span>
            <button
              onClick={copy}
              className="ml-auto rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-ink"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={onClose}
              className="rounded px-2 py-1 text-lg leading-none text-muted hover:bg-elevated hover:text-ink"
              title="Close"
            >
              ×
            </button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12.5px] leading-relaxed whitespace-pre">
            {lines.map((line, index) => (
              <div key={index}>{renderLine(line, CODE_LANGUAGE[target])}</div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}
