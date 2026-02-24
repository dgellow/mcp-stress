/**
 * `chart` command — generate interactive HTML chart from NDJSON.
 */

import { readNdjson } from "../metrics/ndjson.ts";
import { renderHtml } from "../dashboard/render.ts";
import { looksLikeFilePath, resolveRunPath } from "../history.ts";

export interface ChartCommandOptions {
  runsDir: string;
  inputPath: string;
  outputPath?: string;
  open: boolean;
}

export async function chartCommand(opts: ChartCommandOptions): Promise<number> {
  const resolvedInput = await resolveRunPath(opts.runsDir, opts.inputPath);

  let outputPath: string;
  if (opts.outputPath) {
    outputPath = opts.outputPath;
  } else if (looksLikeFilePath(opts.inputPath)) {
    outputPath = opts.inputPath.replace(/\.ndjson$/, ".html");
  } else {
    outputPath = `${opts.inputPath}.html`;
  }

  console.log(`Reading ${resolvedInput}...`);
  const data = await readNdjson(resolvedInput);

  if (data.events.length === 0) {
    console.error("No events found in input file.");
    return 1;
  }

  console.log(`  ${data.events.length} events, generating chart...`);

  const html = await renderHtml({
    mode: "static",
    data: {
      meta: data.meta,
      events: data.events,
      summary: data.summary,
    },
  });

  await Deno.writeTextFile(outputPath, html);
  console.log(`Chart written to ${outputPath}`);

  if (opts.open) {
    openFile(outputPath);
  }

  return 0;
}

function openFile(path: string): void {
  const cmd = Deno.build.os === "darwin"
    ? "open"
    : Deno.build.os === "windows"
    ? "start"
    : "xdg-open";
  try {
    new Deno.Command(cmd, { args: [path], stdout: "null", stderr: "null" })
      .spawn();
  } catch (e) {
    console.error(
      `  Could not open file: ${e instanceof Error ? e.message : e}`,
    );
    console.error(`  Open manually: ${path}`);
  }
}
