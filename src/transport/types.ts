/**
 * Transport abstraction for MCP wire protocols.
 */

export type ErrorCategory =
  | "timeout"
  | "protocol"
  | "server"
  | "network"
  | "client";

export class McpError extends Error {
  constructor(
    public category: ErrorCategory,
    public code: number,
    message: string,
    public data: unknown,
    public latencyMs: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface RequestResult {
  result: unknown;
  latencyMs: number;
}

export interface StdioTransportOptions {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  verbose?: boolean;
}

export interface SseTransportOptions {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  verbose?: boolean;
}

export interface StreamableHttpTransportOptions {
  type: "streamable-http";
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  verbose?: boolean;
}

export type TransportOptions =
  | StdioTransportOptions
  | SseTransportOptions
  | StreamableHttpTransportOptions;

export interface Transport {
  connect(): Promise<void>;
  request(method: string, params?: unknown): Promise<RequestResult>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(handler: (method: string, params: unknown) => void): void;
  close(): Promise<void>;
  readonly closed: boolean;
}

/**
 * Classify an error into a category based on its type, not its message.
 *
 * - McpError: already classified at the transport layer
 * - DOMException(TimeoutError/AbortError): request timeout
 * - SyntaxError: JSON parse failure (protocol)
 * - TypeError from fetch: network-level failure (DNS, TLS, connection refused)
 * - Error with code property: check for Node/Deno error codes
 */
export function classifyError(
  error: unknown,
): { category: ErrorCategory; code: number; message: string } {
  if (error instanceof McpError) {
    return {
      category: error.category,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof DOMException) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return { category: "timeout", code: -1, message: error.message };
    }
  }

  if (error instanceof SyntaxError) {
    return { category: "protocol", code: -32700, message: error.message };
  }

  if (error instanceof Error) {
    // Deno/Node network errors carry specific codes
    const code = (error as Error & { code?: string }).code;
    if (
      code === "ECONNREFUSED" || code === "ECONNRESET" ||
      code === "ENOTFOUND" ||
      code === "EPIPE" || code === "EHOSTUNREACH" || code === "ENETUNREACH"
    ) {
      return { category: "network", code: -1, message: error.message };
    }

    // Deno's fetch throws TypeError for network failures (per spec)
    // Distinguish from genuine TypeErrors by checking the message
    if (
      error instanceof TypeError && (
        error.message.includes("error trying to connect") ||
        error.message.includes("error sending request") ||
        error.message.includes("dns error") ||
        error.message.includes("tcp connect error") ||
        error.message.includes("tls")
      )
    ) {
      return { category: "network", code: -1, message: error.message };
    }

    return { category: "client", code: -1, message: error.message };
  }

  return { category: "client", code: -1, message: String(error) };
}
