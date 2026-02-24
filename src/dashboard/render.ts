/**
 * Dashboard HTML renderer.
 *
 * Reads template files and inlines them into a single self-contained HTML page.
 * Supports three modes:
 *   - "static": data embedded, charts render once
 *   - "live": no data, live.js connects to SSE
 *   - "compare": two datasets embedded, compare.js handles overlay
 *
 * Only the JS modules needed for each mode are included.
 */

import type {
  MetaEvent,
  RequestEvent,
  SummaryEvent,
} from "../metrics/events.ts";
import { percentile } from "../metrics/stats.ts";
import {
  base,
  compare,
  insights,
  interactions,
  live,
  plotly_charts,
  styles,
} from "./templates.generated.ts";

export interface RenderOptions {
  mode: "static" | "live" | "compare";
  data?: ChartData;
  baseline?: ChartData;
  current?: ChartData;
}

export interface ChartData {
  meta: MetaEvent | null;
  events: RequestEvent[];
  summary: SummaryEvent | null;
}

interface WindowStat {
  t: number;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  concurrency?: number;
}

interface PreparedData {
  events: RequestEvent[];
  windows: WindowStat[];
  methods: string[];
  meta: MetaEvent | null;
  hasConcurrency: boolean;
  totalRequests: number;
  totalErrors: number;
  durationSec: number;
  overallP50: number;
  overallP95: number;
  overallP99: number;
  overallMean: number;
  overallMin: number;
  overallMax: number;
  concChanges: Array<{ t: number; from: number; to: number }>;
  concShapes: unknown[];
  concAnnotations: unknown[];
  anomalies: Array<{ t: number; latencyMs: number; rollingMean: number }>;
  anomalyShapes: unknown[];
  anomalyAnnotations: unknown[];
  windowSec: number;
}

export function renderHtml(opts: RenderOptions): string {
  const baseHtml = base;
  const chartsJs = plotly_charts;
  const interactionsJs = interactions;
  const insightsJs = insights;
  const modeJs = opts.mode === "live"
    ? live
    : opts.mode === "compare"
    ? compare
    : "";

  let dataScript = "";
  let title = "mcp-stress";

  if (opts.mode === "static" && opts.data) {
    const prepared = prepareData(opts.data);
    dataScript = `const D = ${JSON.stringify(prepared)};`;
    title = opts.data.meta?.profile ?? "results";
  } else if (opts.mode === "live") {
    dataScript = "// Live mode — data streamed via SSE";
    title = "live";
  } else if (opts.mode === "compare" && opts.baseline && opts.current) {
    const b = prepareData(opts.baseline);
    const c = prepareData(opts.current);
    dataScript = `const D_BASELINE = ${JSON.stringify(b)};\nconst D_CURRENT = ${
      JSON.stringify(c)
    };`;
    title = "comparison";
  }

  // Assemble scripts: core modules + mode-specific module + init trigger
  const modules = [chartsJs, interactionsJs, insightsJs];
  if (modeJs) modules.push(modeJs);

  // Init trigger: render charts if static data is already embedded.
  // Handles both static mode and saved-after-live (where D is injected dynamically).
  modules.push(
    `// ─── Init ───\nif (typeof D !== "undefined" && D.events) {\n  renderAllCharts(D);\n  renderAllInsights(D);\n}`,
  );

  const scripts = modules.join("\n\n");

  let html = baseHtml;
  html = html.replace("{{TITLE}}", title);
  html = html.replace("{{STYLES}}", styles);
  html = html.replace("{{DATA}}", dataScript);
  html = html.replace("{{SCRIPTS}}", scripts);

  return html;
}

export function prepareData(data: ChartData): PreparedData {
  const events = data.events;
  const maxT = events.length > 0 ? events[events.length - 1].t : 0;
  const methods = [...new Set(events.map((e) => e.method))];
  const hasConcurrency = events.some((e) => e.concurrency !== undefined);
  const allLatencies = events.map((e) => e.latencyMs).sort((a, b) => a - b);
  const totalErrors = events.filter((e) => !e.ok).length;

  // Auto-coarsen window size based on duration to keep ~30-60 bars
  const durationSec = maxT / 1000;
  const windowMs = durationSec <= 60
    ? 1000
    : durationSec <= 300
    ? 5000
    : durationSec <= 600
    ? 10000
    : 30000;

  // O(n) single pass using index tracking.
  // Every window slot is emitted (even empty ones) to ensure uniform bar width.
  const windows: WindowStat[] = [];
  let idx = 0;
  let lastConcurrency: number | undefined;
  for (let ws = 0; ws <= maxT; ws += windowMs) {
    const we = ws + windowMs;
    while (idx < events.length && events[idx].t < ws) idx++;
    const start = idx;
    while (idx < events.length && events[idx].t < we) idx++;

    if (start === idx) {
      windows.push({
        t: ws / 1000,
        count: 0,
        errors: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        mean: 0,
        concurrency: lastConcurrency,
      });
      continue;
    }

    const windowEvents = events.slice(start, idx);
    const lat = windowEvents.map((e) => e.latencyMs).sort((a, b) => a - b);
    const errs = windowEvents.filter((e) => !e.ok).length;
    const sum = lat.reduce((a, b) => a + b, 0);
    windows.push({
      t: ws / 1000,
      count: windowEvents.length,
      errors: errs,
      p50: percentile(lat, 0.5),
      p95: percentile(lat, 0.95),
      p99: percentile(lat, 0.99),
      mean: sum / lat.length,
      concurrency: windowEvents.find((e) => e.concurrency !== undefined)
        ?.concurrency ?? lastConcurrency,
    });
    const wConc = windows[windows.length - 1].concurrency;
    if (wConc !== undefined) lastConcurrency = wConc;
  }

  // Concurrency change points
  const concChanges: Array<{ t: number; from: number; to: number }> = [];
  if (hasConcurrency) {
    let lastConc = 0;
    for (const w of windows) {
      if (w.concurrency !== undefined && w.concurrency !== lastConc) {
        concChanges.push({ t: w.t, from: lastConc, to: w.concurrency });
        lastConc = w.concurrency;
      }
    }
  }

  const concAnnotations = concChanges.map((c) => ({
    x: c.t,
    yref: "paper",
    y: 1,
    ay: 0,
    yanchor: "bottom",
    text: "c=" + c.to,
    showarrow: true,
    arrowhead: 0,
    arrowcolor: "#bc8cff",
    font: { size: 10, color: "#bc8cff" },
    bgcolor: "#161b22",
    bordercolor: "#bc8cff",
  }));
  const concShapes = concChanges.map((c) => ({
    type: "line",
    x0: c.t,
    x1: c.t,
    yref: "paper",
    y0: 0,
    y1: 1,
    line: { color: "#bc8cff", width: 1, dash: "dash" },
  }));

  // Anomaly detection: p99 > 3x rolling mean
  const anomalies: Array<
    { t: number; latencyMs: number; rollingMean: number }
  > = [];
  const rollingWindow = 10;
  for (let i = rollingWindow; i < windows.length; i++) {
    const rolling = windows.slice(i - rollingWindow, i);
    const rollingMean = rolling.reduce((s, w) => s + w.mean, 0) /
      rolling.length;
    if (windows[i].p99 > rollingMean * 3 && rollingMean > 0) {
      anomalies.push({
        t: windows[i].t,
        latencyMs: windows[i].p99,
        rollingMean,
      });
    }
  }

  const anomalyShapes = anomalies.map((a) => ({
    type: "rect",
    x0: a.t - 0.3,
    x1: a.t + 0.3,
    yref: "paper",
    y0: 0,
    y1: 1,
    fillcolor: "rgba(240,136,62,0.1)",
    line: { width: 0 },
  }));
  const anomalyAnnotations = anomalies.map((a) => ({
    x: a.t,
    yref: "paper",
    y: 1.02,
    yanchor: "bottom",
    showarrow: false,
    text: "\u26a0",
    font: { size: 12, color: "#f0883e" },
  }));

  // Downsample events for chart rendering.
  // Windows carry the aggregate stats; events are only needed for scatter,
  // histogram, and box plots. Cap at MAX_CHART_EVENTS to keep the HTML
  // reasonable. Always keep errors and outliers (>p95); systematically
  // sample the rest.
  const MAX_CHART_EVENTS = 20_000;
  const chartEvents = downsampleEvents(events, allLatencies, MAX_CHART_EVENTS);

  return {
    events: chartEvents,
    windows,
    methods,
    meta: data.meta,
    hasConcurrency,
    totalRequests: events.length,
    totalErrors,
    durationSec: maxT / 1000,
    overallP50: percentile(allLatencies, 0.5),
    overallP95: percentile(allLatencies, 0.95),
    overallP99: percentile(allLatencies, 0.99),
    overallMean: allLatencies.length > 0
      ? allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length
      : 0,
    overallMin: allLatencies.length > 0 ? allLatencies[0] : 0,
    overallMax: allLatencies.length > 0
      ? allLatencies[allLatencies.length - 1]
      : 0,
    concChanges,
    concShapes,
    concAnnotations,
    anomalies,
    anomalyShapes,
    anomalyAnnotations,
    windowSec: windowMs / 1000,
  };
}

/**
 * Downsample events for chart embedding.
 *
 * Keeps all errors and latency outliers (above p95) since they're rare
 * and visually important. Systematically samples the remaining normal
 * events to stay within the cap. Result is sorted by t.
 */
function downsampleEvents(
  events: RequestEvent[],
  sortedLatencies: number[],
  maxEvents: number,
): RequestEvent[] {
  if (events.length <= maxEvents) return events;

  const p95Threshold = percentile(sortedLatencies, 0.95);

  // Partition into priority (errors + outliers) and normal
  const priority: RequestEvent[] = [];
  const normal: RequestEvent[] = [];
  for (const e of events) {
    if (!e.ok || e.latencyMs > p95Threshold) {
      priority.push(e);
    } else {
      normal.push(e);
    }
  }

  // Budget for normal events after reserving space for priority
  const normalBudget = Math.max(0, maxEvents - priority.length);
  if (normalBudget === 0 || normal.length === 0) {
    return priority.slice(0, maxEvents).sort((a, b) => a.t - b.t);
  }

  // Systematic sampling: pick every Nth event to preserve time distribution
  const step = normal.length / normalBudget;
  const sampled = priority;
  for (let i = 0; i < normalBudget; i++) {
    sampled.push(normal[Math.floor(i * step)]);
  }

  return sampled.sort((a, b) => a.t - b.t);
}
