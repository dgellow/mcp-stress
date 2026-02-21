/**
 * Metrics collection, live reporting, and export.
 */

export interface RequestEvent {
  /** ms since test start */
  t: number;
  method: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
  /** concurrency level when this request was made (if tracked) */
  concurrency?: number;
}

export interface RequestRecord {
  method: string;
  startTime: number;
  latencyMs: number;
  success: boolean;
  errorCode?: number;
  errorMessage?: string;
}

export interface LatencyStats {
  count: number;
  errors: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MethodStats extends LatencyStats {
  method: string;
}

export interface WindowStats {
  windowStart: number;
  windowEnd: number;
  count: number;
  errors: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  concurrency?: number;
}

export interface RunMeta {
  scenario: string;
  shape?: string;
  concurrency: number;
  durationSec: number;
  tool?: string;
  serverCommand: string;
  serverArgs: string[];
  seed: number;
  startedAt: string;
  timeoutMs: number;
}

export class MetricsCollector {
  private records: RequestRecord[] = [];
  private events: RequestEvent[] = [];
  private _startTime = 0;
  private _endTime = 0;
  private _outputFile: Deno.FsFile | null = null;
  private _liveInterval: number | null = null;
  private _lastLiveCount = 0;
  private _currentConcurrency = 0;
  public runMeta: RunMeta | null = null;

  start(): void {
    this._startTime = performance.now();
  }

  stop(): void {
    this._endTime = performance.now();
    this.stopLive();
    if (this._outputFile) {
      this._outputFile.close();
      this._outputFile = null;
    }
  }

  set concurrency(n: number) {
    this._currentConcurrency = n;
  }

  /** Enable NDJSON output to a file. Writes meta header if runMeta is set. */
  async enableOutput(path: string): Promise<void> {
    this._outputFile = await Deno.open(path, { write: true, create: true, truncate: true });
    if (this.runMeta) {
      const line = JSON.stringify({ type: "meta", ...this.runMeta }) + "\n";
      this._outputFile.writeSync(new TextEncoder().encode(line));
    }
  }

  /** Record a successful request. */
  recordSuccess(method: string, latencyMs: number): void {
    const now = performance.now();
    this.records.push({
      method,
      startTime: now,
      latencyMs,
      success: true,
    });

    const event: RequestEvent = {
      t: Math.round(now - this._startTime),
      method,
      latencyMs: Math.round(latencyMs * 100) / 100,
      ok: true,
    };
    if (this._currentConcurrency > 0) event.concurrency = this._currentConcurrency;
    this.events.push(event);
    this._writeEvent(event);
  }

  /** Record a failed request. */
  recordError(
    method: string,
    latencyMs: number,
    errorCode?: number,
    errorMessage?: string,
  ): void {
    const now = performance.now();
    this.records.push({
      method,
      startTime: now,
      latencyMs,
      success: false,
      errorCode,
      errorMessage,
    });

    const event: RequestEvent = {
      t: Math.round(now - this._startTime),
      method,
      latencyMs: Math.round(latencyMs * 100) / 100,
      ok: false,
      error: errorMessage ?? `code:${errorCode}`,
    };
    if (this._currentConcurrency > 0) event.concurrency = this._currentConcurrency;
    this.events.push(event);
    this._writeEvent(event);
  }

  private _writeEvent(event: RequestEvent): void {
    if (!this._outputFile) return;
    const line = JSON.stringify(event) + "\n";
    this._outputFile.writeSync(new TextEncoder().encode(line));
  }

  /** Start printing live stats every second to stderr. */
  startLive(): void {
    this._lastLiveCount = 0;
    this._liveInterval = setInterval(() => {
      this._printLive();
    }, 1000) as unknown as number;
  }

  stopLive(): void {
    if (this._liveInterval !== null) {
      clearInterval(this._liveInterval);
      this._liveInterval = null;
      // Print final line
      this._printLive();
      console.error(""); // newline after live output
    }
  }

  private _printLive(): void {
    const elapsed = (performance.now() - this._startTime) / 1000;
    const total = this.records.length;
    const errors = this.records.filter((r) => !r.success).length;

    // Requests in the last second
    const windowReqs = total - this._lastLiveCount;
    this._lastLiveCount = total;

    // Recent latency stats (last 2 seconds of data)
    const cutoff = performance.now() - 2000;
    const recent = this.records.filter((r) => r.startTime >= cutoff);
    const recentLatencies = recent.map((r) => r.latencyMs).sort((a, b) => a - b);

    const p50 = recentLatencies.length > 0 ? percentile(recentLatencies, 0.5) : 0;
    const p99 = recentLatencies.length > 0 ? percentile(recentLatencies, 0.99) : 0;

    const concStr = this._currentConcurrency > 0 ? `c=${this._currentConcurrency} ` : "";
    const sec = Math.floor(elapsed).toString().padStart(3, " ");
    const errStr = errors > 0 ? `\x1b[31merr=${errors}\x1b[0m` : `err=0`;

    console.error(
      `  [${sec}s] ${concStr}${total} req  ${windowReqs} req/s  p50=${p50.toFixed(0)}ms  p99=${p99.toFixed(0)}ms  ${errStr}`,
    );
  }

  /** Get windowed stats — one entry per second. */
  windowedStats(windowMs = 1000): WindowStats[] {
    if (this.events.length === 0) return [];
    const result: WindowStats[] = [];
    const duration = this.events[this.events.length - 1].t;
    const startMs = 0;

    for (let ws = startMs; ws < duration; ws += windowMs) {
      const we = ws + windowMs;
      const windowEvents = this.events.filter((e) => e.t >= ws && e.t < we);
      if (windowEvents.length === 0) continue;

      const latencies = windowEvents.map((e) => e.latencyMs).sort((a, b) => a - b);
      const errors = windowEvents.filter((e) => !e.ok).length;
      const conc = windowEvents.find((e) => e.concurrency !== undefined)?.concurrency;

      result.push({
        windowStart: ws,
        windowEnd: we,
        count: windowEvents.length,
        errors,
        rps: (windowEvents.length / windowMs) * 1000,
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        concurrency: conc,
      });
    }

    return result;
  }

  get totalRequests(): number {
    return this.records.length;
  }

  get totalErrors(): number {
    return this.records.filter((r) => !r.success).length;
  }

  get elapsedMs(): number {
    const end = this._endTime || performance.now();
    return end - this._startTime;
  }

  get requestsPerSecond(): number {
    const elapsed = this.elapsedMs;
    if (elapsed === 0) return 0;
    return (this.records.length / elapsed) * 1000;
  }

  errorSummary(): Map<string, number> {
    const errors = new Map<string, number>();
    for (const r of this.records) {
      if (!r.success) {
        const key = r.errorMessage ?? `code:${r.errorCode ?? "unknown"}`;
        errors.set(key, (errors.get(key) ?? 0) + 1);
      }
    }
    return errors;
  }

  overallStats(): LatencyStats {
    return computeStats(this.records);
  }

  statsByMethod(): MethodStats[] {
    const byMethod = new Map<string, RequestRecord[]>();
    for (const r of this.records) {
      const list = byMethod.get(r.method) ?? [];
      list.push(r);
      byMethod.set(r.method, list);
    }

    const result: MethodStats[] = [];
    for (const [method, records] of byMethod) {
      result.push({ method, ...computeStats(records) });
    }
    return result.sort((a, b) => a.method.localeCompare(b.method));
  }

  raw(): RequestRecord[] {
    return [...this.records];
  }

  rawEvents(): RequestEvent[] {
    return [...this.events];
  }

  summary(): string {
    const lines: string[] = [];
    const overall = this.overallStats();
    const elapsed = this.elapsedMs;

    lines.push("");
    lines.push("═══════════════════════════════════════════════════════════");
    lines.push("  RESULTS");
    lines.push("═══════════════════════════════════════════════════════════");
    lines.push("");
    lines.push(`  Duration:     ${(elapsed / 1000).toFixed(2)}s`);
    lines.push(`  Requests:     ${this.totalRequests}  (${this.requestsPerSecond.toFixed(1)} req/s)`);
    lines.push(
      `  Errors:       ${this.totalErrors}  (${this.totalRequests > 0 ? ((this.totalErrors / this.totalRequests) * 100).toFixed(1) : 0}%)`,
    );
    lines.push("");

    if (this.totalRequests > 0) {
      lines.push("  Latency (ms):");
      lines.push(
        `    min=${overall.min.toFixed(1)}  mean=${overall.mean.toFixed(1)}  max=${overall.max.toFixed(1)}`,
      );
      lines.push(
        `    p50=${overall.p50.toFixed(1)}  p95=${overall.p95.toFixed(1)}  p99=${overall.p99.toFixed(1)}`,
      );
    }

    const byMethod = this.statsByMethod();
    if (byMethod.length > 1) {
      lines.push("");
      lines.push("  By method:");
      for (const m of byMethod) {
        lines.push(
          `    ${m.method}: n=${m.count} err=${m.errors} p50=${m.p50.toFixed(1)} p95=${m.p95.toFixed(1)} p99=${m.p99.toFixed(1)}`,
        );
      }
    }

    const errors = this.errorSummary();
    if (errors.size > 0) {
      lines.push("");
      lines.push("  Errors:");
      for (const [msg, count] of errors) {
        lines.push(`    ${count}x  ${msg}`);
      }
    }

    lines.push("");
    lines.push("═══════════════════════════════════════════════════════════");
    return lines.join("\n");
  }

  toJSON(): Record<string, unknown> {
    return {
      durationMs: this.elapsedMs,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      requestsPerSecond: this.requestsPerSecond,
      overall: this.overallStats(),
      byMethod: this.statsByMethod(),
      errors: Object.fromEntries(this.errorSummary()),
      windows: this.windowedStats(),
      events: this.events,
    };
  }
}

function computeStats(records: RequestRecord[]): LatencyStats {
  if (records.length === 0) {
    return { count: 0, errors: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  }

  const latencies = records.map((r) => r.latencyMs).sort((a, b) => a - b);
  const errors = records.filter((r) => !r.success).length;
  const sum = latencies.reduce((a, b) => a + b, 0);

  return {
    count: records.length,
    errors,
    min: latencies[0],
    max: latencies[latencies.length - 1],
    mean: sum / latencies.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
