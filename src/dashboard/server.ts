/**
 * Dashboard HTTP server for --live mode.
 *
 * Serves the dashboard HTML and streams 1-second window stats via SSE.
 * Individual request events are NOT streamed — only aggregated windows.
 * When the test completes, sends a 'complete' event with the full PreparedData,
 * making the page self-contained.
 */

import type {
  MetaEvent,
  RequestEvent,
  SummaryEvent,
} from "../metrics/events.ts";
import { type ChartData, prepareData, renderHtml } from "./render.ts";
import { percentile } from "../metrics/stats.ts";

export interface DashboardServer {
  start(): Promise<string>;
  pushEvent(event: RequestEvent): void;
  pushMeta(meta: MetaEvent): void;
  pushMessage(msg: string): void;
  complete(summary: SummaryEvent): void;
  stop(): Promise<void>;
}

export function createDashboardServer(): DashboardServer {
  let server: Deno.HttpServer | null = null;
  let liveHtml = "";
  const encoder = new TextEncoder();
  const controllers = new Set<ReadableStreamDefaultController>();
  const allEvents: RequestEvent[] = [];
  let meta: MetaEvent | null = null;
  let windowBuffer: RequestEvent[] = [];
  let windowStart = 0;
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  function sendToAll(eventType: string, data: string) {
    const msg = encoder.encode(`event: ${eventType}\ndata: ${data}\n\n`);
    for (const ctrl of controllers) {
      try {
        ctrl.enqueue(msg);
      } catch {
        controllers.delete(ctrl);
      }
    }
  }

  function flushWindow() {
    if (windowBuffer.length === 0) {
      // Send empty window so live chart has uniform bar widths
      sendToAll(
        "window",
        JSON.stringify({
          t: windowStart,
          count: 0,
          errors: 0,
          p50: 0,
          p95: 0,
          p99: 0,
        }),
      );
      windowStart++;
      return;
    }
    const latencies = windowBuffer.map((e) => e.latencyMs).sort((a, b) =>
      a - b
    );
    const errors = windowBuffer.filter((e) => !e.ok).length;
    const concurrency = windowBuffer[windowBuffer.length - 1].concurrency;
    const w = {
      t: windowStart,
      count: windowBuffer.length,
      errors,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      concurrency,
    };
    windowBuffer = [];
    sendToAll("window", JSON.stringify(w));
  }

  return {
    async start(): Promise<string> {
      liveHtml = await renderHtml({ mode: "live" });

      // Start window flush timer (every 1 second)
      flushTimer = setInterval(flushWindow, 1000);

      return new Promise((resolve) => {
        server = Deno.serve({
          port: 0,
          onListen: ({ port }) => {
            resolve(`http://localhost:${port}`);
          },
        }, (req: Request): Response => {
          const url = new URL(req.url);

          if (url.pathname === "/" || url.pathname === "/index.html") {
            return new Response(liveHtml, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }

          if (url.pathname === "/events") {
            const stream = new ReadableStream({
              start(controller) {
                controllers.add(controller);
                if (meta) {
                  controller.enqueue(
                    encoder.encode(
                      `event: meta\ndata: ${JSON.stringify(meta)}\n\n`,
                    ),
                  );
                }
              },
              cancel() {
                // Client disconnected — controller removed on next send attempt
              },
            });

            return new Response(stream, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }

          return new Response("Not found", { status: 404 });
        });
      });
    },

    pushEvent(event: RequestEvent) {
      allEvents.push(event);

      // Buffer for window stats — only windows are streamed, not individual events
      const evtSec = Math.floor(event.t / 1000);
      if (evtSec > windowStart && windowBuffer.length > 0) {
        flushWindow();
        windowStart = evtSec;
      }
      windowBuffer.push(event);
    },

    pushMeta(m: MetaEvent) {
      meta = m;
      sendToAll("meta", JSON.stringify(m));
    },

    pushMessage(msg: string) {
      sendToAll("message", JSON.stringify({ text: msg, t: Date.now() }));
    },

    complete(summary: SummaryEvent) {
      // Flush any remaining window
      flushWindow();
      if (flushTimer !== null) {
        clearInterval(flushTimer);
        flushTimer = null;
      }

      // Build ChartData from accumulated state and compute PreparedData
      const chartData: ChartData = {
        meta,
        events: allEvents,
        summary,
      };
      const prepared = prepareData(chartData);

      // Send PreparedData as the complete event — browser re-renders with full dataset
      sendToAll("complete", JSON.stringify(prepared));

      // Close all SSE connections
      for (const ctrl of controllers) {
        try {
          ctrl.close();
        } catch { /* already closed */ }
      }
      controllers.clear();
    },

    async stop() {
      if (flushTimer !== null) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      if (server) {
        try {
          await server.shutdown();
        } catch { /* server already closed */ }
        server = null;
      }
    },
  };
}
