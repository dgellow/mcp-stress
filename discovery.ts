/**
 * Discovery mode: connect to an MCP server, enumerate everything,
 * exercise each capability, and report what works.
 */

import { McpClientError, StdioMcpClient, type ClientOptions } from "./client.ts";
import { generateArgsFromSchema } from "./schema.ts";

interface DiscoveryResult {
  serverInfo: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  tools: ToolResult[];
  resources: ResourceResult[];
  resourceTemplates: unknown[];
  prompts: PromptResult[];
  pingLatencyMs: number;
}

interface ToolResult {
  name: string;
  description?: string;
  inputSchema?: unknown;
  callResult?: { success: boolean; latencyMs: number; error?: string };
}

interface ResourceResult {
  uri: string;
  name?: string;
  readResult?: { success: boolean; latencyMs: number; error?: string };
}

interface PromptResult {
  name: string;
  description?: string;
  arguments?: unknown[];
  getResult?: { success: boolean; latencyMs: number; error?: string };
}

export async function discover(clientOpts: ClientOptions): Promise<void> {
  const client = new StdioMcpClient(clientOpts);

  console.log("\nConnecting...");
  const { capabilities, serverInfo } = await client.connect();

  const result: DiscoveryResult = {
    serverInfo: serverInfo as Record<string, unknown>,
    capabilities: capabilities as Record<string, unknown>,
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    pingLatencyMs: 0,
  };

  // Ping
  try {
    const { latencyMs } = await client.ping();
    result.pingLatencyMs = latencyMs;
    console.log(`  ping: ${latencyMs.toFixed(1)}ms`);
  } catch (e) {
    console.log(`  ping: FAILED - ${e instanceof Error ? e.message : e}`);
  }

  // Server info
  console.log(`\nServer: ${JSON.stringify(result.serverInfo)}`);
  console.log(`Capabilities: ${JSON.stringify(result.capabilities)}`);

  // Tools
  if ("tools" in result.capabilities) {
    console.log("\nTools:");
    try {
      const tools = (await client.listTools()) as Array<Record<string, unknown>>;
      for (const tool of tools) {
        const t: ToolResult = {
          name: tool.name as string,
          description: tool.description as string | undefined,
          inputSchema: tool.inputSchema,
        };

        // Generate sample args from schema and try calling
        const sampleArgs = generateArgsFromSchema(t.inputSchema as Record<string, unknown> | undefined);
        try {
          const { latencyMs } = await client.callTool(t.name, sampleArgs);
          t.callResult = { success: true, latencyMs };
          console.log(`  ${t.name}: OK (${latencyMs.toFixed(1)}ms)`);
        } catch (e) {
          const msg = e instanceof McpClientError ? `[${e.code}] ${e.message}` : String(e);
          const lat = e instanceof McpClientError ? e.latencyMs : 0;
          t.callResult = { success: false, latencyMs: lat, error: msg };
          console.log(`  ${t.name}: FAIL (${lat.toFixed(1)}ms) - ${msg}`);
        }

        if (t.inputSchema) {
          console.log(`    schema: ${JSON.stringify(t.inputSchema)}`);
          console.log(`    sample: ${JSON.stringify(sampleArgs)}`);
        }

        result.tools.push(t);
      }
      if (tools.length === 0) {
        console.log("  (none)");
      }
    } catch (e) {
      console.log(`  tools/list FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Resources
  if ("resources" in result.capabilities) {
    console.log("\nResources:");
    try {
      const resources = (await client.listResources()) as Array<Record<string, unknown>>;
      for (const res of resources) {
        const r: ResourceResult = {
          uri: res.uri as string,
          name: res.name as string | undefined,
        };

        try {
          const { latencyMs } = await client.readResource(r.uri);
          r.readResult = { success: true, latencyMs };
          console.log(`  ${r.uri}: OK (${latencyMs.toFixed(1)}ms)`);
        } catch (e) {
          const msg = e instanceof McpClientError ? `[${e.code}] ${e.message}` : String(e);
          const lat = e instanceof McpClientError ? e.latencyMs : 0;
          r.readResult = { success: false, latencyMs: lat, error: msg };
          console.log(`  ${r.uri}: FAIL (${lat.toFixed(1)}ms) - ${msg}`);
        }

        result.resources.push(r);
      }
      if (resources.length === 0) {
        console.log("  (none)");
      }
    } catch (e) {
      console.log(`  resources/list FAILED: ${e instanceof Error ? e.message : e}`);
    }

    // Resource templates
    try {
      const templates = await client.listResourceTemplates();
      result.resourceTemplates = templates;
      if (templates.length > 0) {
        console.log(`\nResource Templates: ${templates.length}`);
        for (const t of templates) {
          console.log(`  ${JSON.stringify(t)}`);
        }
      }
    } catch {
      // templates not supported, that's fine
    }
  }

  // Prompts
  if ("prompts" in result.capabilities) {
    console.log("\nPrompts:");
    try {
      const prompts = (await client.listPrompts()) as Array<Record<string, unknown>>;
      for (const prompt of prompts) {
        const p: PromptResult = {
          name: prompt.name as string,
          description: prompt.description as string | undefined,
          arguments: prompt.arguments as unknown[] | undefined,
        };

        try {
          const { latencyMs } = await client.getPrompt(p.name, {});
          p.getResult = { success: true, latencyMs };
          console.log(`  ${p.name}: OK (${latencyMs.toFixed(1)}ms)`);
        } catch (e) {
          const msg = e instanceof McpClientError ? `[${e.code}] ${e.message}` : String(e);
          const lat = e instanceof McpClientError ? e.latencyMs : 0;
          p.getResult = { success: false, latencyMs: lat, error: msg };
          console.log(`  ${p.name}: FAIL (${lat.toFixed(1)}ms) - ${msg}`);
        }

        result.prompts.push(p);
      }
      if (prompts.length === 0) {
        console.log("  (none)");
      }
    } catch (e) {
      console.log(`  prompts/list FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log("\nDone.");
  await client.close();
}
