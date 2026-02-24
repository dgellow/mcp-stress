/**
 * End-to-end overhead benchmark using Deno.bench.
 *
 * Measures how much the recorder + writer pipeline costs by comparing:
 * 1. Tight async loop (no recording)
 * 2. Same loop with recorder.success() calls
 * 3. Same loop with recorder + writer worker (full pipeline)
 * 4. Inlined .then()/.catch() pattern (current production path)
 *
 * Run: deno bench --allow-read --allow-write --allow-env bench/e2e_overhead.ts
 */

import { Recorder } from "../src/metrics/recorder.ts";
import { Writer } from "../src/metrics/writer.ts";

// Fake request — resolves immediately, simulates zero-latency transport
function fakeRequest(): Promise<{ latencyMs: number }> {
  return Promise.resolve({ latencyMs: 0.42 });
}

// ─── 1. Baseline: just await a resolved promise ─────────────

Deno.bench("baseline (await resolved promise)", async () => {
  await fakeRequest();
});

// ─── 2. Recorder only (no writer, no I/O) ───────────────────

{
  const recorder = new Recorder();
  const methodId = recorder.registerMethod("ping");
  recorder.start();

  Deno.bench("recorder.success() only", async () => {
    const { latencyMs } = await fakeRequest();
    recorder.success(methodId, latencyMs);
  });
}

// ─── 3. Recorder + writer worker (no file output) ───────────

{
  const recorder = new Recorder();
  const methodId = recorder.registerMethod("ping");
  const writer = new Writer({});
  recorder.connectWriter(writer);
  recorder.start();

  Deno.bench("recorder + writer (no file)", async () => {
    const { latencyMs } = await fakeRequest();
    recorder.success(methodId, latencyMs);
  });
}

// ─── 4. Recorder + writer + file I/O ────────────────────────

{
  const tmpFile = await Deno.makeTempFile({ suffix: ".ndjson" });
  const recorder = new Recorder();
  const methodId = recorder.registerMethod("ping");
  const writer = new Writer({
    outputPath: tmpFile,
    meta: {
      type: "meta",
      profile: "bench",
      shape: "constant",
      concurrency: 1,
      durationSec: 0,
      transport: "stdio",
      target: "bench",
      seed: 0,
      startedAt: new Date().toISOString(),
      timeoutMs: 30000,
      command: "bench",
    },
  });
  recorder.connectWriter(writer);
  recorder.start();

  Deno.bench("recorder + writer + file I/O", async () => {
    const { latencyMs } = await fakeRequest();
    recorder.success(methodId, latencyMs);
  });
}

// ─── 5. .then()/.catch() inlined (production pattern) ───────

{
  const recorder = new Recorder();
  const methodId = recorder.registerMethod("ping");
  const writer = new Writer({});
  recorder.connectWriter(writer);
  recorder.start();

  Deno.bench(".then/.catch inlined (production pattern)", () => {
    return fakeRequest().then(
      ({ latencyMs }) => recorder.success(methodId, latencyMs),
      (e) => recorder.error(methodId, 0, e),
    );
  });
}

// ─── 6. try/catch for comparison ────────────────────────────

{
  const recorder = new Recorder();
  const methodId = recorder.registerMethod("ping");
  const writer = new Writer({});
  recorder.connectWriter(writer);
  recorder.start();

  Deno.bench("try/catch inlined (for comparison)", async () => {
    try {
      const { latencyMs } = await fakeRequest();
      recorder.success(methodId, latencyMs);
    } catch (e) {
      recorder.error(methodId, 0, e);
    }
  });
}
