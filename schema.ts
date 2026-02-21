/**
 * Generate sample arguments from a JSON Schema.
 * Produces minimally valid payloads for stress testing.
 */

// Realistic word pools for generating varied string inputs
const NOUNS = [
  "user", "account", "order", "product", "session", "token", "payment",
  "invoice", "customer", "item", "cart", "subscription", "webhook", "event",
  "metric", "log", "error", "config", "setting", "permission", "role",
  "team", "project", "deployment", "pipeline", "build", "release", "tag",
  "branch", "commit", "review", "comment", "notification", "alert", "rule",
  "policy", "secret", "key", "certificate", "domain", "endpoint", "route",
  "service", "cluster", "node", "pod", "container", "volume", "network",
];
const VERBS = [
  "create", "update", "delete", "list", "get", "fetch", "search", "find",
  "filter", "sort", "validate", "check", "verify", "process", "handle",
  "transform", "parse", "render", "deploy", "monitor", "debug", "trace",
];
const ADJECTIVES = [
  "active", "pending", "failed", "new", "old", "latest", "recent",
  "critical", "high", "low", "default", "custom", "internal", "external",
  "primary", "secondary", "temporary", "permanent", "archived", "deleted",
];
const PHRASES = [
  "how to", "what is", "error in", "timeout on", "rate limit",
  "connection refused", "authentication failed", "invalid request",
  "missing field", "unexpected response", "slow query", "high latency",
  "memory usage", "cpu spike", "disk full", "network error",
];

// ─── Seeded PRNG (mulberry32) ───────────────────────────────────

let _rngState = Date.now() | 0;

/** Set the global seed. Returns the seed used. */
export function setSeed(seed?: number): number {
  _rngState = seed ?? (Date.now() ^ (rng() * 0xffffffff)) | 0;
  return _rngState;
}

/** Get the current seed. */
export function getSeed(): number {
  return _rngState;
}

function rng(): number {
  let t = (_rngState += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randomWord(): string {
  const pool = rng();
  if (pool < 0.4) return pick(NOUNS);
  if (pool < 0.7) return pick(VERBS);
  if (pool < 0.85) return pick(ADJECTIVES);
  return pick(PHRASES);
}

/** Generate a random string that looks like a realistic query/input. */
function randomString(minLen = 0): string {
  const wordCount = 1 + Math.floor(rng() * 4);
  let result = Array.from({ length: wordCount }, () => randomWord()).join(" ");
  while (result.length < minLen) {
    result += " " + randomWord();
  }
  return result;
}

/** Generate a random identifier-style string. */
function randomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const len = 8 + Math.floor(rng() * 16);
  return Array.from({ length: len }, () => chars[Math.floor(rng() * chars.length)]).join("");
}

export function generateArgsFromSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return {};

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return {};

  const required = (schema.required as string[]) ?? [];
  const result: Record<string, unknown> = {};

  for (const [name, prop] of Object.entries(properties)) {
    if (!required.includes(name)) continue;
    result[name] = generateValue(prop);
  }

  return result;
}

/** Generate all possible args (required + optional). */
export function generateFullArgsFromSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return {};

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return {};

  const result: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(properties)) {
    result[name] = generateValue(prop);
  }
  return result;
}

function generateValue(prop: Record<string, unknown>): unknown {
  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum[0];
  }
  if ("const" in prop) return prop.const;
  if ("default" in prop) return prop.default;

  const type = prop.type as string | string[] | undefined;
  const resolvedType = Array.isArray(type) ? type[0] : type;

  switch (resolvedType) {
    case "string": {
      const format = prop.format as string | undefined;
      if (format === "uri" || format === "url") return "https://example.com";
      if (format === "email") return "test@example.com";
      if (format === "date") return "2025-01-01";
      if (format === "date-time") return "2025-01-01T00:00:00Z";
      const minLen = (prop.minLength as number) ?? 0;
      return "test".padEnd(minLen, "x");
    }
    case "number":
    case "integer": {
      const min = (prop.minimum as number) ?? 0;
      const max = (prop.maximum as number) ?? min + 100;
      return Math.floor((min + max) / 2);
    }
    case "boolean":
      return true;
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      return items ? [generateValue(items)] : [];
    }
    case "object": {
      const nested = prop.properties as Record<string, Record<string, unknown>> | undefined;
      if (nested) {
        const obj: Record<string, unknown> = {};
        const req = (prop.required as string[]) ?? [];
        for (const [k, v] of Object.entries(nested)) {
          if (req.includes(k)) obj[k] = generateValue(v);
        }
        return obj;
      }
      return {};
    }
    default:
      return "test";
  }
}

/** Generate randomized args — every call produces different values. */
export function generateRandomArgsFromSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return {};

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return {};

  const required = (schema.required as string[]) ?? [];
  const result: Record<string, unknown> = {};

  for (const [name, prop] of Object.entries(properties)) {
    if (!required.includes(name)) continue;
    result[name] = generateRandomValue(prop);
  }

  return result;
}

function generateRandomValue(prop: Record<string, unknown>): unknown {
  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum[Math.floor(rng() * prop.enum.length)];
  }

  const type = prop.type as string | string[] | undefined;
  const resolvedType = Array.isArray(type) ? type[0] : type;

  switch (resolvedType) {
    case "string": {
      const format = prop.format as string | undefined;
      if (format === "uri" || format === "url") return `https://example.com/${randomId()}`;
      if (format === "email") return `${randomId()}@example.com`;
      if (format === "date") {
        const d = new Date(Date.now() - rng() * 365 * 86400000);
        return d.toISOString().slice(0, 10);
      }
      const minLen = (prop.minLength as number) ?? 0;
      return randomString(minLen);
    }
    case "number":
    case "integer": {
      const min = (prop.minimum as number) ?? 0;
      const max = (prop.maximum as number) ?? min + 100;
      return min + Math.floor(rng() * (max - min + 1));
    }
    case "boolean":
      return rng() > 0.5;
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      if (!items) return [];
      const len = 1 + Math.floor(rng() * 3);
      return Array.from({ length: len }, () => generateRandomValue(items));
    }
    case "object": {
      const nested = prop.properties as Record<string, Record<string, unknown>> | undefined;
      if (nested) {
        const obj: Record<string, unknown> = {};
        const req = (prop.required as string[]) ?? [];
        for (const [k, v] of Object.entries(nested)) {
          if (req.includes(k)) obj[k] = generateRandomValue(v);
        }
        return obj;
      }
      return {};
    }
    default:
      return randomString();
  }
}
