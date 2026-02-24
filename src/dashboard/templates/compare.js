// ─── Comparison mode ───
// Renders overlaid charts from D_BASELINE and D_CURRENT datasets.

(() => {
  const section = document.getElementById("compare-section");
  if (!section) return;
  section.style.display = "";

  // Hide the standard single-run charts
  document.querySelector(".charts").style.display = "none";

  const theme = getTheme();

  // ─── Summary diff table ───
  const metrics = [
    {
      name: "p50",
      unit: "ms",
      b: D_BASELINE.overallP50,
      c: D_CURRENT.overallP50,
      higher_is_worse: true,
    },
    {
      name: "p95",
      unit: "ms",
      b: D_BASELINE.overallP95,
      c: D_CURRENT.overallP95,
      higher_is_worse: true,
    },
    {
      name: "p99",
      unit: "ms",
      b: D_BASELINE.overallP99,
      c: D_CURRENT.overallP99,
      higher_is_worse: true,
    },
    {
      name: "rps",
      unit: "",
      b: D_BASELINE.totalRequests / D_BASELINE.durationSec,
      c: D_CURRENT.totalRequests / D_CURRENT.durationSec,
      higher_is_worse: false,
    },
    {
      name: "error_rate",
      unit: "%",
      b: D_BASELINE.totalErrors / D_BASELINE.totalRequests * 100,
      c: D_CURRENT.totalErrors / D_CURRENT.totalRequests * 100,
      higher_is_worse: true,
    },
  ];

  let tableHtml = '<div class="section"><h2>Comparison Summary</h2>';
  tableHtml +=
    '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px">';
  tableHtml += '<tr style="border-bottom:1px solid var(--border)">';
  tableHtml +=
    '<th style="text-align:left;padding:6px 12px;color:var(--text-muted)">Metric</th>';
  tableHtml +=
    '<th style="text-align:right;padding:6px 12px;color:var(--text-muted)">Baseline</th>';
  tableHtml +=
    '<th style="text-align:right;padding:6px 12px;color:var(--text-muted)">Current</th>';
  tableHtml +=
    '<th style="text-align:right;padding:6px 12px;color:var(--text-muted)">Delta</th>';
  tableHtml +=
    '<th style="text-align:left;padding:6px 12px;color:var(--text-muted)">Status</th>';
  tableHtml += "</tr>";

  for (const m of metrics) {
    const delta = m.c - m.b;
    const deltaPct = m.b !== 0 ? (delta / m.b * 100) : 0;
    const isWorse = m.higher_is_worse ? delta > 0 : delta < 0;
    const statusColor = Math.abs(deltaPct) < 2
      ? "var(--text-muted)"
      : isWorse
      ? "var(--red)"
      : "var(--green)";
    const statusText = Math.abs(deltaPct) < 2
      ? "\u2014"
      : isWorse
      ? "\u25B2 worse"
      : "\u25BC better";

    tableHtml += '<tr style="border-bottom:1px solid var(--border)">';
    tableHtml += `<td style="padding:6px 12px;font-weight:600">${m.name}</td>`;
    tableHtml += `<td style="text-align:right;padding:6px 12px">${
      m.b.toFixed(1)
    }${m.unit}</td>`;
    tableHtml += `<td style="text-align:right;padding:6px 12px">${
      m.c.toFixed(1)
    }${m.unit}</td>`;
    tableHtml +=
      `<td style="text-align:right;padding:6px 12px;color:${statusColor}">${
        deltaPct >= 0 ? "+" : ""
      }${deltaPct.toFixed(1)}%</td>`;
    tableHtml +=
      `<td style="padding:6px 12px;color:${statusColor}">${statusText}</td>`;
    tableHtml += "</tr>";
  }
  tableHtml += "</table></div>";

  // ─── Chart containers ───
  tableHtml += '<div class="charts">';
  tableHtml +=
    '<div class="chart full"><div id="cmp-throughput" class="plot"></div><div class="chart-help"><span class="title">Throughput Comparison</span><div class="legend">' +
    '<span class="legend-item"><span class="legend-dot" style="background:#238636;opacity:0.5"></span> baseline</span>' +
    '<span class="legend-item"><span class="legend-dot" style="background:#58a6ff"></span> current</span>' +
    "</div></div></div>";
  tableHtml +=
    '<div class="chart full"><div id="cmp-latency" class="plot tall"></div><div class="chart-help"><span class="title">Latency Comparison</span><div class="legend">' +
    '<span class="legend-item"><span class="legend-dot" style="background:#3fb950;opacity:0.4"></span> baseline p50</span>' +
    '<span class="legend-item"><span class="legend-dot" style="background:#3fb950"></span> current p50</span>' +
    '<span class="legend-item"><span class="legend-dot" style="background:#da3633;opacity:0.4"></span> baseline p99</span>' +
    '<span class="legend-item"><span class="legend-dot" style="background:#da3633"></span> current p99</span>' +
    "</div></div></div>";
  tableHtml +=
    '<div class="chart"><div id="cmp-hist" class="plot"></div><div class="chart-help"><span class="title">Latency Distribution</span></div></div>';
  tableHtml +=
    '<div class="chart"><div id="cmp-box" class="plot"></div><div class="chart-help"><span class="title">Latency Box Plot</span></div></div>';
  tableHtml += "</div>";

  section.innerHTML = tableHtml;

  // ─── Overlaid throughput ───
  Plotly.newPlot(
    "cmp-throughput",
    [
      {
        x: D_BASELINE.windows.map((w) => w.t),
        y: D_BASELINE.windows.map((w) => w.count),
        type: "bar",
        marker: { color: "#238636", opacity: 0.4 },
        name: "baseline req/s",
      },
      {
        x: D_CURRENT.windows.map((w) => w.t),
        y: D_CURRENT.windows.map((w) => w.count),
        type: "bar",
        marker: { color: "#58a6ff", opacity: 0.7 },
        name: "current req/s",
      },
    ],
    Object.assign({}, theme, {
      title: { text: "Throughput comparison" },
      xaxis: Object.assign({}, theme.xaxis, { title: { text: "Time (s)" } }),
      yaxis: Object.assign({}, theme.yaxis, { title: { text: "Requests/s" } }),
      barmode: "overlay",
      showlegend: false,
    }),
    plotlyCfg,
  );

  // ─── Overlaid latency ───
  Plotly.newPlot(
    "cmp-latency",
    [
      {
        x: D_BASELINE.windows.map((w) => w.t),
        y: D_BASELINE.windows.map((w) => w.p50),
        mode: "lines",
        line: { color: "#3fb950", width: 1, dash: "dash" },
        name: "baseline p50",
        opacity: 0.5,
      },
      {
        x: D_CURRENT.windows.map((w) => w.t),
        y: D_CURRENT.windows.map((w) => w.p50),
        mode: "lines",
        line: { color: "#3fb950", width: 2 },
        name: "current p50",
      },
      {
        x: D_BASELINE.windows.map((w) => w.t),
        y: D_BASELINE.windows.map((w) => w.p99),
        mode: "lines",
        line: { color: "#da3633", width: 1, dash: "dash" },
        name: "baseline p99",
        opacity: 0.5,
      },
      {
        x: D_CURRENT.windows.map((w) => w.t),
        y: D_CURRENT.windows.map((w) => w.p99),
        mode: "lines",
        line: { color: "#da3633", width: 2 },
        name: "current p99",
      },
    ],
    Object.assign({}, theme, {
      title: { text: "Latency comparison" },
      xaxis: Object.assign({}, theme.xaxis, { title: { text: "Time (s)" } }),
      yaxis: Object.assign({}, theme.yaxis, {
        title: { text: "Latency (ms)" },
      }),
      showlegend: false,
    }),
    plotlyCfg,
  );

  // ─── Overlaid histogram ───
  Plotly.newPlot(
    "cmp-hist",
    [
      {
        x: D_BASELINE.events.map((e) => e.latencyMs),
        type: "histogram",
        name: "baseline",
        opacity: 0.5,
        marker: { color: "#238636" },
        nbinsx: 50,
      },
      {
        x: D_CURRENT.events.map((e) => e.latencyMs),
        type: "histogram",
        name: "current",
        opacity: 0.5,
        marker: { color: "#58a6ff" },
        nbinsx: 50,
      },
    ],
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

  // ─── Side-by-side box plots ───
  Plotly.newPlot(
    "cmp-box",
    [
      {
        y: D_BASELINE.events.map((e) => e.latencyMs),
        type: "box",
        name: "baseline",
        marker: { color: "#238636" },
        boxpoints: false,
      },
      {
        y: D_CURRENT.events.map((e) => e.latencyMs),
        type: "box",
        name: "current",
        marker: { color: "#58a6ff" },
        boxpoints: false,
      },
    ],
    Object.assign({}, theme, {
      title: { text: "Latency comparison" },
      yaxis: Object.assign({}, theme.yaxis, {
        title: { text: "Latency (ms)" },
      }),
      showlegend: false,
    }),
    plotlyCfg,
  );
  // ─── Save summary card ───
  const copyBtn = document.getElementById("copy-summary");
  copyBtn.style.display = "";
  copyBtn.textContent = "Save summary card";
  copyBtn.addEventListener("click", function () {
    copyBtn.disabled = true;
    copyBtn.textContent = "Saving...";

    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();

    // Hide everything except summary table + throughput chart
    const chartsEl = section.querySelector(".charts");
    const chartDivs = chartsEl ? Array.from(chartsEl.children) : [];
    for (let i = 1; i < chartDivs.length; i++) chartDivs[i].style.display = "none";

    const header = document.querySelector(".header");
    const stats = document.getElementById("stats");
    const runParams = document.getElementById("run-params");
    header.style.display = "none";
    stats.style.display = "none";
    runParams.style.display = "none";

    htmlToImage.toPng(section, { backgroundColor: bg, pixelRatio: 2 })
      .then(function (dataUrl) {
        const a = document.createElement("a");
        a.download = "mcp-stress-compare-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".png";
        a.href = dataUrl;
        a.click();
      })
      .catch(function (err) {
        console.error("Save summary card failed:", err);
      })
      .finally(function () {
        for (let i = 1; i < chartDivs.length; i++) chartDivs[i].style.display = "";
        header.style.display = "";
        stats.style.display = "";
        runParams.style.display = "";
        copyBtn.disabled = false;
        copyBtn.textContent = "Save summary card";
      });
  });
})();
