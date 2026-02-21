/**
 * Low-level MCP client over stdio.
 * Intentionally not using the official SDK — we want full control
 * over the wire protocol for stress testing.
 */

export class McpClientError extends Error {
  constructor(
    public code: number,
    message: string,
    public data: unknown,
    public latencyMs: number,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

export interface RequestResult {
  result: unknown;
  latencyMs: number;
}

export interface ClientOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  verbose?: boolean;
}

export type NotificationHandler = (method: string, params: unknown) => void;
export type StderrHandler = (line: string) => void;

export class StdioMcpClient {
  private process!: Deno.ChildProcess;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (r: RequestResult) => void;
      reject: (e: McpClientError | Error) => void;
      startTime: number;
      timer?: number;
    }
  >();
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private _closed = false;
  private _stderrLines: string[] = [];
  private readPromise!: Promise<void>;
  private stderrPromise!: Promise<void>;

  public serverCapabilities: Record<string, unknown> = {};
  public serverInfo: Record<string, unknown> = {};
  public onNotification: NotificationHandler = () => {};
  public onStderr: StderrHandler = () => {};

  private requestTimeoutMs: number;
  private command: string;
  private args: string[];
  private env?: Record<string, string>;
  private verbose: boolean;

  constructor(opts: ClientOptions) {
    this.command = opts.command;
    this.args = opts.args;
    this.env = opts.env;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.verbose = opts.verbose ?? false;
  }

  private log(dir: ">>>" | "<<<" | "---", msg: string): void {
    if (!this.verbose) return;
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`  ${dir} [${ts}] ${msg}`);
  }

  /** Spawn the subprocess. Call this before initialize(). */
  spawn(): void {
    const cmd = new Deno.Command(this.command, {
      args: this.args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: this.env ? { ...Deno.env.toObject(), ...this.env } : undefined,
    });
    this.process = cmd.spawn();
    this.writer = this.process.stdin.getWriter();
    this.readPromise = this._readStdout();
    this.stderrPromise = this._readStderr();
  }

  /** Full lifecycle: spawn + initialize handshake. */
  async connect(): Promise<{ capabilities: unknown; serverInfo: unknown }> {
    this.spawn();
    return await this.initialize();
  }

  /** Send initialize and notifications/initialized. */
  async initialize(): Promise<{ capabilities: unknown; serverInfo: unknown }> {
    const { result } = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mcp-stress", version: "0.1.0" },
    });
    const r = result as Record<string, unknown>;
    this.serverCapabilities = (r.capabilities as Record<string, unknown>) ?? {};
    this.serverInfo = (r.serverInfo as Record<string, unknown>) ?? {};
    await this.notify("notifications/initialized");
    return { capabilities: this.serverCapabilities, serverInfo: this.serverInfo };
  }

  /** Send a JSON-RPC request and wait for the response. */
  async request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<RequestResult> {
    if (this._closed) {
      throw new Error("Client is closed");
    }

    const id = this.nextId++;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      message.params = params;
    }

    const line = JSON.stringify(message) + "\n";
    this.log(">>>", `[${id}] ${method} ${params !== undefined ? JSON.stringify(params) : ""}`);
    const startTime = performance.now();

    await this.writer.write(this.encoder.encode(line));

    const timeout = timeoutMs ?? this.requestTimeoutMs;

    return new Promise<RequestResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpClientError(
            -1,
            `Request timed out after ${timeout}ms: ${method}`,
            null,
            timeout,
          ),
        );
      }, timeout);

      this.pending.set(id, {
        resolve,
        reject,
        startTime,
        timer: timer as unknown as number,
      });
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this._closed) return;

    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      message.params = params;
    }

    const line = JSON.stringify(message) + "\n";
    this.log(">>>", `notify ${method} ${params !== undefined ? JSON.stringify(params) : ""}`);
    await this.writer.write(this.encoder.encode(line));
  }

  /** Convenience: tools/list */
  async listTools(): Promise<unknown[]> {
    const { result } = await this.request("tools/list");
    return ((result as Record<string, unknown>).tools as unknown[]) ?? [];
  }

  /** Convenience: tools/call */
  async callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<RequestResult> {
    return await this.request("tools/call", { name, arguments: args ?? {} });
  }

  /** Convenience: resources/list */
  async listResources(): Promise<unknown[]> {
    const { result } = await this.request("resources/list");
    return ((result as Record<string, unknown>).resources as unknown[]) ?? [];
  }

  /** Convenience: resources/read */
  async readResource(uri: string): Promise<RequestResult> {
    return await this.request("resources/read", { uri });
  }

  /** Convenience: resources/templates/list */
  async listResourceTemplates(): Promise<unknown[]> {
    const { result } = await this.request("resources/templates/list");
    return (
      ((result as Record<string, unknown>).resourceTemplates as unknown[]) ?? []
    );
  }

  /** Convenience: prompts/list */
  async listPrompts(): Promise<unknown[]> {
    const { result } = await this.request("prompts/list");
    return ((result as Record<string, unknown>).prompts as unknown[]) ?? [];
  }

  /** Convenience: prompts/get */
  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<RequestResult> {
    return await this.request("prompts/get", { name, arguments: args ?? {} });
  }

  /** Convenience: ping */
  async ping(): Promise<RequestResult> {
    return await this.request("ping");
  }

  /** Graceful shutdown. */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    // Reject all pending requests
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error("Client closing"));
      this.pending.delete(id);
    }

    try {
      await this.writer.close();
    } catch {
      // stdin might already be closed
    }

    try {
      this.process.kill("SIGTERM");
    } catch {
      // process might already be dead
    }

    await Promise.allSettled([this.readPromise, this.stderrPromise]);
  }

  get closed(): boolean {
    return this._closed;
  }

  get stderrLines(): string[] {
    return this._stderrLines;
  }

  // --- internal ---

  private async _readStdout(): Promise<void> {
    let buffer = "";
    const reader = this.process.stdout.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += this.decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this._handleMessage(msg);
          } catch {
            // non-JSON line on stdout — ignore or log
          }
        }
      }
    } catch {
      // stream error
    } finally {
      reader.releaseLock();
    }
  }

  private async _readStderr(): Promise<void> {
    let buffer = "";
    const reader = this.process.stderr.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += this.decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          this._stderrLines.push(line);
          this.onStderr(line);
        }
      }
    } catch {
      // stream error
    } finally {
      reader.releaseLock();
    }
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    // Response (has id)
    if ("id" in msg && msg.id !== null) {
      const id = msg.id as number;
      const entry = this.pending.get(id);
      if (!entry) return; // orphan response

      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);

      const latencyMs = performance.now() - entry.startTime;

      if ("error" in msg) {
        const err = msg.error as Record<string, unknown>;
        this.log("<<<", `[${id}] ERROR ${latencyMs.toFixed(1)}ms ${JSON.stringify(err)}`);
        entry.reject(
          new McpClientError(
            (err.code as number) ?? -1,
            (err.message as string) ?? "Unknown error",
            err.data,
            latencyMs,
          ),
        );
      } else {
        const preview = JSON.stringify(msg.result);
        const truncated = preview.length > 200 ? preview.slice(0, 200) + "..." : preview;
        this.log("<<<", `[${id}] OK ${latencyMs.toFixed(1)}ms ${truncated}`);
        entry.resolve({ result: msg.result, latencyMs });
      }
      return;
    }

    // Notification (no id)
    if ("method" in msg) {
      this.log("<<<", `notify ${msg.method} ${JSON.stringify(msg.params ?? {})}`);
      this.onNotification(msg.method as string, msg.params);
    }
  }
}
