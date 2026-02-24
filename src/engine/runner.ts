/**
 * Generic test execution engine.
 */

import { McpClient } from "../client.ts";
import type { Transport, TransportOptions } from "../transport/types.ts";
import { McpError } from "../transport/types.ts";
import type { MetaEvent, RequestEvent } from "../metrics/events.ts";
import { Recorder } from "../metrics/recorder.ts";
import { Writer } from "../metrics/writer.ts";
import type { WorkloadProfile } from "./workload.ts";
import { SHAPES } from "./shapes.ts";
import { generateRandomArgsFromSchema, rng, setSeed } from "../schema.ts";
import { percentile } from "../metrics/stats.ts";

export interface RunOptions {
  profile: WorkloadProfile;
  createTransport: () => Transport;
  transportOpts: TransportOptions;
  name?: string;
  seed?: number;
  outputPath?: string;
  onEvent?: (event: RequestEvent) => void;
  onMeta?: (meta: MetaEvent) => void;
  onMessage?: (msg: string) => void;
}

export interface PhaseResult {
  concurrency: number;
  rps: number;
  p50: number;
  p99: number;
  errors: number;
  total: number;
}

export interface RunResult {
  summary: import("../metrics/events.ts").SummaryEvent;
  profile: WorkloadProfile;
  phases?: PhaseResult[];
  ceilingConcurrency?: number;
}

interface Op {
  methodId: number;
  execute: () => Promise<
    { latencyMs: number; methodId?: number; isError?: boolean }
  >;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`  [${ts}] ${msg}`);
}

function deadlineReached(startTime: number, durationSec: number): boolean {
  return (performance.now() - startTime) >= durationSec * 1000;
}

function recordResult(
  recorder: Recorder,
  op: Op,
  r: { latencyMs: number; methodId?: number; isError?: boolean },
): void {
  const methodId = r.methodId ?? op.methodId;
  if (r.isError) {
    recorder.error(
      methodId,
      r.latencyMs,
      new McpError("server", -1, "tool returned isError", null, r.latencyMs),
    );
  } else {
    recorder.success(methodId, r.latencyMs);
  }
}

export async function executeRun(opts: RunOptions): Promise<RunResult> {
  const seed = setSeed(opts.seed);
  const profile = opts.profile;
  const recorder = new Recorder();

  const meta: MetaEvent = {
    type: "meta",
    name: opts.name,
    profile: profile.name,
    shape: profile.shape,
    concurrency: profile.concurrency,
    durationSec: profile.durationSec,
    requests: profile.requests,
    tool: profile.tool,
    transport: resolveTransportType(opts.transportOpts),
    target: resolveTarget(opts.transportOpts),
    seed,
    startedAt: new Date().toISOString(),
    timeoutMs: opts.transportOpts.timeoutMs ?? 30_000,
    command: buildReproCommand(opts, seed),
  };

  const writer = new Writer({ outputPath: opts.outputPath, meta });
  recorder.connectWriter(writer);

  if (opts.onEvent) recorder.onEvent = opts.onEvent;
  if (opts.onMeta) opts.onMeta(meta);

  if (profile.connectionChurn) {
    const result = await executeConnectionChurn(recorder, opts, profile);
    recorder.complete();
    const summary = await writer.stats();
    writer.close();
    return { summary, profile, ...result };
  }

  const transport = opts.createTransport();
  const client = new McpClient(transport);
  await client.connect();

  const tools = await discoverTools(client, profile);
  const nextOp = buildOpExecutor(recorder, client, tools, profile.operations);

  let extra: { phases?: PhaseResult[]; ceilingConcurrency?: number } = {};
  if (profile.findCeiling) {
    extra = await executeFindCeiling(recorder, nextOp, profile, opts.onMessage);
  } else {
    await executeShaped(recorder, nextOp, profile);
  }

  await client.close();
  recorder.complete();
  const summary = await writer.stats();
  writer.close();

  return { summary, profile, ...extra };
}

// ─── Tool discovery ─────────────────────────────────────────────

async function discoverTools(
  client: McpClient,
  profile: WorkloadProfile,
): Promise<Array<Record<string, unknown>>> {
  const needsTools = profile.operations.some((op) =>
    op.method === "tools/call"
  );
  if (!needsTools) return [];

  try {
    const { tools } = await client.listTools();
    let filtered = tools as Array<Record<string, unknown>>;
    if (profile.tool) {
      filtered = filtered.filter((t) => t.name === profile.tool);
      if (filtered.length === 0) log(`tool '${profile.tool}' not found`);
    }
    return filtered;
  } catch {
    log("server does not support tools/list");
    return [];
  }
}

// ─── Operation executor ─────────────────────────────────────────

function buildOpExecutor(
  recorder: Recorder,
  client: McpClient,
  tools: Array<Record<string, unknown>>,
  operations: import("./workload.ts").OperationMix[],
): () => Op {
  const weighted: Op[] = [];

  for (const op of operations) {
    const weight = op.weight ?? 1;
    for (let w = 0; w < weight; w++) {
      weighted.push(buildSingleOp(recorder, client, tools, op.method));
    }
  }

  let idx = 0;
  return () => weighted[idx++ % weighted.length];
}

function buildSingleOp(
  recorder: Recorder,
  client: McpClient,
  tools: Array<Record<string, unknown>>,
  method: string,
): Op {
  switch (method) {
    case "ping": {
      const methodId = recorder.registerMethod("ping");
      return {
        methodId,
        execute: async () => await client.ping(),
      };
    }

    case "tools/call": {
      if (tools.length === 0) {
        const methodId = recorder.registerMethod("ping");
        return { methodId, execute: async () => await client.ping() };
      }
      if (tools.length === 1) {
        const tool = tools[0];
        const name = tool.name as string;
        const schema = tool.inputSchema as Record<string, unknown> | undefined;
        const methodId = recorder.registerMethod(`tools/call:${name}`);
        return {
          methodId,
          execute: async () =>
            await client.callTool(name, generateRandomArgsFromSchema(schema)),
        };
      }
      // Multiple tools: register all, pick randomly per call
      const toolOps = tools.map((tool) => {
        const name = tool.name as string;
        const schema = tool.inputSchema as Record<string, unknown> | undefined;
        const methodId = recorder.registerMethod(`tools/call:${name}`);
        return { name, schema, methodId };
      });
      const primaryMethodId = toolOps[0].methodId;
      return {
        methodId: primaryMethodId,
        execute: async () => {
          const pick = toolOps[Math.floor(rng() * toolOps.length)];
          const result = await client.callTool(
            pick.name,
            generateRandomArgsFromSchema(pick.schema),
          );
          return { ...result, methodId: pick.methodId };
        },
      };
    }

    case "tools/list": {
      const methodId = recorder.registerMethod("tools/list");
      return { methodId, execute: async () => await client.listTools() };
    }

    case "resources/list": {
      const methodId = recorder.registerMethod("resources/list");
      return { methodId, execute: async () => await client.listResources() };
    }

    case "prompts/list": {
      const methodId = recorder.registerMethod("prompts/list");
      return { methodId, execute: async () => await client.listPrompts() };
    }

    default: {
      const methodId = recorder.registerMethod("ping");
      return { methodId, execute: async () => await client.ping() };
    }
  }
}

// ─── Shaped execution ───────────────────────────────────────────

async function executeShaped(
  recorder: Recorder,
  nextOp: () => Op,
  profile: WorkloadProfile,
): Promise<void> {
  const shapeInfo = SHAPES[profile.shape];
  if (!shapeInfo) throw new Error(`Unknown shape: ${profile.shape}`);
  const shape = shapeInfo.fn;

  const maxRequests = profile.requests;
  if (maxRequests) {
    log(
      `${profile.name}: ${maxRequests} requests, concurrency=${profile.concurrency}`,
    );
  } else {
    log(
      `${profile.name}: ${profile.durationSec}s, peak=${profile.concurrency}, shape=${profile.shape}`,
    );
  }
  recorder.start();
  const start = performance.now();

  while (
    !deadlineReached(start, profile.durationSec) &&
    (!maxRequests || recorder.total < maxRequests)
  ) {
    const t = (performance.now() - start) / 1000;
    const targetConcurrency = maxRequests
      ? Math.min(profile.concurrency, maxRequests - recorder.total)
      : shape(t, profile.durationSec, profile.concurrency);
    if (targetConcurrency <= 0) break;
    recorder.concurrency = targetConcurrency;

    const batch = Array.from({ length: targetConcurrency }, () => {
      const op = nextOp();
      return op.execute().then(
        (r) => recordResult(recorder, op, r),
        (e) => {
          const latencyMs = e instanceof McpError ? e.latencyMs : 0;
          recorder.error(op.methodId, latencyMs, e);
        },
      );
    });
    await Promise.all(batch);
  }
}

// ─── Find ceiling ───────────────────────────────────────────────

async function executeFindCeiling(
  recorder: Recorder,
  nextOp: () => Op,
  profile: WorkloadProfile,
  onMessage?: (msg: string) => void,
): Promise<{ phases: PhaseResult[]; ceilingConcurrency?: number }> {
  const config = profile.findCeiling!;
  const phaseDuration = Math.max(
    5,
    Math.min(config.phaseDurationSec, profile.durationSec / 5),
  );
  const maxConcurrency = config.maxConcurrency;
  const threshold = config.plateauThreshold ?? 0.05;

  const phases: PhaseResult[] = [];
  let concurrency = 1;
  let plateauDetected = false;

  const stepMsg =
    `find-ceiling: stepping 1 → ${maxConcurrency}, ${phaseDuration}s per phase`;
  log(stepMsg);
  onMessage?.(stepMsg);
  console.error("");
  recorder.start();

  while (concurrency <= maxConcurrency) {
    recorder.concurrency = concurrency;
    const phaseStart = performance.now();
    const recordsBefore = recorder.total;
    const errorsBefore = recorder.errors;

    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push((async () => {
        while (!deadlineReached(phaseStart, phaseDuration)) {
          const op = nextOp();
          await op.execute().then(
            (r) => recordResult(recorder, op, r),
            (e) => {
              const latencyMs = e instanceof McpError ? e.latencyMs : 0;
              recorder.error(op.methodId, latencyMs, e);
            },
          );
        }
      })());
    }
    await Promise.all(workers);

    const phaseElapsed = (performance.now() - phaseStart) / 1000;
    const phaseTotal = recorder.total - recordsBefore;
    const phaseErrors = recorder.errors - errorsBefore;
    const phaseRps = phaseTotal / phaseElapsed;

    const latencies = recorder.latenciesSince(recordsBefore);
    const sorted = Array.from(latencies).sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p99 = percentile(sorted, 0.99);

    const phase: PhaseResult = {
      concurrency,
      rps: phaseRps,
      p50,
      p99,
      errors: phaseErrors,
      total: phaseTotal,
    };
    phases.push(phase);

    if (phases.length >= 2) {
      const prev = phases[phases.length - 2];
      const rpsGain = (phase.rps - prev.rps) / prev.rps;
      const latencyGain = (phase.p50 - prev.p50) / Math.max(prev.p50, 1);

      if (rpsGain < threshold && latencyGain > 0.2) {
        plateauDetected = true;
        const msg = `Plateau detected at concurrency=${prev.concurrency} (${
          prev.rps.toFixed(1)
        } req/s). c=${concurrency}: +${
          (rpsGain * 100).toFixed(1)
        }% throughput, +${(latencyGain * 100).toFixed(1)}% latency`;
        console.error(`\n  >> ${msg}`);
        onMessage?.(msg);
        break;
      }
      if (phase.rps < prev.rps * 0.9) {
        plateauDetected = true;
        const msg = `Throughput degradation at concurrency=${concurrency}`;
        console.error(`\n  >> ${msg}`);
        onMessage?.(msg);
        break;
      }
      if (phase.errors > phase.total * 0.1) {
        plateauDetected = true;
        const msg = `Error rate spike at concurrency=${concurrency} (${
          ((phase.errors / phase.total) * 100).toFixed(1)
        }%)`;
        console.error(`\n  >> ${msg}`);
        onMessage?.(msg);
        break;
      }
    }

    if (concurrency === 1) concurrency = 2;
    else if (concurrency < 5) concurrency += 1;
    else if (concurrency < 20) concurrency += 5;
    else concurrency += 10;
  }

  console.error("\n  Phase results:");
  console.error("  ┌────────────┬──────────┬──────────┬──────────┬────────┐");
  console.error("  │ Concurrency│   req/s  │  p50(ms) │  p99(ms) │ errors │");
  console.error("  ├────────────┼──────────┼──────────┼──────────┼────────┤");
  for (const p of phases) {
    console.error(
      `  │${p.concurrency.toString().padStart(10)} │${
        p.rps.toFixed(1).padStart(8)
      } │${p.p50.toFixed(0).padStart(8)} │${p.p99.toFixed(0).padStart(8)} │${
        p.errors.toString().padStart(6)
      } │`,
    );
  }
  console.error("  └────────────┴──────────┴──────────┴──────────┴────────┘");

  // Send phase results to dashboard
  if (onMessage) {
    const lines = phases.map(
      (p) =>
        `c=${p.concurrency}: ${p.rps.toFixed(1)} req/s, p50=${
          p.p50.toFixed(0)
        }ms, p99=${p.p99.toFixed(0)}ms, errors=${p.errors}`,
    );
    onMessage(`Phase results:\n${lines.join("\n")}`);
  }

  if (!plateauDetected) {
    const msg =
      `No plateau detected up to concurrency=${maxConcurrency}. Try a higher -c value.`;
    console.error(`\n  ${msg}`);
    onMessage?.(msg);
  }

  return {
    phases,
    ceilingConcurrency: plateauDetected
      ? phases[phases.length - 2]?.concurrency
      : undefined,
  };
}

// ─── Connection churn ───────────────────────────────────────────

async function executeConnectionChurn(
  recorder: Recorder,
  opts: RunOptions,
  profile: WorkloadProfile,
): Promise<{ phases?: PhaseResult[]; ceilingConcurrency?: number }> {
  const initMethodId = recorder.registerMethod("initialize");
  const pingMethodId = recorder.registerMethod("ping");

  log(
    `connection-churn: ${profile.durationSec}s, ${profile.concurrency} parallel churners`,
  );
  recorder.start();
  const start = performance.now();

  async function churner(): Promise<void> {
    while (!deadlineReached(start, profile.durationSec)) {
      const connectStart = performance.now();
      let client: McpClient | null = null;
      try {
        const transport = opts.createTransport();
        client = new McpClient(transport);
        await client.connect();
        recorder.success(initMethodId, performance.now() - connectStart);
        const { latencyMs } = await client.ping();
        recorder.success(pingMethodId, latencyMs);
      } catch (e) {
        recorder.error(initMethodId, performance.now() - connectStart, e);
      } finally {
        if (client) await client.close();
      }
    }
  }

  const workers = Array.from({ length: profile.concurrency }, () => churner());
  await Promise.all(workers);

  return {};
}

// ─── Helpers ────────────────────────────────────────────────────

function resolveTransportType(opts: TransportOptions): MetaEvent["transport"] {
  switch (opts.type) {
    case "stdio":
      return "stdio";
    case "sse":
      return "sse";
    case "streamable-http":
      return "streamable-http";
  }
}

function resolveTarget(opts: TransportOptions): string {
  switch (opts.type) {
    case "stdio":
      return `${opts.command} ${opts.args.join(" ")}`;
    case "sse":
      return opts.url;
    case "streamable-http":
      return opts.url;
  }
}

function buildReproCommand(opts: RunOptions, seed: number): string {
  const p = opts.profile;
  const parts = ["mcp-stress run"];
  parts.push(`-p ${p.name.toLowerCase().replace(/\s+/g, "-")}`);
  if (p.requests) {
    parts.push(`-n ${p.requests}`);
  } else {
    parts.push(`-d ${p.durationSec}`);
  }
  parts.push(`-c ${p.concurrency}`);
  if (p.tool) parts.push(`--tool ${p.tool}`);
  if (p.shape !== "constant") parts.push(`--shape ${p.shape}`);
  parts.push(`--seed ${seed}`);
  if (opts.outputPath) parts.push(`-o ${opts.outputPath}`);
  if (opts.transportOpts.timeoutMs && opts.transportOpts.timeoutMs !== 30_000) {
    parts.push(`-t ${opts.transportOpts.timeoutMs}`);
  }
  switch (opts.transportOpts.type) {
    case "stdio":
      parts.push(
        `-- ${opts.transportOpts.command} ${opts.transportOpts.args.join(" ")}`,
      );
      break;
    case "sse":
    case "streamable-http":
      parts.push(`--url ${opts.transportOpts.url}`);
      break;
  }
  return parts.join(" ");
}
