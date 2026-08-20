// Generates client code for the request currently being edited.

import type { HighlightLanguage } from "./highlight";
import type { WireRequest } from "./vars";

/** A request whose body may be a file on disk rather than text. */
export interface CodeRequest extends WireRequest {
  bodyFilePath?: string;
}

export type CodeTarget =
  | "curl"
  | "fetch"
  | "axios"
  | "python"
  | "httpie"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "php"
  | "ruby"
  | "swift";

export const CODE_TARGETS: { value: CodeTarget; label: string }[] = [
  { value: "curl", label: "cURL" },
  { value: "fetch", label: "JavaScript — Fetch" },
  { value: "axios", label: "JavaScript — Axios" },
  { value: "python", label: "Python — requests" },
  { value: "httpie", label: "HTTPie" },
  { value: "go", label: "Go — net/http" },
  { value: "rust", label: "Rust — reqwest" },
  { value: "java", label: "Java — HttpClient" },
  { value: "csharp", label: "C# — HttpClient" },
  { value: "php", label: "PHP — cURL" },
  { value: "ruby", label: "Ruby — Net::HTTP" },
  { value: "swift", label: "Swift — URLSession" },
];

/** How each target's output is highlighted when it is shown. */
export const CODE_LANGUAGE: Record<CodeTarget, HighlightLanguage> = {
  curl: "shell",
  httpie: "shell",
  fetch: "javascript",
  axios: "javascript",
  python: "python",
  go: "go",
  rust: "rust",
  java: "java",
  csharp: "csharp",
  php: "php",
  ruby: "ruby",
  swift: "swift",
};

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Mirrors `method_allows_body` in the Rust client: only TRACE is excluded, so a
// snippet generated from a GET-with-a-body sends the same bytes the app does.
function hasBody(request: WireRequest): boolean {
  return (
    request.body.trim() !== "" && request.method.toUpperCase() !== "TRACE"
  );
}

function curl(request: CodeRequest): string {
  // No trailing `\` on the parts: the join below adds the continuation. Having
  // one here too produced `POST \ \`, where the first pair is an escaped space —
  // an argument of one space, which curl reads as a second URL and rejects
  // ("URL rejected: Malformed input to a URL function") before running the real
  // request.
  const parts = [`curl --request ${request.method.toUpperCase()}`];
  parts.push(`  --url ${shellQuote(request.url)}`);
  for (const header of request.headers) {
    parts.push(`  --header ${shellQuote(`${header.name}: ${header.value}`)}`);
  }
  if (request.bodyFilePath) {
    // `@` streams the file as-is; `--data` would mangle newlines.
    parts.push(`  --data-binary ${shellQuote(`@${request.bodyFilePath}`)}`);
  } else if (hasBody(request)) {
    parts.push(`  --data ${shellQuote(request.body)}`);
  }
  return parts.join(" \\\n");
}

function httpie(request: CodeRequest): string {
  const headers = request.headers
    .map((header) => shellQuote(`${header.name}:${header.value}`))
    .join(" ");
  const body = request.bodyFilePath
    ? ` < ${shellQuote(request.bodyFilePath)}`
    : hasBody(request)
      ? ` <<< ${shellQuote(request.body)}`
      : "";
  return `http ${request.method.toUpperCase()} ${shellQuote(request.url)} ${headers}${body}`.trim();
}

function headersObject(request: WireRequest, indent: string): string {
  if (request.headers.length === 0) return "{}";
  const entries = request.headers
    .map((header) => `${indent}  ${quote(header.name)}: ${quote(header.value)}`)
    .join(",\n");
  return `{\n${entries}\n${indent}}`;
}

function fetchCode(request: WireRequest): string {
  const lines = [
    `const response = await fetch(${quote(request.url)}, {`,
    `  method: ${quote(request.method.toUpperCase())},`,
    `  headers: ${headersObject(request, "  ")},`,
  ];
  if (hasBody(request)) lines.push(`  body: ${quote(request.body)},`);
  lines.push("});", "", "const data = await response.text();", "console.log(data);");
  return lines.join("\n");
}

function axiosCode(request: WireRequest): string {
  const lines = [
    `import axios from "axios";`,
    "",
    "const response = await axios({",
    `  method: ${quote(request.method.toLowerCase())},`,
    `  url: ${quote(request.url)},`,
    `  headers: ${headersObject(request, "  ")},`,
  ];
  if (hasBody(request)) lines.push(`  data: ${quote(request.body)},`);
  lines.push("});", "", "console.log(response.data);");
  return lines.join("\n");
}

function pythonCode(request: WireRequest): string {
  const headers = request.headers
    .map((header) => `    ${quote(header.name)}: ${quote(header.value)},`)
    .join("\n");
  const lines = [
    "import requests",
    "",
    `url = ${quote(request.url)}`,
    `headers = {\n${headers}\n}`,
  ];
  if (hasBody(request)) {
    lines.push(`payload = ${quote(request.body)}`);
    lines.push(
      `response = requests.request(${quote(request.method.toUpperCase())}, url, headers=headers, data=payload)`,
    );
  } else {
    lines.push(
      `response = requests.request(${quote(request.method.toUpperCase())}, url, headers=headers)`,
    );
  }
  lines.push("", "print(response.status_code)", "print(response.text)");
  return lines.join("\n");
}

function goCode(request: WireRequest): string {
  const lines = [
    "package main",
    "",
    "import (",
    '\t"fmt"',
    '\t"io"',
    '\t"net/http"',
  ];
  if (hasBody(request)) lines.push('\t"strings"');
  lines.push(")", "", "func main() {");
  if (hasBody(request)) {
    lines.push(`\tpayload := strings.NewReader(${quote(request.body)})`);
    lines.push(
      `\treq, _ := http.NewRequest(${quote(request.method.toUpperCase())}, ${quote(request.url)}, payload)`,
    );
  } else {
    lines.push(
      `\treq, _ := http.NewRequest(${quote(request.method.toUpperCase())}, ${quote(request.url)}, nil)`,
    );
  }
  for (const header of request.headers) {
    lines.push(`\treq.Header.Add(${quote(header.name)}, ${quote(header.value)})`);
  }
  lines.push(
    "",
    "\tres, err := http.DefaultClient.Do(req)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tdefer res.Body.Close()",
    "",
    "\tbody, _ := io.ReadAll(res.Body)",
    "\tfmt.Println(res.Status)",
    "\tfmt.Println(string(body))",
    "}",
  );
  return lines.join("\n");
}

function rustCode(request: WireRequest): string {
  const lines = [
    "use reqwest::Client;",
    "",
    "#[tokio::main]",
    "async fn main() -> Result<(), Box<dyn std::error::Error>> {",
    "    let client = Client::new();",
    `    let response = client`,
    `        .${request.method.toLowerCase()}(${quote(request.url)})`,
  ];
  for (const header of request.headers) {
    lines.push(`        .header(${quote(header.name)}, ${quote(header.value)})`);
  }
  if (hasBody(request)) lines.push(`        .body(${quote(request.body)})`);
  lines.push(
    "        .send()",
    "        .await?;",
    "",
    "    println!(\"{}\", response.status());",
    "    println!(\"{}\", response.text().await?);",
    "    Ok(())",
    "}",
  );
  return lines.join("\n");
}

function javaCode(request: WireRequest): string {
  const lines = [
    "import java.net.URI;",
    "import java.net.http.*;",
    "",
    "HttpClient client = HttpClient.newHttpClient();",
    "HttpRequest request = HttpRequest.newBuilder()",
    `    .uri(URI.create(${quote(request.url)}))`,
  ];
  for (const header of request.headers) {
    lines.push(`    .header(${quote(header.name)}, ${quote(header.value)})`);
  }
  lines.push(
    hasBody(request)
      ? `    .method(${quote(request.method.toUpperCase())}, HttpRequest.BodyPublishers.ofString(${quote(request.body)}))`
      : `    .method(${quote(request.method.toUpperCase())}, HttpRequest.BodyPublishers.noBody())`,
    "    .build();",
    "",
    "HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());",
    "System.out.println(response.statusCode());",
    "System.out.println(response.body());",
  );
  return lines.join("\n");
}

function csharpCode(request: WireRequest): string {
  const lines = [
    "using var client = new HttpClient();",
    `using var request = new HttpRequestMessage(new HttpMethod(${quote(request.method.toUpperCase())}), ${quote(request.url)});`,
  ];
  for (const header of request.headers) {
    lines.push(
      `request.Headers.TryAddWithoutValidation(${quote(header.name)}, ${quote(header.value)});`,
    );
  }
  if (hasBody(request)) {
    lines.push(`request.Content = new StringContent(${quote(request.body)});`);
  }
  lines.push(
    "",
    "var response = await client.SendAsync(request);",
    "Console.WriteLine((int)response.StatusCode);",
    "Console.WriteLine(await response.Content.ReadAsStringAsync());",
  );
  return lines.join("\n");
}

function phpCode(request: WireRequest): string {
  const headers = request.headers
    .map((header) => `    ${quote(`${header.name}: ${header.value}`)},`)
    .join("\n");
  const lines = [
    "<?php",
    "$curl = curl_init();",
    "",
    "curl_setopt_array($curl, [",
    `  CURLOPT_URL => ${quote(request.url)},`,
    "  CURLOPT_RETURNTRANSFER => true,",
    `  CURLOPT_CUSTOMREQUEST => ${quote(request.method.toUpperCase())},`,
    `  CURLOPT_HTTPHEADER => [\n${headers}\n  ],`,
  ];
  if (hasBody(request)) {
    lines.push(`  CURLOPT_POSTFIELDS => ${quote(request.body)},`);
  }
  lines.push(
    "]);",
    "",
    "$response = curl_exec($curl);",
    "curl_close($curl);",
    "echo $response;",
  );
  return lines.join("\n");
}

function rubyCode(request: WireRequest): string {
  const lines = [
    'require "uri"',
    'require "net/http"',
    "",
    `url = URI(${quote(request.url)})`,
    "http = Net::HTTP.new(url.host, url.port)",
    'http.use_ssl = url.scheme == "https"',
    "",
    `request = Net::HTTP::${request.method.charAt(0).toUpperCase()}${request.method.slice(1).toLowerCase()}.new(url)`,
  ];
  for (const header of request.headers) {
    lines.push(`request[${quote(header.name)}] = ${quote(header.value)}`);
  }
  if (hasBody(request)) lines.push(`request.body = ${quote(request.body)}`);
  lines.push("", "response = http.request(request)", "puts response.read_body");
  return lines.join("\n");
}

function swiftCode(request: WireRequest): string {
  const lines = [
    "import Foundation",
    "",
    `var request = URLRequest(url: URL(string: ${quote(request.url)})!)`,
    `request.httpMethod = ${quote(request.method.toUpperCase())}`,
  ];
  for (const header of request.headers) {
    lines.push(
      `request.addValue(${quote(header.value)}, forHTTPHeaderField: ${quote(header.name)})`,
    );
  }
  if (hasBody(request)) {
    lines.push(`request.httpBody = ${quote(request.body)}.data(using: .utf8)`);
  }
  lines.push(
    "",
    "let (data, response) = try await URLSession.shared.data(for: request)",
    "print((response as! HTTPURLResponse).statusCode)",
    "print(String(data: data, encoding: .utf8) ?? \"\")",
  );
  return lines.join("\n");
}

/**
 * A file body cannot be inlined into generated code, so it is called out.
 *
 * curl and HTTPie can point at the file themselves; every other target would
 * otherwise render an empty body, which is a quiet lie about what gets sent.
 */
function fileBodyNote(path: string, target: CodeTarget): string {
  if (target === "curl" || target === "httpie") return "";
  const comment = target === "python" || target === "ruby" ? "#" : "//";
  return `${comment} Body: the raw bytes of ${path} — read the file and send it as the body.\n\n`;
}

export function generateCode(request: CodeRequest, target: CodeTarget): string {
  const note = request.bodyFilePath
    ? fileBodyNote(request.bodyFilePath, target)
    : "";
  return note + generateBody(request, target);
}

function generateBody(request: CodeRequest, target: CodeTarget): string {
  switch (target) {
    case "curl":
      return curl(request);
    case "httpie":
      return httpie(request);
    case "fetch":
      return fetchCode(request);
    case "axios":
      return axiosCode(request);
    case "python":
      return pythonCode(request);
    case "go":
      return goCode(request);
    case "rust":
      return rustCode(request);
    case "java":
      return javaCode(request);
    case "csharp":
      return csharpCode(request);
    case "php":
      return phpCode(request);
    case "ruby":
      return rubyCode(request);
    case "swift":
      return swiftCode(request);
  }
}
