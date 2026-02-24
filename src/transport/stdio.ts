/**
 * Stdio transport — JSON-RPC over subprocess stdin/stdout.
 */

import {
  McpError,
  type RequestResult,
  type StdioTransportOptions,
  type Transport,
} from "./types.ts";

interface PendingRequest {
  resolve: (r: RequestResult) => void;
  reject: (e: McpError | Error) => void;
  startTime: number;
  timer: number;
}

export class StdioTransport implements Transport {
  private process!: Deno.ChildProcess;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private _closed = false;
  private notificationHandler: (method: string, params: unknown) => void =
    () => {};
  private readPromise!: Promise<void>;
  private stderrPromise!: Promise<void>;

  constructor(private opts: StdioTransportOptions) {}

  // deno-lint-ignore require-await
  async connect(): Promise<void> {
    const cmd = new Deno.Command(this.opts.command, {
      args: this.opts.args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: this.opts.env
        ? { ...Deno.env.toObject(), ...this.opts.env }
        : undefined,
    });
    this.process = cmd.spawn();
    this.writer = this.process.stdin.getWriter();
    this.readPromise = this.readStdout();
    this.stderrPromise = this.readStderr();
  }

  async request(method: string, params?: unknown): Promise<RequestResult> {
    if (this._closed) throw new Error("Transport is closed");

    const id = this.nextId++;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;

    this.log(
      ">>>",
      `[${id}] ${method} ${params !== undefined ? JSON.stringify(params) : ""}`,
    );

    const startTime = performance.now();
    await this.writer.write(
      this.encoder.encode(JSON.stringify(message) + "\n"),
    );

    const timeoutMs = this.opts.timeoutMs ?? 30_000;

    return new Promise<RequestResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpError(
            "timeout",
            -1,
            `Request timed out after ${timeoutMs}ms: ${method}`,
            null,
            timeoutMs,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        startTime,
        timer: timer as unknown as number,
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this._closed) return;

    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;

    this.log(">>>", `notify ${method}`);
    await this.writer.write(
      this.encoder.encode(JSON.stringify(message) + "\n"),
    );
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Transport closing"));
      this.pending.delete(id);
    }

    try {
      await this.writer.close();
    } catch { /* stdin may already be closed */ }
    try {
      this.process.kill("SIGTERM");
    } catch { /* process may already be dead */ }
    await Promise.allSettled([this.readPromise, this.stderrPromise]);
  }

  get closed(): boolean {
    return this._closed;
  }

  private log(dir: string, msg: string): void {
    if (!this.opts.verbose) return;
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`  ${dir} [${ts}] ${msg}`);
  }

  private async readStdout(): Promise<void> {
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
            this.handleMessage(JSON.parse(line));
          } catch {
            this.log("---", `non-JSON on stdout: ${line.slice(0, 100)}`);
          }
        }
      }
    } catch {
      // Stream closed or errored — expected during shutdown
    } finally {
      reader.releaseLock();
    }
  }

  private async readStderr(): Promise<void> {
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
          if (line.trim()) this.log("err", line);
        }
      }
    } catch {
      // Stream closed or errored
    } finally {
      reader.releaseLock();
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
        const preview = JSON.stringify(msg.result);
        this.log(
          "<<<",
          `[${id}] OK ${latencyMs.toFixed(1)}ms ${
            preview.length > 200 ? preview.slice(0, 200) + "..." : preview
          }`,
        );
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
}
