/**
 * Declarative workload profiles.
 */

export interface OperationMix {
  method:
    | "ping"
    | "tools/call"
    | "tools/list"
    | "resources/list"
    | "resources/read"
    | "prompts/list"
    | "prompts/get";
  tool?: string;
  weight?: number;
}

export interface FindCeilingConfig {
  maxConcurrency: number;
  phaseDurationSec: number;
  plateauThreshold?: number;
}

export interface WorkloadProfile {
  name: string;
  operations: OperationMix[];
  shape: string;
  durationSec: number;
  requests?: number;
  concurrency: number;
  tool?: string;
  findCeiling?: FindCeilingConfig;
  connectionChurn?: boolean;
}

export const BUILTIN_PROFILES: Record<
  string,
  Omit<WorkloadProfile, "durationSec" | "concurrency">
> = {
  "ping-flood": {
    name: "Ping flood",
    operations: [{ method: "ping", weight: 1 }],
    shape: "constant",
  },
  "tool-flood": {
    name: "Tool flood",
    operations: [{ method: "tools/call", weight: 1 }],
    shape: "constant",
  },
  mixed: {
    name: "Mixed workload",
    operations: [
      { method: "ping", weight: 1 },
      { method: "tools/call", weight: 3 },
      { method: "tools/list", weight: 1 },
    ],
    shape: "constant",
  },
  "find-ceiling": {
    name: "Find ceiling",
    operations: [{ method: "tools/call", weight: 1 }],
    shape: "constant",
    findCeiling: {
      maxConcurrency: 50,
      phaseDurationSec: 10,
      plateauThreshold: 0.05,
    },
  },
  "connection-churn": {
    name: "Connection churn",
    operations: [{ method: "ping", weight: 1 }],
    shape: "constant",
    connectionChurn: true,
  },
};

export function resolveProfile(
  profileName: string | undefined,
  overrides: {
    durationSec: number;
    requests?: number;
    concurrency: number;
    shape?: string;
    tool?: string;
  },
): WorkloadProfile {
  const name = profileName ?? "tool-flood";
  const builtin = BUILTIN_PROFILES[name];
  if (!builtin) {
    throw new Error(
      `Unknown profile: ${name}. Available: ${
        Object.keys(BUILTIN_PROFILES).join(", ")
      }`,
    );
  }

  const profile: WorkloadProfile = {
    ...builtin,
    durationSec: overrides.durationSec,
    requests: overrides.requests,
    concurrency: overrides.concurrency,
  };

  if (overrides.shape) profile.shape = overrides.shape;
  if (overrides.tool) profile.tool = overrides.tool;

  if (profile.findCeiling) {
    profile.findCeiling.maxConcurrency = overrides.concurrency;
  }

  return profile;
}
