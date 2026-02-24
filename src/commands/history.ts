/**
 * `history` command — list and manage saved runs.
 */

import { runPath } from "../history.ts";
import { readNdjson } from "../metrics/ndjson.ts";

export interface HistoryCommandOptions {
  runsDir: string;
  subcommand: string;
  args: string[];
}

export async function historyCommand(
  opts: HistoryCommandOptions,
): Promise<number> {
  switch (opts.subcommand) {
    case "":
    case "list":
      return await listRuns(opts.runsDir);
    case "rm":
    case "delete":
      return await deleteRun(opts.runsDir, opts.args[0]);
    default:
      console.error(`Unknown history subcommand: ${opts.subcommand}`);
      return 1;
  }
}

async function listRuns(runsDir: string): Promise<number> {
  const entries: Array<{
    name: string;
    date: string;
    profile: string;
    seed: string;
    duration: string;
    requests: number;
    p50: number;
    p99: number;
    errorRate: string;
  }> = [];

  for await (const entry of Deno.readDir(runsDir)) {
    if (!entry.isFile || !entry.name.endsWith(".ndjson")) continue;
    const name = entry.name.replace(/\.ndjson$/, "");
    const path = runPath(runsDir, name);

    try {
      const data = await readNdjson(path);
      const meta = data.meta;
      const summary = data.summary;

      entries.push({
        name,
        date: meta?.startedAt ?? "unknown",
        profile: meta?.profile ?? "unknown",
        seed: meta?.seed != null ? String(meta.seed) : "?",
        duration: summary ? `${(summary.durationMs / 1000).toFixed(1)}s` : "?",
        requests: summary?.totalRequests ?? 0,
        p50: summary?.overall.p50 ?? 0,
        p99: summary?.overall.p99 ?? 0,
        errorRate: summary && summary.totalRequests > 0
          ? `${
            ((summary.totalErrors / summary.totalRequests) * 100).toFixed(1)
          }%`
          : "0%",
      });
    } catch {
      entries.push({
        name,
        date: "error reading",
        profile: "?",
        seed: "?",
        duration: "?",
        requests: 0,
        p50: 0,
        p99: 0,
        errorRate: "?",
      });
    }
  }

  if (entries.length === 0) {
    console.log(
      "\nNo saved runs. Use --name <label> with 'mcp-stress run' to save a run.\n",
    );
    return 0;
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log("\nSaved runs:\n");
  console.log(
    `  ${pad("Name", 20)} ${pad("Date", 22)} ${pad("Profile", 16)} ${
      pad("Seed", 12)
    } ${pad("Duration", 10)} ${pad("Requests", 10)} ${pad("p50", 8)} ${
      pad("p99", 8)
    } Error%`,
  );
  console.log(`  ${"-".repeat(116)}`);

  for (const e of entries) {
    const dateStr = e.date !== "unknown" && e.date !== "error reading"
      ? e.date.slice(0, 19).replace("T", " ")
      : e.date;
    console.log(
      `  ${pad(e.name, 20)} ${pad(dateStr, 22)} ${pad(e.profile, 16)} ${
        pad(e.seed, 12)
      } ${pad(e.duration, 10)} ${pad(String(e.requests), 10)} ${
        pad(e.p50.toFixed(1), 8)
      } ${pad(e.p99.toFixed(1), 8)} ${e.errorRate}`,
    );
  }
  console.log("");

  return 0;
}

async function deleteRun(
  runsDir: string,
  name: string | undefined,
): Promise<number> {
  if (!name) {
    console.error(
      "Error: specify a run name to delete. Usage: mcp-stress history rm <name>",
    );
    return 1;
  }

  const path = runPath(runsDir, name);

  try {
    await Deno.remove(path);
    console.log(`Deleted run: ${name}`);
    return 0;
  } catch {
    console.error(`No saved run named "${name}".`);
    return 1;
  }
}
