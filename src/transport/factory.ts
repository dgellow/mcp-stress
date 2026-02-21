/**
 * Shared transport construction logic.
 */

import { StdioTransport } from "./stdio.ts";
import { SseTransport } from "./sse.ts";
import { StreamableHttpTransport } from "./streamable_http.ts";
import type { Transport, TransportOptions } from "./types.ts";

export interface TransportSpec {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  sse?: boolean;
  headers?: Record<string, string>;
  timeoutMs: number;
  verbose?: boolean;
}

export function buildTransportOptions(spec: TransportSpec): TransportOptions {
  if (spec.url) {
    const type = spec.sse ? "sse" as const : "streamable-http" as const;
    return {
      type,
      url: spec.url,
      headers: spec.headers,
      timeoutMs: spec.timeoutMs,
      verbose: spec.verbose,
    };
  }
  if (!spec.command) {
    throw new Error(
      "Specify -- <command> [args...] for stdio, or --url <url> for HTTP",
    );
  }
  return {
    type: "stdio",
    command: spec.command,
    args: spec.args ?? [],
    env: spec.env,
    timeoutMs: spec.timeoutMs,
    verbose: spec.verbose,
  };
}

export function createTransport(opts: TransportOptions): Transport {
  switch (opts.type) {
    case "stdio":
      return new StdioTransport(opts);
    case "sse":
      return new SseTransport(opts);
    case "streamable-http":
      return new StreamableHttpTransport(opts);
  }
}
