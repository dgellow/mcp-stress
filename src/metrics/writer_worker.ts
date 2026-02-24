/**
 * Writer worker — runs in a separate V8 isolate.
 *
 * Receives raw numeric records from the main thread via MessagePort.
 * Handles: NDJSON serialization, buffered file writes, live CLI stats.
 *
 * Protocol:
 *   Main → Worker:
 *     { type: "init", outputPath?, meta? }    — initialize
 *     { type: "method", id, name }            — register method name
 *     { type: "error_msg", ec, cc, msg }      — cache error message
 *     { t, m, l, ok, ec, cc, cn, ph }         — raw record (no type field)
 *     { type: "complete" }                    — test finished
 *
 *   Worker → Main:
 *     { type: "stats", summary }              — final stats on completion
 */

declare const self: {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (msg: unknown) => void;
  close: () => void;
};

import type {
  LatencyStats,
  MetaEvent,
  MethodStats,
  RequestEvent,
  SummaryEvent,
} from "./events.ts";
import type { ErrorCategory } from "../transport/types.ts";
import { percentile } from "./stats.ts";

interface RawRecord {
  t: number;
  m: number;
  l: number;
  ok: 0 | 1;
  ec: number;
  cc: number;
  cn: number;
  ph: number;
}

const INT_TO_ERROR_CATEGORY: (ErrorCategory | "none")[] = [
  "none",
  "timeout",
  "protocol",
  "server",
  "network",
  "client",
];

// ─── State ──────────────────────────────────────────────────────

const methodNames: string[] = [];
const errorMessages = new Map<string, string>(); // "ec:cc" → message
const records: RawRecord[] = [];
let meta: MetaEvent | null = null;
let outputFile: Deno.FsFile | null = null;

// Write buffer — accumulates NDJSON lines, flushed periodically
let writeBuffer = "";
const encoder = new TextEncoder();
const FLUSH_INTERVAL_MS = 100;
const FLUSH_SIZE_BYTES = 65536;

// Live stats
let liveInterval: ReturnType<typeof setInterval> | null = null;
let lastLiveCount = 0;
let totalErrors = 0;
const errorsByCategory = [0, 0, 0, 0, 0, 0];
let initTime = 0;

// ─── Message handler ────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "init") {
    handleInit(msg);
    return;
  }

  if (msg.type === "method") {
    methodNames[msg.id] = msg.name;
    return;
  }

  if (msg.type === "error_msg") {
    errorMessages.set(`${msg.ec}:${msg.cc}`, msg.msg);
    return;
  }

  if (msg.type === "complete") {
    handleComplete();
    return;
  }

  if (msg.type === "batch") {
    for (const r of msg.records as RawRecord[]) {
      handleRecord(r);
    }
    return;
  }
};

// ─── Init ───────────────────────────────────────────────────────

async function handleInit(msg: { outputPath?: string; meta?: MetaEvent }) {
  meta = msg.meta ?? null;

  if (msg.outputPath) {
    outputFile = await Deno.open(msg.outputPath, {
      write: true,
      create: true,
      truncate: true,
    });
    if (meta) {
      bufferLine(JSON.stringify(meta));
    }
  }

  // Start periodic flush and live stats
  initTime = performance.now();
  setInterval(flushBuffer, FLUSH_INTERVAL_MS);
  liveInterval = setInterval(printLive, 1000);
}

// ─── Record handling ────────────────────────────────────────────

function handleRecord(r: RawRecord): void {
  records.push(r);
  if (r.ok === 0) {
    totalErrors++;
    errorsByCategory[r.ec]++;
  }

  if (outputFile) {
    const event: RequestEvent = {
      t: r.t,
      method: methodNames[r.m] ?? `method_${r.m}`,
      latencyMs: r.l,
      ok: r.ok === 1,
    };
    if (r.ok === 0) {
      const cat = INT_TO_ERROR_CATEGORY[r.ec];
      if (cat && cat !== "none") event.errorCategory = cat as ErrorCategory;
      event.errorCode = r.cc;
      event.error = errorMessages.get(`${r.ec}:${r.cc}`) ?? `${cat}:${r.cc}`;
    }
    if (r.cn > 0) event.concurrency = r.cn;
    if (r.ph >= 0) event.phase = r.ph;
    bufferLine(JSON.stringify(event));
  }
}

// ─── Buffered I/O ───────────────────────────────────────────────

function bufferLine(line: string): void {
  writeBuffer += line + "\n";
  if (writeBuffer.length >= FLUSH_SIZE_BYTES) {
    flushBuffer();
  }
}

function flushBuffer(): void {
  if (!outputFile || writeBuffer.length === 0) return;
  outputFile.writeSync(encoder.encode(writeBuffer));
  writeBuffer = "";
}

// ─── Live CLI stats ─────────────────────────────────────────────

function printLive(): void {
  const total = records.length;
  const windowReqs = total - lastLiveCount;
  lastLiveCount = total;

  const elapsed = (performance.now() - initTime) / 1000;
  if (total === 0) return;

  // Latency from recent records
  const recentCount = Math.max(windowReqs, 10);
  const recentStart = Math.max(0, total - recentCount);
  const recentLatencies: number[] = [];
  for (let i = recentStart; i < total; i++) {
    recentLatencies.push(records[i].l);
  }
  recentLatencies.sort((a, b) => a - b);

  const p50 = recentLatencies.length > 0 ? percentile(recentLatencies, 0.5) : 0;
  const p99 = recentLatencies.length > 0
    ? percentile(recentLatencies, 0.99)
    : 0;

  const conc = records[total - 1].cn;
  const concStr = conc > 0 ? `c=${conc} ` : "";
  const sec = Math.floor(elapsed).toString().padStart(3, " ");
  const errStr = totalErrors > 0
    ? `\x1b[31merr=${totalErrors}\x1b[0m`
    : `err=0`;

  // Write to stderr (console.error would add "error" prefix in workers, use Deno.stderr directly)
  const line = `  [${sec}s] ${concStr}${total} req  ${windowReqs} req/s  p50=${
    p50.toFixed(0)
  }ms  p99=${p99.toFixed(0)}ms  ${errStr}\n`;
  Deno.stderr.writeSync(encoder.encode(line));
}

// ─── Completion ─────────────────────────────────────────────────

function handleComplete(): void {
  if (liveInterval !== null) {
    clearInterval(liveInterval);
    printLive();
    Deno.stderr.writeSync(encoder.encode("\n"));
  }

  // Write summary to NDJSON
  const summary = computeSummary();
  if (outputFile) {
    bufferLine(JSON.stringify(summary));
    flushBuffer();
    outputFile.close();
    outputFile = null;
  }

  // Send stats back to main thread
  self.postMessage({ type: "stats", summary });

  self.close();
}

// ─── Statistics ─────────────────────────────────────────────────

function computeSummary(): SummaryEvent {
  const total = records.length;
  if (total === 0) {
    return {
      type: "summary",
      durationMs: 0,
      totalRequests: 0,
      totalErrors: 0,
      requestsPerSecond: 0,
      overall: emptyStats(),
      byMethod: [],
      errorsByCategory: {},
    };
  }

  const durationMs = records[total - 1].t;
  const rps = durationMs > 0 ? (total / durationMs) * 1000 : 0;

  const catMap: Record<string, number> = {};
  for (let i = 1; i <= 5; i++) {
    if (errorsByCategory[i] > 0) {
      catMap[INT_TO_ERROR_CATEGORY[i] as string] = errorsByCategory[i];
    }
  }

  return {
    type: "summary",
    durationMs,
    totalRequests: total,
    totalErrors,
    requestsPerSecond: rps,
    overall: computeStats(records, 0, total),
    byMethod: computeMethodStats(),
    errorsByCategory: catMap,
  };
}

function computeMethodStats(): MethodStats[] {
  const byMethod = new Map<number, number[]>();
  const errorsByMethod = new Map<number, number>();

  for (const r of records) {
    let list = byMethod.get(r.m);
    if (!list) {
      list = [];
      byMethod.set(r.m, list);
    }
    list.push(r.l);
    if (r.ok === 0) {
      errorsByMethod.set(r.m, (errorsByMethod.get(r.m) ?? 0) + 1);
    }
  }

  const result: MethodStats[] = [];
  for (const [methodId, latencies] of byMethod) {
    latencies.sort((a, b) => a - b);
    const errors = errorsByMethod.get(methodId) ?? 0;
    const sum = latencies.reduce((a, b) => a + b, 0);
    result.push({
      method: methodNames[methodId] ?? `method_${methodId}`,
      count: latencies.length,
      errors,
      min: latencies[0],
      max: latencies[latencies.length - 1],
      mean: sum / latencies.length,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    });
  }

  return result.sort((a, b) => a.method.localeCompare(b.method));
}

function computeStats(
  recs: RawRecord[],
  from: number,
  to: number,
): LatencyStats {
  const count = to - from;
  if (count === 0) return emptyStats();

  const latencies: number[] = [];
  let errors = 0;
  let sum = 0;
  for (let i = from; i < to; i++) {
    latencies.push(recs[i].l);
    sum += recs[i].l;
    if (recs[i].ok === 0) errors++;
  }
  latencies.sort((a, b) => a - b);

  return {
    count,
    errors,
    min: latencies[0],
    max: latencies[count - 1],
    mean: sum / count,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
  };
}

function emptyStats(): LatencyStats {
  return {
    count: 0,
    errors: 0,
    min: 0,
    max: 0,
    mean: 0,
    p50: 0,
    p95: 0,
    p99: 0,
  };
}
