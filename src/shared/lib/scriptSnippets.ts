// Ready-made script templates, offered in the Scripts tab.
//
// Every snippet here must run against the sandbox in scripts.ts as it actually
// is — `runPreScript` / `runPostScript` decide what exists, and a snippet that
// reaches for something they do not expose fails the moment it is inserted.
// What that means in practice:
//
//   * `wrk.expect(v)` has `toBe` and `toContain`, and nothing else. Anything
//     richer is written as `wrk.test(name, () => <boolean>)`, which fails the
//     test on a `false` return.
//   * `wrk.env.set(name, value)` stringifies. There is no `unset`, so clearing
//     a variable means setting it empty.
//   * The script runs through `new Function`, so the ordinary globals — JSON,
//     Date, Math, crypto, btoa — are all in scope.

export interface ScriptSnippet {
  label: string;
  /** Grouping heading in the picker. */
  group: string;
  code: string;
}

export const PRE_SNIPPETS: ScriptSnippet[] = [
  // --- Variables ------------------------------------------------------------
  {
    group: "Variables",
    label: "Read a variable",
    code: 'const token = wrk.env.get("token");',
  },
  {
    group: "Variables",
    label: "Set a variable",
    code: 'wrk.env.set("token", "value");',
  },
  {
    group: "Variables",
    label: "Set a variable only if missing",
    code: `if (!wrk.env.has("sessionId")) {
  wrk.env.set("sessionId", crypto.randomUUID());
}`,
  },
  {
    group: "Variables",
    label: "Clear a variable",
    code: '// There is no unset — an empty value is how a variable is cleared.\nwrk.env.set("token", "");',
  },
  {
    group: "Variables",
    label: "Log every variable",
    code: "console.log(wrk.env.all());",
  },

  // --- Request --------------------------------------------------------------
  {
    group: "Request",
    label: "Set a header",
    code: 'wrk.request.headers["X-Request-Id"] = crypto.randomUUID();',
  },
  {
    group: "Request",
    label: "Set a bearer token from a variable",
    code: 'wrk.request.headers["Authorization"] = "Bearer " + wrk.env.get("token");',
  },
  {
    group: "Request",
    label: "Set basic auth",
    code: `wrk.request.headers["Authorization"] =
  "Basic " + btoa(wrk.env.get("user") + ":" + wrk.env.get("password"));`,
  },
  {
    group: "Request",
    label: "Remove a header",
    code: 'delete wrk.request.headers["X-Debug"];',
  },
  {
    group: "Request",
    label: "Add a query parameter",
    code: `const separator = wrk.request.url.includes("?") ? "&" : "?";
wrk.request.url += separator + "page=1";`,
  },
  {
    group: "Request",
    label: "Change the method",
    code: 'wrk.request.method = "POST";',
  },
  {
    group: "Request",
    label: "Replace the URL",
    code: 'wrk.request.url = wrk.env.get("baseUrl") + "/v2/users";',
  },
  {
    group: "Request",
    label: "Build a JSON body",
    code: `wrk.request.headers["Content-Type"] = "application/json";
wrk.request.body = JSON.stringify({
  email: wrk.env.get("email"),
  at: new Date().toISOString(),
});`,
  },
  {
    group: "Request",
    label: "Edit one field of a JSON body",
    code: `const payload = JSON.parse(wrk.request.body || "{}");
payload.requestedAt = Date.now();
wrk.request.body = JSON.stringify(payload);`,
  },
  {
    group: "Request",
    label: "Log the outgoing request",
    code: `console.log(wrk.request.method, wrk.request.url);
console.log(wrk.request.headers);`,
  },

  // --- Values ---------------------------------------------------------------
  {
    group: "Generated values",
    label: "Timestamp",
    code: 'wrk.env.set("timestamp", Date.now());',
  },
  {
    group: "Generated values",
    label: "ISO date",
    code: 'wrk.env.set("today", new Date().toISOString());',
  },
  {
    group: "Generated values",
    label: "UUID",
    code: 'wrk.env.set("requestId", crypto.randomUUID());',
  },
  {
    group: "Generated values",
    label: "Random integer",
    code: 'wrk.env.set("amount", Math.floor(Math.random() * 1000) + 1);',
  },
  {
    group: "Generated values",
    label: "Base64 encode",
    code: 'wrk.env.set("encoded", btoa("hello"));',
  },
];

export const POST_SNIPPETS: ScriptSnippet[] = [
  // --- Status ---------------------------------------------------------------
  {
    group: "Status code",
    label: "Code is 200",
    code: 'wrk.test("status is 200", () => wrk.response.status === 200);',
  },
  {
    group: "Status code",
    label: "Code is one of",
    code: `wrk.test("status is 200, 201 or 204", () =>
  [200, 201, 204].includes(wrk.response.status));`,
  },
  {
    group: "Status code",
    label: "Request succeeded (2xx)",
    code: `wrk.test("request succeeded", () =>
  wrk.response.status >= 200 && wrk.response.status < 300);`,
  },
  {
    group: "Status code",
    label: "Status text contains",
    code: `wrk.test("status text says OK", () =>
  wrk.expect(wrk.response.statusText).toContain("OK"));`,
  },

  // --- Body -----------------------------------------------------------------
  {
    group: "Response body",
    label: "Contains a string",
    code: `wrk.test("body mentions the user", () =>
  wrk.expect(wrk.response.body).toContain("user"));`,
  },
  {
    group: "Response body",
    label: "Equals a string",
    code: `wrk.test("body is exactly ok", () =>
  wrk.expect(wrk.response.body.trim()).toBe("ok"));`,
  },
  {
    group: "Response body",
    label: "Is valid JSON",
    code: `wrk.test("body parses as JSON", () => {
  wrk.response.json();
  return true;
});`,
  },
  {
    group: "Response body",
    label: "JSON value check",
    code: `wrk.test("id is 42", () => wrk.expect(wrk.response.json().id).toBe(42));`,
  },
  {
    group: "Response body",
    label: "JSON field is present",
    code: `wrk.test("has an access token", () => {
  const body = wrk.response.json();
  return typeof body.access_token === "string" && body.access_token !== "";
});`,
  },
  {
    group: "Response body",
    label: "Nested JSON value",
    code: `wrk.test("first item is active", () =>
  wrk.response.json().data[0].status === "active");`,
  },
  {
    group: "Response body",
    label: "Array is not empty",
    code: `wrk.test("returned at least one row", () => {
  const body = wrk.response.json();
  return Array.isArray(body.data) && body.data.length > 0;
});`,
  },
  {
    group: "Response body",
    label: "Array has an exact length",
    code: `wrk.test("returned 10 rows", () =>
  wrk.response.json().data.length === 10);`,
  },
  {
    group: "Response body",
    label: "Every item has a field",
    code: `wrk.test("every row has an id", () =>
  wrk.response.json().data.every((row) => row.id !== undefined));`,
  },
  {
    group: "Response body",
    label: "Matches a pattern",
    code: `wrk.test("body holds an email", () =>
  /[^@\\s]+@[^@\\s]+\\.[^@\\s]+/.test(wrk.response.body));`,
  },

  // --- Headers --------------------------------------------------------------
  {
    group: "Headers",
    label: "Header is present",
    code: `wrk.test("sends a request id", () =>
  wrk.response.headers["x-request-id"] !== undefined);`,
  },
  {
    group: "Headers",
    label: "Content-Type is JSON",
    code: `wrk.test("responds with JSON", () =>
  wrk.expect(wrk.response.headers["content-type"]).toContain("application/json"));`,
  },
  {
    group: "Headers",
    label: "Log every header",
    code: "console.log(wrk.response.headers);",
  },

  // --- Timing and size ------------------------------------------------------
  {
    group: "Timing and size",
    label: "Response time is under 500ms",
    code: 'wrk.test("responded within 500ms", () => wrk.response.timeMs < 500);',
  },
  {
    group: "Timing and size",
    label: "Body is under 100 KB",
    code: 'wrk.test("body under 100 KB", () => wrk.response.sizeBytes < 100 * 1024);',
  },

  // --- Chaining -------------------------------------------------------------
  {
    group: "Chaining requests",
    label: "Save a token for the next request",
    code: 'wrk.env.set("token", wrk.response.json().access_token);',
  },
  {
    group: "Chaining requests",
    label: "Save an id from a created record",
    code: 'wrk.env.set("userId", wrk.response.json().id);',
  },
  {
    group: "Chaining requests",
    label: "Save a header value",
    code: 'wrk.env.set("requestId", wrk.response.headers["x-request-id"]);',
  },
  {
    group: "Chaining requests",
    label: "Save only when the call worked",
    code: `if (wrk.response.status === 200) {
  wrk.env.set("token", wrk.response.json().access_token);
} else {
  console.error("login failed", wrk.response.status);
}`,
  },

  // --- Debugging ------------------------------------------------------------
  {
    group: "Debugging",
    label: "Log the response",
    code: `console.log(wrk.response.status, wrk.response.timeMs + "ms");
console.log(wrk.response.body);`,
  },
  {
    group: "Debugging",
    label: "Log a JSON field",
    code: "console.log(wrk.response.json().data);",
  },
];

/** Snippets in insertion order, grouped by their heading. */
export function groupSnippets(
  snippets: ScriptSnippet[],
): { group: string; items: ScriptSnippet[] }[] {
  const groups: { group: string; items: ScriptSnippet[] }[] = [];
  for (const snippet of snippets) {
    const existing = groups.find((entry) => entry.group === snippet.group);
    if (existing) existing.items.push(snippet);
    else groups.push({ group: snippet.group, items: [snippet] });
  }
  return groups;
}
