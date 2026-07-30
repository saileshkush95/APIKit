import { Input, Select, Textarea } from "../../shared/components/Field";
import {
  ASSERTION_OPS,
  ASSERTION_SOURCES,
  sourceIsSchema,
  sourceNeedsTarget,
} from "../../shared/lib/assertions";
import { newId } from "../../shared/lib/storage";
import type { Assertion } from "../../shared/types";

/** A shape rather than prose: the point is what to replace, not what to read. */
const SCHEMA_PLACEHOLDER = `{
  "type": "object",
  "required": ["id", "name"],
  "properties": {
    "id": { "type": "integer" },
    "name": { "type": "string", "minLength": 1 },
    "email": { "type": "string", "format": "email" }
  }
}`;

interface Props {
  tests: Assertion[];
  onChange: (tests: Assertion[]) => void;
}


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
        // A schema needs a whole textarea, so its row stacks instead of sitting
        // on one line with the others.
        <div
          key={test.id}
          className={
            sourceIsSchema(test.source)
              ? "flex flex-col gap-1.5"
              : "flex items-center gap-1.5"
          }
        >
          <div className="flex items-center gap-1.5">
          <Select
            value={test.source}
            onChange={(e) =>
              update(test.id, {
                source: e.target.value as Assertion["source"],
              })
            }
            className={"wrk-field w-36 flex-none cursor-pointer"}
          >
            {ASSERTION_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>

          {sourceNeedsTarget(test.source) && (
            <Input
              value={test.target}
              spellCheck={false}
              placeholder={
                test.source === "header" ? "Content-Type" : "data.items[0].id"
              }
              onChange={(e) => update(test.id, { target: e.target.value })}
              className={"wrk-field w-40 flex-none font-mono"}
            />
          )}

          {/* A schema is the entire assertion: there is nothing to compare
              it against and no operator to pick. */}
          {!sourceIsSchema(test.source) && (
            <Select
              value={test.op}
              onChange={(e) =>
                update(test.id, { op: e.target.value as Assertion["op"] })
              }
              className={"wrk-field w-32 flex-none cursor-pointer"}
            >
              {ASSERTION_OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}

          {!sourceIsSchema(test.source) && test.op !== "exists" && (
            <Input
              value={test.expected}
              spellCheck={false}
              placeholder="Expected"
              onChange={(e) => update(test.id, { expected: e.target.value })}
              className={"wrk-field min-w-0 flex-1 font-mono"}
            />
          )}

          {sourceIsSchema(test.source) && (
            <span className="min-w-0 flex-1 text-[11px] text-muted">
              Draft 2020-12 or draft-07, picked from the schema's{" "}
              <span className="font-mono">$schema</span>. Paste one straight out
              of an OpenAPI document — <span className="font-mono">$ref</span>,{" "}
              <span className="font-mono">oneOf</span> and{" "}
              <span className="font-mono">format</span> all work.
            </span>
          )}

          <button
            onClick={() => onChange(tests.filter((t) => t.id !== test.id))}
            className="flex-none px-1.5 text-lg leading-none text-muted hover:text-err"
            title="Remove assertion"
          >
            ×
          </button>
          </div>

          {sourceIsSchema(test.source) && (
            <Textarea
              value={test.expected}
              spellCheck={false}
              rows={8}
              placeholder={SCHEMA_PLACEHOLDER}
              onChange={(e) => update(test.id, { expected: e.target.value })}
              className="wrk-field font-mono text-[11px]"
            />
          )}
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
