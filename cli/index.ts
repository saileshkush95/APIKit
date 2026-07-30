#!/usr/bin/env node
// APIKit's collection runner, for CI.
//
// The GUI runner could export JUnit XML but only ran inside the app, so the one
// place that output is useful could not produce it. This runs an exported
// workspace and exits non-zero when anything fails, which is all a pipeline
// needs.
//
// It shares `executeRequest` with the app and the monitors — the same build →
// pre-script → send → post-script → assertions path — so a run here means what
// a run there means. Only the transport differs (see transport.ts).
//
// Secrets are not in the file: exports redact credentials by design. They come
// from the environment instead, which is where CI keeps them anyway.

import { readFile, writeFile } from "node:fs/promises";
import { executeRequest } from "../src/shared/lib/execute";
import { hydrateTree, parseExport } from "../src/shared/lib/exportWorkspace";
import { junitXml, type RunSummary } from "../src/shared/lib/junit";
import { findNode, isFolder } from "../src/shared/lib/tree";
import { toVarMap } from "../src/shared/lib/vars";
import { defaultSettings, type SavedRequest, type TreeNode } from "../src/shared/types";
import { createTransport, type TransportWarning } from "./transport";

interface Options {
  file: string;
  folder: string | null;
  environment: string | null;
  iterations: number;
  bail: boolean;
  timeoutMs: number | null;
  delayMs: number;
  junitPath: string | null;
  vars: Record<string, string>;
  quiet: boolean;
}

const USAGE = `apikit-run — run an APIKit collection from the command line

  apikit-run <workspace.json> [options]

Options
  --folder <name>        Run only this folder (by name, at any depth)
  --env <name>           Use this environment's variables
  --var name=value       Set or override one variable; repeatable
  --env-var NAME         Take a variable from the process environment
  --iterations <n>       Run the selection n times (default 1)
  --delay <ms>           Wait between requests (default 0)
  --timeout <ms>         Per-request timeout, overriding the collection
  --bail                 Stop at the first failure
  --junit <path>         Write a JUnit XML report
  --quiet                Print only the summary
  -h, --help             Show this

Exit status is 0 only when every request completed and every assertion passed.

Credentials are stripped from exports on purpose, so pass them in:

  apikit-run api.json --env Staging --env-var API_TOKEN
  apikit-run api.json --var baseUrl=https://staging.example.com
`;

function parseArgs(argv: string[]): Options | null {
  const options: Options = {
    file: "",
    folder: null,
    environment: null,
    iterations: 1,
    bail: false,
    timeoutMs: null,
    delayMs: 0,
    junitPath: null,
    vars: {},
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        return null;
      case "--folder":
        options.folder = next();
        break;
      case "--env":
        options.environment = next();
        break;
      case "--var": {
        const pair = next();
        const eq = pair.indexOf("=");
        if (eq === -1) throw new Error(`--var needs name=value, got \`${pair}\``);
        options.vars[pair.slice(0, eq)] = pair.slice(eq + 1);
        break;
      }
      case "--env-var": {
        const name = next();
        const value = process.env[name];
        // A missing one is fatal rather than empty: silently sending no token is
        // how a green pipeline ends up testing nothing.
        if (value === undefined) {
          throw new Error(`--env-var ${name} is not set in the environment`);
        }
        options.vars[name] = value;
        break;
      }
      case "--iterations":
        options.iterations = Math.max(1, Number(next()) || 1);
        break;
      case "--delay":
        options.delayMs = Math.max(0, Number(next()) || 0);
        break;
      case "--timeout":
        options.timeoutMs = Math.max(1, Number(next()) || 30_000);
        break;
      case "--bail":
        options.bail = true;
        break;
      case "--junit":
        options.junitPath = next();
        break;
      case "--quiet":
        options.quiet = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option \`${arg}\``);
        if (options.file !== "") throw new Error("more than one workspace file given");
        options.file = arg;
    }
  }

  if (options.file === "") throw new Error("no workspace file given");
  return options;
}

/** Requests in depth-first order, each with the folder trail above it. */
function collect(
  nodes: TreeNode[],
  trail: string[] = [],
): { request: SavedRequest; path: string[] }[] {
  const found: { request: SavedRequest; path: string[] }[] = [];
  for (const node of nodes) {
    if (isFolder(node)) {
      found.push(...collect(node.children, [...trail, node.name]));
    } else {
      found.push({ request: node, path: trail });
    }
  }
  return found;
}

/** The first folder with this name, at any depth. */
function findFolder(nodes: TreeNode[], name: string): TreeNode | null {
  for (const node of nodes) {
    if (isFolder(node)) {
      if (node.name === name) return node;
      const inside = findFolder(node.children, name);
      if (inside) return inside;
    }
  }
  return null;
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Colour only when attached to a terminal, so logs stay readable. */
const colour = process.stdout.isTTY ? (c: string, s: string) => `${c}${s}${RESET}` : (_c: string, s: string) => s;

async function main(): Promise<number> {
  let options: Options | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options === null) {
    process.stdout.write(USAGE);
    return 0;
  }

  let document;
  try {
    document = parseExport(await readFile(options.file, "utf8"));
  } catch (error) {
    process.stderr.write(`cannot read ${options.file}: ${(error as Error).message}\n`);
    return 2;
  }

  const tree = hydrateTree(document.tree);

  let selection = tree;
  let target = document.workspace || "collection";
  if (options.folder) {
    const folder = findFolder(tree, options.folder);
    if (!folder || !isFolder(folder)) {
      process.stderr.write(`no folder named \`${options.folder}\` in this workspace\n`);
      return 2;
    }
    selection = folder.children;
    target = folder.name;
  }

  const entries = collect(selection);
  if (entries.length === 0) {
    process.stderr.write("nothing to run: that selection holds no requests\n");
    return 2;
  }

  // Environment variables first, then --var and --env-var on top, so a CI
  // override always wins over what the file happened to carry.
  const environment = options.environment
    ? document.environments.find((env) => env.name === options.environment)
    : undefined;
  if (options.environment && !environment) {
    process.stderr.write(`no environment named \`${options.environment}\`\n`);
    return 2;
  }
  const vars = { ...toVarMap(environment?.variables ?? []), ...options.vars };

  const settings = {
    ...defaultSettings(),
    ...(options.timeoutMs ? { defaultTimeoutMs: options.timeoutMs } : {}),
  };

  const warnings: TransportWarning[] = [];
  const send = createTransport(warnings);

  const rows: RunSummary["rows"] = [];
  const startedAt = Date.now();
  const startedMs = performance.now();
  let failed = 0;
  let errored = 0;
  let stopped = false;

  for (let iteration = 1; iteration <= options.iterations && !stopped; iteration++) {
    for (const { request, path } of entries) {
      const result = await executeRequest(request, {
        vars,
        settings,
        tree,
        send,
        // The keychain is not reachable outside the app, so a token has to come
        // from the environment as a variable.
        resolveToken: async () => "",
        // Scripts writing variables must carry into the next request, which is
        // what makes a login-then-use chain work.
        onVariables: (updates) => Object.assign(vars, updates),
      });

      const assertions = result.results.map((entry) => ({
        passed: entry.passed,
        message: entry.message,
      }));
      const badAssertions = assertions.filter((entry) => !entry.passed);

      if (result.error) errored += 1;
      else if (badAssertions.length > 0) failed += 1;

      rows.push({
        name: request.name,
        path,
        method: request.method,
        iteration,
        status: result.status,
        timeMs: result.timeMs,
        error: result.error,
        assertions,
      });

      if (!options.quiet) {
        const label = [...path, request.name].join(" / ");
        const suffix = options.iterations > 1 ? colour(DIM, ` #${iteration}`) : "";
        if (result.error) {
          process.stdout.write(
            `${colour(RED, "ERROR")} ${label}${suffix} — ${result.error}\n`,
          );
        } else if (badAssertions.length > 0) {
          process.stdout.write(
            `${colour(RED, "FAIL ")} ${label}${suffix} ${colour(DIM, `${result.status} · ${result.timeMs}ms`)}\n`,
          );
          for (const entry of badAssertions) {
            process.stdout.write(`        ${colour(RED, "×")} ${entry.message}\n`);
          }
        } else {
          const count =
            assertions.length > 0 ? colour(DIM, ` · ${assertions.length} passed`) : "";
          process.stdout.write(
            `${colour(GREEN, "ok   ")} ${label}${suffix} ${colour(DIM, `${result.status} · ${result.timeMs}ms`)}${count}\n`,
          );
        }
      }

      if (options.bail && (result.error || badAssertions.length > 0)) {
        stopped = true;
        break;
      }
      if (options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }

  const summary: RunSummary = {
    atMs: startedAt,
    target,
    environment: environment?.name ?? "none",
    iterations: options.iterations,
    total: rows.length,
    passed: rows.length - failed - errored,
    failed,
    errored,
    timeMs: Math.round(performance.now() - startedMs),
    rows,
  };

  process.stdout.write(
    `\n${summary.total} run · ${summary.passed} passed · ${summary.failed} failed · ${summary.errored} errored · ${(summary.timeMs / 1000).toFixed(2)}s\n`,
  );
  if (stopped) {
    process.stdout.write(colour(DIM, "stopped at the first failure (--bail)\n"));
  }

  for (const warning of warnings) {
    process.stderr.write(`${colour(DIM, "note:")} ${warning.message}\n`);
  }

  if (options.junitPath) {
    await writeFile(options.junitPath, junitXml(summary), "utf8");
    if (!options.quiet) {
      process.stdout.write(`${colour(DIM, `wrote ${options.junitPath}`)}\n`);
    }
  }

  return failed + errored > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exit(2);
  });
