/**
 * `discover` command — enumerate server capabilities.
 *
 * Connects to an MCP server, lists all capabilities, and
 * exercises each one with sample invocations.
 */

import {
  buildTransportOptions,
  createTransport,
} from "../transport/factory.ts";
import { McpClient } from "../client.ts";
import { generateArgsFromSchema } from "../schema.ts";

export interface DiscoverOptions {
  command?: string;
  args?: string[];
  url?: string;
  sse?: boolean;
  timeoutMs: number;
  headers?: Record<string, string>;
  verbose: boolean;
}

export async function discoverCommand(opts: DiscoverOptions): Promise<number> {
  const transportOpts = buildTransportOptions({
    command: opts.command,
    args: opts.args,
    url: opts.url,
    sse: opts.sse,
    headers: opts.headers,
    timeoutMs: opts.timeoutMs,
    verbose: opts.verbose,
  });
  const transport = createTransport(transportOpts);
  const client = new McpClient(transport);

  console.log("\nConnecting...");

  try {
    const { capabilities, serverInfo } = await client.connect();

    // Server info
    const info = serverInfo as Record<string, unknown>;
    console.log(`\nServer: ${info.name ?? "unknown"} v${info.version ?? "?"}`);
    console.log(
      `Capabilities: ${
        Object.keys(capabilities as Record<string, unknown>).join(", ") ||
        "(none)"
      }`,
    );

    // Ping
    try {
      const { latencyMs } = await client.ping();
      console.log(`\nPing: ${latencyMs.toFixed(1)}ms`);
    } catch (e) {
      console.log(`\nPing: FAILED — ${e instanceof Error ? e.message : e}`);
    }

    const caps = capabilities as Record<string, unknown>;

    // Tools
    if ("tools" in caps) {
      console.log("\nTools:");
      try {
        const { tools } = await client.listTools();
        if (tools.length === 0) {
          console.log("  (none)");
        }
        for (const rawTool of tools) {
          const tool = rawTool as Record<string, unknown>;
          const name = tool.name as string;
          const desc = tool.description as string | undefined;
          const schema = tool.inputSchema as
            | Record<string, unknown>
            | undefined;
          const sampleArgs = generateArgsFromSchema(schema);

          try {
            const { latencyMs } = await client.callTool(name, sampleArgs);
            console.log(`  ${name}: OK (${latencyMs.toFixed(1)}ms)`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`  ${name}: FAIL — ${msg}`);
          }

          if (desc) console.log(`    ${desc}`);
          if (schema) {
            console.log(`    schema: ${JSON.stringify(schema)}`);
            console.log(`    sample: ${JSON.stringify(sampleArgs)}`);
          }
        }
      } catch (e) {
        console.log(
          `  tools/list FAILED: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // Resources
    if ("resources" in caps) {
      console.log("\nResources:");
      try {
        const { resources } = await client.listResources();
        if (resources.length === 0) {
          console.log("  (none)");
        }
        for (const rawRes of resources) {
          const res = rawRes as Record<string, unknown>;
          const uri = res.uri as string;
          const name = res.name as string | undefined;

          try {
            const { latencyMs } = await client.readResource(uri);
            console.log(
              `  ${uri}: OK (${latencyMs.toFixed(1)}ms)${
                name ? ` — ${name}` : ""
              }`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`  ${uri}: FAIL — ${msg}`);
          }
        }
      } catch (e) {
        console.log(
          `  resources/list FAILED: ${e instanceof Error ? e.message : e}`,
        );
      }

      // Resource templates
      try {
        const { resourceTemplates } = await client.listResourceTemplates();
        if (resourceTemplates.length > 0) {
          console.log(`\nResource Templates: ${resourceTemplates.length}`);
          for (const t of resourceTemplates) {
            console.log(`  ${JSON.stringify(t)}`);
          }
        }
      } catch {
        // templates not supported
      }
    }

    // Prompts
    if ("prompts" in caps) {
      console.log("\nPrompts:");
      try {
        const { prompts } = await client.listPrompts();
        if (prompts.length === 0) {
          console.log("  (none)");
        }
        for (const rawPrompt of prompts) {
          const prompt = rawPrompt as Record<string, unknown>;
          const name = prompt.name as string;
          const desc = prompt.description as string | undefined;

          try {
            const { latencyMs } = await client.getPrompt(name);
            console.log(
              `  ${name}: OK (${latencyMs.toFixed(1)}ms)${
                desc ? ` — ${desc}` : ""
              }`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`  ${name}: FAIL — ${msg}`);
          }
        }
      } catch (e) {
        console.log(
          `  prompts/list FAILED: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    console.log("\nDone.");
  } catch (e) {
    console.error(`Failed to connect: ${e instanceof Error ? e.message : e}`);
    return 1;
  } finally {
    await client.close();
  }

  return 0;
}
