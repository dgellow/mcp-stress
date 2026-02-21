/**
 * Main-thread recorder. Append-only, minimal overhead.
 *
 * Hot path per request:
 *   1. Write latency to pre-allocated Float64Array (for find-ceiling phase stats)
 *   2. Push a flat object to pendingRecords (for writer worker, cleared every 50ms)
 *   3. Increment counter
 *
 * Design choices for low overhead:
 *   - Date.now() instead of performance.now() for timestamps (~15ns savings)
 *   - Single array push (pendingRecords only), not dual storage
 *   - Typed array for latencies — O(1) subarray view for latenciesSince()
 *   - No try/catch in recorder — error handling is caller's responsibility
 */

import { classifyError } from "../transport/types.ts";
import type { ErrorCategory } from "../transport/types.ts";
import type { RequestEvent } from "./events.ts";
import type { Writer } from "./writer.ts";

export interface RawRecord {
  t: number;
  m: number;
  l: number;
  ok: 0 | 1;
  ec: number;
  cc: number;
  cn: number;
  ph: number;
}

const ERROR_CATEGORY_TO_INT: Record<ErrorCategory, number> = {
  timeout: 1,
  protocol: 2,
  server: 3,
  network: 4,
  client: 5,
};

export const INT_TO_ERROR_CATEGORY: ErrorCategory[] = [
  "timeout",
  "timeout",
  "protocol",
  "server",
  "network",
  "client",
];

const FLUSH_INTERVAL_MS = 50;
const INITIAL_LATENCY_CAPACITY = 65536;

export class Recorder {
  private startTime = 0;
  private startTimeHr = 0; // performance.now() for elapsed getter
  private methodRegistry = new Map<string, number>();
  private methodNames: string[] = [];
  private latencies = new Float64Array(INITIAL_LATENCY_CAPACITY);
  private latencyCount = 0;
  private _total = 0;
  private _errors = 0;
  private _concurrency = 0;
  private _phase = -1;
  private writer: Writer | null = null;
  private pendingRecords: RawRecord[] = [];
  private pendingErrors: Array<{ ec: number; cc: number; msg: string }> = [];
  private flushTimer: number | null = null;
  private _onEvent: ((event: RequestEvent) => void) | null = null;

  start(): void {
    this.startTime = Date.now();
    this.startTimeHr = performance.now();
    if (this.writer) {
      this.flushTimer = setInterval(
        () => this.flush(),
        FLUSH_INTERVAL_MS,
      ) as unknown as number;
    }
  }

  set concurrency(n: number) {
    this._concurrency = n;
  }
  set phase(n: number) {
    this._phase = n;
  }
  set onEvent(cb: ((event: RequestEvent) => void) | null) {
    this._onEvent = cb;
  }

  connectWriter(writer: Writer): void {
    this.writer = writer;
    for (const [name, id] of this.methodRegistry) {
      writer.post({ type: "method", id, name });
    }
  }

  registerMethod(name: string): number {
    let id = this.methodRegistry.get(name);
    if (id !== undefined) return id;
    id = this.methodNames.length;
    this.methodNames.push(name);
    this.methodRegistry.set(name, id);
    this.writer?.post({ type: "method", id, name });
    return id;
  }

  methodName(id: number): string {
    return this.methodNames[id] ?? "unknown";
  }

  /**
   * Record a successful request. HOT PATH.
   */
  success(methodId: number, latencyMs: number): void {
    const l = Math.round(latencyMs * 100) / 100;

    // Store latency in typed array (for find-ceiling phase stats)
    if (this.latencyCount >= this.latencies.length) this.growLatencies();
    this.latencies[this.latencyCount++] = l;
    this._total++;

    const t = Date.now() - this.startTime;

    // Queue record for writer worker (cleared every 50ms)
    if (this.writer) {
      this.pendingRecords.push({
        t,
        m: methodId,
        l,
        ok: 1,
        ec: 0,
        cc: 0,
        cn: this._concurrency,
        ph: this._phase,
      });
    }

    // Forward to live dashboard (only active when --live)
    if (this._onEvent) {
      this._onEvent({
        t,
        method: this.methodNames[methodId],
        latencyMs: l,
        ok: true,
        concurrency: this._concurrency,
        phase: this._phase >= 0 ? this._phase : undefined,
      });
    }
  }

  /**
   * Record a failed request. HOT PATH.
   */
  error(methodId: number, latencyMs: number, error: unknown): void {
    const classified = classifyError(error);
    const catInt = ERROR_CATEGORY_TO_INT[classified.category];
    const l = Math.round(latencyMs * 100) / 100;

    // Store latency in typed array
    if (this.latencyCount >= this.latencies.length) this.growLatencies();
    this.latencies[this.latencyCount++] = l;
    this._total++;
    this._errors++;

    const t = Date.now() - this.startTime;

    // Queue record for writer worker
    if (this.writer) {
      this.pendingRecords.push({
        t,
        m: methodId,
        l,
        ok: 0,
        ec: catInt,
        cc: classified.code,
        cn: this._concurrency,
        ph: this._phase,
      });
      this.pendingErrors.push({
        ec: catInt,
        cc: classified.code,
        msg: classified.message,
      });
    }

    // Forward to live dashboard (only active when --live)
    if (this._onEvent) {
      this._onEvent({
        t,
        method: this.methodNames[methodId],
        latencyMs: l,
        ok: false,
        error: classified.message,
        errorCategory: classified.category,
        errorCode: classified.code,
        concurrency: this._concurrency,
        phase: this._phase >= 0 ? this._phase : undefined,
      });
    }
  }

  /**
   * Flush pending records to the writer worker.
   * Called by a timer every 50ms — NOT in the hot path.
   */
  private flush(): void {
    if (this.pendingRecords.length === 0) return;

    // Send error messages first (they're few)
    for (const err of this.pendingErrors) {
      this.writer!.post({ type: "error_msg", ...err });
    }
    this.pendingErrors.length = 0;

    // Send records as a batch
    this.writer!.post({ type: "batch", records: this.pendingRecords });
    this.pendingRecords = [];
  }

  /**
   * Signal test completion. Flushes remaining records and notifies writer.
   */
  complete(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    this.writer?.post({ type: "complete" });
  }

  // ─── Accessors (used by runner for phase logic) ────────────────

  get total(): number {
    return this._total;
  }
  get errors(): number {
    return this._errors;
  }
  get elapsed(): number {
    return performance.now() - this.startTimeHr;
  }

  /**
   * Return a view over latencies recorded since startIdx. O(1), no copy.
   */
  latenciesSince(startIdx: number): Float64Array {
    if (startIdx >= this.latencyCount) return new Float64Array(0);
    return this.latencies.subarray(startIdx, this.latencyCount);
  }

  // ─── Internal ──────────────────────────────────────────────────

  private growLatencies(): void {
    const next = new Float64Array(this.latencies.length * 2);
    next.set(this.latencies);
    this.latencies = next;
  }
}
