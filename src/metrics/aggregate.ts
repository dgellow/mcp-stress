/**
 * Aggregate multiple run summaries into mean ± stddev statistics.
 */

import type { LatencyStats, SummaryEvent } from "./events.ts";

export interface MeanStddev {
  mean: number;
  stddev: number;
}

export interface AggregateResult {
  count: number;
  durationMs: MeanStddev;
  totalRequests: MeanStddev;
  requestsPerSecond: MeanStddev;
  totalErrors: MeanStddev;
  errorRate: MeanStddev;
  overall: {
    p50: MeanStddev;
    p95: MeanStddev;
    p99: MeanStddev;
    mean: MeanStddev;
    min: MeanStddev;
    max: MeanStddev;
  };
}

export function meanStddev(values: number[]): MeanStddev {
  const n = values.length;
  if (n === 0) return { mean: 0, stddev: 0 };
  if (n === 1) return { mean: values[0], stddev: 0 };

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return { mean, stddev: Math.sqrt(variance) };
}

export function computeAggregate(summaries: SummaryEvent[]): AggregateResult {
  if (summaries.length === 0) {
    throw new Error("Cannot aggregate zero summaries");
  }

  const errorRates = summaries.map((s) =>
    s.totalRequests > 0 ? (s.totalErrors / s.totalRequests) * 100 : 0
  );

  return {
    count: summaries.length,
    durationMs: meanStddev(summaries.map((s) => s.durationMs)),
    totalRequests: meanStddev(summaries.map((s) => s.totalRequests)),
    requestsPerSecond: meanStddev(summaries.map((s) => s.requestsPerSecond)),
    totalErrors: meanStddev(summaries.map((s) => s.totalErrors)),
    errorRate: meanStddev(errorRates),
    overall: {
      p50: meanStddev(summaries.map((s) => s.overall.p50)),
      p95: meanStddev(summaries.map((s) => s.overall.p95)),
      p99: meanStddev(summaries.map((s) => s.overall.p99)),
      mean: meanStddev(summaries.map((s) => s.overall.mean)),
      min: meanStddev(summaries.map((s) => s.overall.min)),
      max: meanStddev(summaries.map((s) => s.overall.max)),
    },
  };
}

/**
 * Convert an AggregateResult to a SummaryEvent (using means).
 * This lets aggregate NDJSON files work with chart/compare.
 */
export function printAggregateSummary(agg: AggregateResult): void {
  const fmt = (ms: MeanStddev) =>
    `${ms.mean.toFixed(1)} ± ${ms.stddev.toFixed(1)}`;

  const lines: string[] = [];
  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push(`  AGGREGATE RESULTS  (${agg.count} runs)`);
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("");
  lines.push(`  Duration:     ${fmt(agg.durationMs)}ms`);
  lines.push(
    `  Requests:     ${fmt(agg.totalRequests)}  (${
      fmt(agg.requestsPerSecond)
    } req/s)`,
  );
  lines.push(
    `  Errors:       ${fmt(agg.totalErrors)}  (${fmt(agg.errorRate)}%)`,
  );
  lines.push("");
  lines.push("  Latency (ms):      mean ± stddev");
  lines.push(`    min:   ${fmt(agg.overall.min)}`);
  lines.push(`    mean:  ${fmt(agg.overall.mean)}`);
  lines.push(`    p50:   ${fmt(agg.overall.p50)}`);
  lines.push(`    p95:   ${fmt(agg.overall.p95)}`);
  lines.push(`    p99:   ${fmt(agg.overall.p99)}`);
  lines.push(`    max:   ${fmt(agg.overall.max)}`);
  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════");
  console.log(lines.join("\n"));
}

export function aggregateToSummary(agg: AggregateResult): SummaryEvent {
  const overall: LatencyStats = {
    count: Math.round(agg.totalRequests.mean),
    errors: Math.round(agg.totalErrors.mean),
    min: agg.overall.min.mean,
    max: agg.overall.max.mean,
    mean: agg.overall.mean.mean,
    p50: agg.overall.p50.mean,
    p95: agg.overall.p95.mean,
    p99: agg.overall.p99.mean,
  };

  return {
    type: "summary",
    durationMs: agg.durationMs.mean,
    totalRequests: Math.round(agg.totalRequests.mean),
    totalErrors: Math.round(agg.totalErrors.mean),
    requestsPerSecond: agg.requestsPerSecond.mean,
    overall,
    byMethod: [],
    errorsByCategory: {},
  };
}
