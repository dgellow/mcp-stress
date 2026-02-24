/**
 * Microbenchmark: isolate what's expensive in the recorder hot path.
 *
 * Run: deno bench bench/overhead_bench.ts
 */

// 1. Baseline
Deno.bench("baseline (empty)", () => {});

// 2. performance.now()
Deno.bench("performance.now()", () => {
  performance.now();
});

// 3. Math.round
let _sink = 0;
Deno.bench("Math.round(float * 100) / 100", () => {
  _sink = Math.round(123.456789 * 100) / 100;
});

// 4. Object literal + array push
{
  const objects: unknown[] = [];
  Deno.bench("object literal + push", (b) => {
    b.start();
    objects.push({
      t: 1234,
      m: 0,
      l: 45.67,
      ok: 1,
      ec: 0,
      cc: 0,
      cn: 3,
      ph: -1,
    });
    b.end();
    if (objects.length > 100_000) objects.length = 0;
  });
}

// 5. Push to two arrays (current recorder pattern)
{
  const arr1: unknown[] = [];
  const arr2: unknown[] = [];
  Deno.bench("object + push to TWO arrays (current pattern)", (b) => {
    b.start();
    const obj = { t: 1234, m: 0, l: 45.67, ok: 1, ec: 0, cc: 0, cn: 3, ph: -1 };
    arr1.push(obj);
    arr2.push(obj);
    b.end();
    if (arr1.length > 100_000) {
      arr1.length = 0;
      arr2.length = 0;
    }
  });
}

// 6. Full current recorder hot path (perf.now + math + object + two pushes + counter)
{
  const recArr: unknown[] = [];
  const pendArr: unknown[] = [];
  const startTime = performance.now();
  let total = 0;
  Deno.bench("FULL recorder hot path (current)", (b) => {
    b.start();
    const record = {
      t: Math.round(performance.now() - startTime),
      m: 0,
      l: Math.round(45.67 * 100) / 100,
      ok: 1 as const,
      ec: 0,
      cc: 0,
      cn: 3,
      ph: -1,
    };
    recArr.push(record);
    pendArr.push(record);
    total++;
    b.end();
    if (recArr.length > 100_000) {
      recArr.length = 0;
      pendArr.length = 0;
    }
  });
}

// 7. Columnar typed arrays (alternative)
{
  const colT = new Float64Array(10_000_000);
  const colM = new Int32Array(10_000_000);
  const colL = new Float64Array(10_000_000);
  const colOk = new Uint8Array(10_000_000);
  let colIdx = 0;
  const startTime2 = performance.now();
  Deno.bench("columnar typed arrays (alternative)", (b) => {
    b.start();
    const i = colIdx++;
    colT[i] = Math.round(performance.now() - startTime2);
    colM[i] = 0;
    colL[i] = Math.round(45.67 * 100) / 100;
    colOk[i] = 1;
    b.end();
    if (colIdx >= 10_000_000) colIdx = 0;
  });
}

// 8. Just array.push (number only)
{
  const nums: number[] = [];
  Deno.bench("array push (number)", (b) => {
    b.start();
    nums.push(123.456);
    b.end();
    if (nums.length > 100_000) nums.length = 0;
  });
}

// 9. Typed array write (pre-allocated)
{
  const ta = new Float64Array(10_000_000);
  let taIdx = 0;
  Deno.bench("typed array write (pre-allocated)", (b) => {
    b.start();
    ta[taIdx++] = 123.456;
    b.end();
    if (taIdx >= 10_000_000) taIdx = 0;
  });
}

// 10. postMessage overhead simulation (structured clone of small object)
{
  const { port1, port2 } = new MessageChannel();
  let received = 0;
  port2.onmessage = () => {
    received++;
  };
  Deno.bench("postMessage (small object, MessageChannel)", async (b) => {
    b.start();
    port1.postMessage({
      t: 1234,
      m: 0,
      l: 45.67,
      ok: 1,
      ec: 0,
      cc: 0,
      cn: 3,
      ph: -1,
    });
    b.end();
    // Let the message drain
    await new Promise((r) => setTimeout(r, 0));
  });
}

// 11. postMessage batch (100 records as array)
{
  const { port1, port2 } = new MessageChannel();
  let received = 0;
  port2.onmessage = () => {
    received++;
  };
  const batch: unknown[] = [];
  for (let i = 0; i < 100; i++) {
    batch.push({ t: 1234, m: 0, l: 45.67, ok: 1, ec: 0, cc: 0, cn: 3, ph: -1 });
  }
  Deno.bench("postMessage (batch of 100, amortized per record)", async (b) => {
    b.start();
    port1.postMessage(batch);
    b.end();
    await new Promise((r) => setTimeout(r, 0));
  });
}
