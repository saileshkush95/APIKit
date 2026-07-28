// Generated values, written like variables: {{$faker.string.uuid}},
// {{$faker.person.fullName}}, {{$faker.internet.email}}.
//
// Everything comes from Faker, addressed by its own path, so the whole library
// is reachable without a list here that would go stale. The English locale
// build is imported deliberately: the full package carries every locale and
// most of its weight.
//
// Each is resolved fresh per request, which is the point — a retry should get a
// new idempotency key, not the one that already failed.

import { faker } from "@faker-js/faker/locale/en";

export interface DynamicVar {
  name: string;
  description: string;
  generate: () => string;
}

/**
 * Anything Faker exposes, addressed by its own path: `{{$faker.person.fullName}}`,
 * `{{$faker.internet.email}}`, `{{$faker.finance.creditCardNumber}}`. Written
 * this way rather than as a fixed list because Faker has hundreds of generators
 * and enumerating them here would go stale the moment it is published.
 */
function fromFaker(name: string): string | undefined {
  const path = name.startsWith("$faker.")
    ? name.slice("$faker.".length)
    : undefined;
  if (!path) return undefined;

  const steps = path.split(".").filter(Boolean);
  if (steps.length === 0) return undefined;

  // The parent is kept so the call has its `this` — Faker's generators are
  // methods on their module and break when detached.
  let parent: unknown = faker;
  let node: unknown = faker;
  for (const step of steps) {
    if (node === null || typeof node !== "object") return undefined;
    parent = node;
    node = (node as Record<string, unknown>)[step];
  }
  if (typeof node !== "function") return undefined;

  try {
    const value = (node as (...args: unknown[]) => unknown).call(parent);
    if (value === null || value === undefined) return undefined;
    return value instanceof Date ? value.toISOString() : String(value);
  } catch {
    // A generator that needs arguments; leaving the placeholder shows why.
    return undefined;
  }
}

export function isDynamic(name: string): boolean {
  return fromFaker(name) !== undefined;
}

export function generateDynamic(name: string): string | undefined {
  return fromFaker(name);
}

/**
 * Faker's own generators, discovered by walking it. Every zero-argument method
 * on a module qualifies, which is what makes the whole library reachable from
 * the completion list rather than a list someone has to maintain.
 */
export const DYNAMIC_VARS: DynamicVar[] = (() => {
  const found: DynamicVar[] = [];
  for (const [moduleName, module] of Object.entries(
    faker as unknown as Record<string, unknown>,
  )) {
    if (moduleName.startsWith("_") || module === null) continue;
    if (typeof module !== "object") continue;
    // Methods live on the prototype for Faker's class-based modules.
    const names = new Set([
      ...Object.keys(module),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(module) ?? {}),
    ]);
    for (const method of names) {
      if (method === "constructor" || method.startsWith("_")) continue;
      let value: unknown;
      try {
        value = (module as Record<string, unknown>)[method];
      } catch {
        continue;
      }
      if (typeof value !== "function") continue;
      found.push({
        name: `$faker.${moduleName}.${method}`,
        description: `Faker · ${moduleName}`,
        generate: () => generateDynamic(`$faker.${moduleName}.${method}`) ?? "",
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
})();

/** Names for the completion list, filtered by what has been typed. */
export function matchDynamic(query: string): DynamicVar[] {
  const needle = query.trim().toLowerCase().replace(/^\$/, "");
  const all = DYNAMIC_VARS;
  if (needle === "") return all.slice(0, 50);
  return all
    .filter((item) => item.name.slice(1).toLowerCase().includes(needle))
    .slice(0, 60);
}
