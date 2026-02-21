// ─── Plotly chart rendering ───
// Each function renders a chart into a DOM container.
// Live update functions append data incrementally.

const plotlyCfg = {
  displayModeBar: true,
  responsive: true,
  modeBarButtonsToRemove: ["lasso2d", "select2d"],
};

const getTheme = () => {
  const s = getComputedStyle(document.documentElement);
  return {
    paper_bgcolor: s.getPropertyValue("--bg-card").trim(),
    plot_bgcolor: s.getPropertyValue("--bg-card").trim(),
    font: { color: s.getPropertyValue("--text").trim(), size: 11 },
    xaxis: {
      gridcolor: s.getPropertyValue("--grid").trim(),
      zerolinecolor: s.getPropertyValue("--zeroline").trim(),
    },
    yaxis: {
      gridcolor: s.getPropertyValue("--grid").trim(),
      zerolinecolor: s.getPropertyValue("--zeroline").trim(),
    },
    margin: { l: 50, r: 20, t: 40, b: 40 },
  };
};

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const i = p * (arr.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (i - lo);
};

// ─── Throughput ───

const renderThroughput = (D, theme) => {
  const ws = D.windowSec ?? 1;
  const traces = [{
    x: D.windows.map((w) => w.t),
    y: D.windows.map((w) => w.count / ws),
    type: "bar",
    marker: { color: "#238636" },
    name: "req/s",
  }];
  if (D.windows.some((w) => w.errors > 0)) {
    traces.push({
      x: D.windows.map((w) => w.t),
      y: D.windows.map((w) => w.errors / ws),
      type: "bar",
      marker: { color: "#da3633" },
      name: "errors/s",
    });
  }
  Plotly.newPlot(
    "throughput",
    traces,
    Object.assign({}, theme, {
      title: { text: "Throughput over time" },
      xaxis: Object.assign({}, theme.xaxis, { title: { text: "Time (s)" } }),
      yaxis: Object.assign({}, theme.yaxis, { title: { text: "Requests/s" } }),
      barmode: "overlay",
      showlegend: false,
      shapes: D.concShapes || [],
      annotations: D.concAnnotations || [],
    }),
    plotlyCfg,
  );
};

// ─── Latency over time ───

const renderLatencyTime = (D, theme) => {
  const scatter = {
    x: D.events.map((e) => e.t / 1000),
    y: D.events.map((e) => e.latencyMs),
    mode: "markers",
    type: "scatter",
    marker: {
      size: 3,
      color: D.events.map((e) => e.ok ? "#58a6ff" : "#da3633"),
      opacity: 0.4,
    },
    name: "requests",
    hovertemplate: "%{y:.0f}ms at %{x:.1f}s<extra></extra>",
  };
  const p50 = {
    x: D.windows.map((w) => w.t),
    y: D.windows.map((w) => w.p50),
    mode: "lines",
    line: { color: "#3fb950", width: 2 },
    name: "p50",
  };
  const p95 = {
    x: D.windows.map((w) => w.t),
    y: D.windows.map((w) => w.p95),
    mode: "lines",
    line: { color: "#d29922", width: 2 },
    name: "p95",
  };
  const p99 = {
    x: D.windows.map((w) => w.t),
    y: D.windows.map((w) => w.p99),
    mode: "lines",
    line: { color: "#da3633", width: 2 },
    name: "p99",
  };

  const shapes = (D.concShapes || []).concat(D.anomalyShapes || []);
  const annotations = (D.concAnnotations || []).concat(
    D.anomalyAnnotations || [],
  );

  Plotly.newPlot(
    "latency-time",
    [scatter, p50, p95, p99],
    Object.assign({}, theme, {
      title: { text: "Latency over time" },
      xaxis: Object.assign({}, theme.xaxis, { title: { text: "Time (s)" } }),
      yaxis: Object.assign({}, theme.yaxis, {
        title: { text: "Latency (ms)" },
      }),
      showlegend: false,
      shapes,
      annotations,
    }),
    plotlyCfg,
  );
};

// ─── Histogram ───

const renderLatencyHist = (D, theme) => {
  const traces = D.methods.map((m) => ({
    x: D.events.filter((e) => e.method === m).map((e) => e.latencyMs),
    type: "histogram",
    name: m,
    opacity: 0.7,
    nbinsx: 50,
  }));
  Plotly.newPlot(
    "latency-hist",
    traces,
    Object.assign({}, theme, {
      title: { text: "Latency distribution" },
      xaxis: Object.assign({}, theme.xaxis, {
        title: { text: "Latency (ms)" },
      }),
      yaxis: Object.assign({}, theme.yaxis, { title: { text: "Count" } }),
      barmode: "overlay",
      showlegend: false,
    }),
    plotlyCfg,
  );
};

// ─── Box plot ───

const renderLatencyBox = (D, theme) => {
  const traces = D.methods.map((m) => ({
    y: D.events.filter((e) => e.method === m).map((e) => e.latencyMs),
    type: "box",
    name: m.length > 30 ? `...${m.slice(-30)}` : m,
    marker: { color: "#58a6ff" },
    boxpoints: false,
  }));
  Plotly.newPlot(
    "latency-box",
    traces,
    Object.assign({}, theme, {
      title: { text: "Latency by method" },
      yaxis: Object.assign({}, theme.yaxis, {
        title: { text: "Latency (ms)" },
      }),
      showlegend: false,
    }),
    plotlyCfg,
  );
};

// ─── Concurrency triple-axis ───

const renderConcurrencyTriple = (D, theme) => {
  const concTrace = {
    x: D.windows.map((w) => w.t),
    y: D.windows.map((w) => w.concurrency),
    mode: "lines+markers",
    line: { color: "#bc8cff", width: 1.5 },
    marker: { color: "#bc8cff", size: 4, opacity: 0.4 },
    opacity: 0.5,
    name: "concurrency",
    yaxis: "y2",
  };
  const ws = D.windowSec ?? 1;
  const rpsTrace = {
    x: D.windows.map((w) => w.t),
    y: D.windows.map((w) => w.count / ws),
    type: "bar",
    marker: { color: "#238636", opacity: 0.5 },
    name: "req/s",
  };
  const latTrace = {
    x: D.windows.map((w) => w.t),
    y: D.windows.map((w) => w.p50),
    mode: "lines",
    line: { color: "#d29922", width: 2 },
    name: "p50 latency",
    yaxis: "y3",
  };

  Plotly.newPlot(
    "concurrency",
    [rpsTrace, concTrace, latTrace],
    Object.assign({}, theme, {
      title: { text: "Concurrency vs Throughput vs Latency" },
      xaxis: Object.assign({}, theme.xaxis, {
        title: { text: "Time (s)" },
        type: "linear",
        domain: [0.05, 0.9],
      }),
      yaxis: Object.assign({}, theme.yaxis, {
        title: { text: "Requests/s" },
        side: "left",
      }),
      yaxis2: Object.assign({}, theme.yaxis, {
        title: { text: "Concurrency" },
        overlaying: "y",
        side: "right",
        showgrid: false,
      }),
      yaxis3: Object.assign({}, theme.yaxis, {
        title: { text: "p50 (ms)" },
        overlaying: "y",
        side: "right",
        position: 0.95,
        showgrid: false,
      }),
      showlegend: false,
      shapes: D.concShapes || [],
      annotations: D.concAnnotations || [],
    }),
    plotlyCfg,
  );
};

// ─── Render all charts ───

const renderAllCharts = (D) => {
  const theme = getTheme();
  renderThroughput(D, theme);
  renderLatencyTime(D, theme);
  renderLatencyHist(D, theme);
  renderLatencyBox(D, theme);
  renderConcurrencyTriple(D, theme);
};

// ─── Live chart updates ───

const appendToThroughput = (w) => {
  const el = document.getElementById("throughput");
  if (!el || !el.data) return;
  Plotly.extendTraces("throughput", { x: [[w.t]], y: [[w.count]] }, [0]);
  if (el.data[1] && w.errors > 0) {
    Plotly.extendTraces("throughput", { x: [[w.t]], y: [[w.errors]] }, [1]);
  }
};

// ─── Re-theme all plots ───

const plotIds = [
  "throughput",
  "latency-time",
  "latency-hist",
  "latency-box",
  "concurrency",
];

const rethemeAll = () => {
  const theme = getTheme();
  for (const id of plotIds) {
    const el = document.getElementById(id);
    if (el && el.data) {
      Plotly.relayout(id, {
        paper_bgcolor: theme.paper_bgcolor,
        plot_bgcolor: theme.plot_bgcolor,
        font: theme.font,
        "xaxis.gridcolor": theme.xaxis.gridcolor,
        "xaxis.zerolinecolor": theme.xaxis.zerolinecolor,
        "yaxis.gridcolor": theme.yaxis.gridcolor,
        "yaxis.zerolinecolor": theme.yaxis.zerolinecolor,
      });
    }
  }
};
