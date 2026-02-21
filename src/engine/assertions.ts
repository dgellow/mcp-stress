/**
 * Parse and evaluate --assert expressions for CI.
 *
 * Syntax: "<metric> <op> <value>[unit]"
 * Examples: "p99 < 500ms", "error_rate < 1%", "rps > 100"
 */

export interface Assertion {
  metric: string;
  operator: "<" | ">" | "<=" | ">=" | "==" | "!=";
  value: number;
  unit: string;
  raw: string;
}

export interface AssertionResult {
  assertion: Assertion;
  actual: number;
  passed: boolean;
}

const OPS = ["<=", ">=", "!=", "==", "<", ">"] as const;

export function parseAssertions(exprs: string[]): Assertion[] {
  return exprs.map((raw) => {
    const trimmed = raw.trim();
    let found: { metric: string; op: string; rest: string } | null = null;

    for (const op of OPS) {
      const idx = trimmed.indexOf(op);
      if (idx > 0) {
        found = {
          metric: trimmed.slice(0, idx).trim(),
          op,
          rest: trimmed.slice(idx + op.length).trim(),
        };
        break;
      }
    }

    if (!found) {
      throw new Error(
        `Invalid assertion: "${raw}". Expected format: "metric < value"`,
      );
    }

    // Parse value and unit
    const match = found.rest.match(/^([\d.]+)\s*(ms|%|s)?$/);
    if (!match) {
      throw new Error(`Invalid assertion value: "${found.rest}" in "${raw}"`);
    }

    let value = parseFloat(match[1]);
    const unit = match[2] ?? "";

    // Normalize: seconds to ms
    if (unit === "s") value *= 1000;

    return {
      metric: found.metric,
      operator: found.op as Assertion["operator"],
      value,
      unit,
      raw,
    };
  });
}

export function evaluateAssertions(
  assertions: Assertion[],
  stats: Record<string, number>,
): AssertionResult[] {
  return assertions.map((assertion) => {
    const actual = stats[assertion.metric];
    if (actual === undefined) {
      return { assertion, actual: NaN, passed: false };
    }

    let passed: boolean;
    switch (assertion.operator) {
      case "<":
        passed = actual < assertion.value;
        break;
      case ">":
        passed = actual > assertion.value;
        break;
      case "<=":
        passed = actual <= assertion.value;
        break;
      case ">=":
        passed = actual >= assertion.value;
        break;
      case "==":
        passed = actual === assertion.value;
        break;
      case "!=":
        passed = actual !== assertion.value;
        break;
    }

    return { assertion, actual, passed };
  });
}

/** Extract flat metric map from collector stats for assertion evaluation. */
export function metricsToAssertionMap(stats: {
  requestsPerSecond: number;
  overall: {
    p50: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
    mean: number;
  };
  totalErrors: number;
  totalRequests: number;
}): Record<string, number> {
  return {
    rps: stats.requestsPerSecond,
    p50: stats.overall.p50,
    p95: stats.overall.p95,
    p99: stats.overall.p99,
    min: stats.overall.min,
    max: stats.overall.max,
    mean: stats.overall.mean,
    error_rate: stats.totalRequests > 0
      ? (stats.totalErrors / stats.totalRequests) * 100
      : 0,
    errors: stats.totalErrors,
    requests: stats.totalRequests,
  };
}
