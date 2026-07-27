// Response body renderings offered by the viewer.

import { beautify } from "./request";
import type { Header } from "../types";

export type ViewMode =
  | "json"
  | "xml"
  | "html"
  | "yaml"
  | "javascript"
  | "markdown"
  | "raw"
  | "hex"
  | "base64";

export const VIEW_MODES: { value: ViewMode; label: string; icon: string }[] = [
  { value: "json", label: "JSON", icon: "{ }" },
  { value: "xml", label: "XML", icon: "</>" },
  { value: "html", label: "HTML", icon: "<>" },
  { value: "yaml", label: "YAML", icon: "≡" },
  { value: "javascript", label: "JavaScript", icon: "JS" },
  { value: "markdown", label: "Markdown", icon: "M↓" },
  { value: "raw", label: "Raw", icon: "T" },
  { value: "hex", label: "Hex", icon: "0x" },
  { value: "base64", label: "Base64", icon: "64" },
];

/** Picks the initial view from the response's content type. */
export function guessViewMode(contentType: string | undefined, body: string): ViewMode {
  const type = contentType?.toLowerCase() ?? "";
  if (type.includes("json")) return "json";
  if (type.includes("html")) return "html";
  if (type.includes("xml")) return "xml";
  if (type.includes("yaml")) return "yaml";
  if (type.includes("javascript")) return "javascript";
  if (type.includes("markdown")) return "markdown";
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (trimmed.startsWith("<")) return "html";
  return "raw";
}

function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const rendered = toYaml(item, indent + 1);
        return typeof item === "object" && item !== null
          ? `${pad}-\n${rendered}`
          : `${pad}- ${rendered}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, item]) => {
        if (typeof item === "object" && item !== null) {
          return `${pad}${key}:\n${toYaml(item, indent + 1)}`;
        }
        return `${pad}${key}: ${toYaml(item, indent + 1)}`;
      })
      .join("\n");
  }
  if (typeof value === "string") {
    // Quote only when the string could be read as another scalar type.
    return /^[\w .@/:-]*$/.test(value) && value !== "" ? value : JSON.stringify(value);
  }
  return String(value);
}

function toHex(body: string): string {
  const bytes = new TextEncoder().encode(body);
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = bytes.slice(offset, offset + 16);
    const hex = [...slice]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(47, " ");
    const ascii = [...slice]
      .map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : "."))
      .join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}

function toBase64(body: string): string {
  try {
    // btoa is Latin-1 only, so encode through UTF-8 bytes first.
    const bytes = new TextEncoder().encode(body);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/(.{76})/g, "$1\n");
  } catch {
    return body;
  }
}

export function renderBody(body: string, mode: ViewMode): string {
  switch (mode) {
    case "json":
      try {
        return JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        return body;
      }
    case "xml":
    case "html":
      return beautify(body, "xml");
    case "yaml":
      try {
        return toYaml(JSON.parse(body));
      } catch {
        return body;
      }
    case "hex":
      return toHex(body);
    case "base64":
      return toBase64(body);
    case "javascript":
    case "markdown":
    case "raw":
    default:
      return body;
  }
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

/** Parses `Set-Cookie` response headers into displayable rows. */
export function parseCookies(headers: Header[]): Cookie[] {
  return headers
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => {
      const [pair, ...attributes] = header.value.split(";");
      const eq = pair.indexOf("=");
      const cookie: Cookie = {
        name: eq === -1 ? pair.trim() : pair.slice(0, eq).trim(),
        value: eq === -1 ? "" : pair.slice(eq + 1).trim(),
        domain: "",
        path: "",
        expires: "",
        httpOnly: false,
        secure: false,
        sameSite: "",
      };
      for (const attribute of attributes) {
        const [rawKey, ...rest] = attribute.split("=");
        const key = rawKey.trim().toLowerCase();
        const value = rest.join("=").trim();
        if (key === "domain") cookie.domain = value;
        else if (key === "path") cookie.path = value;
        else if (key === "expires") cookie.expires = value;
        else if (key === "max-age") cookie.expires ||= `${value}s`;
        else if (key === "httponly") cookie.httpOnly = true;
        else if (key === "secure") cookie.secure = true;
        else if (key === "samesite") cookie.sameSite = value;
      }
      return cookie;
    });
}
