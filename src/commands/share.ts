/**
 * `share` command — upload a run to the sharing server.
 */

import { resolveRunPath } from "../history.ts";

export interface ShareCommandOptions {
  runsDir: string;
  input: string;
  server: string;
}

export async function shareCommand(
  opts: ShareCommandOptions,
): Promise<number> {
  const path = await resolveRunPath(opts.runsDir, opts.input);
  const content = await Deno.readTextFile(path);

  const res = await fetch(`${opts.server}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: content,
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Error: server returned ${res.status}: ${body}`);
    return 1;
  }

  const { url } = await res.json();
  console.log(url);
  return 0;
}
