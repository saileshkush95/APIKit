// Generated values, written like variables: {{$uuid}}, {{$timestamp}}.
//
// Each is resolved fresh per request, which is the point — a retry should get a
// new idempotency key, not the one that already failed.

export interface DynamicVar {
  name: string;
  description: string;
  generate: () => string;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(items: T[]): T {
  return items[randomInt(0, items.length - 1)];
}

const FIRST = ["ada", "alan", "grace", "linus", "maya", "omar", "rita", "yuki"];
const LAST = ["lovelace", "turing", "hopper", "chen", "silva", "khan", "novak"];
const DOMAINS = ["example.com", "example.org", "test.dev"];

export const DYNAMIC_VARS: DynamicVar[] = [
  {
    name: "$uuid",
    description: "Random UUID v4",
    generate: () => crypto.randomUUID(),
  },
  {
    name: "$timestamp",
    description: "Unix time in seconds",
    generate: () => String(Math.floor(Date.now() / 1000)),
  },
  {
    name: "$timestampMs",
    description: "Unix time in milliseconds",
    generate: () => String(Date.now()),
  },
  {
    name: "$isoTimestamp",
    description: "Current time, ISO 8601",
    generate: () => new Date().toISOString(),
  },
  {
    name: "$randomInt",
    description: "Integer from 0 to 1000",
    generate: () => String(randomInt(0, 1000)),
  },
  {
    name: "$randomEmail",
    description: "Plausible email address",
    generate: () => `${pick(FIRST)}.${pick(LAST)}@${pick(DOMAINS)}`,
  },
  {
    name: "$randomFirstName",
    description: "First name",
    generate: () => pick(FIRST),
  },
  {
    name: "$randomLastName",
    description: "Last name",
    generate: () => pick(LAST),
  },
  {
    name: "$randomString",
    description: "Ten random characters",
    generate: () => Math.random().toString(36).slice(2, 12),
  },
  {
    name: "$randomBoolean",
    description: '"true" or "false"',
    generate: () => String(Math.random() < 0.5),
  },
];

const BY_NAME = new Map(DYNAMIC_VARS.map((item) => [item.name, item]));

export function isDynamic(name: string): boolean {
  return BY_NAME.has(name);
}

export function generateDynamic(name: string): string | undefined {
  return BY_NAME.get(name)?.generate();
}

/** Names for the completion list, filtered by what has been typed. */
export function matchDynamic(query: string): DynamicVar[] {
  const needle = query.trim().toLowerCase().replace(/^\$/, "");
  if (needle === "") return DYNAMIC_VARS;
  return DYNAMIC_VARS.filter((item) =>
    item.name.slice(1).toLowerCase().includes(needle),
  );
}
