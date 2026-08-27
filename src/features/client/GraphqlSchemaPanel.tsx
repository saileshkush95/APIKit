import { Input } from "../../shared/components/Field";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  browsableTypes,
  rootTypes,
  typeByName,
  type GraphqlSchema,
  type SchemaField,
  type SchemaType,
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

/** The root operation a tab lists, named the way the tab bar says it. */
const ROOT_TAB_LABELS: Record<string, string> = {
  Query: "Queries",
  Mutation: "Mutations",
  Subscription: "Subscriptions",
};

/**
 * What to badge a type with. `INPUT_OBJECT` is what the server calls it and
 * nobody writing a query does, so it is renamed here.
 *
 * OBJECT is deliberately absent: it is most of the list, and a badge on every
 * row says nothing while making the names harder to scan. The badge is here to
 * mark the ones that behave differently — an input you can only pass in, an
 * enum with a fixed set of values, a scalar the server encodes its own way.
 */
const KIND_LABELS: Record<string, string> = {
  INPUT_OBJECT: "input",
  INTERFACE: "interface",
  ENUM: "enum",
  UNION: "union",
  SCALAR: "scalar",
};

interface Tab {
  id: string;
  label: string;
  /** The root type's fields, or null for the Types tab. */
  fields: SchemaField[] | null;
  /** False when the schema declares no such root operation. */
  present: boolean;
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
  const [tabId, setTabId] = useState("types");
  // A trail rather than one open type, so following Query → Country →
  // Continent can be walked back the way it was walked in.
  const [trail, setTrail] = useState<string[]>([]);
  // The whole panel folds to a slim rail.
  const [collapsed, setCollapsed] = useState(false);

  const needle = query.trim().toLowerCase();

  const tabs = useMemo<Tab[]>(() => {
    if (!schema) return [];
    const roots = new Map(
      rootTypes(schema).map(({ label, type }) => [label, type] as const),
    );
    // Queries and Mutations are offered even by a schema that has neither:
    // "does this API let me write anything?" is a question people come here to
    // answer, and a tab that is simply absent does not answer it. Subscriptions
    // are rare enough that an empty one would be noise on most schemas.
    const wanted = ["Query", "Mutation"];
    if (roots.has("Subscription")) wanted.push("Subscription");
    return [
      { id: "types", label: "Types", fields: null, present: true },
      ...wanted.map((label) => ({
        id: label,
        label: ROOT_TAB_LABELS[label] ?? label,
        fields: roots.get(label)?.fields ?? [],
        present: roots.has(label),
      })),
    ];
  }, [schema]);

  const tab = tabs.find((candidate) => candidate.id === tabId) ?? tabs[0];

  const types = useMemo(
    () => (schema ? browsableTypes(schema) : []),
    [schema],
  );

  const detail = useMemo(
    () => (schema ? typeByName(schema, trail[trail.length - 1] ?? null) : null),
    [schema, trail],
  );

  // A new schema is a different set of types, so a trail into the old one
  // points at names that may no longer exist.
  useEffect(() => {
    setTrail([]);
  }, [schema]);

  function openType(name: string) {
    // A field's type is often a built-in scalar, which has no page to open.
    // Pushing it anyway left the trail one deeper with the view unchanged, so
    // the click read as broken and the back arrow had a dead step in it.
    if (!schema || !typeByName(schema, name)) return;
    setTrail((previous) => [...previous, name]);
    setQuery("");
  }

  function selectTab(id: string) {
    setTabId(id);
    setTrail([]);
  }

  if (collapsed) {
    return (
      <div className="flex w-7 flex-none flex-col items-center gap-2 border-l border-edge py-2">
        <button
          onClick={() => setCollapsed(false)}
          className="rounded px-1 text-[11px] text-muted hover:bg-elevated hover:text-ink"
          title="Show the schema panel"
        >
          ⟨
        </button>
        <span
          className="text-[10px] font-semibold tracking-wide text-muted select-none"
          style={{ writingMode: "vertical-rl" }}
        >
          Schema
        </span>
      </div>
    );
  }

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
        <button
          onClick={() => setCollapsed(true)}
          className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-elevated hover:text-ink"
          title="Hide the schema panel"
        >
          ⟩
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

      {schema && tab && (
        <>
          <div
            role="tablist"
            // Four tabs plus their counts overflow the panel, and a wrapped
            // tab bar pushes the list out of view.
            className="flex flex-none overflow-x-auto border-b border-edge px-1"
          >
            {tabs.map((candidate) => {
              const active = candidate.id === tab.id;
              return (
                <button
                  key={candidate.id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => selectTab(candidate.id)}
                  className={`-mb-px flex-none border-b-2 px-2 py-1.5 text-[11px] whitespace-nowrap ${
                    active
                      ? "border-brand font-semibold text-brand"
                      : "border-transparent text-muted hover:text-ink"
                  }`}
                >
                  {candidate.label}
                  <span className="ml-1 font-normal text-muted">
                    {candidate.fields ? candidate.fields.length : types.length}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex-none px-2 py-1.5">
            <Input
              value={query}
              spellCheck={false}
              placeholder={
                detail
                  ? `Filter ${detail.name}…`
                  : tab.fields
                    ? "Filter fields…"
                    : "Filter types…"
              }
              onChange={(e) => setQuery(e.target.value)}
              className="wrk-field compact"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-auto pb-4">
            {detail ? (
              <TypeDetail
                type={detail}
                trail={trail}
                needle={needle}
                onBack={() => setTrail((previous) => previous.slice(0, -1))}
                onInsert={onInsert}
                onOpenType={openType}
              />
            ) : tab.fields ? (
              <FieldList
                fields={tab.fields}
                needle={needle}
                empty={
                  tab.present
                    ? `No ${tab.label.toLowerCase()} match “${query.trim()}”.`
                    : `This schema defines no ${tab.label.toLowerCase()}.`
                }
                onInsert={onInsert}
                onOpenType={openType}
              />
            ) : (
              <TypeList types={types} needle={needle} onOpen={openType} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Every type the schema defines — the way in for anything off the roots. */
function TypeList({
  types,
  needle,
  onOpen,
}: {
  types: SchemaType[];
  needle: string;
  onOpen: (name: string) => void;
}) {
  const matches = types.filter(
    (type) =>
      needle === "" ||
      type.name.toLowerCase().includes(needle) ||
      (type.description ?? "").toLowerCase().includes(needle),
  );

  if (matches.length === 0) {
    return <Empty>No types match that filter.</Empty>;
  }

  return (
    <div className="px-2">
      {matches.map((type) => (
        <button
          key={type.name}
          onClick={() => onOpen(type.name)}
          className="flex w-full items-baseline gap-1.5 border-b border-edge/60 py-1.5 text-left hover:text-brand"
        >
          <span className="font-mono text-[11px] text-ink">{type.name}</span>
          <KindBadge kind={type.kind} />
          <span className="ml-auto text-[10px] text-muted">
            {type.fields.length || type.enumValues.length || ""}
          </span>
        </button>
      ))}
    </div>
  );
}

/** One type opened up: what it is, what it says, and what it holds. */
function TypeDetail({
  type,
  trail,
  needle,
  onBack,
  onInsert,
  onOpenType,
}: {
  type: SchemaType;
  trail: string[];
  needle: string;
  onBack: () => void;
  onInsert: (field: SchemaField) => void;
  onOpenType: (name: string) => void;
}) {
  const values = type.enumValues.filter(
    (value) => needle === "" || value.name.toLowerCase().includes(needle),
  );

  return (
    <div className="px-2">
      <button
        onClick={onBack}
        className="my-1.5 text-[11px] text-brand hover:underline"
      >
        ← {trail.length > 1 ? trail[trail.length - 2] : "back"}
      </button>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-xs font-semibold text-ink">
          {type.name}
        </span>
        <KindBadge kind={type.kind} />
      </div>
      {type.description && (
        <p className="mt-0.5 mb-1 text-[11px] leading-relaxed text-muted">
          {type.description}
        </p>
      )}

      {type.fields.length > 0 && (
        <FieldList
          fields={type.fields}
          needle={needle}
          empty="No fields match that filter."
          onInsert={onInsert}
          onOpenType={onOpenType}
        />
      )}

      {values.map((value) => (
        <div key={value.name} className="border-b border-edge/60 py-1">
          <div className="font-mono text-[11px] text-ink">{value.name}</div>
          {value.description && (
            <div className="text-[10px] leading-snug text-muted">
              {value.description}
            </div>
          )}
        </div>
      ))}

      {/* A union's members and a scalar's shape are not in the introspection
          this panel asks for, so say so rather than showing a blank body that
          reads as a type with nothing in it. */}
      {type.fields.length === 0 && type.enumValues.length === 0 && (
        <Empty>
          {type.kind === "SCALAR"
            ? "A custom scalar — the server decides how it is encoded."
            : "Nothing to list for this type."}
        </Empty>
      )}
    </div>
  );
}

function FieldList({
  fields,
  needle,
  empty,
  onInsert,
  onOpenType,
}: {
  fields: SchemaField[];
  needle: string;
  empty: string;
  onInsert: (field: SchemaField) => void;
  onOpenType: (name: string) => void;
}) {
  const matches = fields.filter(
    (field) =>
      needle === "" ||
      field.name.toLowerCase().includes(needle) ||
      field.type.toLowerCase().includes(needle),
  );

  if (matches.length === 0) return <Empty>{empty}</Empty>;

  return (
    <>
      {matches.map((field) => (
        <FieldRow
          key={field.name}
          field={field}
          onInsert={onInsert}
          onOpenType={onOpenType}
        />
      ))}
    </>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const label = KIND_LABELS[kind];
  if (!label) return null;
  return (
    <span className="rounded bg-elevated px-1 text-[9px] tracking-wide text-muted uppercase">
      {label}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-3 text-[11px] leading-relaxed text-muted">
      {children}
    </p>
  );
}

/**
 * A type reference with its decoration picked out. `!` is the difference
 * between an argument you may leave off and one the server rejects you for,
 * and at one flat colour it vanishes into the name it is attached to.
 */
function TypeName({ type }: { type: string }) {
  return (
    <>
      {type.split(/([[\]!])/).map((part, i) =>
        part === "!" ? (
          <span key={i} className="text-warn">
            !
          </span>
        ) : part === "[" || part === "]" ? (
          <span key={i} className="text-muted">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** A type, coloured as one and clickable through to its own page. */
function TypeLink({
  type,
  onOpenType,
}: {
  type: string;
  onOpenType: (name: string) => void;
}) {
  const bare = type.replace(/[[\]!]/g, "");
  return (
    <button
      onClick={() => onOpenType(bare)}
      className="text-left font-mono text-[11px] break-words text-redirect hover:underline"
      title={`Open ${bare}`}
    >
      <TypeName type={type} />
    </button>
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
  return (
    <div className="group border-b border-edge/60 py-1">
      <div className="flex items-baseline gap-1">
        <button
          onClick={() => onInsert(field)}
          className="font-mono text-[11px] break-words text-ink hover:text-brand"
          title="Insert into query"
        >
          {field.name}
        </button>
        <span className="font-mono text-[11px] text-muted">:</span>
        <TypeLink type={field.type} onOpenType={onOpenType} />
      </div>

      {/* One argument to a line, each token its own colour, rather than the
          single grey signature this used to print. On a mutation the argument
          *is* the field — its input type is the page you actually want to
          open, and its description is usually the only documentation there
          is — and none of that survives being run together at one weight. */}
      {field.args.map((arg) => (
        <div key={arg.name} className="mt-0.5 pl-3">
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-[11px] break-words text-brand">
              {arg.name}
            </span>
            <span className="font-mono text-[11px] text-muted">:</span>
            <TypeLink type={arg.type} onOpenType={onOpenType} />
          </div>
          {arg.description && (
            <div className="text-[10px] leading-snug text-muted">
              {arg.description}
            </div>
          )}
        </div>
      ))}

      {field.description && (
        <div className="mt-0.5 text-[10px] leading-snug text-muted">
          {field.description}
        </div>
      )}
    </div>
  );
}
