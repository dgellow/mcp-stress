/**
 * Transport-agnostic MCP client.
 *
 * All methods return RequestResult, which includes latencyMs measured
 * at the transport layer. This ensures consistent measurement across
 * all operation types.
 */

import type { RequestResult, Transport } from "./transport/types.ts";

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export class McpClient {
  public serverCapabilities: Record<string, unknown> = {};
  public serverInfo: Record<string, unknown> = {};
  public serverProtocolVersion: string | null = null;

  constructor(private transport: Transport) {}

  async connect(): Promise<{ capabilities: unknown; serverInfo: unknown }> {
    await this.transport.connect();

    const { result } = await this.transport.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-stress", version: "0.1.0" },
    });
    const r = result as Record<string, unknown>;
    this.serverCapabilities = (r.capabilities as Record<string, unknown>) ?? {};
    this.serverInfo = (r.serverInfo as Record<string, unknown>) ?? {};

    const serverVersion = r.protocolVersion as string | undefined;
    if (serverVersion) {
      this.serverProtocolVersion = serverVersion;
      if (serverVersion !== MCP_PROTOCOL_VERSION) {
        console.error(
          `[mcp-stress] WARNING: protocol version mismatch — sent ${MCP_PROTOCOL_VERSION}, server replied ${serverVersion}`,
        );
      }
    }

    await this.transport.notify("notifications/initialized");

    return {
      capabilities: this.serverCapabilities,
      serverInfo: this.serverInfo,
    };
  }

  async ping(): Promise<RequestResult> {
    return await this.transport.request("ping");
  }

  async listTools(): Promise<RequestResult & { tools: unknown[] }> {
    const r = await this.transport.request("tools/list");
    return {
      ...r,
      tools: ((r.result as Record<string, unknown>).tools as unknown[]) ?? [],
    };
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<RequestResult & { isError: boolean }> {
    const r = await this.transport.request("tools/call", {
      name,
      arguments: args ?? {},
    });
    const isError = (r.result as Record<string, unknown>)?.isError === true;
    return { ...r, isError };
  }

  async listResources(): Promise<RequestResult & { resources: unknown[] }> {
    const r = await this.transport.request("resources/list");
    return {
      ...r,
      resources:
        ((r.result as Record<string, unknown>).resources as unknown[]) ?? [],
    };
  }

  async readResource(uri: string): Promise<RequestResult> {
    return await this.transport.request("resources/read", { uri });
  }

  async listResourceTemplates(): Promise<
    RequestResult & { resourceTemplates: unknown[] }
  > {
    const r = await this.transport.request("resources/templates/list");
    return {
      ...r,
      resourceTemplates: ((r.result as Record<string, unknown>)
        .resourceTemplates as unknown[]) ?? [],
    };
  }

  async listPrompts(): Promise<RequestResult & { prompts: unknown[] }> {
    const r = await this.transport.request("prompts/list");
    return {
      ...r,
      prompts: ((r.result as Record<string, unknown>).prompts as unknown[]) ??
        [],
    };
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<RequestResult> {
    return await this.transport.request("prompts/get", {
      name,
      arguments: args ?? {},
    });
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  get closed(): boolean {
    return this.transport.closed;
  }
}
