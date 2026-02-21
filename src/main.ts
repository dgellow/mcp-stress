/**
 * mcp-stress — stress testing tool for MCP servers.
 */

import { runCommand } from "./commands/run.ts";
import { chartCommand } from "./commands/chart.ts";
import { compareCommand } from "./commands/compare.ts";
import { diagnoseCommand } from "./commands/diagnose.ts";
import { discoverCommand } from "./commands/discover.ts";
import { SHAPES } from "./engine/shapes.ts";
import { BUILTIN_PROFILES } from "./engine/workload.ts";

function usage(): void {
  console.log(`
mcp-stress - Stress testing tool for MCP servers

USAGE:
  mcp-stress run [options] -- <command> [args...]
  mcp-stress run [options] --url <url>
  mcp-stress compare <baseline.ndjson> <current.ndjson> [options]
  mcp-stress chart <input.ndjson> [output.html] [options]
  mcp-stress diagnose [--url <url> | -- <command>]
  mcp-stress discover [--url <url> | -- <command>]
  mcp-stress profiles
  mcp-stress shapes

COMMANDS:
  run               Execute a stress test
  compare           Compare two test runs, detect regressions
  chart             Generate interactive HTML chart from NDJSON
  diagnose          Probe server connectivity and protocol compliance
  discover          Enumerate server capabilities
  profiles          List built-in workload profiles
  shapes            List available load shapes

RUN OPTIONS:
  -p, --profile     Workload profile (default: tool-flood)
  -d, --duration    Test duration in seconds (default: 10)
  -n, --requests    Stop after N requests (overrides duration)
  -c, --concurrency Peak concurrent workers (default: 1)
  -t, --timeout     Request timeout in ms (default: 30000)
  --tool            Target a specific tool by name
  --shape           Load shape: constant, linear-ramp, exponential, step, spike, sawtooth
  -o, --output      NDJSON output file path
  --live            Open real-time browser dashboard
  --json            Output JSON summary to stdout
  --assert          Threshold check, repeatable (e.g. "p99 < 500ms")
  --seed            PRNG seed for reproducibility
  --sse             Use legacy HTTP+SSE transport (default: streamable-http)
  -H, --header      Extra HTTP header (Key: Value), repeatable
  -v, --verbose     Log every request/response to stderr

COMPARE OPTIONS:
  --open            Open HTML in browser
  --json            Output JSON diff to stdout
  --assert          Delta assertion (e.g. "p99_delta < 10%")

CHART OPTIONS:
  --open            Open in browser after generation

EXAMPLES:
  mcp-stress run -p tool-flood -d 30 -c 10 --tool search_docs -- node server.js
  mcp-stress run -p find-ceiling -d 120 -c 50 -o results.ndjson -- node server.js
  mcp-stress run -p ping-flood --shape linear-ramp -d 60 -c 20 -- node server.js
  mcp-stress run --json --assert "p99 < 500ms" --assert "error_rate < 1%" -- node server.js
  mcp-stress run --url http://localhost:3000/mcp -d 30 -c 5
  mcp-stress run --url http://localhost:3000/sse --sse -d 30
  mcp-stress chart --open results.ndjson
  mcp-stress compare baseline.ndjson current.ndjson --open
`);
}

interface ParsedArgs {
  command: string;
  opts: {
    profile: string;
    durationSec: number;
    concurrency: number;
    timeoutMs: number;
    json: boolean;
    verbose: boolean;
    tool: string;
    url: string;
    sse: boolean;
    shape: string;
    outputPath: string;
    requests: number | undefined;
    seed: number | undefined;
    live: boolean;
    asserts: string[];
    open: boolean;
    headers: Record<string, string>;
  };
  serverCommand: string;
  serverArgs: string[];
  positionalArgs: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const sepIdx = args.indexOf("--");
  const ourArgs = sepIdx >= 0 ? args.slice(0, sepIdx) : args;
  const serverParts = sepIdx >= 0 ? args.slice(sepIdx + 1) : [];

  const command = ourArgs[0] ?? "";
  let profile = "";
  let durationSec = 10;
  let concurrency = 1;
  let timeoutMs = 30_000;
  let json = false;
  let verbose = false;
  let tool = "";
  let url = "";
  let sse = false;
  let shape = "";
  let outputPath = "";
  let requests: number | undefined;
  let seed: number | undefined;
  let live = false;
  let open = false;
  const asserts: string[] = [];
  const headers: Record<string, string> = {};
  const positionalArgs: string[] = [];

  let i = 1;
  while (i < ourArgs.length) {
    const arg = ourArgs[i];
    switch (arg) {
      case "--profile":
      case "-p":
        profile = ourArgs[++i] ?? "";
        break;
      case "--duration":
      case "-d":
        durationSec = parseInt(ourArgs[++i] ?? "10");
        break;
      case "--concurrency":
      case "-c":
        concurrency = parseInt(ourArgs[++i] ?? "1");
        break;
      case "--requests":
      case "-n":
        requests = parseInt(ourArgs[++i] ?? "0") || undefined;
        break;
      case "--timeout":
      case "-t":
        timeoutMs = parseInt(ourArgs[++i] ?? "30000");
        break;
      case "--json":
        json = true;
        break;
      case "--verbose":
      case "-v":
        verbose = true;
        break;
      case "--tool":
        tool = ourArgs[++i] ?? "";
        break;
      case "--url":
        url = ourArgs[++i] ?? "";
        break;
      case "--sse":
        sse = true;
        break;
      case "--shape":
        shape = ourArgs[++i] ?? "";
        break;
      case "--output":
      case "-o":
        outputPath = ourArgs[++i] ?? "";
        break;
      case "--seed":
        seed = parseInt(ourArgs[++i] ?? "0");
        break;
      case "--live":
        live = true;
        break;
      case "--open":
        open = true;
        break;
      case "--assert":
        asserts.push(ourArgs[++i] ?? "");
        break;
      case "--header":
      case "-H": {
        const h = ourArgs[++i] ?? "";
        const colonIdx = h.indexOf(":");
        if (colonIdx > 0) {
          headers[h.slice(0, colonIdx).trim()] = h.slice(colonIdx + 1).trim();
        }
        break;
      }
      default: {
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          Deno.exit(1);
        }
        positionalArgs.push(arg);
      }
    }
    i++;
  }

  return {
    command,
    positionalArgs,
    opts: {
      profile,
      durationSec,
      concurrency,
      timeoutMs,
      json,
      verbose,
      tool,
      url,
      sse,
      shape,
      outputPath,
      requests,
      seed,
      live,
      asserts,
      open,
      headers,
    },
    serverCommand: serverParts[0] ?? "",
    serverArgs: serverParts.slice(1),
  };
}

async function main(): Promise<void> {
  const raw = Deno.args;

  if (raw.length === 0 || raw[0] === "--help" || raw[0] === "-h") {
    usage();
    Deno.exit(0);
  }

  const parsed = parseArgs(raw);

  switch (parsed.command) {
    case "profiles": {
      console.log("\nBuilt-in workload profiles:\n");
      for (const [name, info] of Object.entries(BUILTIN_PROFILES)) {
        console.log(`  ${name.padEnd(22)} ${info.name}`);
      }
      console.log("");
      break;
    }

    case "shapes": {
      console.log("\nAvailable load shapes:\n");
      for (const [name, info] of Object.entries(SHAPES)) {
        console.log(`  ${name.padEnd(16)} ${info.description}`);
      }
      console.log("");
      break;
    }

    case "run": {
      if (!parsed.serverCommand && !parsed.opts.url) {
        console.error(
          "Error: specify -- <command> [args...] for stdio, or --url <url> for HTTP",
        );
        Deno.exit(1);
      }

      const exitCode = await runCommand({
        profile: parsed.opts.profile || undefined,
        durationSec: parsed.opts.requests ? 3600 : parsed.opts.durationSec,
        requests: parsed.opts.requests,
        concurrency: parsed.opts.concurrency,
        timeoutMs: parsed.opts.timeoutMs,
        tool: parsed.opts.tool || undefined,
        shape: parsed.opts.shape || undefined,
        outputPath: parsed.opts.outputPath || undefined,
        seed: parsed.opts.seed,
        json: parsed.opts.json,
        verbose: parsed.opts.verbose,
        asserts: parsed.opts.asserts,
        url: parsed.opts.url || undefined,
        sse: parsed.opts.sse || undefined,
        command: parsed.serverCommand || undefined,
        args: parsed.serverArgs.length > 0 ? parsed.serverArgs : undefined,
        headers: Object.keys(parsed.opts.headers).length > 0
          ? parsed.opts.headers
          : undefined,
        live: parsed.opts.live,
      });

      Deno.exit(exitCode);
      break;
    }

    case "chart": {
      const inputPath = parsed.positionalArgs[0];
      if (!inputPath) {
        console.error("Error: chart requires an input NDJSON file path");
        Deno.exit(1);
      }
      const outputPath = parsed.positionalArgs[1] || parsed.opts.outputPath ||
        undefined;
      const exitCode = await chartCommand({
        inputPath,
        outputPath,
        open: parsed.opts.open,
      });
      Deno.exit(exitCode);
      break;
    }

    case "compare": {
      const baselinePath = parsed.positionalArgs[0];
      const currentPath = parsed.positionalArgs[1];
      if (!baselinePath || !currentPath) {
        console.error("Error: compare requires two NDJSON file paths");
        Deno.exit(1);
      }
      const exitCode = await compareCommand({
        baselinePath,
        currentPath,
        open: parsed.opts.open,
        json: parsed.opts.json,
        asserts: parsed.opts.asserts,
      });
      Deno.exit(exitCode);
      break;
    }

    case "diagnose": {
      if (!parsed.serverCommand && !parsed.opts.url) {
        console.error(
          "Error: specify -- <command> [args...] for stdio, or --url <url> for HTTP",
        );
        Deno.exit(1);
      }
      const exitCode = await diagnoseCommand({
        command: parsed.serverCommand || undefined,
        args: parsed.serverArgs.length > 0 ? parsed.serverArgs : undefined,
        url: parsed.opts.url || undefined,
        sse: parsed.opts.sse || undefined,
        timeoutMs: parsed.opts.timeoutMs,
        headers: Object.keys(parsed.opts.headers).length > 0
          ? parsed.opts.headers
          : undefined,
        verbose: parsed.opts.verbose,
      });
      Deno.exit(exitCode);
      break;
    }

    case "discover": {
      if (!parsed.serverCommand && !parsed.opts.url) {
        console.error(
          "Error: specify -- <command> [args...] for stdio, or --url <url> for HTTP",
        );
        Deno.exit(1);
      }
      const exitCode = await discoverCommand({
        command: parsed.serverCommand || undefined,
        args: parsed.serverArgs.length > 0 ? parsed.serverArgs : undefined,
        url: parsed.opts.url || undefined,
        sse: parsed.opts.sse || undefined,
        timeoutMs: parsed.opts.timeoutMs,
        headers: Object.keys(parsed.opts.headers).length > 0
          ? parsed.opts.headers
          : undefined,
        verbose: parsed.opts.verbose,
      });
      Deno.exit(exitCode);
      break;
    }

    default:
      console.error(`Unknown command: ${parsed.command}`);
      usage();
      Deno.exit(1);
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message ?? e}`);
  Deno.exit(1);
});
