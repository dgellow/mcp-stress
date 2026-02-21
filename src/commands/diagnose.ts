/**
 * `diagnose` command — step-by-step transport probe.
 *
 * Probes connectivity and protocol compliance, reporting
 * pass/fail/skip for each step.
 */

import type { Transport } from "../transport/types.ts";
import {
  buildTransportOptions,
  createTransport,
  type TransportSpec,
} from "../transport/factory.ts";
import { McpClient } from "../client.ts";

export interface DiagnoseOptions {
  command?: string;
  args?: string[];
  url?: string;
  sse?: boolean;
  timeoutMs: number;
  headers?: Record<string, string>;
  verbose: boolean;
}

interface StepResult {
  step: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  detail?: string;
  error?: string;
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

function pass(step: string, ms: number, detail?: string): StepResult {
  const d = detail ? ` — ${detail}` : "";
  console.log(`  [\x1b[32mPASS\x1b[0m] ${step} (${fmt(ms)})${d}`);
  return { step, status: "pass", durationMs: ms, detail };
}

function fail(step: string, ms: number, error: string): StepResult {
  console.log(`  [\x1b[31mFAIL\x1b[0m] ${step} (${fmt(ms)}) — ${error}`);
  return { step, status: "fail", durationMs: ms, error };
}

function skip(step: string, reason: string): StepResult {
  console.log(`  [\x1b[33mSKIP\x1b[0m] ${step} — ${reason}`);
  return { step, status: "skip", durationMs: 0, detail: reason };
}

export async function diagnoseCommand(opts: DiagnoseOptions): Promise<number> {
  console.log("\nmcp-stress diagnose\n");

  const results: StepResult[] = [];

  if (opts.url) {
    const type = opts.sse ? "sse" : "streamable-http";
    await probeTransport(results, type, opts);
  } else if (opts.command) {
    await probeTransport(results, "stdio", opts);
  } else {
    console.error("Error: specify -- <command> or --url <url>");
    return 1;
  }

  // Summary
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);

  return failed > 0 ? 1 : 0;
}

async function probeTransport(
  results: StepResult[],
  type: string,
  opts: DiagnoseOptions,
): Promise<boolean> {
  let transport: Transport;

  // Step 1: Create transport
  const t1 = performance.now();
  try {
    const spec: TransportSpec = {
      command: opts.command,
      args: opts.args,
      url: opts.url,
      sse: type === "sse",
      headers: opts.headers,
      timeoutMs: opts.timeoutMs,
      verbose: opts.verbose,
    };
    const transportOpts = buildTransportOptions(spec);
    transport = createTransport(transportOpts);
    results.push(pass("create transport", performance.now() - t1, type));
  } catch (e) {
    results.push(
      fail(
        "create transport",
        performance.now() - t1,
        e instanceof Error ? e.message : String(e),
      ),
    );
    return false;
  }

  // Step 2: Connect
  const t2 = performance.now();
  try {
    await transport.connect();
    results.push(pass("connect", performance.now() - t2));
  } catch (e) {
    results.push(
      fail(
        "connect",
        performance.now() - t2,
        e instanceof Error ? e.message : String(e),
      ),
    );
    try {
      await transport.close();
    } catch { /* */ }
    return false;
  }

  // Step 3: Initialize
  const _client = new McpClient(transport);
  const t3 = performance.now();
  try {
    const { result } = await transport.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mcp-stress", version: "0.1.0" },
    });
    const r = result as Record<string, unknown>;
    const serverInfo = r.serverInfo as Record<string, unknown> | undefined;
    const capabilities = r.capabilities as Record<string, unknown> | undefined;
    const detail = serverInfo?.name
      ? `${serverInfo.name} v${serverInfo.version ?? "?"}`
      : "ok";
    results.push(pass("initialize", performance.now() - t3, detail));

    await transport.notify("notifications/initialized");

    // Step 4: Ping
    const t4 = performance.now();
    try {
      await transport.request("ping");
      results.push(pass("ping", performance.now() - t4));
    } catch (e) {
      results.push(
        fail(
          "ping",
          performance.now() - t4,
          e instanceof Error ? e.message : String(e),
        ),
      );
    }

    // Step 5: tools/list
    if (capabilities && "tools" in capabilities) {
      const t5 = performance.now();
      try {
        const { result: toolsResult } = await transport.request("tools/list");
        const tools = (toolsResult as Record<string, unknown>)
          .tools as unknown[];
        results.push(
          pass(
            "tools/list",
            performance.now() - t5,
            `${tools?.length ?? 0} tools`,
          ),
        );
      } catch (e) {
        results.push(
          fail(
            "tools/list",
            performance.now() - t5,
            e instanceof Error ? e.message : String(e),
          ),
        );
      }
    } else {
      results.push(skip("tools/list", "not in capabilities"));
    }

    // Step 6: resources/list
    if (capabilities && "resources" in capabilities) {
      const t6 = performance.now();
      try {
        const { result: resResult } = await transport.request("resources/list");
        const resources = (resResult as Record<string, unknown>)
          .resources as unknown[];
        results.push(
          pass(
            "resources/list",
            performance.now() - t6,
            `${resources?.length ?? 0} resources`,
          ),
        );
      } catch (e) {
        results.push(
          fail(
            "resources/list",
            performance.now() - t6,
            e instanceof Error ? e.message : String(e),
          ),
        );
      }
    } else {
      results.push(skip("resources/list", "not in capabilities"));
    }

    // Step 7: prompts/list
    if (capabilities && "prompts" in capabilities) {
      const t7 = performance.now();
      try {
        const { result: promptsResult } = await transport.request(
          "prompts/list",
        );
        const prompts = (promptsResult as Record<string, unknown>)
          .prompts as unknown[];
        results.push(
          pass(
            "prompts/list",
            performance.now() - t7,
            `${prompts?.length ?? 0} prompts`,
          ),
        );
      } catch (e) {
        results.push(
          fail(
            "prompts/list",
            performance.now() - t7,
            e instanceof Error ? e.message : String(e),
          ),
        );
      }
    } else {
      results.push(skip("prompts/list", "not in capabilities"));
    }
  } catch (e) {
    results.push(
      fail(
        "initialize",
        performance.now() - t3,
        e instanceof Error ? e.message : String(e),
      ),
    );
    try {
      await transport.close();
    } catch { /* */ }
    return false;
  }

  // Cleanup
  try {
    await transport.close();
  } catch { /* */ }
  return true;
}
