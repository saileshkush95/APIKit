import { Input } from "../../shared/components/Field";
import { useMemo, useState } from "react";
import {
  rootTypes,
  typeByName,
  type GraphqlSchema,
  type SchemaField,
} from "../../shared/lib/graphql";

interface Props {
  schema: GraphqlSchema | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** Inserts a field name into the query editor. */
  onInsert: (field: SchemaField) => void;
}

/** Turns a field into the skeleton you would actually type. */
export function fieldSnippet(field: SchemaField): string {
  const args = field.args.length
    ? `(${field.args.map((arg) => `${arg.name}: $${arg.name}`).join(", ")})`
    : "";
  return `${field.name}${args}`;
}

/** Schema explorer: the server's own documentation, click to insert. */
export function GraphqlSchemaPanel({
  schema,
  loading,
  error,
  onRefresh,
  onInsert,
}: Props) {
  const [query, setQuery] = useState("");
  const [openType, setOpenType] = useState<string | null>(null);

  const roots = useMemo(() => (schema ? rootTypes(schema) : []), [schema]);
  const needle = query.trim().toLowerCase();

  const detail = useMemo(
    () => (schema && openType ? typeByName(schema, openType) : null),
    [schema, openType],
  );

  return (
    <div className="flex w-72 flex-none flex-col border-l border-edge">
      <div className="flex flex-none items-center gap-2 border-b border-edge px-2 py-1.5">
        <span className="text-[11px] font-semibold text-muted">Schema</span>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-elevated hover:text-ink disabled:opacity-50"
          title="Re-run introspection"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      {error && (
        <div className="border-b border-edge px-2 py-2 text-[11px] text-err">
          {error}
        </div>
      )}

      {!schema && !loading && !error && (
        <p className="px-2 py-3 text-[11px] leading-relaxed text-muted">
          Enter a GraphQL URL and the schema is fetched automatically.
        </p>
      )}

      {loading && !schema && (
        <p className="px-2 py-3 text-[11px] text-muted">Introspecting…</p>
      )}

      {schema && (
        <>
          <div className="flex-none px-2 py-1.5">
            <Input
              value={query}
              spellCheck={false}
              placeholder="Filter fields…"
              onChange={(e) => setQuery(e.target.value)}
              className="wrk-field compact"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-auto pb-4">
            {detail ? (
              <div className="px-2">
                <button
                  onClick={() => setOpenType(null)}
                  className="my-1.5 text-[11px] text-brand hover:underline"
                >
                  ← back
                </button>
                <div className="text-xs font-semibold text-ink">
                  {detail.name}
                </div>
                {detail.description && (
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
                    {detail.description}
                  </p>
                )}
                {detail.fields.map((field) => (
                  <FieldRow
                    key={field.name}
                    field={field}
                    onInsert={onInsert}
                    onOpenType={setOpenType}
                  />
                ))}
                {detail.enumValues.map((value) => (
                  <div key={value.name} className="py-0.5 font-mono text-[11px]">
                    {value.name}
                  </div>
                ))}
              </div>
            ) : (
              roots.map(({ label, type }) => {
                const fields = type.fields.filter(
                  (field) =>
                    needle === "" ||
                    field.name.toLowerCase().includes(needle) ||
                    field.type.toLowerCase().includes(needle),
                );
                if (fields.length === 0) return null;
                return (
                  <div key={label} className="px-2 pt-2">
                    <div className="text-[10px] font-semibold tracking-wide text-muted uppercase">
                      {label}
                    </div>
                    {fields.map((field) => (
                      <FieldRow
                        key={field.name}
                        field={field}
                        onInsert={onInsert}
                        onOpenType={setOpenType}
                      />
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FieldRow({
  field,
  onInsert,
  onOpenType,
}: {
  field: SchemaField;
  onInsert: (field: SchemaField) => void;
  onOpenType: (name: string) => void;
}) {
  // Strip list/non-null decoration to get a type worth opening.
  const bare = field.type.replace(/[[\]!]/g, "");

  return (
    <div className="group border-b border-edge/60 py-1">
      <div className="flex items-baseline gap-1.5">
        <button
          onClick={() => onInsert(field)}
          className="font-mono text-[11px] text-ink hover:text-brand"
          title="Insert into query"
        >
          {field.name}
        </button>
        <button
          onClick={() => onOpenType(bare)}
          className="font-mono text-[10px] text-muted hover:text-brand"
          title={`Open ${bare}`}
        >
          {field.type}
        </button>
      </div>
      {field.args.length > 0 && (
        <div className="font-mono text-[10px] text-muted">
          ({field.args.map((arg) => `${arg.name}: ${arg.type}`).join(", ")})
        </div>
      )}
      {field.description && (
        <div className="text-[10px] leading-snug text-muted">
          {field.description}
        </div>
      )}
    </div>
  );
}
