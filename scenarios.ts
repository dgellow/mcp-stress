/**
 * Stress test scenarios.
 */

import { McpClientError, StdioMcpClient, type ClientOptions } from "./client.ts";
import { MetricsCollector, type RunMeta } from "./metrics.ts";
import { generateRandomArgsFromSchema, setSeed } from "./schema.ts";

// ─── Config ──────────────────────────────────────────────────────

export interface ScenarioConfig {
  durationSec: number;
  concurrency: number;
  clientOpts: ClientOptions;
  tool?: string;
  shape?: string;
  outputPath?: string;
  seed?: number;
}

export interface ScenarioResult {
  name: string;
  metrics: MetricsCollector;
}

type ScenarioFn = (config: ScenarioConfig) => Promise<ScenarioResult>;

export const SCENARIOS: Record<string, { description: string; run: ScenarioFn }> = {
  "rapid-ping": {
    description: "Send ping requests as fast as possible on a single connection",
    run: rapidPing,
  },
  "concurrent-pings": {
    description: "Send N concurrent ping requests on a single connection",
    run: concurrentPings,
  },
  "connection-churn": {
    description: "Repeatedly connect, initialize, ping, disconnect",
    run: connectionChurn,
  },
  "tool-flood": {
    description: "Discover tools and call each one rapidly (supports --shape)",
    run: toolFlood,
  },
  "mixed-workload": {
    description: "Realistic mix of list, read, and call operations",
    run: mixedWorkload,
  },
  "find-ceiling": {
    description: "Auto-detect throughput plateau by stepping up concurrency",
    run: findCeiling,
  },
};

// ─── Load Shapes ────────────────────────────────────────────────

/** Returns target concurrency at time t. */
type ShapeFn = (t: number, duration: number, peak: number) => number;

export const SHAPES: Record<string, { description: string; fn: ShapeFn }> = {
  constant: {
    description: "Fixed concurrency for entire duration",
    fn: (_t, _dur, peak) => peak,
  },
  "linear-ramp": {
    description: "Linearly ramp from 1 to peak concurrency",
    fn: (t, dur, peak) => Math.max(1, Math.ceil((t / dur) * peak)),
  },
  exponential: {
    description: "Exponential growth from 1 to peak",
    fn: (t, dur, peak) => {
      const ratio = (Math.exp(3 * t / dur) - 1) / (Math.exp(3) - 1);
      return Math.max(1, Math.ceil(ratio * peak));
    },
  },
  step: {
    description: "Step up in 5 discrete jumps",
    fn: (t, dur, peak) => {
      const steps = 5;
      const step = Math.min(Math.floor(t / (dur / steps)), steps - 1);
      return Math.max(1, Math.ceil(((step + 1) / steps) * peak));
    },
  },
  spike: {
    description: "Low baseline with a spike in the middle",
    fn: (t, dur, peak) => {
      const mid = dur / 2;
      const spikeWidth = dur * 0.2;
      if (t >= mid - spikeWidth / 2 && t <= mid + spikeWidth / 2) return peak;
      return Math.max(1, Math.ceil(peak * 0.1));
    },
  },
  sawtooth: {
    description: "Repeating ramp-up/drop cycles",
    fn: (t, dur, peak) => {
      const cycleLen = dur / 4;
      const pos = (t % cycleLen) / cycleLen;
      return Math.max(1, Math.ceil(pos * peak));
    },
  },
};

// ─── Helpers ────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`  [${ts}] ${msg}`);
}

async function recordRequest(
  metrics: MetricsCollector,
  method: string,
  fn: () => Promise<{ latencyMs: number }>,
): Promise<void> {
  try {
    const { latencyMs } = await fn();
    metrics.recordSuccess(method, latencyMs);
  } catch (e) {
    if (e instanceof McpClientError) {
      metrics.recordError(method, e.latencyMs, e.code, e.message);
    } else if (e instanceof Error) {
      metrics.recordError(method, 0, -1, e.message);
    }
  }
}

async function makeClient(opts: ClientOptions): Promise<StdioMcpClient> {
  const client = new StdioMcpClient(opts);
  await client.connect();
  return client;
}

function deadlineReached(startTime: number, durationSec: number): boolean {
  return (performance.now() - startTime) >= durationSec * 1000;
}

async function initMetrics(config: ScenarioConfig, scenarioName: string): Promise<MetricsCollector> {
  const seed = setSeed(config.seed);
  const metrics = new MetricsCollector();
  metrics.runMeta = {
    scenario: scenarioName,
    shape: config.shape,
    concurrency: config.concurrency,
    durationSec: config.durationSec,
    tool: config.tool,
    serverCommand: config.clientOpts.command,
    serverArgs: config.clientOpts.args,
    seed,
    startedAt: new Date().toISOString(),
    timeoutMs: config.clientOpts.requestTimeoutMs ?? 30_000,
  };
  if (config.outputPath) {
    await metrics.enableOutput(config.outputPath);
  }
  return metrics;
}

// ─── Shaped worker runner ───────────────────────────────────────
// Runs workers with concurrency controlled by a shape function.

async function runShaped(
  config: ScenarioConfig,
  metrics: MetricsCollector,
  makeWork: () => Promise<void>,
): Promise<void> {
  const shapeName = config.shape ?? "constant";
  const shapeInfo = SHAPES[shapeName];
  if (!shapeInfo) {
    throw new Error(`Unknown shape: ${shapeName}. Available: ${Object.keys(SHAPES).join(", ")}`);
  }

  const shape = shapeInfo.fn;
  const duration = config.durationSec;
  const peak = config.concurrency;

  metrics.start();
  metrics.startLive();
  const start = performance.now();

  // Run in 1-second ticks, adjusting concurrency each tick
  while (!deadlineReached(start, duration)) {
    const t = (performance.now() - start) / 1000;
    const targetConcurrency = shape(t, duration, peak);
    metrics.concurrency = targetConcurrency;

    // Fire targetConcurrency requests, wait for all before next tick
    const batch = Array.from({ length: targetConcurrency }, () => makeWork());
    await Promise.all(batch);
  }

  metrics.stop();
}

// ─── Scenarios ──────────────────────────────────────────────────

async function rapidPing(config: ScenarioConfig): Promise<ScenarioResult> {
  const metrics = await initMetrics(config, "rapid-ping");
  const client = await makeClient(config.clientOpts);

  log(`rapid-ping: ${config.durationSec}s, single connection`);
  metrics.start();
  metrics.startLive();
  const start = performance.now();

  while (!deadlineReached(start, config.durationSec)) {
    await recordRequest(metrics, "ping", () => client.ping());
  }

  metrics.stop();
  await client.close();
  return { name: "rapid-ping", metrics };
}

async function concurrentPings(config: ScenarioConfig): Promise<ScenarioResult> {
  const metrics = await initMetrics(config, "concurrent-pings");
  const client = await makeClient(config.clientOpts);

  log(`concurrent-pings: ${config.durationSec}s, ${config.concurrency} concurrent`);
  metrics.start();
  metrics.startLive();
  const start = performance.now();

  while (!deadlineReached(start, config.durationSec)) {
    const batch = Array.from({ length: config.concurrency }, () =>
      recordRequest(metrics, "ping", () => client.ping()),
    );
    await Promise.all(batch);
  }

  metrics.stop();
  await client.close();
  return { name: "concurrent-pings", metrics };
}

async function connectionChurn(config: ScenarioConfig): Promise<ScenarioResult> {
  const metrics = await initMetrics(config, "connection-churn");

  log(`connection-churn: ${config.durationSec}s, ${config.concurrency} parallel churners`);
  metrics.start();
  metrics.startLive();
  const start = performance.now();

  async function churner(): Promise<void> {
    while (!deadlineReached(start, config.durationSec)) {
      const connectStart = performance.now();
      let client: StdioMcpClient | null = null;
      try {
        client = new StdioMcpClient(config.clientOpts);
        client.spawn();
        const { latencyMs } = await client.request("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "mcp-stress", version: "0.1.0" },
        });
        metrics.recordSuccess("initialize", latencyMs);
        await client.notify("notifications/initialized");
        await recordRequest(metrics, "ping", () => client!.ping());
      } catch (e) {
        const elapsed = performance.now() - connectStart;
        if (e instanceof McpClientError) {
          metrics.recordError("initialize", e.latencyMs, e.code, e.message);
        } else if (e instanceof Error) {
          metrics.recordError("initialize", elapsed, -1, e.message);
        }
      } finally {
        if (client) await client.close();
      }
    }
  }

  const workers = Array.from({ length: config.concurrency }, () => churner());
  await Promise.all(workers);

  metrics.stop();
  return { name: "connection-churn", metrics };
}

async function toolFlood(config: ScenarioConfig): Promise<ScenarioResult> {
  const metrics = await initMetrics(config, "tool-flood");
  const client = await makeClient(config.clientOpts);

  let tools: Array<Record<string, unknown>> = [];
  try {
    let allTools = (await client.listTools()) as Array<Record<string, unknown>>;
    if (config.tool) {
      allTools = allTools.filter((t) => t.name === config.tool);
      if (allTools.length === 0) log(`tool-flood: tool '${config.tool}' not found`);
    }
    tools = allTools;
  } catch {
    log("tool-flood: server does not support tools/list");
  }

  if (tools.length === 0) {
    log("tool-flood: no tools found, falling back to ping flood");
    metrics.start();
    metrics.startLive();
    const start = performance.now();
    while (!deadlineReached(start, config.durationSec)) {
      await recordRequest(metrics, "ping", () => client.ping());
    }
    metrics.stop();
    await client.close();
    return { name: "tool-flood", metrics };
  }

  const shapeName = config.shape ?? "constant";
  log(`tool-flood: ${tools.length} tools, ${config.durationSec}s, peak=${config.concurrency}, shape=${shapeName}`);

  let callIdx = 0;
  await runShaped(config, metrics, async () => {
    const tool = tools[callIdx++ % tools.length];
    const name = tool.name as string;
    const schema = tool.inputSchema as Record<string, unknown> | undefined;
    const args = generateRandomArgsFromSchema(schema);
    await recordRequest(metrics, `tools/call:${name}`, () => client.callTool(name, args));
  });

  await client.close();
  return { name: "tool-flood", metrics };
}

async function mixedWorkload(config: ScenarioConfig): Promise<ScenarioResult> {
  const metrics = await initMetrics(config, "mixed-workload");
  const client = await makeClient(config.clientOpts);

  const caps = client.serverCapabilities;
  type Op = () => Promise<void>;
  const ops: Op[] = [];

  ops.push(() => recordRequest(metrics, "ping", () => client.ping()));
  if ("tools" in caps) {
    ops.push(() =>
      recordRequest(metrics, "tools/list", async () => {
        const start = performance.now();
        await client.listTools();
        return { latencyMs: performance.now() - start };
      }),
    );
  }
  if ("resources" in caps) {
    ops.push(() =>
      recordRequest(metrics, "resources/list", async () => {
        const start = performance.now();
        await client.listResources();
        return { latencyMs: performance.now() - start };
      }),
    );
  }
  if ("prompts" in caps) {
    ops.push(() =>
      recordRequest(metrics, "prompts/list", async () => {
        const start = performance.now();
        await client.listPrompts();
        return { latencyMs: performance.now() - start };
      }),
    );
  }

  const shapeName = config.shape ?? "constant";
  log(`mixed-workload: ${ops.length} op types, ${config.durationSec}s, peak=${config.concurrency}, shape=${shapeName}`);

  let opIdx = 0;
  await runShaped(config, metrics, async () => {
    const op = ops[opIdx++ % ops.length];
    await op();
  });

  await client.close();
  return { name: "mixed-workload", metrics };
}

// ─── Find Ceiling (smart plateau detection) ─────────────────────

interface PhaseResult {
  concurrency: number;
  rps: number;
  p50: number;
  p99: number;
  errors: number;
  total: number;
}

async function findCeiling(config: ScenarioConfig): Promise<ScenarioResult> {
  const metrics = await initMetrics(config, "find-ceiling");
  const client = await makeClient(config.clientOpts);

  // Discover tools for the workload
  let tools: Array<Record<string, unknown>> = [];
  try {
    let allTools = (await client.listTools()) as Array<Record<string, unknown>>;
    if (config.tool) {
      allTools = allTools.filter((t) => t.name === config.tool);
    }
    tools = allTools;
  } catch { /* */ }

  const usePing = tools.length === 0;
  if (usePing) log("find-ceiling: no tools, using ping");

  // Phase duration: use total duration / expected phases, minimum 5s
  const maxConcurrency = config.concurrency;
  const phaseDuration = Math.max(5, Math.min(10, config.durationSec / 10));

  const phases: PhaseResult[] = [];
  let concurrency = 1;
  let plateauDetected = false;

  log(`find-ceiling: stepping 1 → ${maxConcurrency}, ${phaseDuration}s per phase`);
  console.error("");
  metrics.start();
  metrics.startLive();

  while (concurrency <= maxConcurrency) {
    metrics.concurrency = concurrency;
    const phaseStart = performance.now();
    const phaseRecordsBefore = metrics.totalRequests;
    const phaseErrorsBefore = metrics.totalErrors;

    // Run the phase
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push((async () => {
        while (!deadlineReached(phaseStart, phaseDuration)) {
          if (usePing) {
            await recordRequest(metrics, "ping", () => client.ping());
          } else {
            const tool = tools[Math.floor(Math.random() * tools.length)];
            const name = tool.name as string;
            const schema = tool.inputSchema as Record<string, unknown> | undefined;
            const args = generateRandomArgsFromSchema(schema);
            await recordRequest(metrics, `tools/call:${name}`, () => client.callTool(name, args));
          }
        }
      })());
    }
    await Promise.all(workers);

    const phaseElapsed = (performance.now() - phaseStart) / 1000;
    const phaseTotal = metrics.totalRequests - phaseRecordsBefore;
    const phaseErrors = metrics.totalErrors - phaseErrorsBefore;
    const phaseRps = phaseTotal / phaseElapsed;

    // Compute phase latency from recent records
    const recentRecords = metrics.raw().slice(phaseRecordsBefore);
    const latencies = recentRecords.map((r) => r.latencyMs).sort((a, b) => a - b);
    const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p99 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.99)] : 0;

    const phase: PhaseResult = { concurrency, rps: phaseRps, p50, p99, errors: phaseErrors, total: phaseTotal };
    phases.push(phase);

    // Check for plateau
    if (phases.length >= 2) {
      const prev = phases[phases.length - 2];
      const rpsGain = (phase.rps - prev.rps) / prev.rps;
      const latencyGain = (phase.p50 - prev.p50) / Math.max(prev.p50, 1);

      if (rpsGain < 0.05 && latencyGain > 0.2) {
        // Throughput barely increased but latency jumped — queueing
        plateauDetected = true;
        console.error(`\n  >> Plateau detected at concurrency=${prev.concurrency} (${prev.rps.toFixed(1)} req/s)`);
        console.error(`     c=${concurrency}: +${(rpsGain * 100).toFixed(1)}% throughput, +${(latencyGain * 100).toFixed(1)}% latency`);
        break;
      }

      if (phase.rps < prev.rps * 0.9) {
        // Throughput actually decreased — overloaded
        plateauDetected = true;
        console.error(`\n  >> Throughput degradation at concurrency=${concurrency} (${phase.rps.toFixed(1)} < ${prev.rps.toFixed(1)} req/s)`);
        break;
      }

      if (phase.errors > phase.total * 0.1) {
        // Error rate > 10%
        plateauDetected = true;
        console.error(`\n  >> Error rate spike at concurrency=${concurrency} (${((phase.errors / phase.total) * 100).toFixed(1)}%)`);
        break;
      }
    }

    // Step up concurrency
    if (concurrency === 1) concurrency = 2;
    else if (concurrency < 5) concurrency += 1;
    else if (concurrency < 20) concurrency += 5;
    else concurrency += 10;
  }

  metrics.stop();
  await client.close();

  // Print phase summary table
  console.error("\n  Phase results:");
  console.error("  ┌────────────┬──────────┬──────────┬──────────┬────────┐");
  console.error("  │ Concurrency│   req/s  │  p50(ms) │  p99(ms) │ errors │");
  console.error("  ├────────────┼──────────┼──────────┼──────────┼────────┤");
  for (const p of phases) {
    const c = p.concurrency.toString().padStart(10);
    const r = p.rps.toFixed(1).padStart(8);
    const p50 = p.p50.toFixed(0).padStart(8);
    const p99 = p.p99.toFixed(0).padStart(8);
    const e = p.errors.toString().padStart(6);
    console.error(`  │${c} │${r} │${p50} │${p99} │${e} │`);
  }
  console.error("  └────────────┴──────────┴──────────┴──────────┴────────┘");

  if (!plateauDetected) {
    console.error(`\n  No plateau detected up to concurrency=${maxConcurrency}. Try a higher -c value.`);
  }

  return { name: "find-ceiling", metrics };
}
