/**
 * NDJSON read/write utilities.
 */

import type { MetaEvent, RequestEvent, SummaryEvent } from "./events.ts";

export interface ParsedNdjson {
  meta: MetaEvent | null;
  events: RequestEvent[];
  summary: SummaryEvent | null;
}

export async function readNdjson(path: string): Promise<ParsedNdjson> {
  const text = await Deno.readTextFile(path);
  const lines = text.split("\n").filter((l) => l.trim());

  let meta: MetaEvent | null = null;
  const events: RequestEvent[] = [];
  let summary: SummaryEvent | null = null;

  for (const line of lines) {
    const obj = JSON.parse(line);
    if (obj.type === "meta") {
      meta = obj as MetaEvent;
    } else if (obj.type === "summary") {
      summary = obj as SummaryEvent;
    } else {
      events.push(obj as RequestEvent);
    }
  }

  return { meta, events, summary };
}
