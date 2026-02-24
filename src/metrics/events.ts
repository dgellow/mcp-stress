/**
 * NDJSON event types.
 */

import type { ErrorCategory } from "../transport/types.ts";

export interface MetaEvent {
  type: "meta";
  name?: string;
  profile: string;
  shape: string;
  concurrency: number;
  durationSec: number;
  requests?: number;
  tool?: string;
  transport: "stdio" | "sse" | "streamable-http";
  target: string;
  seed: number;
  startedAt: string;
  timeoutMs: number;
  command: string;
}

export interface RequestEvent {
  t: number;
  method: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
  errorCategory?: ErrorCategory;
  errorCode?: number;
  concurrency?: number;
  phase?: number;
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

export interface SummaryEvent {
  type: "summary";
  durationMs: number;
  totalRequests: number;
  totalErrors: number;
  requestsPerSecond: number;
  overall: LatencyStats;
  byMethod: MethodStats[];
  errorsByCategory: Record<string, number>;
}
