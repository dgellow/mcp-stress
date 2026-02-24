/**
 * `run` command — orchestrates the test execution engine.
 */

import {
  buildTransportOptions,
  createTransport,
} from "../transport/factory.ts";
import type { Transport, TransportOptions } from "../transport/types.ts";
import { executeRun } from "../engine/runner.ts";
import { resolveProfile } from "../engine/workload.ts";
import type { WorkloadProfile } from "../engine/workload.ts";
import {
  evaluateAssertions,
  metricsToAssertionMap,
  parseAssertions,
} from "../engine/assertions.ts";
import {
  createDashboardServer,
  type DashboardServer,
} from "../dashboard/server.ts";
import {
  ensureRunSubdir,
  runExists,
  runPath,
  runSubdirPath,
  validateRunName,
} from "../history.ts";
import type { MetaEvent, SummaryEvent } from "../metrics/events.ts";
import {
  aggregateToSummary,
  computeAggregate,
  printAggregateSummary,
} from "../metrics/aggregate.ts";

export interface RunCommandOptions {
  runsDir: string;
  profile?: string;
  durationSec: number;
  requests?: number;
  concurrency: number;
  timeoutMs: number;
  tool?: string;
  shape?: string;
  outputPath?: string;
  seed?: number;
  json: boolean;
  verbose: boolean;
  asserts: string[];
  url?: string;
  sse?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  live: boolean;
  name?: string;
  repeat?: number;
}

export async function runCommand(opts: RunCommandOptions): Promise<number> {
  // Validate and resolve --name
  let historyPath: string | undefined;
  if (opts.name) {
    const nameError = validateRunName(opts.name);
    if (nameError) {
      console.error(`Error: invalid run name: ${nameError}`);
      return 1;
    }
    if (await runExists(opts.runsDir, opts.name)) {
      console.error(
        `Error: a run named "${opts.name}" already exists. Use 'mcp-stress history rm ${opts.name}' first.`,
      );
      return 1;
    }
    historyPath = runPath(opts.runsDir, opts.name);
  }

  const repeatCount = opts.repeat && opts.repeat > 1 ? opts.repeat : 1;

  const profile = resolveProfile(opts.profile, {
    durationSec: opts.durationSec,
    requests: opts.requests,
    concurrency: opts.concurrency,
    shape: opts.shape,
    tool: opts.tool,
  });

  const transportOpts = buildTransportOptions({
    command: opts.command,
    args: opts.args,
    env: opts.env,
    url: opts.url,
    sse: opts.sse,
    headers: opts.headers,
    timeoutMs: opts.timeoutMs,
    verbose: opts.verbose,
  });

  const makeTransport = () => createTransport(transportOpts);

  if (!opts.json) {
    console.log(`\n${profile.name}`);
    const parts: string[] = [];
    if (profile.requests) {
      parts.push(`requests=${profile.requests}`);
    } else {
      parts.push(`duration=${profile.durationSec}s`);
    }
    parts.push(
      `concurrency=${profile.concurrency}`,
      `timeout=${opts.timeoutMs}ms`,
    );
    if (profile.shape !== "constant") parts.push(`shape=${profile.shape}`);
    if (profile.tool) parts.push(`tool=${profile.tool}`);
    if (opts.outputPath) parts.push(`output=${opts.outputPath}`);
    if (repeatCount > 1) parts.push(`repeat=${repeatCount}`);
    const target = transportOpts.type === "stdio"
      ? `${transportOpts.command} ${transportOpts.args.join(" ")}`
      : transportOpts.url;
    console.log(`  ${parts.join("  ")}`);
    console.log(`  target: ${target}`);
    console.log("");
  }

  if (repeatCount > 1) {
    return await runRepeated(opts, profile, transportOpts, makeTransport, {
      historyPath,
      repeatCount,
    });
  }

  return await runSingle(opts, profile, transportOpts, makeTransport, {
    historyPath,
  });
}

async function runSingle(
  opts: RunCommandOptions,
  profile: WorkloadProfile,
  transportOpts: TransportOptions,
  makeTransport: () => Transport,
  ctx: { historyPath?: string },
): Promise<number> {
  const effectiveOutputPath = ctx.historyPath ?? opts.outputPath;

  // Start live dashboard if requested
  let dashboard: DashboardServer | null = null;
  if (opts.live) {
    dashboard = createDashboardServer();
    const url = await dashboard.start();
    console.error(`  Dashboard: ${url}`);
    openBrowser(url);
  }

  const result = await executeRun({
    profile,
    createTransport: makeTransport,
    transportOpts,
    name: opts.name,
    seed: opts.seed,
    outputPath: effectiveOutputPath,
    onEvent: dashboard ? (event) => dashboard!.pushEvent(event) : undefined,
    onMeta: dashboard ? (meta) => dashboard!.pushMeta(meta) : undefined,
    onMessage: dashboard ? (msg) => dashboard!.pushMessage(msg) : undefined,
  });

  // Copy to -o path if both --name and -o were given
  if (ctx.historyPath && opts.outputPath) {
    await Deno.copyFile(ctx.historyPath, opts.outputPath);
  }

  const summary = result.summary;

  // Complete and shut down the dashboard
  if (dashboard) {
    dashboard.complete(summary);
    await dashboard.stop();
  }

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummary(summary);
  }

  return evaluateRunAssertions(opts, summary);
}

async function runRepeated(
  opts: RunCommandOptions,
  profile: WorkloadProfile,
  transportOpts: TransportOptions,
  makeTransport: () => Transport,
  ctx: { historyPath?: string; repeatCount: number },
): Promise<number> {
  // Prepare subdir for individual runs if named
  let subdir: string | undefined;
  if (opts.name) {
    subdir = await ensureRunSubdir(opts.runsDir, opts.name);
  }

  // Start live dashboard if requested
  let dashboard: DashboardServer | null = null;
  if (opts.live) {
    dashboard = createDashboardServer();
    const url = await dashboard.start();
    console.error(`  Dashboard: ${url}`);
    openBrowser(url);
  }

  const summaries: SummaryEvent[] = [];
  let firstMeta: MetaEvent | undefined;

  for (let i = 1; i <= ctx.repeatCount; i++) {
    if (!opts.json) {
      console.log(`  Run ${i}/${ctx.repeatCount}...`);
    }

    if (dashboard) {
      dashboard.startRun(i, ctx.repeatCount);
    }

    // Each individual run writes to its own path
    const individualPath = subdir
      ? runSubdirPath(opts.runsDir, opts.name!, i)
      : undefined;

    const result = await executeRun({
      profile,
      createTransport: makeTransport,
      transportOpts,
      name: opts.name,
      seed: opts.seed,
      outputPath: individualPath,
      onEvent: dashboard ? (event) => dashboard!.pushEvent(event) : undefined,
      onMeta: dashboard ? (meta) => dashboard!.pushMeta(meta) : undefined,
      onMessage: dashboard ? (msg) => dashboard!.pushMessage(msg) : undefined,
    });

    summaries.push(result.summary);

    // Use the real meta from the first run as the base for the aggregate
    if (i === 1) {
      firstMeta = {
        ...result.meta,
        aggregate: true,
        runCount: ctx.repeatCount,
      };
    }

    if (dashboard) {
      dashboard.completeRun(i, result.summary);
    }

    if (!opts.json) {
      const s = result.summary;
      console.log(
        `    ${s.totalRequests} requests, ${
          s.requestsPerSecond.toFixed(1)
        } req/s, p50=${s.overall.p50.toFixed(1)}ms, p99=${
          s.overall.p99.toFixed(1)
        }ms`,
      );
    }
  }

  // Compute aggregate
  const agg = computeAggregate(summaries);
  const aggSummary = aggregateToSummary(agg);

  // Write aggregate NDJSON
  const ndjsonContent = [
    JSON.stringify(firstMeta),
    JSON.stringify(aggSummary),
  ].join("\n") + "\n";

  if (ctx.historyPath) {
    await Deno.writeTextFile(ctx.historyPath, ndjsonContent);
  }
  if (opts.outputPath) {
    await Deno.writeTextFile(opts.outputPath, ndjsonContent);
  }

  // Complete and shut down the dashboard
  if (dashboard) {
    dashboard.allComplete(aggSummary);
    await dashboard.stop();
  }

  if (opts.json) {
    console.log(
      JSON.stringify({ aggregate: agg, summary: aggSummary }, null, 2),
    );
  } else {
    printAggregateSummary(agg);
  }

  return evaluateRunAssertions(opts, aggSummary);
}

function evaluateRunAssertions(
  opts: RunCommandOptions,
  summary: SummaryEvent,
): number {
  if (opts.asserts.length === 0) return 0;

  const assertions = parseAssertions(opts.asserts);
  const statsMap = metricsToAssertionMap({
    requestsPerSecond: summary.requestsPerSecond,
    overall: summary.overall,
    totalErrors: summary.totalErrors,
    totalRequests: summary.totalRequests,
  });
  const results = evaluateAssertions(assertions, statsMap);
  const failures = results.filter((r) => !r.passed);

  if (!opts.json) {
    console.log("\n  Assertions:");
    for (const r of results) {
      const icon = r.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
      console.log(
        `    [${icon}] ${r.assertion.raw}  (actual: ${
          isNaN(r.actual) ? "N/A" : r.actual.toFixed(1)
        })`,
      );
    }
  }

  if (failures.length > 0) {
    if (!opts.json) {
      console.error(`\n  ${failures.length} assertion(s) failed.`);
    }
    return 1;
  }

  return 0;
}

function openBrowser(url: string): void {
  const cmd = Deno.build.os === "darwin"
    ? "open"
    : Deno.build.os === "windows"
    ? "start"
    : "xdg-open";
  try {
    new Deno.Command(cmd, { args: [url], stdout: "null", stderr: "null" })
      .spawn();
  } catch (e) {
    console.error(
      `  Could not open browser: ${e instanceof Error ? e.message : e}`,
    );
    console.error(`  Open manually: ${url}`);
  }
}

function printSummary(s: SummaryEvent): void {
  const lines: string[] = [];
  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("  RESULTS");
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("");
  lines.push(`  Duration:     ${(s.durationMs / 1000).toFixed(2)}s`);
  lines.push(
    `  Requests:     ${s.totalRequests}  (${
      s.requestsPerSecond.toFixed(1)
    } req/s)`,
  );
  lines.push(
    `  Errors:       ${s.totalErrors}  (${
      s.totalRequests > 0
        ? ((s.totalErrors / s.totalRequests) * 100).toFixed(1)
        : 0
    }%)`,
  );

  const cats = Object.entries(s.errorsByCategory);
  if (cats.length > 0) {
    lines.push(
      `                ${cats.map(([k, v]) => `${k}=${v}`).join("  ")}`,
    );
  }
  lines.push("");

  if (s.totalRequests > 0) {
    const o = s.overall;
    lines.push("  Latency (ms):");
    lines.push(
      `    min=${o.min.toFixed(1)}  mean=${o.mean.toFixed(1)}  max=${
        o.max.toFixed(1)
      }`,
    );
    lines.push(
      `    p50=${o.p50.toFixed(1)}  p95=${o.p95.toFixed(1)}  p99=${
        o.p99.toFixed(1)
      }`,
    );
  }

  if (s.byMethod.length > 1) {
    lines.push("");
    lines.push("  By method:");
    for (const m of s.byMethod) {
      lines.push(
        `    ${m.method}: n=${m.count} err=${m.errors} p50=${
          m.p50.toFixed(1)
        } p95=${m.p95.toFixed(1)} p99=${m.p99.toFixed(1)}`,
      );
    }
  }

  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════");
  console.log(lines.join("\n"));
}
