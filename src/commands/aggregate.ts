/**
 * `aggregate` command — combine multiple runs into a statistical summary.
 */

import { readNdjson } from "../metrics/ndjson.ts";
import {
  aggregateToSummary,
  computeAggregate,
  printAggregateSummary,
} from "../metrics/aggregate.ts";
import {
  resolveRunPath,
  runExists,
  runPath,
  validateRunName,
} from "../history.ts";
import type { SummaryEvent } from "../metrics/events.ts";

export interface AggregateCommandOptions {
  runsDir: string;
  inputs: string[];
  outputPath?: string;
  name?: string;
  json: boolean;
}

export async function aggregateCommand(
  opts: AggregateCommandOptions,
): Promise<number> {
  if (opts.inputs.length < 2) {
    console.error("Error: aggregate requires at least 2 inputs.");
    return 1;
  }

  // Validate --name if given
  if (opts.name) {
    const nameError = validateRunName(opts.name);
    if (nameError) {
      console.error(`Error: invalid run name: ${nameError}`);
      return 1;
    }
    if (await runExists(opts.runsDir, opts.name)) {
      console.error(
        `Error: a run named "${opts.name}" already exists. Use 'mcp-stress history rm ${opts.name}' first.`,
      );
      return 1;
    }
  }

  // Resolve and read all inputs
  const summaries: SummaryEvent[] = [];
  for (const input of opts.inputs) {
    const path = await resolveRunPath(opts.runsDir, input);
    const data = await readNdjson(path);
    if (!data.summary) {
      console.error(`Error: no summary found in ${input}`);
      return 1;
    }
    summaries.push(data.summary);
  }

  const agg = computeAggregate(summaries);
  const aggSummary = aggregateToSummary(agg);

  // Build aggregate meta
  const meta = {
    type: "meta" as const,
    name: opts.name,
    aggregate: true,
    runCount: summaries.length,
    profile: "aggregate",
    shape: "constant",
    concurrency: 0,
    durationSec: 0,
    transport: "stdio" as const,
    target: "",
    seed: 0,
    startedAt: new Date().toISOString(),
    timeoutMs: 0,
    command: `mcp-stress aggregate ${opts.inputs.join(" ")}`,
  };

  // Write aggregate NDJSON
  const ndjsonContent = [
    JSON.stringify(meta),
    JSON.stringify(aggSummary),
  ].join("\n") + "\n";

  if (opts.name) {
    const historyPath = runPath(opts.runsDir, opts.name);
    await Deno.writeTextFile(historyPath, ndjsonContent);
    if (!opts.json) {
      console.log(`  Saved aggregate as: ${opts.name}`);
    }
  }

  if (opts.outputPath) {
    await Deno.writeTextFile(opts.outputPath, ndjsonContent);
    if (!opts.json) {
      console.log(`  Written to: ${opts.outputPath}`);
    }
  }

  if (opts.json) {
    console.log(
      JSON.stringify({ aggregate: agg, summary: aggSummary }, null, 2),
    );
  } else {
    printAggregateSummary(agg);
  }

  return 0;
}
