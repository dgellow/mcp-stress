/**
 * mcp-stress: Stress testing tool for MCP servers.
 */

import { discover } from "./discovery.ts";
import { diagnose } from "./diagnose.ts";
import { generateChart } from "./chart.ts";
import { SCENARIOS, SHAPES, type ScenarioConfig } from "./scenarios.ts";
import type { ClientOptions } from "./client.ts";

function usage(): void {
  console.log(`
mcp-stress - Stress testing tool for MCP servers

USAGE:
  mcp-stress discover [options] -- <command> [args...]
  mcp-stress diagnose [options] -- <command> [args...]
  mcp-stress diagnose --url <url>
  mcp-stress stress --scenario <name> [options] -- <command> [args...]
  mcp-stress chart <input.ndjson> [output.html]
  mcp-stress scenarios
  mcp-stress shapes

COMMANDS:
  discover          Connect and enumerate all server capabilities
  diagnose          Probe server step by step, report where things fail
  stress            Run a stress test scenario
  chart             Generate interactive HTML chart from NDJSON output
  scenarios         List available scenarios
  shapes            List available load shapes

STRESS OPTIONS:
  --scenario, -s    Scenario name (required)
  --duration, -d    Test duration in seconds (default: 10)
  --concurrency, -c Peak concurrent workers (default: 1)
  --timeout, -t     Request timeout in ms (default: 30000)
  --tool            Target a specific tool by name
  --shape           Load shape: constant, linear-ramp, exponential, step, spike, sawtooth
  --output, -o      Write per-request NDJSON events to file (for charting)
  --json            Output final results as JSON to stdout
  --verbose, -v     Log every request/response to stderr

DIAGNOSE OPTIONS:
  --url             HTTP/SSE URL to probe
  -H, --header      Extra header (Key: Value)

SERVER:
  Everything after -- is the server command and arguments.

EXAMPLES:
  mcp-stress discover -- node my-server.js
  mcp-stress stress -s tool-flood --tool search_docs -d 30 -c 10 -- node server.js
  mcp-stress stress -s tool-flood --shape linear-ramp -d 60 -c 20 -o results.ndjson -- node server.js
  mcp-stress stress -s find-ceiling -d 120 -c 50 --tool search_docs -- node server.js
  mcp-stress diagnose --url https://example.com/mcp/sse -H "Authorization: Bearer tok"
`);
}

interface ParsedArgs {
  command: string;
  opts: {
    scenario: string;
    durationSec: number;
    concurrency: number;
    timeoutMs: number;
    json: boolean;
    verbose: boolean;
    tool: string;
    url: string;
    shape: string;
    outputPath: string;
    seed: number | undefined;
    headers: Record<string, string>;
  };
  serverCommand: string;
  serverArgs: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const sepIdx = args.indexOf("--");
  const ourArgs = sepIdx >= 0 ? args.slice(0, sepIdx) : args;
  const serverParts = sepIdx >= 0 ? args.slice(sepIdx + 1) : [];

  const command = ourArgs[0] ?? "";
  let scenario = "";
  let durationSec = 10;
  let concurrency = 1;
  let timeoutMs = 30_000;
  let json = false;
  let verbose = false;
  let tool = "";
  let url = "";
  let shape = "";
  let outputPath = "";
  let seed: number | undefined;
  const headers: Record<string, string> = {};

  let i = 1;
  while (i < ourArgs.length) {
    const arg = ourArgs[i];
    switch (arg) {
      case "--scenario":
      case "-s":
        scenario = ourArgs[++i] ?? "";
        break;
      case "--duration":
      case "-d":
        durationSec = parseInt(ourArgs[++i] ?? "10");
        break;
      case "--concurrency":
      case "-c":
        concurrency = parseInt(ourArgs[++i] ?? "1");
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
      case "--header":
      case "-H": {
        const h = ourArgs[++i] ?? "";
        const colonIdx = h.indexOf(":");
        if (colonIdx > 0) {
          headers[h.slice(0, colonIdx).trim()] = h.slice(colonIdx + 1).trim();
        }
        break;
      }
      default:
        console.error(`Unknown option: ${arg}`);
        Deno.exit(1);
    }
    i++;
  }

  return {
    command,
    opts: { scenario, durationSec, concurrency, timeoutMs, json, verbose, tool, url, shape, outputPath, seed, headers },
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

  // chart command has its own arg parsing (no -- separator)
  if (raw[0] === "chart") {
    const rest = raw.slice(1);
    let openAfter = false;
    const positional: string[] = [];
    for (const a of rest) {
      if (a === "--open") openAfter = true;
      else positional.push(a);
    }
    const inputFile = positional[0];
    if (!inputFile) {
      console.error("Usage: mcp-stress chart [--open] <input.ndjson> [output.html]");
      Deno.exit(1);
    }
    const outputFile = positional[1] ?? inputFile.replace(/\.ndjson$/, "") + ".html";
    await generateChart(inputFile, outputFile);
    if (openAfter) {
      const cmd = Deno.build.os === "darwin" ? "open" : Deno.build.os === "windows" ? "start" : "xdg-open";
      new Deno.Command(cmd, { args: [outputFile] }).spawn();
    }
    return;
  }

  const parsed = parseArgs(raw);

  switch (parsed.command) {
    case "scenarios": {
      console.log("\nAvailable scenarios:\n");
      for (const [name, info] of Object.entries(SCENARIOS)) {
        console.log(`  ${name.padEnd(22)} ${info.description}`);
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

    case "diagnose": {
      const diagnoseUrl = parsed.opts.url;
      if (!parsed.serverCommand && !diagnoseUrl) {
        console.error("Error: specify -- <command> [args...] for stdio, or --url <url> for HTTP/SSE");
        Deno.exit(1);
      }
      await diagnose({
        command: parsed.serverCommand || undefined,
        args: parsed.serverArgs.length > 0 ? parsed.serverArgs : undefined,
        url: diagnoseUrl || undefined,
        timeoutMs: parsed.opts.timeoutMs,
        headers: Object.keys(parsed.opts.headers).length > 0 ? parsed.opts.headers : undefined,
      });
      break;
    }

    case "discover": {
      if (!parsed.serverCommand) {
        console.error("Error: no server command specified. Use -- <command> [args...]");
        Deno.exit(1);
      }
      await discover({
        command: parsed.serverCommand,
        args: parsed.serverArgs,
        requestTimeoutMs: parsed.opts.timeoutMs,
        verbose: parsed.opts.verbose,
      });
      break;
    }

    case "stress": {
      const { scenario, durationSec, concurrency, timeoutMs, json, verbose, tool, shape, outputPath, seed } = parsed.opts;

      if (!scenario) {
        console.error("Error: --scenario is required. Use 'mcp-stress scenarios' to list.");
        Deno.exit(1);
      }

      const scenarioInfo = SCENARIOS[scenario];
      if (!scenarioInfo) {
        console.error(`Error: unknown scenario '${scenario}'`);
        console.error(`Available: ${Object.keys(SCENARIOS).join(", ")}`);
        Deno.exit(1);
      }

      if (shape && !SHAPES[shape]) {
        console.error(`Error: unknown shape '${shape}'`);
        console.error(`Available: ${Object.keys(SHAPES).join(", ")}`);
        Deno.exit(1);
      }

      if (!parsed.serverCommand) {
        console.error("Error: no server command specified. Use -- <command> [args...]");
        Deno.exit(1);
      }

      const clientOpts: ClientOptions = {
        command: parsed.serverCommand,
        args: parsed.serverArgs,
        requestTimeoutMs: timeoutMs,
        verbose,
      };

      const config: ScenarioConfig = {
        durationSec,
        concurrency,
        clientOpts,
        tool: tool || undefined,
        shape: shape || undefined,
        outputPath: outputPath || undefined,
        seed,
      };

      if (!json) {
        console.log(`\nScenario: ${scenario}`);
        console.log(`  ${scenarioInfo.description}`);
        const parts = [`duration=${durationSec}s`, `concurrency=${concurrency}`, `timeout=${timeoutMs}ms`];
        if (shape) parts.push(`shape=${shape}`);
        if (tool) parts.push(`tool=${tool}`);
        if (outputPath) parts.push(`output=${outputPath}`);
        console.log(`  ${parts.join("  ")}`);
        console.log(`  server: ${parsed.serverCommand} ${parsed.serverArgs.join(" ")}`);
        console.log("");
      }

      const result = await scenarioInfo.run(config);

      if (json) {
        console.log(JSON.stringify(result.metrics.toJSON(), null, 2));
      } else {
        console.log(result.metrics.summary());
      }
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
