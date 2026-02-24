/**
 * Dashboard HTTP server for --live mode.
 *
 * Serves the dashboard HTML and streams 1-second window stats via SSE.
 * Individual request events are NOT streamed — only aggregated windows.
 * When the test completes, sends a 'complete' event with the full PreparedData,
 * making the page self-contained.
 *
 * For --repeat runs, supports multiple sequential runs with per-run events:
 * - 'new-run' signals the start of each run
 * - 'run-complete' sends PreparedData for a finished run
 * - 'all-complete' sends aggregate summary and closes SSE
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
  /** Single-run completion: sends PreparedData and closes SSE. */
  complete(summary: SummaryEvent): void;
  /** Multi-run: signal start of run i/total, resets per-run state. */
  startRun(index: number, total: number): void;
  /** Multi-run: complete one run, send its PreparedData without closing SSE. */
  completeRun(index: number, summary: SummaryEvent): void;
  /** Multi-run: all runs done, send aggregate and close SSE. */
  allComplete(aggregateSummary: SummaryEvent): void;
  stop(): Promise<void>;
}

export function createDashboardServer(): DashboardServer {
  let server: Deno.HttpServer | null = null;
  let liveHtml = "";
  const encoder = new TextEncoder();
  const controllers = new Set<ReadableStreamDefaultController>();
  let allEvents: RequestEvent[] = [];
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

  function buildPreparedData(summary: SummaryEvent) {
    const chartData: ChartData = {
      meta,
      events: allEvents,
      summary,
    };
    return prepareData(chartData);
  }

  function resetRunState() {
    allEvents = [];
    windowBuffer = [];
    windowStart = 0;
  }

  function closeAllConnections() {
    for (const ctrl of controllers) {
      try {
        ctrl.close();
      } catch { /* already closed */ }
    }
    controllers.clear();
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

    // ─── Single-run completion ──────────────────────────────────

    complete(summary: SummaryEvent) {
      flushWindow();
      if (flushTimer !== null) {
        clearInterval(flushTimer);
        flushTimer = null;
      }

      const prepared = buildPreparedData(summary);
      sendToAll("complete", JSON.stringify(prepared));
      closeAllConnections();
    },

    // ─── Multi-run (--repeat) ───────────────────────────────────

    startRun(index: number, total: number) {
      resetRunState();
      sendToAll("new-run", JSON.stringify({ index, total }));
    },

    completeRun(index: number, summary: SummaryEvent) {
      // Flush remaining window data for this run
      flushWindow();

      const prepared = buildPreparedData(summary);
      sendToAll(
        "run-complete",
        JSON.stringify({ index, prepared }),
      );

      // Reset state for the next run
      resetRunState();
    },

    allComplete(aggregateSummary: SummaryEvent) {
      if (flushTimer !== null) {
        clearInterval(flushTimer);
        flushTimer = null;
      }

      sendToAll(
        "all-complete",
        JSON.stringify({
          summary: aggregateSummary,
        }),
      );
      closeAllConnections();
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
