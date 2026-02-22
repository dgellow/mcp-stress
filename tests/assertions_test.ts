import { assertEquals, assertThrows } from "@std/assert";
import {
  evaluateAssertions,
  metricsToAssertionMap,
  parseAssertions,
} from "../src/engine/assertions.ts";

Deno.test("parseAssertions: basic operators", () => {
  const result = parseAssertions(["p99 < 500ms"]);
  assertEquals(result.length, 1);
  assertEquals(result[0].metric, "p99");
  assertEquals(result[0].operator, "<");
  assertEquals(result[0].value, 500);
  assertEquals(result[0].unit, "ms");
});

Deno.test("parseAssertions: percentage", () => {
  const result = parseAssertions(["error_rate < 1%"]);
  assertEquals(result[0].metric, "error_rate");
  assertEquals(result[0].value, 1);
  assertEquals(result[0].unit, "%");
});

Deno.test("parseAssertions: seconds to ms conversion", () => {
  const result = parseAssertions(["p50 < 2s"]);
  assertEquals(result[0].value, 2000);
});

Deno.test("parseAssertions: no unit", () => {
  const result = parseAssertions(["rps > 100"]);
  assertEquals(result[0].metric, "rps");
  assertEquals(result[0].value, 100);
  assertEquals(result[0].unit, "");
});

Deno.test("parseAssertions: multi-char operators", () => {
  const le = parseAssertions(["p99 <= 500ms"]);
  assertEquals(le[0].operator, "<=");

  const ge = parseAssertions(["rps >= 10"]);
  assertEquals(ge[0].operator, ">=");

  const ne = parseAssertions(["errors != 0"]);
  assertEquals(ne[0].operator, "!=");
});

Deno.test("parseAssertions: invalid expression throws", () => {
  assertThrows(() => parseAssertions(["garbage"]), Error, "Invalid assertion");
});

Deno.test("parseAssertions: invalid value throws", () => {
  assertThrows(
    () => parseAssertions(["p99 < abc"]),
    Error,
    "Invalid assertion value",
  );
});

Deno.test("evaluateAssertions: pass and fail", () => {
  const assertions = parseAssertions(["p99 < 500ms", "rps > 100"]);
  const stats = { p99: 300, rps: 50 };
  const results = evaluateAssertions(assertions, stats);

  assertEquals(results[0].passed, true); // 300 < 500
  assertEquals(results[0].actual, 300);
  assertEquals(results[1].passed, false); // 50 > 100
  assertEquals(results[1].actual, 50);
});

Deno.test("evaluateAssertions: missing metric fails", () => {
  const assertions = parseAssertions(["nonexistent < 100"]);
  const results = evaluateAssertions(assertions, {});
  assertEquals(results[0].passed, false);
  assertEquals(isNaN(results[0].actual), true);
});

Deno.test("metricsToAssertionMap: extracts all metrics", () => {
  const map = metricsToAssertionMap({
    requestsPerSecond: 42.5,
    overall: { p50: 10, p95: 50, p99: 100, min: 1, max: 200, mean: 30 },
    totalErrors: 3,
    totalRequests: 100,
  });

  assertEquals(map.rps, 42.5);
  assertEquals(map.p50, 10);
  assertEquals(map.p99, 100);
  assertEquals(map.error_rate, 3);
  assertEquals(map.errors, 3);
  assertEquals(map.requests, 100);
});
