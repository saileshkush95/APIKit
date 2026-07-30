// What a single `{{variable}}` resolves to, and where that came from.
//
// The overlay colours a variable by whether it resolves, which answers "will
// this send". It does not answer "send what" — and it cannot answer the
// question behind most of the confusion, which is *which* definition won. The
// same name can be a collection default, an environment override and a script
// write; hovering has to say which one is in force, or the value on its own is
// only half an answer.

import { generateDynamic, isDynamic } from "./dynamicVars";
import { isActive } from "./rows";
import type { Environment, Variable } from "../types";

export type VariableScope =
  | "session"
  | "environment"
  | "collection"
  | "dynamic"
  /** Defined, but the row is switched off, so it does not resolve. */
  | "disabled"
  | "unknown";

/**
 * Where an edit to this variable should be written.
 *
 * Null for a generated value, which has no definition to change. For a name
 * nothing defines yet this points at where it *would* go, so hovering an
 * undefined variable can define it.
 */
export type VariableTarget =
  | { kind: "environment"; id: string; name: string }
  | { kind: "collection" }
  | { kind: "session" }
  | null;

export interface VariableInfo {
  name: string;
  scope: VariableScope;
  /** Label for where it came from: the environment's name, "Collection", … */
  origin: string;
  target: VariableTarget;
  /** The resolved value. Empty when unresolved, and withheld for a secret. */
  value: string;
  /** Marked secret, so `value` is withheld rather than missing. */
  secret: boolean;
  /** The stored value is the empty string, which sends as nothing. */
  empty: boolean;
  /** Nothing is substituted: `{{name}}` travels as literal text. */
  unresolved: boolean;
}

export interface VariableSources {
  sessionVars: Record<string, string>;
  environment: Environment | null;
  collectionVariables: Variable[];
}

function find(variables: Variable[], name: string): Variable | undefined {
  return variables.find((variable) => variable.name.trim() === name);
}

function resolved(
  name: string,
  scope: VariableScope,
  origin: string,
  target: VariableTarget,
  variable: Variable,
): VariableInfo {
  const secret = variable.secret === true;
  return {
    name,
    scope,
    origin,
    target,
    // A secret's value is not shown: this tooltip follows the pointer around a
    // screen that gets shared and recorded, and "is it set" is the part the
    // user actually needs. The environment editor is where a value gets read.
    value: secret ? "" : variable.value,
    secret,
    empty: variable.value === "",
    unresolved: false,
  };
}

/**
 * Resolves `name` the way the request will, and reports the scope that won.
 *
 * The precedence here must match `useEnvironments().vars` — session over
 * environment over collection over generated — because a tooltip that
 * disagreed with what gets sent would be worse than no tooltip.
 */
export function describeVariable(
  name: string,
  sources: VariableSources,
): VariableInfo {
  const { sessionVars, environment, collectionVariables } = sources;
  const inEnvironmentTarget: VariableTarget = environment
    ? { kind: "environment", id: environment.id, name: environment.name }
    : null;

  if (Object.prototype.hasOwnProperty.call(sessionVars, name)) {
    return {
      name,
      scope: "session",
      origin: "Set by a script",
      target: { kind: "session" },
      value: sessionVars[name],
      secret: false,
      empty: sessionVars[name] === "",
      unresolved: false,
    };
  }

  const inEnvironment = environment
    ? find(environment.variables, name)
    : undefined;
  if (inEnvironment && isActive(inEnvironment)) {
    return resolved(
      name,
      "environment",
      environment?.name ?? "Environment",
      inEnvironmentTarget,
      inEnvironment,
    );
  }

  const inCollection = find(collectionVariables, name);
  if (inCollection && isActive(inCollection)) {
    return resolved(
      name,
      "collection",
      "Collection",
      { kind: "collection" },
      inCollection,
    );
  }

  if (isDynamic(name)) {
    return {
      name,
      scope: "dynamic",
      origin: "Generated",
      // Nothing to edit: the value is produced fresh for every request.
      target: null,
      value: generateDynamic(name) ?? "",
      secret: false,
      empty: false,
      unresolved: false,
    };
  }

  // Defined but parked. Saying "not defined" would send the user looking for
  // something they would then find, which is the more annoying wrong answer.
  if (inEnvironment) {
    return {
      name,
      scope: "disabled",
      origin: environment?.name ?? "Environment",
      target: inEnvironmentTarget,
      value: "",
      secret: inEnvironment.secret === true,
      empty: false,
      unresolved: true,
    };
  }
  if (inCollection) {
    return {
      name,
      scope: "disabled",
      origin: "Collection",
      target: { kind: "collection" },
      value: "",
      secret: inCollection.secret === true,
      empty: false,
      unresolved: true,
    };
  }

  return {
    name,
    scope: "unknown",
    origin: environment ? environment.name : "No environment",
    // A value typed for an undefined name has to land somewhere that persists;
    // without an environment that is the collection, not the session.
    target: inEnvironmentTarget ?? { kind: "collection" },
    value: "",
    secret: false,
    empty: false,
    unresolved: true,
  };
}

/**
 * Sets `name` to `value` in a list of variable rows.
 *
 * A row that was switched off comes back on: you do not edit a parked variable
 * in order to leave it parked, and saving a value that still would not be sent
 * is the one outcome nobody wants.
 */
export function upsertVariable(
  rows: Variable[],
  name: string,
  value: string,
): Variable[] {
  const index = rows.findIndex((row) => row.name.trim() === name);
  if (index !== -1) {
    return rows.map((row, i) =>
      i === index
        ? { ...row, value, ...(row.enabled === false ? { enabled: true } : {}) }
        : row,
    );
  }
  // The editors keep a blank row at the end to type into; a new variable goes
  // before it, or that row stops being the last one.
  const last = rows.length - 1;
  const added: Variable = { name, value };
  return last >= 0 && rows[last].name.trim() === ""
    ? [...rows.slice(0, last), added, rows[last]]
    : [...rows, added];
}
