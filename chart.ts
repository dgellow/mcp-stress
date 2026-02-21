/**
 * Generate an interactive HTML chart from NDJSON event data.
 */

import type { RequestEvent, RunMeta } from "./metrics.ts";

export async function generateChart(inputPath: string, outputPath: string): Promise<void> {
  const text = await Deno.readTextFile(inputPath);
  const lines = text.split("\n").filter((l) => l.trim());

  let meta: RunMeta | null = null;
  const events: RequestEvent[] = [];

  for (const line of lines) {
    const obj = JSON.parse(line);
    if (obj.type === "meta") {
      meta = obj as RunMeta;
    } else {
      events.push(obj as RequestEvent);
    }
  }

  if (events.length === 0) {
    console.error("No events found in input file.");
    return;
  }

  const html = buildHtml(events, meta, inputPath);
  await Deno.writeTextFile(outputPath, html);
  console.log(`Chart written to ${outputPath} (${events.length} events)`);
}

function buildHtml(events: RequestEvent[], meta: RunMeta | null, source: string): string {
  const maxT = events[events.length - 1].t;
  const methods = [...new Set(events.map((e) => e.method))];
  const hasConcurrency = events.some((e) => e.concurrency !== undefined);
  const allLatencies = events.map((e) => e.latencyMs).sort((a, b) => a - b);
  const totalErrors = events.filter((e) => !e.ok).length;

  // 1-second windows
  const windows: Array<{
    t: number; count: number; errors: number;
    p50: number; p95: number; p99: number; mean: number;
    concurrency?: number;
  }> = [];
  for (let ws = 0; ws <= maxT; ws += 1000) {
    const we = ws + 1000;
    const w = events.filter((e) => e.t >= ws && e.t < we);
    if (w.length === 0) continue;
    const lat = w.map((e) => e.latencyMs).sort((a, b) => a - b);
    const errs = w.filter((e) => !e.ok).length;
    const sum = lat.reduce((a, b) => a + b, 0);
    windows.push({
      t: ws / 1000, count: w.length, errors: errs,
      p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99),
      mean: sum / lat.length,
      concurrency: w.find((e) => e.concurrency !== undefined)?.concurrency,
    });
  }

  // Detect concurrency change points for annotations
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

  // Detect anomalies: latency spikes (>3x rolling mean)
  const anomalies: Array<{ t: number; latencyMs: number; rollingMean: number }> = [];
  const rollingWindow = 10;
  for (let i = rollingWindow; i < windows.length; i++) {
    const rolling = windows.slice(i - rollingWindow, i);
    const rollingMean = rolling.reduce((s, w) => s + w.mean, 0) / rolling.length;
    if (windows[i].p99 > rollingMean * 3 && rollingMean > 0) {
      anomalies.push({ t: windows[i].t, latencyMs: windows[i].p99, rollingMean });
    }
  }

  // Build reproduction command
  let reproCmd = "deno run -A main.ts stress";
  if (meta) {
    reproCmd += ` -s ${meta.scenario}`;
    reproCmd += ` -d ${meta.durationSec}`;
    reproCmd += ` -c ${meta.concurrency}`;
    reproCmd += ` -t ${meta.timeoutMs}`;
    if (meta.tool) reproCmd += ` --tool ${meta.tool}`;
    if (meta.shape) reproCmd += ` --shape ${meta.shape}`;
    reproCmd += ` --seed ${meta.seed}`;
    reproCmd += ` -o results.ndjson`;
    reproCmd += ` -- ${meta.serverCommand} ${meta.serverArgs.join(" ")}`;
  }

  const dataJson = JSON.stringify({
    events, windows, methods, hasConcurrency, source, meta, concChanges, anomalies, reproCmd,
    totalRequests: events.length,
    totalErrors,
    durationSec: maxT / 1000,
    overallP50: pct(allLatencies, 0.5),
    overallP95: pct(allLatencies, 0.95),
    overallP99: pct(allLatencies, 0.99),
    overallMean: allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length,
    overallMin: allLatencies[0],
    overallMax: allLatencies[allLatencies.length - 1],
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>mcp-stress — ${meta?.scenario ?? source}</title>
<script src="https://cdn.plot.ly/plotly-3.3.1.min.js"></script>
<style>
  :root {
    --bg: #0d1117; --bg-card: #161b22; --bg-insight: #1c2128; --bg-anomaly: #2d1b1b;
    --border: #21262d; --grid: #21262d; --zeroline: #30363d;
    --text: #c9d1d9; --text-heading: #f0f6fc; --text-muted: #8b949e; --text-faint: #6e7681; --text-dimmed: #484f58;
    --accent: #58a6ff; --green: #3fb950; --yellow: #d29922; --red: #da3633; --purple: #bc8cff;
    --repro-bg: #161b22; --repro-text: #3fb950;
  }
  [data-theme="light"] {
    --bg: #ffffff; --bg-card: #f6f8fa; --bg-insight: #f0f4f8; --bg-anomaly: #fff0f0;
    --border: #d0d7de; --grid: #e8eaed; --zeroline: #d0d7de;
    --text: #1f2328; --text-heading: #1f2328; --text-muted: #59636e; --text-faint: #8b949e; --text-dimmed: #8b949e;
    --accent: #0969da; --green: #1a7f37; --yellow: #9a6700; --red: #d1242f; --purple: #8250df;
    --repro-bg: #f6f8fa; --repro-text: #1a7f37;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: var(--bg); color: var(--text); transition: background 0.2s, color 0.2s; }
  a { color: var(--accent); }
  .header { padding: 20px 32px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .header-left h1 { font-size: 20px; font-weight: 600; }
  .header-left .meta { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
  .theme-toggle { background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px;
                   cursor: pointer; font-size: 13px; color: var(--text-muted); transition: all 0.2s; }
  .theme-toggle:hover { border-color: var(--accent); color: var(--text); }
  .stats { display: flex; gap: 32px; padding: 16px 32px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .stat { text-align: center; min-width: 80px; }
  .stat .value { font-size: 28px; font-weight: 700; color: var(--accent); }
  .stat .value.warn { color: var(--yellow); }
  .stat .value.bad { color: var(--red); }
  .stat .label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .section { padding: 16px 32px; border-bottom: 1px solid var(--border); }
  .section h2 { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--text-heading); }
  .section p, .section li { font-size: 13px; color: var(--text-muted); line-height: 1.6; }
  .section ul { margin-left: 20px; }
  .params { display: grid; grid-template-columns: auto 1fr; gap: 2px 16px; font-size: 13px; }
  .params dt { color: var(--text-muted); }
  .params dd { color: var(--text); font-family: monospace; }
  .repro { background: var(--repro-bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-top: 8px;
           font-family: monospace; font-size: 12px; color: var(--repro-text); white-space: pre-wrap; word-break: break-all;
           cursor: pointer; position: relative; }
  .repro { position: relative; }
  .repro:hover { border-color: var(--green); }
  .repro .repro-hint { position: absolute; right: 8px; top: -10px; font-size: 10px; color: var(--text-dimmed);
                       background: var(--bg); padding: 1px 6px; border-radius: 3px; border: 1px solid var(--border); transition: all 0.15s; }
  .repro .repro-hint.copied { color: var(--green); border-color: var(--green); }
  .charts { padding: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .chart { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 8px; display: grid; grid-template-columns: 1fr; gap: 0; overflow: visible; }
  .chart.full { grid-column: 1 / -1; grid-template-columns: 1fr 280px; }
  .chart.full .chart-help { border-left: 1px solid var(--border); border-top: none; }
  .chart:not(.full) .chart-help { border-top: 1px solid var(--border); border-left: none; max-height: none; }
  .chart-help { font-size: 12px; color: var(--text-muted); padding: 12px 16px; line-height: 1.7; border-left: 1px solid var(--border); overflow: visible; }
  .chart-help .title { color: var(--text-heading); font-weight: 600; display: block; margin-bottom: 6px; font-size: 13px; }
  .chart-help .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 8px; }
  .chart-help .legend-item { display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer; user-select: none; padding: 2px 4px; border-radius: 3px; transition: opacity 0.15s; }
  .chart-help .legend-item:hover { background: var(--border); }
  .chart-help .legend-item.hidden { opacity: 0.35; text-decoration: line-through; }
  .chart-help .legend-dot { width: 10px; height: 3px; border-radius: 1px; display: inline-block; transition: opacity 0.15s; }
  .chart-help .insight { background: var(--bg-insight); border-left: 3px solid var(--accent); padding: 6px 10px; margin: 6px 0; border-radius: 0 4px 4px 0; font-size: 12px; color: var(--text); transition: background 0.15s; }
  .chart-help .insight[data-highlight]:hover { background: var(--border); cursor: pointer; }
  .chart-help .insight.warn { border-left-color: var(--yellow); }
  .chart-help .insight.bad { border-left-color: var(--red); }
  .chart-help .insight.good { border-left-color: var(--green); }
  .chart-help .how-to { color: var(--text-faint); font-size: 11px; margin-top: 6px; }
  .kw { border-bottom: 1px dotted var(--text-dimmed); cursor: help; position: relative; }
  .kw:hover { color: var(--accent); border-bottom-color: var(--accent); }
  .kw-tip { display: none; position: fixed; z-index: 999999;
            background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px;
            font-size: 11px; color: var(--text); white-space: normal; width: 260px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5); line-height: 1.5; pointer-events: none; }
  .kw-tip.visible { display: block; }
  .plot { width: 100%; height: 350px; }
  .plot.tall { height: 450px; }
  .anomalies { margin-top: 8px; }
  .anomaly { background: var(--bg-anomaly); border: 1px solid var(--red); border-radius: 4px; padding: 6px 10px; margin: 4px 0;
             font-size: 12px; color: var(--text-heading); }
  .anomaly .ts { color: var(--red); font-weight: 600; }
</style>
</head>
<body>
<div class="header">
  <div class="header-left">
    <h1>mcp-stress results</h1>
    <div class="meta" id="meta"></div>
  </div>
  <button class="theme-toggle" id="theme-toggle">Light mode</button>
</div>
<div class="stats" id="stats"></div>

<div class="section" id="run-params"></div>

<div class="charts">
  <div class="chart full">
    <div id="throughput" class="plot"></div>
    <div class="chart-help" id="help-throughput"></div>
  </div>
  <div class="chart full">
    <div id="latency-time" class="plot tall"></div>
    <div class="chart-help" id="help-latency-time"></div>
  </div>
  <div class="chart">
    <div id="latency-hist" class="plot"></div>
    <div class="chart-help" id="help-latency-hist"></div>
  </div>
  <div class="chart">
    <div id="latency-box" class="plot"></div>
    <div class="chart-help" id="help-latency-box"></div>
  </div>
  ${hasConcurrency ? `
  <div class="chart full">
    <div id="concurrency" class="plot tall"></div>
    <div class="chart-help" id="help-concurrency"></div>
  </div>` : ''}
</div>


<script>
const D = ${dataJson};
// ─── Theme ───
let isDark = true;
function getTheme() {
  const s = getComputedStyle(document.documentElement);
  return {
    paper_bgcolor: s.getPropertyValue('--bg-card').trim(),
    plot_bgcolor: s.getPropertyValue('--bg-card').trim(),
    font: { color: s.getPropertyValue('--text').trim(), size: 11 },
    xaxis: { gridcolor: s.getPropertyValue('--grid').trim(), zerolinecolor: s.getPropertyValue('--zeroline').trim() },
    yaxis: { gridcolor: s.getPropertyValue('--grid').trim(), zerolinecolor: s.getPropertyValue('--zeroline').trim() },
    margin: { l: 50, r: 20, t: 40, b: 40 },
  };
}
let dark = getTheme();
const cfg = { displayModeBar: true, responsive: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };

const plotIds = ['throughput', 'latency-time', 'latency-hist', 'latency-box', 'concurrency'];
document.getElementById('theme-toggle').addEventListener('click', function() {
  isDark = !isDark;
  document.documentElement.setAttribute('data-theme', isDark ? '' : 'light');
  if (!isDark) document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  this.textContent = isDark ? 'Light mode' : 'Dark mode';
  dark = getTheme();
  // Update all plotly charts
  for (const id of plotIds) {
    const el = document.getElementById(id);
    if (el && el.data) {
      Plotly.relayout(id, {
        paper_bgcolor: dark.paper_bgcolor, plot_bgcolor: dark.plot_bgcolor,
        font: dark.font,
        'xaxis.gridcolor': dark.xaxis.gridcolor, 'xaxis.zerolinecolor': dark.xaxis.zerolinecolor,
        'yaxis.gridcolor': dark.yaxis.gridcolor, 'yaxis.zerolinecolor': dark.yaxis.zerolinecolor,
      });
    }
  }
});

// ─── Keyword glossary ───
const KW = {
  'p50': { tip: '50th percentile (median). Half of all requests completed faster than this.', plot: 'latency-time', trace: 1, color: '#3fb950' },
  'p95': { tip: '95th percentile. Only 5% of requests were slower than this.', plot: 'latency-time', trace: 2, color: '#d29922' },
  'p99': { tip: '99th percentile. Only 1% of requests were slower. This is your worst-case for most users.', plot: 'latency-time', trace: 3, color: '#da3633' },
  'median': { tip: 'The middle value — 50% of requests are faster, 50% slower. Same as p50.', plot: 'latency-time', trace: 1, color: '#3fb950' },
  'tail latency': { tip: 'The gap between typical (p50) and worst-case (p99) latency. A long tail means unpredictable performance for some users.', plot: 'latency-time', trace: 3, color: '#da3633' },
  'throughput': { tip: 'Requests completed per second. Higher is better. Plateaus indicate the server\\'s capacity limit.', plot: 'throughput', trace: 0, color: '#238636' },
  'req/s': { tip: 'Requests per second — the rate at which the server processes work.', plot: 'throughput', trace: 0, color: '#238636' },
  'concurrency': { tip: 'Number of simultaneous in-flight requests. Higher concurrency tests how the server handles parallel load.', plot: 'concurrency', trace: 1, color: '#bc8cff' },
  'IQR': { tip: 'Interquartile Range — the span from p25 to p75, covering the middle 50% of latencies. A narrow IQR means consistent performance; a wide one means high variance.', plot: 'latency-box', trace: 0, color: '#58a6ff' },
  'rolling mean': { tip: 'Average latency over a sliding 10-second window. Anomalies are detected when p99 exceeds 3x this value.', plot: 'latency-time', trace: 1, color: '#3fb950' },
  'CV': { tip: 'Coefficient of Variation — standard deviation divided by mean. Below 20% = stable, above 50% = volatile.', plot: 'throughput', trace: 0, color: '#238636' },
  'error rate': { tip: 'Percentage of requests that returned errors. Any sustained error rate above 1% warrants investigation.', plot: 'throughput', trace: 1, color: '#da3633' },
  'saturation': { tip: 'The point where adding more concurrency no longer increases throughput — only latency. This is the server\\'s practical limit.', plot: 'concurrency', trace: 0, color: '#238636' },
};
function kw(word, displayText) {
  const entry = KW[word];
  if (!entry) return displayText || word;
  const label = displayText || word;
  return '<span class="kw" data-kw-plot="' + entry.plot + '" data-kw-trace="' + entry.trace + '" data-kw-color="' + entry.color + '">' + label + '<span class="kw-tip">' + entry.tip + '</span></span>';
}

// keyword tooltip positioning
document.addEventListener('mouseover', function(e) {
  const kwEl = e.target.closest('.kw');
  if (!kwEl) return;
  const tip = kwEl.querySelector('.kw-tip');
  if (!tip) return;
  const rect = kwEl.getBoundingClientRect();
  tip.classList.add('visible');
  // Position above the keyword, centered
  let top = rect.top - tip.offsetHeight - 6;
  let left = rect.left + rect.width / 2 - tip.offsetWidth / 2;
  // If clipped at top, show below
  if (top < 4) top = rect.bottom + 6;
  // Clamp horizontal
  if (left < 4) left = 4;
  if (left + tip.offsetWidth > window.innerWidth - 4) left = window.innerWidth - tip.offsetWidth - 4;
  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
});
document.addEventListener('mouseout', function(e) {
  const kwEl = e.target.closest('.kw');
  if (!kwEl) return;
  if (kwEl.contains(e.relatedTarget)) return;
  const tip = kwEl.querySelector('.kw-tip');
  if (tip) tip.classList.remove('visible');
});

// keyword hover → highlight trace
// Track default opacities per plot so we can restore them
const defaultOpacities = {};
function storeDefaults(plotId) {
  const el = document.getElementById(plotId);
  if (!el || !el.data || defaultOpacities[plotId]) return;
  defaultOpacities[plotId] = el.data.map(t => t.opacity !== undefined ? t.opacity : 1);
}

document.addEventListener('mouseover', function(e) {
  const el = e.target.closest('.kw[data-kw-plot]');
  if (!el) return;
  const plotId = el.getAttribute('data-kw-plot');
  const traceIdx = parseInt(el.getAttribute('data-kw-trace'));
  const plotEl = document.getElementById(plotId);
  if (!plotEl || !plotEl.data || traceIdx >= plotEl.data.length) return;
  storeDefaults(plotId);
  // Colorize the keyword underline
  el.style.borderBottomColor = el.getAttribute('data-kw-color');
  for (let i = 0; i < plotEl.data.length; i++) {
    Plotly.restyle(plotId, { opacity: i === traceIdx ? 1 : 0.08 }, [i]);
  }
});
document.addEventListener('mouseout', function(e) {
  const el = e.target.closest('.kw[data-kw-plot]');
  if (!el) return;
  // Reset underline color
  el.style.borderBottomColor = '';
  const plotId = el.getAttribute('data-kw-plot');
  const plotEl = document.getElementById(plotId);
  if (!plotEl || !plotEl.data) return;
  const defaults = defaultOpacities[plotId] || plotEl.data.map(() => 1);
  for (let i = 0; i < plotEl.data.length; i++) {
    Plotly.restyle(plotId, { opacity: defaults[i] }, [i]);
  }
});

// ─── Legend helper ───
function legendItem(plotId, traceIndex, color, label, style) {
  const dotStyle = style === 'warn' ? 'color:' + color + ';font-size:12px' : 'background:' + color;
  const dotEl = style === 'warn' ? '<span style="' + dotStyle + '">\u26a0</span>' : '<span class="legend-dot" style="' + dotStyle + '"></span>';
  return '<span class="legend-item" data-plot="' + plotId + '" data-trace="' + traceIndex + '">' + dotEl + ' ' + label + '</span>';
}
document.addEventListener('click', function(e) {
  const item = e.target.closest('.legend-item[data-plot]');
  if (!item) return;
  const plotId = item.getAttribute('data-plot');
  const traceIdx = parseInt(item.getAttribute('data-trace'));
  const el = document.getElementById(plotId);
  if (!el || !el.data || !el.data[traceIdx]) return;
  const current = el.data[traceIdx].visible;
  const next = current === 'legendonly' ? true : 'legendonly';
  Plotly.restyle(plotId, { visible: next }, [traceIdx]);
  item.classList.toggle('hidden', next === 'legendonly');
});

// ─── Insight hover highlights ───
let activeHighlight = null;
document.addEventListener('mouseover', function(e) {
  const insight = e.target.closest('.insight[data-highlight]');
  if (!insight) return;
  if (activeHighlight === insight) return;
  activeHighlight = insight;

  const plotId = insight.getAttribute('data-highlight');
  const regionStart = parseFloat(insight.getAttribute('data-region-start') || '0');
  const regionEnd = parseFloat(insight.getAttribute('data-region-end') || '0');
  const compareStart = insight.getAttribute('data-compare-start');
  const compareEnd = insight.getAttribute('data-compare-end');
  const traceIdxs = (insight.getAttribute('data-traces') || '').split(',').map(Number);

  // Dim all traces except the highlighted ones
  const el = document.getElementById(plotId);
  if (!el || !el.data) return;
  const updates = {};
  for (let i = 0; i < el.data.length; i++) {
    const isHighlighted = traceIdxs.includes(i);
    Plotly.restyle(plotId, { opacity: isHighlighted ? 1 : 0.15 }, [i]);
  }

  // Add highlight rectangle(s)
  const shapes = (el.layout.shapes || []).filter(s => !s._isHighlight);
  shapes.push({
    type: 'rect', xref: 'x', yref: 'paper', x0: regionStart, x1: regionEnd, y0: 0, y1: 1,
    fillcolor: 'rgba(88,166,255,0.08)', line: { color: 'rgba(88,166,255,0.4)', width: 1 }, _isHighlight: true,
  });
  if (compareStart && compareEnd) {
    shapes.push({
      type: 'rect', xref: 'x', yref: 'paper', x0: parseFloat(compareStart), x1: parseFloat(compareEnd), y0: 0, y1: 1,
      fillcolor: 'rgba(88,166,255,0.04)', line: { color: 'rgba(88,166,255,0.2)', width: 1, dash: 'dot' }, _isHighlight: true,
    });
  }
  Plotly.relayout(plotId, { shapes: shapes });
});
document.addEventListener('mouseout', function(e) {
  const insight = e.target.closest('.insight[data-highlight]');
  if (!insight || !activeHighlight) return;
  // Check if we're moving to a child element
  if (insight.contains(e.relatedTarget)) return;
  activeHighlight = null;

  const plotId = insight.getAttribute('data-highlight');
  const el = document.getElementById(plotId);
  if (!el || !el.data) return;

  // Restore all traces
  for (let i = 0; i < el.data.length; i++) {
    Plotly.restyle(plotId, { opacity: i === 0 ? 0.4 : 1 }, [i]);
  }
  // Remove highlight shapes
  const shapes = (el.layout.shapes || []).filter(s => !s._isHighlight);
  Plotly.relayout(plotId, { shapes: shapes });
});

// ─── Copy repro command (delegated, element created later) ───
document.addEventListener('click', function(e) {
  const repro = e.target.closest('#repro-cmd');
  if (!repro) return;
  const hint = document.getElementById('repro-hint');
  if (!hint) return;
  const text = repro.textContent.replace(hint.textContent, '').trim();
  navigator.clipboard.writeText(text).then(function() {
    hint.textContent = 'copied!';
    hint.classList.add('copied');
    setTimeout(function() { hint.textContent = 'click to copy'; hint.classList.remove('copied'); }, 2000);
  });
});

// ─── Header ───
document.getElementById('meta').textContent =
  (D.meta ? D.meta.scenario + ' | ' : '') +
  D.totalRequests + ' requests over ' + D.durationSec.toFixed(1) + 's' +
  (D.meta ? ' | ' + D.meta.startedAt : '') +
  ' | source: ' + D.source;

// ─── Stats bar ───
const rps = D.totalRequests / D.durationSec;
const errRate = D.totalErrors / D.totalRequests * 100;
const errClass = errRate > 5 ? 'bad' : errRate > 1 ? 'warn' : '';
document.getElementById('stats').innerHTML =
  stat(rps.toFixed(1), 'avg req/s') +
  stat(D.totalRequests, 'total requests') +
  stat(D.overallP50.toFixed(0) + 'ms', 'p50 latency') +
  stat(D.overallP95.toFixed(0) + 'ms', 'p95 latency') +
  stat(D.overallP99.toFixed(0) + 'ms', 'p99 latency') +
  stat(D.overallMin.toFixed(0) + 'ms', 'min') +
  stat(D.overallMax.toFixed(0) + 'ms', 'max') +
  '<div class="stat"><div class="value ' + errClass + '">' + errRate.toFixed(1) + '%</div><div class="label">error rate</div></div>';

function stat(v, l) { return '<div class="stat"><div class="value">' + v + '</div><div class="label">' + l + '</div></div>'; }
function pct(arr, p) { if (!arr.length) return 0; const i = p*(arr.length-1); const lo = Math.floor(i), hi = Math.ceil(i); return lo===hi ? arr[lo] : arr[lo]+(arr[hi]-arr[lo])*(i-lo); }

// ─── Run parameters ───
{
  let html = '<h2>Run parameters</h2><dl class="params">';
  if (D.meta) {
    const m = D.meta;
    html += kv('Scenario', m.scenario);
    html += kv('Duration', m.durationSec + 's');
    html += kv('Concurrency', m.concurrency);
    if (m.shape) html += kv('Shape', m.shape);
    if (m.tool) html += kv('Tool', m.tool);
    html += kv('Timeout', m.timeoutMs + 'ms');
    html += kv('Seed', m.seed);
    html += kv('Server', m.serverCommand + ' ' + m.serverArgs.join(' '));
    html += kv('Started', m.startedAt);
  } else {
    html += kv('Source', D.source);
    html += kv('Note', 'No metadata found in NDJSON. Re-run with latest mcp-stress for full metadata.');
  }
  html += '</dl>';
  html += '<div class="repro" id="repro-cmd">' + D.reproCmd + '<span class="repro-hint" id="repro-hint">click to copy</span></div>';
  document.getElementById('run-params').innerHTML = html;
}
function kv(k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; }

// ─── Concurrency change annotations ───
const annotations = D.concChanges.map(c => ({
  x: c.t, yref: 'paper', y: 1, ay: 0, yanchor: 'bottom',
  text: 'c=' + c.to, showarrow: true, arrowhead: 0, arrowcolor: '#bc8cff',
  font: { size: 10, color: '#bc8cff' }, bgcolor: '#161b22', bordercolor: '#bc8cff',
}));
const concShapes = D.concChanges.map(c => ({
  type: 'line', x0: c.t, x1: c.t, yref: 'paper', y0: 0, y1: 1,
  line: { color: '#bc8cff', width: 1, dash: 'dash' },
}));

// ─── Anomaly markers ───
const anomalyShapes = D.anomalies.map(a => ({
  type: 'rect', x0: a.t - 0.3, x1: a.t + 0.3, yref: 'paper', y0: 0, y1: 1,
  fillcolor: 'rgba(240,136,62,0.1)', line: { width: 0 },
}));
const anomalyAnnotations = D.anomalies.map(a => ({
  x: a.t, yref: 'paper', y: 1.02, yanchor: 'bottom', showarrow: false,
  text: '\u26a0', font: { size: 12, color: '#f0883e' },
}));

// ─── Throughput ───
{
  const traces = [{
    x: D.windows.map(w => w.t), y: D.windows.map(w => w.count),
    type: 'bar', marker: { color: '#238636' }, name: 'req/s',
  }];
  if (D.windows.some(w => w.errors > 0)) {
    traces.push({
      x: D.windows.map(w => w.t), y: D.windows.map(w => w.errors),
      type: 'bar', marker: { color: '#da3633' }, name: 'errors/s',
    });
  }
  Plotly.newPlot('throughput', traces, {
    ...dark, title: { text: 'Throughput over time' },
    xaxis: { ...dark.xaxis, title: { text: 'Time (s)' } }, yaxis: { ...dark.yaxis, title: { text: 'Requests' } },
    barmode: 'overlay', showlegend: false, shapes: concShapes, annotations,
  }, cfg);
}

// ─── Latency over time ───
{
  const scatter = {
    x: D.events.map(e => e.t / 1000), y: D.events.map(e => e.latencyMs),
    mode: 'markers', type: 'scatter',
    marker: { size: 3, color: D.events.map(e => e.ok ? '#58a6ff' : '#da3633'), opacity: 0.4 },
    name: 'requests', hovertemplate: '%{y:.0f}ms at %{x:.1f}s<extra></extra>',
  };
  const p50 = { x: D.windows.map(w => w.t), y: D.windows.map(w => w.p50), mode: 'lines', line: { color: '#3fb950', width: 2 }, name: 'p50' };
  const p95 = { x: D.windows.map(w => w.t), y: D.windows.map(w => w.p95), mode: 'lines', line: { color: '#d29922', width: 2 }, name: 'p95' };
  const p99 = { x: D.windows.map(w => w.t), y: D.windows.map(w => w.p99), mode: 'lines', line: { color: '#da3633', width: 2 }, name: 'p99' };
  Plotly.newPlot('latency-time', [scatter, p50, p95, p99], {
    ...dark, title: { text: 'Latency over time' },
    xaxis: { ...dark.xaxis, title: { text: 'Time (s)' } }, yaxis: { ...dark.yaxis, title: { text: 'Latency (ms)' } },
    showlegend: false, shapes: [...concShapes, ...anomalyShapes], annotations: [...annotations, ...anomalyAnnotations],
  }, cfg);
}

// ─── Histogram ───
{
  const traces = D.methods.map(m => ({
    x: D.events.filter(e => e.method === m).map(e => e.latencyMs),
    type: 'histogram', name: m, opacity: 0.7, nbinsx: 50,
  }));
  Plotly.newPlot('latency-hist', traces, {
    ...dark, title: { text: 'Latency distribution' },
    xaxis: { ...dark.xaxis, title: { text: 'Latency (ms)' } }, yaxis: { ...dark.yaxis, title: { text: 'Count' } },
    barmode: 'overlay', showlegend: false,
  }, cfg);
}

// ─── Box plot ───
{
  const traces = D.methods.map(m => ({
    y: D.events.filter(e => e.method === m).map(e => e.latencyMs),
    type: 'box', name: m.length > 30 ? '...' + m.slice(-30) : m,
    marker: { color: '#58a6ff' }, boxpoints: false,
  }));
  Plotly.newPlot('latency-box', traces, {
    ...dark, title: { text: 'Latency by method' }, yaxis: { ...dark.yaxis, title: { text: 'Latency (ms)' } }, showlegend: false,
  }, cfg);
}

// ─── Concurrency chart ───
if (D.hasConcurrency && document.getElementById('concurrency')) {
  const conc = { x: D.windows.map(w => w.t), y: D.windows.map(w => w.concurrency), mode: 'lines+markers', line: { color: '#bc8cff', width: 2 }, name: 'concurrency', yaxis: 'y2' };
  const rps = { x: D.windows.map(w => w.t), y: D.windows.map(w => w.count), type: 'bar', marker: { color: '#238636', opacity: 0.5 }, name: 'req/s' };
  const lat = { x: D.windows.map(w => w.t), y: D.windows.map(w => w.p50), mode: 'lines', line: { color: '#d29922', width: 2 }, name: 'p50 latency', yaxis: 'y3' };

  Plotly.newPlot('concurrency', [rps, conc, lat], {
    ...dark, title: { text: 'Concurrency vs Throughput vs Latency' },
    xaxis: { ...dark.xaxis, title: { text: 'Time (s)' }, domain: [0.05, 0.9] },
    yaxis: { ...dark.yaxis, title: { text: 'Requests/s' }, side: 'left' },
    yaxis2: { ...dark.yaxis, title: { text: 'Concurrency' }, overlaying: 'y', side: 'right', showgrid: false },
    yaxis3: { ...dark.yaxis, title: { text: 'p50 (ms)' }, overlaying: 'y', side: 'right', position: 0.95, showgrid: false },
    showlegend: false, shapes: concShapes, annotations,
  }, cfg);
}

// ─── Data-driven help text per chart ───
{
  // Throughput insights
  const rpsValues = D.windows.map(w => w.count);
  const peakRps = Math.max(...rpsValues);
  const avgRps = rpsValues.reduce((a,b) => a+b, 0) / rpsValues.length;
  const rpsVariance = rpsValues.reduce((s,v) => s + (v - avgRps) ** 2, 0) / rpsValues.length;
  const rpsStddev = Math.sqrt(rpsVariance);
  const rpsCV = avgRps > 0 ? rpsStddev / avgRps : 0; // coefficient of variation

  let tpHtml = '<span class="title">Throughput over time</span>';
  tpHtml += '<div class="legend">';
  tpHtml += legendItem('throughput', 0, '#238636', 'requests/sec');
  if (D.windows.some(w => w.errors > 0)) tpHtml += legendItem('throughput', 1, '#da3633', 'errors/sec');
  tpHtml += '</div>';

  tpHtml += '<div class="insight ' + (rpsCV < 0.3 ? 'good' : rpsCV < 0.6 ? 'warn' : 'bad') + '">';
  tpHtml += 'Peak: <strong>' + peakRps + ' ' + kw('req/s') + '</strong>, avg: <strong>' + avgRps.toFixed(1) + ' ' + kw('req/s') + '</strong>. ';
  if (rpsCV < 0.2) tpHtml += 'Very stable ' + kw('throughput') + ' (' + kw('CV') + '=' + (rpsCV*100).toFixed(0) + '%) — the server handles this load consistently.';
  else if (rpsCV < 0.5) tpHtml += 'Moderate variation (' + kw('CV') + '=' + (rpsCV*100).toFixed(0) + '%) — some fluctuation, likely from varying ' + kw('concurrency') + ' or upstream jitter.';
  else tpHtml += 'High variation (' + kw('CV') + '=' + (rpsCV*100).toFixed(0) + '%) — ' + kw('throughput') + ' is unstable. Check for queueing, GC pauses, or rate limiting.';
  tpHtml += '</div>';
  if (D.totalErrors > 0) {
    tpHtml += '<div class="insight bad">' + kw('error rate', 'Error rate') + ': ' + (D.totalErrors/D.totalRequests*100).toFixed(1) + '%. Check if errors cluster at specific times (transient) or spread evenly (systematic).</div>';
  }
  tpHtml += '<div class="how-to">Each bar = 1 second window. Drag to zoom, double-click to reset.</div>';
  document.getElementById('help-throughput').innerHTML = tpHtml;

  // Latency over time insights
  const p99p50ratio = D.overallP99 / Math.max(D.overallP50, 1);
  const latRange = D.overallMax - D.overallMin;

  let ltHtml = '<span class="title">Latency over time</span>';
  ltHtml += '<div class="legend">';
  ltHtml += legendItem('latency-time', 0, '#58a6ff', 'requests');
  ltHtml += legendItem('latency-time', 1, '#3fb950', 'p50');
  ltHtml += legendItem('latency-time', 2, '#d29922', 'p95');
  ltHtml += legendItem('latency-time', 3, '#da3633', 'p99');
  ltHtml += '</div>';

  ltHtml += '<div class="insight ' + (p99p50ratio < 2 ? 'good' : p99p50ratio < 5 ? 'warn' : 'bad') + '">';
  ltHtml += kw('p50') + '=' + D.overallP50.toFixed(0) + 'ms, ' + kw('p99') + '=' + D.overallP99.toFixed(0) + 'ms (ratio: ' + p99p50ratio.toFixed(1) + 'x). ';
  if (p99p50ratio < 2) ltHtml += 'Tight tail — most requests complete near the ' + kw('median') + '. Predictable performance.';
  else if (p99p50ratio < 5) ltHtml += 'Noticeable ' + kw('tail latency') + ' — 1% of requests are ' + p99p50ratio.toFixed(1) + 'x slower than ' + kw('median') + '. Typical under load.';
  else ltHtml += 'Very long ' + kw('tail latency') + ' — 1% of requests are ' + p99p50ratio.toFixed(1) + 'x slower than ' + kw('median') + '. Investigate outliers for timeouts, retries, or cold paths.';
  ltHtml += '</div>';

  // Check for latency trend
  if (D.windows.length >= 4) {
    const firstQuarter = D.windows.slice(0, Math.floor(D.windows.length/4));
    const lastQuarter = D.windows.slice(Math.floor(D.windows.length*3/4));
    const firstP50 = firstQuarter.reduce((s,w) => s+w.p50, 0) / firstQuarter.length;
    const lastP50 = lastQuarter.reduce((s,w) => s+w.p50, 0) / lastQuarter.length;
    const drift = (lastP50 - firstP50) / Math.max(firstP50, 1);
    const q1End = D.windows[Math.floor(D.windows.length/4)]?.t || 0;
    const q3Start = D.windows[Math.floor(D.windows.length*3/4)]?.t || 0;
    const lastT = D.windows[D.windows.length-1]?.t || 0;
    if (drift > 0.3) {
      ltHtml += '<div class="insight warn" data-highlight="latency-time" data-traces="1" data-region-start="' + q3Start + '" data-region-end="' + lastT + '" data-compare-start="0" data-compare-end="' + q1End + '">Latency drift: ' + kw('p50') + ' increased ' + (drift*100).toFixed(0) + '% from first to last quarter. Possible queueing buildup, memory pressure, or connection pool exhaustion.</div>';
    } else if (drift < -0.2) {
      ltHtml += '<div class="insight good" data-highlight="latency-time" data-traces="1" data-region-start="0" data-region-end="' + q1End + '" data-compare-start="' + q3Start + '" data-compare-end="' + lastT + '">Latency improved ' + (Math.abs(drift)*100).toFixed(0) + '% over the run — server warmed up (JIT, caches, connection reuse).</div>';
    }
  }
  // Anomalies inline
  if (D.anomalies.length > 0) {
    ltHtml += '<div style="margin-top:8px"><strong style="color:var(--text-heading);font-size:12px">Anomalies (' + D.anomalies.length + ')</strong>';
    for (const a of D.anomalies.slice(0, 5)) {
      ltHtml += '<div class="insight warn" style="font-size:11px;padding:4px 8px;margin:3px 0" data-highlight="latency-time" data-traces="3" data-region-start="' + (a.t-2) + '" data-region-end="' + (a.t+2) + '">';
      ltHtml += '<strong>t=' + a.t.toFixed(0) + 's</strong> ' + kw('p99') + '=' + a.latencyMs.toFixed(0) + 'ms (' + (a.latencyMs / a.rollingMean).toFixed(1) + 'x ' + kw('rolling mean') + ')';
      ltHtml += '</div>';
    }
    if (D.anomalies.length > 5) ltHtml += '<div style="font-size:11px;color:var(--text-faint)">...and ' + (D.anomalies.length - 5) + ' more</div>';
    ltHtml += '</div>';
  }
  ltHtml += '<div class="how-to">Drag to zoom into a region. Double-click to reset.</div>';
  document.getElementById('help-latency-time').innerHTML = ltHtml;

  // Histogram insights
  const allLat = D.events.map(e => e.latencyMs).sort((a,b) => a-b);
  const iqr = pct(allLat, 0.75) - pct(allLat, 0.25);
  const skew = (D.overallMean - D.overallP50) / Math.max(iqr, 1);

  let hHtml = '<span class="title">Latency distribution</span>';
  hHtml += '<div class="insight ' + (Math.abs(skew) < 0.5 ? 'good' : 'warn') + '">';
  hHtml += 'Range: ' + D.overallMin.toFixed(0) + '–' + D.overallMax.toFixed(0) + 'ms. ' + kw('IQR', 'IQR (middle 50%)') + ': ' + iqr.toFixed(0) + 'ms. ';
  if (Math.abs(skew) < 0.3) hHtml += 'Symmetric distribution — consistent latency across requests.';
  else if (skew > 0) hHtml += 'Right-skewed (mean > ' + kw('median') + ' by ' + (D.overallMean - D.overallP50).toFixed(0) + 'ms) — a minority of requests are significantly slower, pulling the mean up.';
  else hHtml += 'Left-skewed — unusual, most requests are slower than the ' + kw('median') + ' cluster.';
  hHtml += '</div>';
  document.getElementById('help-latency-hist').innerHTML = hHtml;

  // Box plot insights
  let bHtml = '<span class="title">Latency by method</span>';
  if (D.methods.length === 1) {
    bHtml += '<div class="insight">Single method (' + D.methods[0] + '). Box shows p25–p75, line = median, whiskers = p5–p95.</div>';
  } else {
    bHtml += '<div class="insight">Comparing ' + D.methods.length + ' methods. Look for boxes at different heights — that tells you which operations are inherently slower.</div>';
  }
  document.getElementById('help-latency-box').innerHTML = bHtml;

  // Concurrency chart insights
  if (D.hasConcurrency && document.getElementById('help-concurrency')) {
    let cHtml = '<span class="title">Concurrency vs Throughput vs Latency</span>';
    cHtml += '<div class="legend">';
    cHtml += legendItem('concurrency', 0, '#238636', 'throughput (req/s)');
    cHtml += legendItem('concurrency', 1, '#bc8cff', 'concurrency');
    cHtml += legendItem('concurrency', 2, '#d29922', 'p50 latency');
    cHtml += '</div>';

    // Find the peak throughput window and its concurrency
    const peakWindow = D.windows.reduce((best, w) => w.count > best.count ? w : best, D.windows[0]);
    cHtml += '<div class="insight">Peak ' + kw('throughput') + ': <strong>' + peakWindow.count + ' ' + kw('req/s') + '</strong> at ' + kw('concurrency') + ' <strong>' + (peakWindow.concurrency || '?') + '</strong> (t=' + peakWindow.t.toFixed(0) + 's). ';

    // Check if there's a plateau pattern
    if (D.concChanges.length >= 2) {
      const lastChange = D.concChanges[D.concChanges.length - 1];
      const prevChange = D.concChanges[D.concChanges.length - 2];
      const windowsAtLast = D.windows.filter(w => w.concurrency === lastChange.to);
      const windowsAtPrev = D.windows.filter(w => w.concurrency === prevChange.to);
      if (windowsAtLast.length && windowsAtPrev.length) {
        const rpsLast = windowsAtLast.reduce((s,w) => s+w.count, 0) / windowsAtLast.length;
        const rpsPrev = windowsAtPrev.reduce((s,w) => s+w.count, 0) / windowsAtPrev.length;
        const latLast = windowsAtLast.reduce((s,w) => s+w.p50, 0) / windowsAtLast.length;
        const latPrev = windowsAtPrev.reduce((s,w) => s+w.p50, 0) / windowsAtPrev.length;
        if (rpsLast <= rpsPrev * 1.1 && latLast > latPrev * 1.2) {
          cHtml += 'At c=' + lastChange.to + ', ' + kw('throughput') + ' plateaued while latency jumped — <strong>' + kw('saturation') + ' point is around c=' + prevChange.to + '</strong>.';
        } else {
          cHtml += 'Throughput was still scaling at c=' + lastChange.to + '.';
        }
      }
    }
    cHtml += '</div>';
    cHtml += '<div class="how-to">Three y-axes: left = req/s, right = concurrency + latency.</div>';
    document.getElementById('help-concurrency').innerHTML = cHtml;
  }
}
</script>
</body>
</html>`;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
