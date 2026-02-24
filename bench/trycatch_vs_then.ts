/**
 * Benchmark: try/catch vs .then/.catch vs other error handling patterns.
 *
 * Run: deno bench --allow-read --allow-write --allow-env bench/trycatch_vs_then.ts
 */

import { Recorder } from "../src/metrics/recorder.ts";

function fakeRequest(): Promise<{ latencyMs: number }> {
  return Promise.resolve({ latencyMs: 0.42 });
}

// ─── Baseline ────────────────────────────────────────────────

Deno.bench("baseline (await only)", async () => {
  await fakeRequest();
});

// ─── Pattern 1: try/catch (current) ─────────────────────────

{
  const recorder = new Recorder();
  const mid = recorder.registerMethod("ping");
  recorder.start();

  Deno.bench("try/catch", async () => {
    try {
      const { latencyMs } = await fakeRequest();
      recorder.success(mid, latencyMs);
    } catch {
      recorder.error(mid, 0, new Error("fail"));
    }
  });
}

// ─── Pattern 2: .then/.catch ────────────────────────────────

{
  const recorder = new Recorder();
  const mid = recorder.registerMethod("ping");
  recorder.start();

  Deno.bench(".then/.catch", () => {
    return fakeRequest().then(
      ({ latencyMs }) => recorder.success(mid, latencyMs),
      (e) => recorder.error(mid, 0, e),
    );
  });
}

// ─── Pattern 3: await with no try/catch, error ignored ──────

{
  const recorder = new Recorder();
  const mid = recorder.registerMethod("ping");
  recorder.start();

  Deno.bench("await, no try/catch (success only)", async () => {
    const { latencyMs } = await fakeRequest();
    recorder.success(mid, latencyMs);
  });
}

// ─── Pattern 4: .then only (no error handling) ──────────────

{
  const recorder = new Recorder();
  const mid = recorder.registerMethod("ping");
  recorder.start();

  Deno.bench(".then only (no error handling)", () => {
    return fakeRequest().then(
      ({ latencyMs }) => recorder.success(mid, latencyMs),
    );
  });
}

// ─── Pattern 5: Date.now() instead of performance.now() ─────

{
  const recorder = new Recorder();
  const mid = recorder.registerMethod("ping");
  // Simulating what success() does but with Date.now()
  const records: unknown[] = [];
  const startTime = Date.now();

  Deno.bench("Date.now() based recording", async () => {
    const { latencyMs } = await fakeRequest();
    records.push({
      t: Date.now() - startTime,
      m: mid,
      l: latencyMs,
      ok: 1,
      ec: 0,
      cc: 0,
      cn: 0,
      ph: -1,
    });
    if (records.length > 100_000) records.length = 0;
  });
}

// ─── Pattern 6: No timestamp in hot path ────────────────────
// Pre-compute timestamp from a timer instead of per-record

{
  const recorder = new Recorder();
  const mid = recorder.registerMethod("ping");
  const records: unknown[] = [];
  let currentT = 0;
  const timer = setInterval(() => {
    currentT = performance.now();
  }, 1);

  Deno.bench("cached timestamp (1ms resolution)", async () => {
    const { latencyMs } = await fakeRequest();
    records.push({
      t: currentT,
      m: mid,
      l: latencyMs,
      ok: 1,
      ec: 0,
      cc: 0,
      cn: 0,
      ph: -1,
    });
    if (records.length > 100_000) records.length = 0;
  });

  // cleanup handled by process exit
}

// ─── Pattern 7: SharedArrayBuffer (no postMessage needed) ───

{
  // Simulate writing to a SharedArrayBuffer — flat numeric writes
  const sab = new SharedArrayBuffer(8 * 1_000_000); // 1M slots
  const view = new Float64Array(sab);
  let idx = 0;

  Deno.bench("SharedArrayBuffer write (latency only)", async () => {
    const { latencyMs } = await fakeRequest();
    view[idx++] = latencyMs;
    if (idx >= 1_000_000) idx = 0;
  });
}

// ─── Pattern 8: Pre-allocated ring buffer (typed arrays) ────

{
  const SIZE = 1_000_000;
  const timestamps = new Float64Array(SIZE);
  const methods = new Int32Array(SIZE);
  const latencies = new Float64Array(SIZE);
  const flags = new Uint8Array(SIZE); // ok/error
  let idx = 0;
  const startTime = performance.now();

  Deno.bench("ring buffer (typed arrays, all fields)", async () => {
    const { latencyMs } = await fakeRequest();
    const i = idx++ % SIZE;
    timestamps[i] = performance.now() - startTime;
    methods[i] = 0;
    latencies[i] = latencyMs;
    flags[i] = 1;
  });
}
