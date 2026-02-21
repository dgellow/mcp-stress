/**
 * Legacy HTTP+SSE transport — MCP protocol version 2024-11-05.
 *
 * Two endpoints:
 *   GET  <url>         — opens SSE stream, receives `endpoint` event then `message` events
 *   POST <endpoint>    — sends JSON-RPC requests/notifications (endpoint URL from SSE)
 *
 * All JSON-RPC responses come back through the SSE stream, not the POST response body.
 * Session identity is encoded in the POST endpoint URL (e.g., ?sessionId=abc).
 */

import {
  McpError,
  type RequestResult,
  type SseTransportOptions,
  type Transport,
} from "./types.ts";

interface PendingRequest {
  resolve: (r: RequestResult) => void;
  reject: (e: McpError | Error) => void;
  startTime: number;
  timer: ReturnType<typeof setTimeout>;
}

export class SseTransport implements Transport {
  private sseUrl: string;
  private postUrl: string | null = null;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private _closed = false;
  private notificationHandler: (method: string, params: unknown) => void =
    () => {};
  private sseController: AbortController | null = null;
  private sseReadPromise: Promise<void> | null = null;
  private verbose: boolean;

  constructor(private opts: SseTransportOptions) {
    this.sseUrl = opts.url;
    this.headers = opts.headers ?? {};
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.verbose = opts.verbose ?? false;
  }

  async connect(): Promise<void> {
    // Open SSE stream and wait for the `endpoint` event
    this.sseController = new AbortController();

    const resp = await fetch(this.sseUrl, {
      headers: {
        ...this.headers,
        "Accept": "text/event-stream",
      },
      signal: this.sseController.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`SSE connect failed: HTTP ${resp.status} ${text}`.trim());
    }

    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      await resp.body?.cancel();
      throw new Error(`Expected text/event-stream, got ${contentType}`);
    }

    // Wait for the endpoint event, then continue reading in background
    this.postUrl = await this.waitForEndpoint(resp);
    this.log("---", `POST endpoint: ${this.postUrl}`);
  }

  async request(method: string, params?: unknown): Promise<RequestResult> {
    if (this._closed) throw new Error("Transport is closed");
    if (!this.postUrl) throw new Error("Not connected — no POST endpoint");

    const id = this.nextId++;
    const body: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) body.params = params;

    this.log(">>>", `[${id}] ${method}`);

    const startTime = performance.now();

    return new Promise<RequestResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpError(
            "timeout",
            -1,
            `Request timed out after ${this.timeoutMs}ms: ${method}`,
            null,
            this.timeoutMs,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        startTime,
        timer,
      });

      // Fire the POST — response comes back on the SSE stream
      fetch(this.postUrl!, {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }).then(async (resp) => {
        if (!resp.ok) {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            clearTimeout(entry.timer);
            const latencyMs = performance.now() - startTime;
            const text = await resp.text().catch(() => "");
            entry.reject(
              new McpError(
                "server",
                resp.status,
                `HTTP ${resp.status}: ${text}`.trim(),
                null,
                latencyMs,
              ),
            );
          }
        }
        // On success, drain the POST response body — actual response comes via SSE
        await resp.body?.cancel();
      }).catch((e) => {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(e);
        }
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this._closed || !this.postUrl) return;

    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;

    this.log(">>>", `notify ${method}`);

    const resp = await fetch(this.postUrl, {
      method: "POST",
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    await resp.body?.cancel();
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    // Abort the SSE stream
    this.sseController?.abort();

    // Reject pending requests
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Transport closing"));
      this.pending.delete(id);
    }

    // Wait for SSE reader to finish
    if (this.sseReadPromise) {
      await this.sseReadPromise.catch(() => {});
    }
  }

  get closed(): boolean {
    return this._closed;
  }

  // ─── SSE stream handling ───────────────────────────────────────

  /**
   * Read the SSE stream until we get the `endpoint` event, then
   * continue reading messages in the background.
   */
  private async waitForEndpoint(resp: Response): Promise<string> {
    const body = resp.body;
    if (!body) throw new Error("SSE response has no body");

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "";
    let dataLines: string[] = [];
    let endpointUrl: string | null = null;

    // Read until we find the endpoint event
    while (endpointUrl === null) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream ended before endpoint event");

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line === "") {
          if (dataLines.length > 0) {
            const data = dataLines.join("\n");
            dataLines = [];
            const type = eventType || "message";
            eventType = "";

            if (type === "endpoint") {
              endpointUrl = this.resolveEndpointUrl(data.trim());
            } else if (type === "message") {
              this.handleMessage(JSON.parse(data));
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
      }
    }

    // Continue reading messages in the background
    this.sseReadPromise = this.readSseStream(
      reader,
      decoder,
      buffer,
      eventType,
      dataLines,
    );

    return endpointUrl;
  }

  /**
   * Background SSE message reader. Runs until the stream closes or is aborted.
   */
  private async readSseStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    buffer: string,
    eventType: string,
    dataLines: string[],
  ): Promise<void> {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line === "") {
            if (dataLines.length > 0) {
              const data = dataLines.join("\n");
              dataLines = [];
              const type = eventType || "message";
              eventType = "";

              if (type === "message") {
                try {
                  this.handleMessage(JSON.parse(data));
                } catch {
                  this.log("---", `invalid JSON in SSE: ${data.slice(0, 100)}`);
                }
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
        }
      }
    } catch {
      // Stream closed or aborted — expected during shutdown
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Resolve the endpoint URL from the `endpoint` SSE event data.
   * The URL may be relative to the SSE URL.
   */
  private resolveEndpointUrl(endpoint: string): string {
    try {
      // If it's already an absolute URL, validate origin matches
      const endpointParsed = new URL(endpoint);
      const sseParsed = new URL(this.sseUrl);
      if (endpointParsed.origin !== sseParsed.origin) {
        throw new Error(
          `Endpoint origin ${endpointParsed.origin} does not match SSE origin ${sseParsed.origin}`,
        );
      }
      return endpointParsed.href;
    } catch (e) {
      if (e instanceof TypeError) {
        // Relative URL — resolve against SSE URL
        return new URL(endpoint, this.sseUrl).href;
      }
      throw e;
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Response to a request (has id)
    if ("id" in msg && msg.id !== null) {
      const id = msg.id as number;
      const entry = this.pending.get(id);
      if (!entry) return;

      this.pending.delete(id);
      clearTimeout(entry.timer);
      const latencyMs = performance.now() - entry.startTime;

      if ("error" in msg) {
        const err = msg.error as Record<string, unknown>;
        this.log(
          "<<<",
          `[${id}] ERROR ${latencyMs.toFixed(1)}ms ${JSON.stringify(err)}`,
        );
        entry.reject(
          new McpError(
            "server",
            (err.code as number) ?? -1,
            (err.message as string) ?? "Unknown error",
            err.data,
            latencyMs,
          ),
        );
      } else {
        this.log("<<<", `[${id}] OK ${latencyMs.toFixed(1)}ms`);
        entry.resolve({ result: msg.result, latencyMs });
      }
      return;
    }

    // Server-initiated notification (no id)
    if ("method" in msg) {
      this.log("<<<", `notify ${msg.method}`);
      this.notificationHandler(msg.method as string, msg.params);
    }
  }

  private log(dir: string, msg: string): void {
    if (!this.verbose) return;
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`  ${dir} [${ts}] ${msg}`);
  }
}
