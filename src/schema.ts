/**
 * JSON Schema -> random argument generation with seeded PRNG.
 */

const NOUNS = [
  "user",
  "account",
  "order",
  "product",
  "session",
  "token",
  "payment",
  "invoice",
  "customer",
  "item",
  "cart",
  "subscription",
  "webhook",
  "event",
  "metric",
  "log",
  "error",
  "config",
  "setting",
  "permission",
  "role",
  "team",
  "project",
  "deployment",
  "pipeline",
  "build",
  "release",
  "tag",
  "branch",
  "commit",
  "review",
  "comment",
  "notification",
  "alert",
  "rule",
  "policy",
  "secret",
  "key",
  "certificate",
  "domain",
  "endpoint",
  "route",
  "service",
  "cluster",
  "node",
  "pod",
  "container",
  "volume",
  "network",
];
const VERBS = [
  "create",
  "update",
  "delete",
  "list",
  "get",
  "fetch",
  "search",
  "find",
  "filter",
  "sort",
  "validate",
  "check",
  "verify",
  "process",
  "handle",
  "transform",
  "parse",
  "render",
  "deploy",
  "monitor",
  "debug",
  "trace",
];
const ADJECTIVES = [
  "active",
  "pending",
  "failed",
  "new",
  "old",
  "latest",
  "recent",
  "critical",
  "high",
  "low",
  "default",
  "custom",
  "internal",
  "external",
  "primary",
  "secondary",
  "temporary",
  "permanent",
  "archived",
  "deleted",
];
const PHRASES = [
  "how to",
  "what is",
  "error in",
  "timeout on",
  "rate limit",
  "connection refused",
  "authentication failed",
  "invalid request",
  "missing field",
  "unexpected response",
  "slow query",
  "high latency",
  "memory usage",
  "cpu spike",
  "disk full",
  "network error",
];

// ─── Seeded PRNG (mulberry32) ───────────────────────────────────

let _rngState = Date.now() | 0;

export function setSeed(seed?: number): number {
  _rngState = seed ?? (Date.now() ^ (Math.random() * 0xffffffff)) | 0;
  return _rngState;
}

export function getSeed(): number {
  return _rngState;
}

/** Seeded random number in [0, 1). Use this instead of Math.random() for reproducibility. */
export function rng(): number {
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

function randomString(minLen = 0): string {
  const wordCount = 1 + Math.floor(rng() * 4);
  let result = Array.from({ length: wordCount }, () => randomWord()).join(" ");
  while (result.length < minLen) result += " " + randomWord();
  return result;
}

function randomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const len = 8 + Math.floor(rng() * 16);
  return Array.from(
    { length: len },
    () => chars[Math.floor(rng() * chars.length)],
  ).join("");
}

export function generateArgsFromSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return {};
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return {};
  const required = (schema.required as string[]) ?? [];
  const result: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(properties)) {
    if (!required.includes(name)) continue;
    result[name] = generateValue(prop);
  }
  return result;
}

export function generateRandomArgsFromSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return {};
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return {};
  const required = (schema.required as string[]) ?? [];
  const result: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(properties)) {
    if (!required.includes(name)) continue;
    result[name] = generateRandomValue(prop);
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
  const resolved = Array.isArray(type) ? type[0] : type;
  switch (resolved) {
    case "string": {
      const fmt = prop.format as string | undefined;
      if (fmt === "uri" || fmt === "url") return "https://example.com";
      if (fmt === "email") return "test@example.com";
      if (fmt === "date") return "2025-01-01";
      if (fmt === "date-time") return "2025-01-01T00:00:00Z";
      return "test".padEnd((prop.minLength as number) ?? 0, "x");
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
      const nested = prop.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (!nested) return {};
      const obj: Record<string, unknown> = {};
      const req = (prop.required as string[]) ?? [];
      for (const [k, v] of Object.entries(nested)) {
        if (req.includes(k)) obj[k] = generateValue(v);
      }
      return obj;
    }
    default:
      return "test";
  }
}

function generateRandomValue(prop: Record<string, unknown>): unknown {
  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum[Math.floor(rng() * prop.enum.length)];
  }
  const type = prop.type as string | string[] | undefined;
  const resolved = Array.isArray(type) ? type[0] : type;
  switch (resolved) {
    case "string": {
      const fmt = prop.format as string | undefined;
      if (fmt === "uri" || fmt === "url") {
        return `https://example.com/${randomId()}`;
      }
      if (fmt === "email") return `${randomId()}@example.com`;
      if (fmt === "date") {
        const d = new Date(Date.now() - rng() * 365 * 86400000);
        return d.toISOString().slice(0, 10);
      }
      return randomString((prop.minLength as number) ?? 0);
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
      return Array.from(
        { length: 1 + Math.floor(rng() * 3) },
        () => generateRandomValue(items),
      );
    }
    case "object": {
      const nested = prop.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (!nested) return {};
      const obj: Record<string, unknown> = {};
      const req = (prop.required as string[]) ?? [];
      for (const [k, v] of Object.entries(nested)) {
        if (req.includes(k)) obj[k] = generateRandomValue(v);
      }
      return obj;
    }
    default:
      return randomString();
  }
}
