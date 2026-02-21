// ─── Live SSE client ───
// Connects to /events endpoint, streams window stats in real-time.
// On 'complete' event, receives full PreparedData and re-renders.
// Individual request events are NOT streamed — only 1-second window aggregates.

(() => {
  const statusEl = document.createElement("div");
  statusEl.className = "live-status connected";
  statusEl.innerHTML = '<span class="dot"></span>Live';
  document.body.appendChild(statusEl);

  // All charts except throughput are deferred until test completes
  const deferredIds = [
    "latency-time",
    "latency-hist",
    "latency-box",
    "concurrency",
  ];
  for (const id of deferredIds) {
    const plotEl = document.getElementById(id);
    if (!plotEl) continue;
    const chart = plotEl.closest(".chart");
    chart.style.position = "relative";
    const overlay = document.createElement("div");
    overlay.className = "deferred-overlay";
    overlay.textContent = "Available after test completes";
    chart.appendChild(overlay);
  }

  const liveWindows = [];
  let liveMeta = null;
  let reconnectDelay = 500;

  const buildLiveData = () => {
    let totalRequests = 0;
    let totalErrors = 0;
    let maxT = 0;
    const p50s = [];
    const p95s = [];
    const p99s = [];

    for (const w of liveWindows) {
      totalRequests += w.count;
      totalErrors += w.errors;
      if (w.t > maxT) maxT = w.t;
      p50s.push(w.p50);
      p95s.push(w.p95);
      p99s.push(w.p99);
    }

    p50s.sort((a, b) => a - b);
    p95s.sort((a, b) => a - b);
    p99s.sort((a, b) => a - b);

    return {
      events: [],
      windows: liveWindows,
      methods: [],
      meta: liveMeta,
      hasConcurrency: liveWindows.some((w) => w.concurrency !== undefined),
      totalRequests,
      totalErrors,
      durationSec: maxT + 1,
      overallP50: pct(p50s, 0.5),
      overallP95: pct(p95s, 0.5),
      overallP99: pct(p99s, 0.5),
      overallMean: 0,
      overallMin: p50s.length > 0 ? p50s[0] : 0,
      overallMax: p99s.length > 0 ? p99s[p99s.length - 1] : 0,
      concChanges: [],
      concShapes: [],
      concAnnotations: [],
      anomalies: [],
      anomalyShapes: [],
      anomalyAnnotations: [],
    };
  };

  const connect = () => {
    const source = new EventSource("/events");

    source.onopen = () => {
      reconnectDelay = 500;
      statusEl.className = "live-status connected";
      statusEl.innerHTML = '<span class="dot"></span>Live';
    };

    source.addEventListener("window", (e) => {
      const w = JSON.parse(e.data);
      liveWindows.push(w);
      const liveD = buildLiveData();

      if (liveWindows.length === 1) {
        const theme = getTheme();
        renderThroughput(liveD, theme);
        renderAllInsights(liveD);
      } else {
        appendToThroughput(w);
        if (liveWindows.length % 5 === 0) {
          renderAllInsights(liveD);
        }
      }
    });

    source.addEventListener("meta", (e) => {
      liveMeta = JSON.parse(e.data);
      const liveD = buildLiveData();
      renderHeader(liveD);
      renderRunParams(liveD);
    });

    source.addEventListener("message", (e) => {
      const { text } = JSON.parse(e.data);
      const logEl = document.getElementById("engine-log");
      logEl.style.display = "";
      const entry = document.createElement("div");
      entry.className = "log-entry";
      entry.textContent = text;
      logEl.appendChild(entry);
    });

    source.addEventListener("complete", (e) => {
      const prepared = JSON.parse(e.data);
      source.close();

      statusEl.className = "live-status complete";
      statusEl.innerHTML = "Complete — page is now self-contained";
      setTimeout(() => {
        statusEl.style.display = "none";
      }, 10000);

      // Embed PreparedData for page persistence (save-as works)
      const scriptEl = document.createElement("script");
      scriptEl.id = "embedded-data";
      scriptEl.textContent = `var D = ${JSON.stringify(prepared)};`;
      document.head.appendChild(scriptEl);
      window.D = prepared;

      // Remove deferred overlays
      for (const overlay of document.querySelectorAll(".deferred-overlay")) {
        overlay.remove();
      }

      // Full re-render with complete PreparedData
      renderAllCharts(prepared);
      renderAllInsights(prepared);
    });

    source.onerror = () => {
      source.close();
      statusEl.className = "live-status";
      statusEl.innerHTML = "Reconnecting...";
      statusEl.style.color = "var(--yellow)";
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 5000);
        connect();
      }, reconnectDelay);
    };
  };

  connect();
})();
