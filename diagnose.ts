/**
 * Diagnose mode: probe an MCP server step by step, reporting
 * the result of each phase. Works with both stdio and HTTP/SSE.
 */

export interface DiagnoseOptions {
  /** For stdio: the command to run. */
  command?: string;
  /** For stdio: command arguments. */
  args?: string[];
  /** For HTTP/SSE: the URL to connect to. */
  url?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Extra headers for HTTP. */
  headers?: Record<string, string>;
}

interface StepResult {
  step: string;
  status: "ok" | "fail" | "skip";
  durationMs: number;
  detail?: string;
  error?: string;
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

function pass(step: string, ms: number, detail?: string): StepResult {
  const d = detail ? ` — ${detail}` : "";
  console.log(`  [PASS] ${step} (${fmt(ms)})${d}`);
  return { step, status: "ok", durationMs: ms, detail };
}

function fail(step: string, ms: number, error: string): StepResult {
  console.log(`  [FAIL] ${step} (${fmt(ms)}) — ${error}`);
  return { step, status: "fail", durationMs: ms, error };
}

function skip(step: string, reason: string): StepResult {
  console.log(`  [SKIP] ${step} — ${reason}`);
  return { step, status: "skip", durationMs: 0, detail: reason };
}

// ─── Stdio diagnostics ───────────────────────────────────────────

async function diagnoseStdio(opts: DiagnoseOptions): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const timeout = opts.timeoutMs ?? 10_000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Step 1: Spawn process
  let process: Deno.ChildProcess;
  let writer: WritableStreamDefaultWriter<Uint8Array>;
  {
    const t = performance.now();
    try {
      const cmd = new Deno.Command(opts.command!, {
        args: opts.args ?? [],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });
      process = cmd.spawn();
      writer = process.stdin.getWriter();
      results.push(pass("spawn process", performance.now() - t, `pid exists`));
    } catch (e) {
      results.push(fail("spawn process", performance.now() - t, e instanceof Error ? e.message : String(e)));
      return results;
    }
  }

  // Start reading stdout in the background
  let stdoutBuffer = "";
  const stdoutReader = process.stdout.getReader();
  const stderrLines: string[] = [];

  // Read stderr in background
  const stderrReader = process.stderr.getReader();
  const stderrPromise = (async () => {
    let buf = "";
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (line.trim()) stderrLines.push(line);
        }
      }
    } catch { /* */ }
  })();

  async function readResponse(timeoutMs: number): Promise<Record<string, unknown> | null> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const { done, value } = await Promise.race([
        stdoutReader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - performance.now()),
        ),
      ]);
      if (done && !value) return null;
      if (done) break;
      if (value) {
        stdoutBuffer += decoder.decode(value, { stream: true });
      }
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          return JSON.parse(line);
        } catch { /* non-JSON */ }
      }
    }
    return null;
  }

  async function sendRequest(id: number, method: string, params?: unknown): Promise<Record<string, unknown> | null> {
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;
    const line = JSON.stringify(msg) + "\n";
    await writer.write(encoder.encode(line));
    return await readResponse(timeout);
  }

  async function sendNotification(method: string, params?: unknown): Promise<void> {
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    const line = JSON.stringify(msg) + "\n";
    await writer.write(encoder.encode(line));
  }

  // Step 2: Initialize handshake
  {
    const t = performance.now();
    try {
      const resp = await sendRequest(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "mcp-stress-diagnose", version: "0.1.0" },
      });
      const elapsed = performance.now() - t;
      if (!resp) {
        results.push(fail("initialize", elapsed, `no response within ${timeout}ms`));
        if (stderrLines.length > 0) {
          results.push(fail("server stderr", 0, stderrLines.slice(-5).join("\n")));
        }
        cleanup();
        return results;
      }
      if ("error" in resp) {
        const err = resp.error as Record<string, unknown>;
        results.push(fail("initialize", elapsed, `${err.code}: ${err.message}`));
        cleanup();
        return results;
      }
      const result = resp.result as Record<string, unknown>;
      const version = result.protocolVersion as string;
      const info = result.serverInfo as Record<string, unknown> | undefined;
      const caps = result.capabilities as Record<string, unknown> | undefined;
      const serverName = info?.name ?? "unknown";
      results.push(pass("initialize", elapsed, `protocol=${version} server=${serverName}`));

      // Report capabilities
      if (caps) {
        const capList = Object.keys(caps).join(", ");
        results.push(pass("capabilities", 0, capList || "(none)"));
      }
    } catch (e) {
      results.push(fail("initialize", performance.now() - t, e instanceof Error ? e.message : String(e)));
      cleanup();
      return results;
    }
  }

  // Step 3: Send initialized notification
  {
    const t = performance.now();
    try {
      await sendNotification("notifications/initialized");
      results.push(pass("notifications/initialized", performance.now() - t));
    } catch (e) {
      results.push(fail("notifications/initialized", performance.now() - t, e instanceof Error ? e.message : String(e)));
    }
  }

  // Step 4: Ping
  {
    const t = performance.now();
    try {
      const resp = await sendRequest(2, "ping");
      const elapsed = performance.now() - t;
      if (!resp) {
        results.push(fail("ping", elapsed, "no response"));
      } else if ("error" in resp) {
        const err = resp.error as Record<string, unknown>;
        results.push(fail("ping", elapsed, `${err.code}: ${err.message}`));
      } else {
        results.push(pass("ping", elapsed));
      }
    } catch (e) {
      results.push(fail("ping", performance.now() - t, e instanceof Error ? e.message : String(e)));
    }
  }

  // Step 5: tools/list
  {
    const t = performance.now();
    try {
      const resp = await sendRequest(3, "tools/list");
      const elapsed = performance.now() - t;
      if (!resp) {
        results.push(skip("tools/list", "no response (may not be supported)"));
      } else if ("error" in resp) {
        const err = resp.error as Record<string, unknown>;
        results.push(fail("tools/list", elapsed, `${err.code}: ${err.message}`));
      } else {
        const tools = ((resp.result as Record<string, unknown>).tools as unknown[]) ?? [];
        results.push(pass("tools/list", elapsed, `${tools.length} tools`));
        for (const tool of tools) {
          const t = tool as Record<string, unknown>;
          console.log(`         - ${t.name}`);
        }
      }
    } catch (e) {
      results.push(fail("tools/list", performance.now() - t, e instanceof Error ? e.message : String(e)));
    }
  }

  // Step 6: resources/list
  {
    const t = performance.now();
    try {
      const resp = await sendRequest(4, "resources/list");
      const elapsed = performance.now() - t;
      if (!resp) {
        results.push(skip("resources/list", "no response"));
      } else if ("error" in resp) {
        const err = resp.error as Record<string, unknown>;
        // Method not found is fine — server doesn't support resources
        if ((err.code as number) === -32601) {
          results.push(skip("resources/list", "not supported by server"));
        } else {
          results.push(fail("resources/list", elapsed, `${err.code}: ${err.message}`));
        }
      } else {
        const resources = ((resp.result as Record<string, unknown>).resources as unknown[]) ?? [];
        results.push(pass("resources/list", elapsed, `${resources.length} resources`));
      }
    } catch (e) {
      results.push(fail("resources/list", performance.now() - t, e instanceof Error ? e.message : String(e)));
    }
  }

  // Step 7: prompts/list
  {
    const t = performance.now();
    try {
      const resp = await sendRequest(5, "prompts/list");
      const elapsed = performance.now() - t;
      if (!resp) {
        results.push(skip("prompts/list", "no response"));
      } else if ("error" in resp) {
        const err = resp.error as Record<string, unknown>;
        if ((err.code as number) === -32601) {
          results.push(skip("prompts/list", "not supported by server"));
        } else {
          results.push(fail("prompts/list", elapsed, `${err.code}: ${err.message}`));
        }
      } else {
        const prompts = ((resp.result as Record<string, unknown>).prompts as unknown[]) ?? [];
        results.push(pass("prompts/list", elapsed, `${prompts.length} prompts`));
      }
    } catch (e) {
      results.push(fail("prompts/list", performance.now() - t, e instanceof Error ? e.message : String(e)));
    }
  }

  // Step 8: Check stderr for warnings/errors
  if (stderrLines.length > 0) {
    console.log(`\n  Server stderr (${stderrLines.length} lines):`);
    for (const line of stderrLines.slice(-10)) {
      console.log(`    ${line}`);
    }
  }

  async function cleanup() {
    try { await writer.close(); } catch { /* */ }
    try { process.kill("SIGTERM"); } catch { /* */ }
    stdoutReader.releaseLock();
    await stderrPromise;
  }

  await cleanup();
  return results;
}

// ─── SSE helpers ─────────────────────────────────────────────────

interface SseEvent {
  event: string;
  data: string;
}

interface SseReadResult {
  events: SseEvent[];
  totalBytes: number;
  elapsed: number;
}

async function readSseEvents(resp: Response, timeout: number): Promise<SseReadResult> {
  const reader = resp.body?.getReader();
  if (!reader) return { events: [], totalBytes: 0, elapsed: 0 };

  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  const events: SseEvent[] = [];
  const maxWait = Math.min(timeout, 10000);
  const start = performance.now();

  while (performance.now() - start < maxWait && events.length < 5) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), maxWait),
      ),
    ]);
    if (done && !value) break;
    if (done) break;
    if (value) {
      totalBytes += value.length;
      buffer += decoder.decode(value, { stream: true });
    }

    // Normalize line endings and split on double newline
    const normalized = buffer.replace(/\r\n/g, "\n");
    const parts = normalized.split("\n\n");
    buffer = parts.pop()!;

    for (const part of parts) {
      if (!part.trim()) continue;
      let event = "message";
      let data = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      events.push({ event, data });
    }

    // If we got the endpoint event, stop waiting — we have what we need
    if (events.some((e) => e.event === "endpoint")) break;
  }

  reader.cancel().catch(() => {});
  return { events, totalBytes, elapsed: performance.now() - start };
}

/**
 * Full SSE-based MCP protocol probe.
 * Keeps the SSE stream alive as the response channel while POSTing requests.
 */
async function diagnoseSseProtocol(
  results: StepResult[],
  resp: Response,
  opts: DiagnoseOptions,
  timeout: number,
): Promise<void> {
  const reader = resp.body?.getReader();
  if (!reader) {
    results.push(fail("sse stream", 0, "no response body"));
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  // Collected SSE events (including JSON-RPC responses)
  const pendingResolvers = new Map<number, (data: string) => void>();

  // Shared state for endpoint discovery
  let endpointUrl = "";
  let endpointResolve: (() => void) | undefined;

  // Background reader: continuously parse SSE events
  let readerDone = false;
  const bgReader = (async () => {
    try {
      while (!readerDone) {
        const { done, value } = await reader.read();
        if (done) { readerDone = true; break; }
        buffer += decoder.decode(value, { stream: true });

        const normalized = buffer.replace(/\r\n/g, "\n");
        const parts = normalized.split("\n\n");
        buffer = parts.pop()!;

        for (const part of parts) {
          if (!part.trim()) continue;
          let event = "message";
          let data = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }

          if (event === "endpoint") {
            // Store for the main flow
            endpointUrl = data.trim();
            endpointResolve?.();
          } else if (event === "message" && data) {
            // Try to match to a pending request
            try {
              const msg = JSON.parse(data);
              if (msg.id !== undefined && pendingResolvers.has(msg.id)) {
                pendingResolvers.get(msg.id)!(data);
                pendingResolvers.delete(msg.id);
              }
            } catch { /* not JSON */ }
          }
        }
      }
    } catch { /* stream error */ }
  })();

  // Wait for endpoint event
  const endpointPromise = new Promise<void>((resolve) => { endpointResolve = resolve; });

  const endpointStart = performance.now();
  const gotEndpoint = await Promise.race([
    endpointPromise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeout)),
  ]);

  if (!gotEndpoint || !endpointUrl) {
    results.push(fail("sse endpoint", performance.now() - endpointStart, "no endpoint event received"));
    readerDone = true;
    reader.cancel().catch(() => {});
    return;
  }

  results.push(pass("sse endpoint", performance.now() - endpointStart, endpointUrl));

  // Helper: POST to message URL and wait for response on SSE stream
  async function sseRequest(id: number, method: string, params?: unknown): Promise<{ data: string; elapsed: number }> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) body.params = params;

    const responsePromise = new Promise<string>((resolve) => {
      pendingResolvers.set(id, resolve);
    });

    const t = performance.now();
    await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...opts.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

    const data = await Promise.race([
      responsePromise,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout)),
    ]);

    return { data, elapsed: performance.now() - t };
  }

  // Initialize
  {
    try {
      const { data, elapsed } = await sseRequest(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "mcp-stress-diagnose", version: "0.1.0" },
      });
      const parsed = JSON.parse(data);
      if ("error" in parsed) {
        const err = parsed.error as Record<string, unknown>;
        results.push(fail("initialize (SSE)", elapsed, `${err.code}: ${err.message}`));
        readerDone = true;
        reader.cancel().catch(() => {});
        return;
      }
      const result = parsed.result as Record<string, unknown>;
      const version = result.protocolVersion as string;
      const info = result.serverInfo as Record<string, unknown> | undefined;
      const caps = result.capabilities as Record<string, unknown> | undefined;
      results.push(pass("initialize (SSE)", elapsed, `protocol=${version} server=${info?.name ?? "unknown"}`));
      if (caps) {
        results.push(pass("capabilities", 0, Object.keys(caps).join(", ") || "(none)"));
      }
    } catch (e) {
      results.push(fail("initialize (SSE)", 0, e instanceof Error ? e.message : String(e)));
      readerDone = true;
      reader.cancel().catch(() => {});
      return;
    }
  }

  // Send initialized notification (fire and forget)
  {
    try {
      await fetch(endpointUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...opts.headers },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        signal: AbortSignal.timeout(timeout),
      });
      results.push(pass("notifications/initialized (SSE)", 0));
    } catch (e) {
      results.push(fail("notifications/initialized (SSE)", 0, e instanceof Error ? e.message : String(e)));
    }
  }

  // Ping
  {
    try {
      const { elapsed } = await sseRequest(2, "ping");
      results.push(pass("ping (SSE)", elapsed));
    } catch (e) {
      results.push(fail("ping (SSE)", 0, e instanceof Error ? e.message : String(e)));
    }
  }

  // tools/list
  {
    try {
      const { data, elapsed } = await sseRequest(3, "tools/list");
      const parsed = JSON.parse(data);
      if ("result" in parsed) {
        const tools = ((parsed.result as Record<string, unknown>).tools as unknown[]) ?? [];
        results.push(pass("tools/list (SSE)", elapsed, `${tools.length} tools`));
        for (const tool of tools) {
          const t = tool as Record<string, unknown>;
          console.log(`         - ${t.name}`);
        }
      } else if ("error" in parsed) {
        const err = parsed.error as Record<string, unknown>;
        if ((err.code as number) === -32601) {
          results.push(skip("tools/list (SSE)", "not supported"));
        } else {
          results.push(fail("tools/list (SSE)", elapsed, `${err.code}: ${err.message}`));
        }
      }
    } catch (e) {
      results.push(fail("tools/list (SSE)", 0, e instanceof Error ? e.message : String(e)));
    }
  }

  // Cleanup
  readerDone = true;
  reader.cancel().catch(() => {});
  await bgReader;
}

// ─── HTTP/SSE diagnostics ────────────────────────────────────────

async function diagnoseHttp(opts: DiagnoseOptions): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const timeout = opts.timeoutMs ?? 10_000;
  const url = opts.url!;

  const supported: string[] = [];

  // ── Probe 1: SSE transport (GET) ──────────────────────────────
  console.log("  --- Probing SSE transport (GET) ---");
  {
    const t = performance.now();
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...opts.headers,
        },
        signal: AbortSignal.timeout(timeout),
      });
      const elapsed = performance.now() - t;
      const ct = resp.headers.get("content-type") ?? "(none)";

      if (resp.status === 405) {
        results.push(fail("sse (GET)", elapsed, `405 Method Not Allowed — server does not support SSE`));
        await resp.body?.cancel().catch(() => {});
      } else if (resp.status >= 400) {
        const body = await resp.text().catch(() => "");
        results.push(fail("sse (GET)", elapsed, `${resp.status} — ${body.slice(0, 200)}`));
      } else if (ct.includes("text/event-stream")) {
        results.push(pass("sse (GET)", elapsed, `status=${resp.status} content-type=${ct}`));
        supported.push("SSE");

        // Full SSE protocol probe
        await diagnoseSseProtocol(results, resp, opts, timeout);
      } else {
        results.push(fail("sse (GET)", elapsed, `unexpected content-type: ${ct}`));
        await resp.body?.cancel().catch(() => {});
      }
    } catch (e) {
      results.push(fail("sse (GET)", performance.now() - t, e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Probe 2: Streamable HTTP transport (POST) ─────────────────
  console.log("  --- Probing Streamable HTTP transport (POST) ---");
  {
    const t = performance.now();
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...opts.headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "mcp-stress-diagnose", version: "0.1.0" },
          },
        }),
        signal: AbortSignal.timeout(timeout),
      });
      const elapsed = performance.now() - t;
      const body = await resp.text();
      const parsed = parseJsonRpcResponse(body);

      if (resp.status === 405) {
        results.push(fail("streamable-http (POST)", elapsed, `405 Method Not Allowed — server does not support streamable HTTP`));
      } else if (resp.status >= 400) {
        results.push(fail("streamable-http (POST)", elapsed, `${resp.status} — ${body.slice(0, 200)}`));
      } else if (parsed && "result" in parsed) {
        const result = parsed.result as Record<string, unknown>;
        const version = result.protocolVersion as string;
        const info = result.serverInfo as Record<string, unknown> | undefined;
        const caps = result.capabilities as Record<string, unknown> | undefined;
        const sessionId = resp.headers.get("mcp-session-id");

        results.push(pass("streamable-http (POST)", elapsed,
          `protocol=${version} server=${info?.name ?? "unknown"}${sessionId ? ` session=${sessionId}` : ""}`));
        supported.push("Streamable HTTP");

        if (caps) {
          results.push(pass("capabilities (streamable-http)", 0, Object.keys(caps).join(", ") || "(none)"));
        }

        // Continue with ping and tools/list using the session
        await tryStreamableHttpContinue(results, url, opts, timeout, sessionId ?? undefined);
      } else if (parsed && "error" in parsed) {
        const err = parsed.error as Record<string, unknown>;
        results.push(fail("streamable-http (POST)", elapsed, `${err.code}: ${err.message}`));
      } else {
        results.push(fail("streamable-http (POST)", elapsed, `unexpected response: ${body.slice(0, 200)}`));
      }
    } catch (e) {
      results.push(fail("streamable-http (POST)", performance.now() - t, e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Summary ───────────────────────────────────────────────────
  if (supported.length > 0) {
    results.push(pass("transports", 0, supported.join(", ")));
  } else {
    results.push(fail("transports", 0, "no supported transports detected"));
  }

  return results;
}

// ─── Streamable HTTP probe ────────────────────────────────────────

async function httpPost(
  url: string,
  body: unknown,
  opts: DiagnoseOptions,
  timeout: number,
  sessionId?: string,
): Promise<{ status: number; headers: Headers; body: string; elapsed: number }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...opts.headers,
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const t = performance.now();
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const elapsed = performance.now() - t;
  const text = await resp.text();
  return { status: resp.status, headers: resp.headers, body: text, elapsed };
}

function parseJsonRpcResponse(body: string): Record<string, unknown> | null {
  // Try raw JSON first
  try {
    return JSON.parse(body);
  } catch { /* not raw JSON */ }

  // Try SSE format: extract data lines
  const lines = body.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch { /* not valid JSON in data line */ }
    }
  }

  return null;
}

async function tryStreamableHttpInit(
  results: StepResult[],
  url: string,
  opts: DiagnoseOptions,
  timeout: number,
): Promise<void> {
  let sessionId: string | undefined;

  // Initialize
  {
    try {
      const resp = await httpPost(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "mcp-stress-diagnose", version: "0.1.0" },
        },
      }, opts, timeout);

      sessionId = resp.headers.get("mcp-session-id") ?? undefined;

      if (!resp.status || resp.status >= 400) {
        results.push(fail("initialize (POST)", resp.elapsed, `${resp.status} — ${resp.body.slice(0, 300)}`));
        return;
      }

      const parsed = parseJsonRpcResponse(resp.body);
      if (!parsed) {
        results.push(fail("initialize (POST)", resp.elapsed, `invalid JSON: ${resp.body.slice(0, 200)}`));
        return;
      }

      if ("error" in parsed) {
        const err = parsed.error as Record<string, unknown>;
        results.push(fail("initialize (POST)", resp.elapsed, `${err.code}: ${err.message}`));
        return;
      }

      const result = parsed.result as Record<string, unknown>;
      const version = result.protocolVersion as string;
      const info = result.serverInfo as Record<string, unknown> | undefined;
      const caps = result.capabilities as Record<string, unknown> | undefined;
      const serverName = info?.name ?? "unknown";

      results.push(pass("initialize (POST)", resp.elapsed, `protocol=${version} server=${serverName}`));
      if (sessionId) {
        results.push(pass("session", 0, `mcp-session-id=${sessionId}`));
      }
      if (caps) {
        results.push(pass("capabilities", 0, Object.keys(caps).join(", ") || "(none)"));
      }
    } catch (e) {
      results.push(fail("initialize (POST)", 0, e instanceof Error ? e.message : String(e)));
      return;
    }
  }

  // Send initialized notification
  {
    try {
      const resp = await httpPost(url, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }, opts, timeout, sessionId);
      if (resp.status < 300) {
        results.push(pass("notifications/initialized (POST)", resp.elapsed));
      } else {
        results.push(fail("notifications/initialized (POST)", resp.elapsed, `${resp.status} — ${resp.body.slice(0, 200)}`));
      }
    } catch (e) {
      results.push(fail("notifications/initialized (POST)", 0, e instanceof Error ? e.message : String(e)));
    }
  }

  // Ping
  {
    try {
      const resp = await httpPost(url, {
        jsonrpc: "2.0", id: 2, method: "ping",
      }, opts, timeout, sessionId);
      const parsed = parseJsonRpcResponse(resp.body);
      if (parsed && !("error" in parsed)) {
        results.push(pass("ping (POST)", resp.elapsed));
      } else if (parsed && "error" in parsed) {
        const err = parsed.error as Record<string, unknown>;
        results.push(fail("ping (POST)", resp.elapsed, `${err.code}: ${err.message}`));
      } else {
        results.push(fail("ping (POST)", resp.elapsed, `${resp.status} — ${resp.body.slice(0, 200)}`));
      }
    } catch (e) {
      results.push(fail("ping (POST)", 0, e instanceof Error ? e.message : String(e)));
    }
  }

  // tools/list
  {
    try {
      const resp = await httpPost(url, {
        jsonrpc: "2.0", id: 3, method: "tools/list",
      }, opts, timeout, sessionId);
      const parsed = parseJsonRpcResponse(resp.body);
      if (parsed && "result" in parsed) {
        const tools = ((parsed.result as Record<string, unknown>).tools as unknown[]) ?? [];
        results.push(pass("tools/list (POST)", resp.elapsed, `${tools.length} tools`));
        for (const tool of tools) {
          const t = tool as Record<string, unknown>;
          console.log(`         - ${t.name}`);
        }
      } else if (parsed && "error" in parsed) {
        const err = parsed.error as Record<string, unknown>;
        if ((err.code as number) === -32601) {
          results.push(skip("tools/list (POST)", "not supported by server"));
        } else {
          results.push(fail("tools/list (POST)", resp.elapsed, `${err.code}: ${err.message}`));
        }
      } else {
        results.push(fail("tools/list (POST)", resp.elapsed, `${resp.status} — ${resp.body.slice(0, 200)}`));
      }
    } catch (e) {
      results.push(fail("tools/list (POST)", 0, e instanceof Error ? e.message : String(e)));
    }
  }

  // resources/list
  {
    try {
      const resp = await httpPost(url, {
        jsonrpc: "2.0", id: 4, method: "resources/list",
      }, opts, timeout, sessionId);
      const parsed = parseJsonRpcResponse(resp.body);
      if (parsed && "result" in parsed) {
        const resources = ((parsed.result as Record<string, unknown>).resources as unknown[]) ?? [];
        results.push(pass("resources/list (POST)", resp.elapsed, `${resources.length} resources`));
      } else if (parsed && "error" in parsed) {
        const err = parsed.error as Record<string, unknown>;
        if ((err.code as number) === -32601) {
          results.push(skip("resources/list (POST)", "not supported"));
        } else {
          results.push(fail("resources/list (POST)", resp.elapsed, `${err.code}: ${err.message}`));
        }
      }
    } catch (e) {
      results.push(fail("resources/list (POST)", 0, e instanceof Error ? e.message : String(e)));
    }
  }

  // prompts/list
  {
    try {
      const resp = await httpPost(url, {
        jsonrpc: "2.0", id: 5, method: "prompts/list",
      }, opts, timeout, sessionId);
      const parsed = parseJsonRpcResponse(resp.body);
      if (parsed && "result" in parsed) {
        const prompts = ((parsed.result as Record<string, unknown>).prompts as unknown[]) ?? [];
        results.push(pass("prompts/list (POST)", resp.elapsed, `${prompts.length} prompts`));
      } else if (parsed && "error" in parsed) {
        const err = parsed.error as Record<string, unknown>;
        if ((err.code as number) === -32601) {
          results.push(skip("prompts/list (POST)", "not supported"));
        } else {
          results.push(fail("prompts/list (POST)", resp.elapsed, `${err.code}: ${err.message}`));
        }
      }
    } catch (e) {
      results.push(fail("prompts/list (POST)", 0, e instanceof Error ? e.message : String(e)));
    }
  }
}

/** Continue streamable HTTP probe after a successful initialize (ping, tools/list, etc.) */
async function tryStreamableHttpContinue(
  results: StepResult[],
  url: string,
  opts: DiagnoseOptions,
  timeout: number,
  sessionId?: string,
): Promise<void> {
  // Send initialized notification
  {
    try {
      const resp = await httpPost(url, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }, opts, timeout, sessionId);
      if (resp.status < 300) {
        results.push(pass("notifications/initialized (POST)", resp.elapsed));
      } else {
        results.push(fail("notifications/initialized (POST)", resp.elapsed, `${resp.status} — ${resp.body.slice(0, 200)}`));
      }
    } catch (e) {
      results.push(fail("notifications/initialized (POST)", 0, e instanceof Error ? e.message : String(e)));
    }
  }

  // Ping
  {
    try {
      const resp = await httpPost(url, {
        jsonrpc: "2.0", id: 2, method: "ping",
      }, opts, timeout, sessionId);
      const parsed = parseJsonRpcResponse(resp.body);
      if (parsed && !("error" in parsed)) {
        results.push(pass("ping (POST)", resp.elapsed));
      } else if (parsed && "error" in parsed) {
        const err = parsed.error as Record<string, unknown>;
        results.push(fail("ping (POST)", resp.elapsed, `${err.code}: ${err.message}`));
      } else {
        results.push(fail("ping (POST)", resp.elapsed, `${resp.status} — ${resp.body.slice(0, 200)}`));
      }
    } catch (e) {
      results.push(fail("ping (POST)", 0, e instanceof Error ? e.message : String(e)));
    }
  }

  // tools/list
  {
    try {
      const resp = await httpPost(url, {
        jsonrpc: "2.0", id: 3, method: "tools/list",
      }, opts, timeout, sessionId);
      const parsed = parseJsonRpcResponse(resp.body);
      if (parsed && "result" in parsed) {
        const tools = ((parsed.result as Record<string, unknown>).tools as unknown[]) ?? [];
        results.push(pass("tools/list (POST)", resp.elapsed, `${tools.length} tools`));
        for (const tool of tools) {
          const t = tool as Record<string, unknown>;
          console.log(`         - ${t.name}`);
        }
      } else if (parsed && "error" in parsed) {
        const err = parsed.error as Record<string, unknown>;
        if ((err.code as number) === -32601) {
          results.push(skip("tools/list (POST)", "not supported"));
        } else {
          results.push(fail("tools/list (POST)", resp.elapsed, `${err.code}: ${err.message}`));
        }
      }
    } catch (e) {
      results.push(fail("tools/list (POST)", 0, e instanceof Error ? e.message : String(e)));
    }
  }
}

// ─── Main entry point ────────────────────────────────────────────

export async function diagnose(opts: DiagnoseOptions): Promise<void> {
  const isHttp = !!opts.url;
  const isStdio = !!opts.command;

  if (!isHttp && !isStdio) {
    console.error("Error: specify either a server command (-- <cmd>) or a URL (--url <url>)");
    return;
  }

  console.log(`\nDiagnosing MCP server...`);
  if (isStdio) {
    console.log(`  Transport: stdio`);
    console.log(`  Command: ${opts.command} ${(opts.args ?? []).join(" ")}`);
  } else {
    console.log(`  Transport: HTTP/SSE`);
    console.log(`  URL: ${opts.url}`);
  }
  console.log("");

  const results = isStdio ? await diagnoseStdio(opts) : await diagnoseHttp(opts);

  // Summary
  const passed = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  console.log(`\n  Summary: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    console.log("\n  Failures:");
    for (const r of results.filter((r) => r.status === "fail")) {
      console.log(`    ${r.step}: ${r.error}`);
    }
  }
  console.log("");
}
