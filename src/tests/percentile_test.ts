import { assertEquals } from "@std/assert";
import { percentile } from "../metrics/stats.ts";

Deno.test("percentile: empty array", () => {
  assertEquals(percentile([], 0.5), 0);
});

Deno.test("percentile: single element", () => {
  assertEquals(percentile([42], 0.5), 42);
  assertEquals(percentile([42], 0.99), 42);
});

Deno.test("percentile: p50 of even count", () => {
  const sorted = [1, 2, 3, 4];
  // p50 at index 1.5 → interpolate between 2 and 3 → 2.5
  assertEquals(percentile(sorted, 0.5), 2.5);
});

Deno.test("percentile: p50 of odd count", () => {
  const sorted = [1, 2, 3, 4, 5];
  assertEquals(percentile(sorted, 0.5), 3);
});

Deno.test("percentile: p0 and p100", () => {
  const sorted = [10, 20, 30, 40, 50];
  assertEquals(percentile(sorted, 0), 10);
  assertEquals(percentile(sorted, 1), 50);
});

Deno.test("percentile: p99 with 100 elements", () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  // p99 at index 98.01 → between 99 and 100 → 99.01
  const result = percentile(sorted, 0.99);
  assertEquals(result > 99, true);
  assertEquals(result <= 100, true);
});
