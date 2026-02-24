import { define } from "../../utils.ts";
import { prisma } from "../../src/db.ts";
import { parseNdjsonText } from "@mcp-stress/metrics/ndjson.ts";
import { renderHtml } from "@mcp-stress/dashboard/render.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const { slug } = ctx.params;

    const run = await prisma.run.findUnique({ where: { id: slug } });
    if (!run) {
      return new Response("Not found", { status: 404 });
    }

    const parsed = parseNdjsonText(run.ndjson);
    const html = await renderHtml({
      mode: "static",
      data: {
        meta: parsed.meta,
        events: parsed.events,
        summary: parsed.summary,
      },
    });

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});
