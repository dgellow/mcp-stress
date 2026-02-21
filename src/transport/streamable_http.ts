/**
 * Streamable HTTP transport — MCP protocol version 2025-03-26.
 *
 * Single endpoint handles everything:
 *   POST — send JSON-RPC requests/notifications, receive JSON or SSE responses
 *   GET  — open SSE stream for server-initiated messages (optional)
 *   DELETE — terminate session
 *
 * Response handling:
 *   Content-Type: application/json → parse JSON body as response
 *   Content-Type: text/event-stream → parse SSE stream for message events
 */

import {
  McpError,
  type RequestResult,
  type StreamableHttpTransportOptions,
  type Transport,
} from "./types.ts";

interface PendingRequest {
  resolve: (r: RequestResult) => void;
  reject: (e: McpError | Error) => void;
  startTime: number;
  timer: ReturnType<typeof setTimeout>;
}

export class StreamableHttpTransport implements Transport {
  private url: string;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private sessionId: string | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private _closed = false;
  private notificationHandler: (method: string, params: unknown) => void =
    () => {};
  private verbose: boolean;

  constructor(private opts: StreamableHttpTransportOptions) {
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.verbose = opts.verbose ?? false;
  }

  async connect(): Promise<void> {
    // Streamable HTTP has no persistent connection to open.
    // The session is established on the first POST (initialize).
  }

  async request(method: string, params?: unknown): Promise<RequestResult> {
    if (this._closed) throw new Error("Transport is closed");

    const id = this.nextId++;
    const body: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) body.params = params;

    this.log(">>>", `[${id}] ${method}`);

    const startTime = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(this.url, {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Capture session ID from response (set on initialize response)
      const respSessionId = resp.headers.get("mcp-session-id");
      if (respSessionId) {
        this.sessionId = respSessionId;
      }

      if (!resp.ok) {
        const latencyMs = performance.now() - startTime;
        const text = await resp.text().catch(() => "");
        throw new McpError(
          "server",
          resp.status,
          `HTTP ${resp.status}: ${text}`.trim(),
          null,
          latencyMs,
        );
      }

      const contentType = resp.headers.get("content-type") ?? "";

      if (
        !contentType.includes("application/json") &&
        !contentType.includes("text/event-stream")
      ) {
        const latencyMs = performance.now() - startTime;
        await resp.body?.cancel();
        throw new McpError(
          "protocol",
          -32600,
          `Unexpected Content-Type: ${
            contentType || "(none)"
          }. Expected application/json or text/event-stream`,
          null,
          latencyMs,
        );
      }

      if (contentType.includes("text/event-stream")) {
        return await this.readSseResponse(resp, id, startTime);
      }

      // Default: JSON response
      const json = await resp.json();
      const latencyMs = performance.now() - startTime;

      if (json.error) {
        const err = json.error;
        this.log(
          "<<<",
          `[${id}] ERROR ${latencyMs.toFixed(1)}ms ${JSON.stringify(err)}`,
        );
        throw new McpError(
          "server",
          err.code ?? -1,
          err.message ?? "Unknown error",
          err.data,
          latencyMs,
        );
      }

      this.log("<<<", `[${id}] OK ${latencyMs.toFixed(1)}ms`);
      return { result: json.result, latencyMs };
    } catch (e) {
      if (e instanceof McpError) throw e;

      const latencyMs = performance.now() - startTime;
      if (
        e instanceof DOMException &&
        (e.name === "AbortError" || e.name === "TimeoutError")
      ) {
        throw new McpError(
          "timeout",
          -1,
          `Request timed out after ${this.timeoutMs}ms: ${method}`,
          null,
          latencyMs,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this._closed) return;

    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;

    this.log(">>>", `notify ${method}`);

    const resp = await fetch(this.url, {
      method: "POST",
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

    // Capture session ID
    const respSessionId = resp.headers.get("mcp-session-id");
    if (respSessionId) this.sessionId = respSessionId;

    // Drain body to avoid resource leak
    await resp.body?.cancel();
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    // Reject pending requests
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Transport closing"));
      this.pending.delete(id);
    }

    // Terminate session via DELETE
    if (this.sessionId) {
      try {
        const resp = await fetch(this.url, {
          method: "DELETE",
          headers: {
            ...this.headers,
            "Mcp-Session-Id": this.sessionId,
          },
        });
        await resp.body?.cancel();
      } catch {
        // Server may not support DELETE — that's fine
      }
    }
  }

  get closed(): boolean {
    return this._closed;
  }

  // ─── SSE response parsing ─────────────────────────────────────

  /**
   * Read a JSON-RPC response from an SSE stream.
   * The stream may contain server-initiated notifications before the final response.
   */
  private async readSseResponse(
    resp: Response,
    requestId: number,
    startTime: number,
  ): Promise<RequestResult> {
    const body = resp.body;
    if (!body) {
      const latencyMs = performance.now() - startTime;
      throw new McpError(
        "protocol",
        -32600,
        "SSE response has no body",
        null,
        latencyMs,
      );
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "";
    let dataLines: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line === "") {
            // Empty line = end of event
            if (dataLines.length > 0) {
              const data = dataLines.join("\n");
              dataLines = [];
              const type = eventType || "message";
              eventType = "";

              if (type === "message") {
                const msg = JSON.parse(data);
                const result = this.handleSseMessage(msg, requestId, startTime);
                if (result !== null) return result;
              }
            }
            eventType = "";
            continue;
          }

          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
          // Ignore id:, retry:, and comments (:)
        }
      }

      // If we reach here, stream ended without a response
      const latencyMs = performance.now() - startTime;
      throw new McpError(
        "protocol",
        -32600,
        "SSE stream ended without response",
        null,
        latencyMs,
      );
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Handle a JSON-RPC message from an SSE stream.
   * Returns RequestResult if this is the response we're waiting for, null otherwise.
   */
  private handleSseMessage(
    msg: Record<string, unknown>,
    requestId: number,
    startTime: number,
  ): RequestResult | null {
    // Response (has id matching our request)
    if ("id" in msg && msg.id === requestId) {
      const latencyMs = performance.now() - startTime;

      if ("error" in msg) {
        const err = msg.error as Record<string, unknown>;
        this.log(
          "<<<",
          `[${requestId}] ERROR ${latencyMs.toFixed(1)}ms ${
            JSON.stringify(err)
          }`,
        );
        throw new McpError(
          "server",
          (err.code as number) ?? -1,
          (err.message as string) ?? "Unknown error",
          err.data,
          latencyMs,
        );
      }

      this.log("<<<", `[${requestId}] OK ${latencyMs.toFixed(1)}ms`);
      return { result: msg.result, latencyMs };
    }

    // Server-initiated notification (no id)
    if ("method" in msg && !("id" in msg)) {
      this.log("<<<", `notify ${msg.method}`);
      this.notificationHandler(msg.method as string, msg.params);
      return null;
    }

    // Response for a different request ID — shouldn't happen in single-request SSE
    return null;
  }

  private log(dir: string, msg: string): void {
    if (!this.verbose) return;
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`  ${dir} [${ts}] ${msg}`);
  }
}
