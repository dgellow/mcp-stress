import { define } from "../../utils.ts";
import { prisma } from "../../src/db.ts";
import { config } from "../../src/config.ts";
import { generateSlug } from "../../src/idgen.ts";
import { parseNdjsonText } from "@mcp-stress/metrics/ndjson.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const contentLength = parseInt(
      ctx.req.headers.get("content-length") ?? "0",
      10,
    );
    if (contentLength > config.maxUploadBytes) {
      return new Response(
        JSON.stringify({ error: "Upload exceeds 10MB limit" }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    }

    const body = await ctx.req.text();
    const sizeBytes = new TextEncoder().encode(body).length;

    if (sizeBytes > config.maxUploadBytes) {
      return new Response(
        JSON.stringify({ error: "Upload exceeds 10MB limit" }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    }

    let parsed;
    try {
      parsed = parseNdjsonText(body);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid NDJSON" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!parsed.meta || !parsed.summary) {
      return new Response(
        JSON.stringify({
          error: "NDJSON must contain both a meta and summary event",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const slug = generateSlug();
    const title = parsed.meta.name ?? parsed.meta.profile ?? "untitled";

    await prisma.run.create({
      data: {
        id: slug,
        title,
        meta: parsed.meta as Record<string, unknown>,
        summary: parsed.summary as Record<string, unknown>,
        ndjson: body,
        size_bytes: sizeBytes,
      },
    });

    const url = `${config.appUrl}/r/${slug}`;
    return new Response(
      JSON.stringify({ url, slug }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      },
    );
  },
});
