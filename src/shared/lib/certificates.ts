// Picks the client certificate for a request, and collects the extra CAs.
//
// The matching lives here rather than in Rust so there is one answer shared by
// every send path, and so the settings panel can show which certificate a host
// would actually get.

import type { AppSettings, ClientCertificate } from "../types";

/** The host of a URL, or "" if there is not one to read. */
export function hostOf(url: string): string {
  // Not the URL API: a URL under edit may still hold `{{variables}}` and be
  // unparseable, and a request that cannot be parsed simply has no match.
  const match = /^[a-zA-Z][\w+.-]*:\/\/(?:[^@/]*@)?([^:/?#]+)/.exec(url.trim());
  return match ? match[1].toLowerCase() : "";
}

/**
 * Exact match, or one leading `*.` wildcard covering a single label — the rule
 * certificates themselves use, so `*.example.com` covers `api.example.com` but
 * not `example.com` or `a.b.example.com`.
 *
 * This is the only implementation on purpose. The backend is handed an
 * already-chosen certificate, because a second copy of these rules there could
 * drift from this one and the panel would promise a certificate that never gets
 * sent.
 */
export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = host.trim().toLowerCase();
  if (p === "" || h === "") return false;
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    const dot = h.indexOf(".");
    return dot === -1 ? false : h.slice(dot + 1) === suffix;
  }
  return p === h;
}

/**
 * The certificate for this URL, if any.
 *
 * An exact host wins over a wildcard, so a specific certificate can be added
 * for one host inside a domain that already has one. Among equals the first
 * wins, which is the order shown in settings.
 */
export function certificateFor(
  url: string,
  certificates: ClientCertificate[],
): ClientCertificate | null {
  const host = hostOf(url);
  if (host === "") return null;

  const usable = certificates.filter(
    (certificate) =>
      certificate.enabled !== false &&
      certificate.certPath.trim() !== "" &&
      hostMatches(certificate.host, host),
  );
  if (usable.length === 0) return null;

  return (
    usable.find((certificate) => !certificate.host.trim().startsWith("*.")) ??
    usable[0]
  );
}

/** The TLS fields to put on a request spec, ready to send to the backend. */
export function tlsFor(
  url: string,
  settings: AppSettings,
): {
  clientCert: { certPath: string; keyPath: string } | null;
  caCertPaths: string[];
} {
  const certificate = certificateFor(url, settings.clientCertificates ?? []);
  return {
    clientCert: certificate
      ? { certPath: certificate.certPath, keyPath: certificate.keyPath }
      : null,
    caCertPaths: (settings.caCertificatePaths ?? []).filter(
      (path) => path.trim() !== "",
    ),
  };
}
