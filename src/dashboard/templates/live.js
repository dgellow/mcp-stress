// ─── Live SSE client ───
// Connects to /events endpoint, streams window stats in real-time.
// On 'complete' event, receives full PreparedData and re-renders.
// Individual request events are NOT streamed — only 1-second window aggregates.
//
// For --repeat runs, handles multiple sequential runs with tabs:
// - 'new-run' creates a new tab for each run
// - 'run-complete' stores PreparedData per run
// - 'all-complete' adds an Aggregate tab and closes SSE

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

  function addDeferredOverlays() {
    for (const id of deferredIds) {
      const plotEl = document.getElementById(id);
      if (!plotEl) continue;
      const chart = plotEl.closest(".chart");
      // Remove existing overlay if any
      const existing = chart.querySelector(".deferred-overlay");
      if (existing) continue;
      chart.style.position = "relative";
      const overlay = document.createElement("div");
      overlay.className = "deferred-overlay";
      overlay.textContent = "Available after test completes";
      chart.appendChild(overlay);
    }
  }

  function removeDeferredOverlays() {
    for (const overlay of document.querySelectorAll(".deferred-overlay")) {
      overlay.remove();
    }
  }

  addDeferredOverlays();

  // ─── State ────────────────────────────────────────────────────
  // For single runs, runs stays empty and we use the flat liveWindows/liveMeta.
  // For multi-run (--repeat), each run gets its own entry in runs[].

  const runs = [];        // [{index, windows, meta, prepared?}]
  let activeRunIndex = -1;
  let totalRuns = 1;
  let isMultiRun = false;

  // Flat state for single-run mode (or the currently active run in multi-run)
  let liveWindows = [];
  let liveMeta = null;
  let reconnectDelay = 500;
  let tabBar = null;

  const buildLiveData = (windows, meta) => {
    let totalRequests = 0;
    let totalErrors = 0;
    let maxT = 0;
    const p50s = [];
    const p95s = [];
    const p99s = [];

    for (const w of windows) {
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
      windows: windows,
      methods: [],
      meta: meta,
      hasConcurrency: windows.some((w) => w.concurrency !== undefined),
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

  // ─── Tab bar ──────────────────────────────────────────────────

  function ensureTabBar() {
    if (tabBar) return;
    tabBar = document.createElement("div");
    tabBar.className = "tab-bar";
    const charts = document.querySelector(".charts");
    charts.parentNode.insertBefore(tabBar, charts);
  }

  function addTab(label, index) {
    ensureTabBar();
    const btn = document.createElement("button");
    btn.className = "tab-btn";
    btn.textContent = label;
    btn.dataset.runIndex = index;
    btn.addEventListener("click", () => switchToTab(index));
    tabBar.appendChild(btn);
  }

  function switchToTab(index) {
    activeRunIndex = index;
    // Update active tab styling
    for (const btn of tabBar.querySelectorAll(".tab-btn")) {
      btn.classList.toggle("active", parseInt(btn.dataset.runIndex) === index);
    }
    // Render the tab's data
    const run = runs.find((r) => r.index === index);
    if (!run) return;

    if (run.prepared) {
      removeDeferredOverlays();
      renderAllCharts(run.prepared);
      renderAllInsights(run.prepared);
      renderHeader(run.prepared);
      renderRunParams(run.prepared);
    } else {
      addDeferredOverlays();
      const liveD = buildLiveData(run.windows, run.meta);
      const theme = getTheme();
      renderThroughput(liveD, theme);
      renderAllInsights(liveD);
      renderHeader(liveD);
      renderRunParams(liveD);
    }
  }

  // ─── SSE connection ───────────────────────────────────────────

  const connect = () => {
    const source = new EventSource("/events");

    source.onopen = () => {
      reconnectDelay = 500;
      statusEl.className = "live-status connected";
      statusEl.innerHTML = '<span class="dot"></span>Live';
    };

    source.addEventListener("window", (e) => {
      const w = JSON.parse(e.data);

      if (isMultiRun) {
        // Append to the active run's windows
        const run = runs.find((r) => r.index === activeRunIndex);
        if (run) run.windows.push(w);
        // Only render if this tab is active
        liveWindows = run ? run.windows : liveWindows;
      } else {
        liveWindows.push(w);
      }

      const liveD = buildLiveData(liveWindows, liveMeta);

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

      if (isMultiRun) {
        const run = runs.find((r) => r.index === activeRunIndex);
        if (run) run.meta = liveMeta;
      }

      const liveD = buildLiveData(liveWindows, liveMeta);
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

    // ─── Single-run complete ──────────────────────────────────

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

      removeDeferredOverlays();
      renderAllCharts(prepared);
      renderAllInsights(prepared);
    });

    // ─── Multi-run events ─────────────────────────────────────

    source.addEventListener("new-run", (e) => {
      const { index, total } = JSON.parse(e.data);
      isMultiRun = true;
      totalRuns = total;

      const run = { index, windows: [], meta: null, prepared: null };
      runs.push(run);
      activeRunIndex = index;
      liveWindows = run.windows;
      liveMeta = null;

      addTab(`Run ${index}`, index);
      switchToTab(index);

      addDeferredOverlays();

      statusEl.className = "live-status connected";
      statusEl.innerHTML = `<span class="dot"></span>Run ${index}/${total}`;
    });

    source.addEventListener("run-complete", (e) => {
      const { index, prepared } = JSON.parse(e.data);
      const run = runs.find((r) => r.index === index);
      if (run) {
        run.prepared = prepared;
      }
      // If this tab is active, render it fully
      if (activeRunIndex === index) {
        removeDeferredOverlays();
        renderAllCharts(prepared);
        renderAllInsights(prepared);
      }
    });

    source.addEventListener("all-complete", (e) => {
      const { summary } = JSON.parse(e.data);
      source.close();

      // Add aggregate tab
      const aggIndex = -1; // special index for aggregate
      runs.push({
        index: aggIndex,
        windows: [],
        meta: null,
        // Build a minimal prepared-like object from the aggregate summary
        prepared: {
          events: [],
          windows: [],
          methods: [],
          meta: { profile: "Aggregate", aggregate: true, runCount: totalRuns },
          hasConcurrency: false,
          totalRequests: summary.totalRequests,
          totalErrors: summary.totalErrors,
          durationSec: summary.durationMs / 1000,
          overallP50: summary.overall.p50,
          overallP95: summary.overall.p95,
          overallP99: summary.overall.p99,
          overallMean: summary.overall.mean,
          overallMin: summary.overall.min,
          overallMax: summary.overall.max,
          concChanges: [],
          concShapes: [],
          concAnnotations: [],
          anomalies: [],
          anomalyShapes: [],
          anomalyAnnotations: [],
          windowSec: 1,
        },
      });
      addTab("Aggregate", aggIndex);

      statusEl.className = "live-status complete";
      statusEl.innerHTML = `Complete — ${totalRuns} runs`;
      setTimeout(() => {
        statusEl.style.display = "none";
      }, 10000);

      // Embed last active run's data for page persistence
      const lastRun = runs.find((r) => r.index === activeRunIndex);
      if (lastRun && lastRun.prepared) {
        const scriptEl = document.createElement("script");
        scriptEl.id = "embedded-data";
        scriptEl.textContent = `var D = ${JSON.stringify(lastRun.prepared)};`;
        document.head.appendChild(scriptEl);
        window.D = lastRun.prepared;
      }
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
