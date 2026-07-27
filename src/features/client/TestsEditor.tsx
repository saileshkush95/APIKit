import {
  ASSERTION_OPS,
  ASSERTION_SOURCES,
  sourceNeedsTarget,
} from "../../shared/lib/assertions";
import { newId } from "../../shared/lib/storage";
import type { Assertion } from "../../shared/types";

interface Props {
  tests: Assertion[];
  onChange: (tests: Assertion[]) => void;
}

const controlCls =
  "rounded border border-edge bg-panel px-1.5 py-1 text-xs text-ink outline-none focus:border-brand";

export function newAssertion(): Assertion {
  return {
    id: newId(),
    source: "status",
    target: "",
    op: "equals",
    expected: "200",
  };
}

/** Row-per-assertion editor; assertions run against every response. */
export function TestsEditor({ tests, onChange }: Props) {
  function update(id: string, patch: Partial<Assertion>) {
    onChange(tests.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  return (
    <div className="flex flex-col gap-1.5">
      {tests.length === 0 && (
        <p className="py-2 text-xs leading-relaxed text-muted">
          No assertions yet. They run automatically after every response, and
          the collection runner reports them per request.
        </p>
      )}

      {tests.map((test) => (
        <div key={test.id} className="flex items-center gap-1.5">
          <select
            value={test.source}
            onChange={(e) =>
              update(test.id, {
                source: e.target.value as Assertion["source"],
              })
            }
            className={`${controlCls} w-36 flex-none cursor-pointer`}
          >
            {ASSERTION_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          {sourceNeedsTarget(test.source) && (
            <input
              value={test.target}
              spellCheck={false}
              placeholder={
                test.source === "header" ? "Content-Type" : "data.items[0].id"
              }
              onChange={(e) => update(test.id, { target: e.target.value })}
              className={`${controlCls} w-40 flex-none font-mono`}
            />
          )}

          <select
            value={test.op}
            onChange={(e) =>
              update(test.id, { op: e.target.value as Assertion["op"] })
            }
            className={`${controlCls} w-32 flex-none cursor-pointer`}
          >
            {ASSERTION_OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          {test.op !== "exists" && (
            <input
              value={test.expected}
              spellCheck={false}
              placeholder="Expected"
              onChange={(e) => update(test.id, { expected: e.target.value })}
              className={`${controlCls} min-w-0 flex-1 font-mono`}
            />
          )}

          <button
            onClick={() => onChange(tests.filter((t) => t.id !== test.id))}
            className="flex-none px-1.5 text-lg leading-none text-muted hover:text-err"
            title="Remove assertion"
          >
            ×
          </button>
        </div>
      ))}

      <button
        onClick={() => onChange([...tests, newAssertion()])}
        className="mt-1 self-start rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-ink"
      >
        + Add assertion
      </button>
    </div>
  );
}
