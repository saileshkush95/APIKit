// Declarative response assertions. Requests carry a list of these; the runner
// and the response pane both evaluate them with `runAssertions`.

import type { Assertion, AssertionResult, HttpResponseData } from "../types";

export const ASSERTION_SOURCES = [
  { value: "status", label: "Status code" },
  { value: "responseTime", label: "Response time (ms)" },
  { value: "header", label: "Header" },
  { value: "jsonBody", label: "JSON path" },
  { value: "bodyText", label: "Body text" },
] as const;

export const ASSERTION_OPS = [
  { value: "equals", label: "equals" },
  { value: "notEquals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "lessThan", label: "<" },
  { value: "greaterThan", label: ">" },
  { value: "exists", label: "exists" },
  { value: "matches", label: "matches regex" },
] as const;

/** Whether a source needs the "target" field (header name / JSON path). */
export function sourceNeedsTarget(source: Assertion["source"]): boolean {
  return source === "header" || source === "jsonBody";
}

/**
 * Resolves a dotted JSON path such as `data.items[0].id`. A leading `$.` is
 * accepted for familiarity with JSONPath but is not required.
 */
export function resolveJsonPath(value: unknown, path: string): unknown {
  const steps = path
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((step) => step !== "");

  let current: unknown = value;
  for (const step of steps) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(step);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[step];
    } else {
      return undefined;
    }
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** The observed value an assertion compares against, plus whether it existed. */
function actualFor(
  assertion: Assertion,
  response: HttpResponseData,
): { actual: string; present: boolean } {
  switch (assertion.source) {
    case "status":
      return { actual: String(response.status), present: true };
    case "responseTime":
      return { actual: String(response.timeMs), present: true };
    case "header": {
      const wanted = assertion.target.trim().toLowerCase();
      const header = response.headers.find(
        (h) => h.name.toLowerCase() === wanted,
      );
      return { actual: header?.value ?? "", present: header !== undefined };
    }
    case "jsonBody": {
      try {
        const parsed = JSON.parse(response.body);
        const value = resolveJsonPath(parsed, assertion.target);
        return { actual: stringify(value), present: value !== undefined };
      } catch {
        return { actual: "", present: false };
      }
    }
    case "bodyText":
      return { actual: response.body, present: true };
  }
}

function compare(
  op: Assertion["op"],
  actual: string,
  expected: string,
  present: boolean,
): boolean {
  switch (op) {
    case "exists":
      return present;
    case "equals":
      return actual === expected;
    case "notEquals":
      return actual !== expected;
    case "contains":
      return actual.includes(expected);
    case "lessThan":
      return Number(actual) < Number(expected);
    case "greaterThan":
      return Number(actual) > Number(expected);
    case "matches":
      try {
        return new RegExp(expected).test(actual);
      } catch {
        return false;
      }
  }
}

export function describeAssertion(assertion: Assertion): string {
  const source =
    ASSERTION_SOURCES.find((s) => s.value === assertion.source)?.label ??
    assertion.source;
  const op =
    ASSERTION_OPS.find((o) => o.value === assertion.op)?.label ?? assertion.op;
  const subject = sourceNeedsTarget(assertion.source)
    ? `${source} ${assertion.target}`
    : source;
  return assertion.op === "exists"
    ? `${subject} exists`
    : `${subject} ${op} ${assertion.expected}`;
}

export function runAssertion(
  assertion: Assertion,
  response: HttpResponseData,
): AssertionResult {
  const { actual, present } = actualFor(assertion, response);
  const passed = compare(assertion.op, actual, assertion.expected, present);
  // Long bodies make failure lines unreadable; a prefix is enough to diagnose.
  const shown = actual.length > 120 ? `${actual.slice(0, 120)}…` : actual;
  return {
    assertion,
    passed,
    actual: shown,
    message: passed
      ? describeAssertion(assertion)
      : `${describeAssertion(assertion)} — got "${shown}"`,
  };
}

export function runAssertions(
  assertions: Assertion[],
  response: HttpResponseData,
): AssertionResult[] {
  return assertions
    .filter((a) => a.source !== undefined)
    .map((a) => runAssertion(a, response));
}
