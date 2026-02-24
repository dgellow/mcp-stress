/**
 * Named run history — stores runs in ~/.mcp-stress/runs/.
 */

import { join } from "@std/path";

export function getRunsDir(home: string): string {
  return join(home, ".mcp-stress", "runs");
}

export async function ensureRunsDir(home: string): Promise<string> {
  const dir = getRunsDir(home);
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

export function runPath(runsDir: string, name: string): string {
  return join(runsDir, `${name}.ndjson`);
}

export function looksLikeFilePath(arg: string): boolean {
  return arg.includes("/") || arg.includes("\\") || arg.includes(".");
}

export async function resolveRunPath(
  runsDir: string,
  arg: string,
): Promise<string> {
  if (looksLikeFilePath(arg)) return arg;

  const path = runPath(runsDir, arg);
  try {
    await Deno.stat(path);
    return path;
  } catch {
    throw new Error(
      `No saved run named "${arg}". Use 'mcp-stress history' to list runs.`,
    );
  }
}

export async function runExists(
  runsDir: string,
  name: string,
): Promise<boolean> {
  const path = runPath(runsDir, name);
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export function validateRunName(name: string): string | null {
  if (name.includes("/") || name.includes("\\")) {
    return "Name cannot contain path separators";
  }
  if (name.endsWith(".ndjson")) {
    return "Name should not include .ndjson extension";
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return "Name must contain only letters, digits, hyphens, and underscores";
  }
  return null;
}

export async function ensureRunSubdir(
  runsDir: string,
  name: string,
): Promise<string> {
  const dir = join(runsDir, name);
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

export function runSubdirPath(
  runsDir: string,
  name: string,
  index: number,
): string {
  return join(runsDir, name, `${index}.ndjson`);
}
