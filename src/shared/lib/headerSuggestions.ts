// Suggestions for the header editor.
//
// Typing "auth" should offer Authorization; picking Authorization should offer
// "Bearer {{token}}". The lists are deliberately short — the headers people
// actually type by hand, not the full IANA registry, which would bury the
// useful ones.

/** Request headers worth suggesting, most-used first within each group. */
export const REQUEST_HEADERS: string[] = [
  "Accept",
  "Accept-Encoding",
  "Accept-Language",
  "Authorization",
  "Cache-Control",
  "Content-Type",
  "Content-Length",
  "Cookie",
  "Host",
  "If-Match",
  "If-None-Match",
  "Idempotency-Key",
  "Origin",
  "Referer",
  "User-Agent",
  "X-Api-Key",
  "X-Correlation-Id",
  "X-CSRF-Token",
  "X-Forwarded-For",
  "X-Request-Id",
  "X-Requested-With",
];

/** Response headers, for the mock server's canned replies. */
export const RESPONSE_HEADERS: string[] = [
  "Access-Control-Allow-Credentials",
  "Access-Control-Allow-Headers",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Origin",
  "Cache-Control",
  "Content-Disposition",
  "Content-Encoding",
  "Content-Language",
  "Content-Type",
  "ETag",
  "Expires",
  "Last-Modified",
  "Location",
  "Retry-After",
  "Set-Cookie",
  "Vary",
  "WWW-Authenticate",
  "X-Request-Id",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
];

/** Values that make sense for a given header. */
const VALUES: Record<string, string[]> = {
  "access-control-allow-origin": ["*", "{{origin}}"],
  "access-control-allow-methods": ["GET, POST, PUT, PATCH, DELETE, OPTIONS"],
  "access-control-allow-headers": ["Content-Type, Authorization"],
  "access-control-allow-credentials": ["true"],
  "content-disposition": ['attachment; filename="file.json"', "inline"],
  "content-encoding": ["gzip", "br", "identity"],
  location: ["/", "https://example.com"],
  "retry-after": ["1", "30", "120"],
  vary: ["Accept-Encoding", "Origin"],
  "www-authenticate": ['Bearer realm="api"'],
  accept: [
    "application/json",
    "application/xml",
    "text/plain",
    "text/event-stream",
    "*/*",
  ],
  "accept-encoding": ["gzip, deflate, br", "gzip", "identity"],
  "accept-language": ["en-US,en;q=0.9"],
  authorization: [
    "Bearer {{token}}",
    "Basic {{credentials}}",
    "Token {{token}}",
  ],
  "cache-control": ["no-cache", "no-store", "max-age=0"],
  "content-type": [
    "application/json",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
    "application/xml",
    "text/plain",
  ],
  "x-api-key": ["{{apiKey}}"],
  "x-requested-with": ["XMLHttpRequest"],
  connection: ["keep-alive", "close"],
};

/** Ranks prefix matches above substring matches, as a user would expect. */
export function matchHeaders(query: string, pool = REQUEST_HEADERS): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return pool.slice(0, 8);

  const prefix: string[] = [];
  const contains: string[] = [];
  for (const header of pool) {
    const lower = header.toLowerCase();
    if (lower === needle) continue;
    if (lower.startsWith(needle)) prefix.push(header);
    else if (lower.includes(needle)) contains.push(header);
  }
  return [...prefix, ...contains].slice(0, 8);
}

export function matchHeaderValues(header: string, query: string): string[] {
  const values = VALUES[header.trim().toLowerCase()];
  if (!values) return [];
  const needle = query.trim().toLowerCase();
  if (needle === "") return values.slice(0, 8);
  return values
    .filter((value) => value.toLowerCase().includes(needle) && value !== query)
    .slice(0, 8);
}
