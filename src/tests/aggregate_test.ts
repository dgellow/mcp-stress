import { assertEquals, assertThrows } from "@std/assert";
import {
  aggregateToSummary,
  computeAggregate,
  meanStddev,
} from "../metrics/aggregate.ts";
import type { SummaryEvent } from "../metrics/events.ts";

// ── meanStddev ──────────────────────────────────────────────────

Deno.test("meanStddev: empty array returns zeros", () => {
  const result = meanStddev([]);
  assertEquals(result.mean, 0);
  assertEquals(result.stddev, 0);
});

Deno.test("meanStddev: single value has zero stddev", () => {
  const result = meanStddev([42]);
  assertEquals(result.mean, 42);
  assertEquals(result.stddev, 0);
});

Deno.test("meanStddev: known values", () => {
  // [2, 4, 4, 4, 5, 5, 7, 9] — mean=5, population stddev=2, sample stddev≈2.138
  const result = meanStddev([2, 4, 4, 4, 5, 5, 7, 9]);
  assertAlmostEquals(result.mean, 5.0);
  assertAlmostEquals(result.stddev, 2.138, 0.001);
});

Deno.test("meanStddev: identical values have zero stddev", () => {
  const result = meanStddev([10, 10, 10, 10]);
  assertEquals(result.mean, 10);
  assertEquals(result.stddev, 0);
});

// ── computeAggregate ────────────────────────────────────────────

function makeSummary(overrides: Partial<SummaryEvent> = {}): SummaryEvent {
  return {
    type: "summary",
    durationMs: 10000,
    totalRequests: 100,
    totalErrors: 2,
    requestsPerSecond: 10,
    overall: {
      count: 100,
      errors: 2,
      min: 5,
      max: 200,
      mean: 50,
      p50: 45,
      p95: 150,
      p99: 190,
    },
    byMethod: [],
    errorsByCategory: {},
    ...overrides,
  };
}

Deno.test("computeAggregate: throws on empty input", () => {
  assertThrows(
    () => computeAggregate([]),
    Error,
    "Cannot aggregate zero summaries",
  );
});

Deno.test("computeAggregate: single summary returns zero stddev", () => {
  const agg = computeAggregate([makeSummary()]);
  assertEquals(agg.count, 1);
  assertEquals(agg.durationMs.mean, 10000);
  assertEquals(agg.durationMs.stddev, 0);
  assertEquals(agg.overall.p50.mean, 45);
  assertEquals(agg.overall.p50.stddev, 0);
});

Deno.test("computeAggregate: two summaries with different values", () => {
  const s1 = makeSummary({ requestsPerSecond: 10 });
  const s2 = makeSummary({ requestsPerSecond: 20 });
  const agg = computeAggregate([s1, s2]);

  assertEquals(agg.count, 2);
  assertAlmostEquals(agg.requestsPerSecond.mean, 15.0);
  // stddev of [10, 20] with sample stddev: sqrt(((10-15)^2 + (20-15)^2) / 1) = sqrt(50) ≈ 7.071
  assertAlmostEquals(agg.requestsPerSecond.stddev, 7.071, 0.001);
});

Deno.test("computeAggregate: error rate computed correctly", () => {
  const s1 = makeSummary({ totalRequests: 100, totalErrors: 5 });
  const s2 = makeSummary({ totalRequests: 200, totalErrors: 10 });
  const agg = computeAggregate([s1, s2]);

  // Error rates: 5% and 5%, so mean=5, stddev=0
  assertAlmostEquals(agg.errorRate.mean, 5.0);
  assertAlmostEquals(agg.errorRate.stddev, 0);
});

Deno.test("computeAggregate: latency stats aggregated across runs", () => {
  const s1 = makeSummary();
  s1.overall.p99 = 100;
  const s2 = makeSummary();
  s2.overall.p99 = 200;
  const s3 = makeSummary();
  s3.overall.p99 = 150;

  const agg = computeAggregate([s1, s2, s3]);
  assertAlmostEquals(agg.overall.p99.mean, 150.0);
  // stddev of [100, 200, 150]: mean=150, variance = ((100-150)^2 + (200-150)^2 + (150-150)^2) / 2 = 2500
  assertAlmostEquals(agg.overall.p99.stddev, 50.0);
});

// ── aggregateToSummary ──────────────────────────────────────────

Deno.test("aggregateToSummary: produces valid SummaryEvent from aggregate", () => {
  const s1 = makeSummary({ totalRequests: 100, requestsPerSecond: 10 });
  const s2 = makeSummary({ totalRequests: 200, requestsPerSecond: 20 });
  const agg = computeAggregate([s1, s2]);
  const summary = aggregateToSummary(agg);

  assertEquals(summary.type, "summary");
  assertEquals(summary.totalRequests, 150); // rounded mean
  assertAlmostEquals(summary.requestsPerSecond, 15.0);
  assertEquals(summary.byMethod.length, 0);
});

Deno.test("aggregateToSummary: latency values use means", () => {
  const s1 = makeSummary();
  s1.overall.p50 = 40;
  const s2 = makeSummary();
  s2.overall.p50 = 60;
  const agg = computeAggregate([s1, s2]);
  const summary = aggregateToSummary(agg);

  assertAlmostEquals(summary.overall.p50, 50.0);
});

// ── Helper ──────────────────────────────────────────────────────

function assertAlmostEquals(
  actual: number,
  expected: number,
  tolerance = 0.01,
): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `Expected ${actual} to be close to ${expected} (tolerance: ${tolerance})`,
    );
  }
}
