// The CLI's request transport.
//
// Inside the app a request goes to Rust over Tauri; here it goes through fetch.
// Everything above it — building the request, the pre/post scripts, the
// assertions — is the same `executeRequest` the app and the monitors use, so the
// CLI cannot quietly disagree with them about what a request means.
//
// What this transport cannot do is worth stating, because each one is a real
// difference from the app rather than an omission:
//
//   * HTTP/2 and HTTP/3 are whatever the runtime negotiates; the per-request
//     version override is ignored.
//   * `verifyTls: false` and client certificates need runtime-level flags
//     (NODE_EXTRA_CA_CERTS, --tls-* ), not per-request options, so they are
//     reported rather than silently skipped.
//   * A file body or a multipart file part is read from disk here, which the
//     Rust side did to keep bytes exact; that part is the same.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { HttpRequestSpec, HttpResponseData } from "../src/shared/types";

export interface TransportWarning {
  request: string;
  message: string;
}

/**
 * Builds a fetch-backed transport.
 *
 * `warnings` collects the per-request options fetch has no answer for, so the
 * run can report them once at the end instead of per request.
 */
export function createTransport(warnings: TransportWarning[]) {
  return async function send(spec: HttpRequestSpec): Promise<HttpResponseData> {
    const note = (message: string) => {
      if (!warnings.some((w) => w.message === message)) {
        warnings.push({ request: spec.url, message });
      }
    };

    if (spec.verifyTls === false) {
      note(
        "verifyTls is off for some requests, which fetch cannot do per request. Run with NODE_TLS_REJECT_UNAUTHORIZED=0 to apply it to the whole process, and only against a server you control.",
      );
    }
    if (spec.clientCert?.certPath) {
      note(
        "a client certificate is configured, which fetch cannot present per request. The CLI does not support mutual TLS.",
      );
    }
    if (spec.caCertPaths?.length) {
      note(
        "extra CA certificates are configured. Pass them with NODE_EXTRA_CA_CERTS=/path/to/ca.pem instead.",
      );
    }
    if (spec.httpVersion && spec.httpVersion !== "auto") {
      note(
        `an explicit HTTP version (${spec.httpVersion}) is set, which fetch negotiates itself. The override is ignored.`,
      );
    }

    const headers = new Headers();
    for (const header of spec.headers) {
      if (header.name.trim() !== "") headers.append(header.name, header.value);
    }

    let body: BodyInit | undefined;
    if (spec.multipart?.length) {
      const form = new FormData();
      for (const part of spec.multipart) {
        if (part.filePath) {
          const bytes = await readFile(part.filePath);
          form.append(
            part.name,
            new File([new Uint8Array(bytes)], part.fileName ?? basename(part.filePath), {
              type: part.contentType ?? "application/octet-stream",
            }),
          );
        } else {
          form.append(part.name, part.value);
        }
      }
      body = form;
      // FormData sets its own Content-Type with the boundary; a copied one from
      // the collection would carry the wrong boundary and the server would read
      // an empty body.
      headers.delete("content-type");
    } else if (spec.bodyFilePath) {
      const bytes = await readFile(spec.bodyFilePath);
      body = new Uint8Array(bytes);
    } else if (spec.body != null && spec.body !== "") {
      body = spec.body;
    }

    const method = spec.method.toUpperCase();
    const controller = new AbortController();
    const timeout = spec.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeout);

    const started = performance.now();
    try {
      const response = await fetch(spec.url, {
        method,
        headers,
        // GET and HEAD must not carry one, and fetch throws rather than ignoring.
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: spec.followRedirects === false ? "manual" : "follow",
        signal: controller.signal,
      });

      const buffer = new Uint8Array(await response.arrayBuffer());
      const timeMs = Math.round(performance.now() - started);

      // Same rule as the Rust side: text stays text, anything that is not valid
      // UTF-8 keeps its exact bytes as base64 so assertions on a binary body
      // still have something to look at.
      let text: string;
      let base64: string | null = null;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        text = "";
        base64 = Buffer.from(buffer).toString("base64");
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()].map(([name, value]) => ({
          name,
          value,
        })),
        body: text,
        bodyBase64: base64,
        timeMs,
        sizeBytes: buffer.byteLength,
        finalUrl: response.url || spec.url,
        // fetch does not say which version it negotiated.
        httpVersion: "HTTP",
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`timed out after ${timeout}ms`);
      }
      // fetch's own message is "fetch failed" with the reason one level down.
      const cause = (error as { cause?: unknown }).cause;
      const detail =
        cause instanceof Error ? `: ${cause.message}` : cause ? `: ${String(cause)}` : "";
      throw new Error(`${(error as Error).message}${detail}`);
    } finally {
      clearTimeout(timer);
    }
  };
}
