// ─── Save as image ───

document.getElementById("save-image").addEventListener("click", function () {
  const btn = this;
  btn.disabled = true;
  btn.textContent = "Saving...";

  const actions = document.querySelector(".header-actions");
  const liveStatus = document.querySelector(".live-status");
  actions.style.display = "none";
  if (liveStatus) liveStatus.style.display = "none";

  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();

  htmlToImage.toPng(document.body, { backgroundColor: bg })
    .then(function (dataUrl) {
      const a = document.createElement("a");
      a.download = "mcp-stress-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".png";
      a.href = dataUrl;
      a.click();
    })
    .catch(function (err) {
      console.error("Save as image failed:", err);
    })
    .finally(function () {
      actions.style.display = "";
      if (liveStatus) liveStatus.style.display = "";
      btn.disabled = false;
      btn.textContent = "Save as image";
    });
});

// ─── Theme toggle ───

let isDark = localStorage.getItem("mcp-stress-theme") !== "light";
if (!isDark) {
  document.documentElement.setAttribute("data-theme", "light");
  document.getElementById("theme-toggle").textContent = "Dark mode";
}

document.getElementById("theme-toggle").addEventListener("click", function () {
  isDark = !isDark;
  if (isDark) {
    document.documentElement.removeAttribute("data-theme");
    this.textContent = "Light mode";
  } else {
    document.documentElement.setAttribute("data-theme", "light");
    this.textContent = "Dark mode";
  }
  localStorage.setItem("mcp-stress-theme", isDark ? "dark" : "light");
  rethemeAll();
});

// ─── Keyword glossary ───

const KW = {
  "p50": {
    tip:
      "50th percentile (median). Half of all requests completed faster than this.",
    plot: "latency-time",
    trace: 1,
    color: "#3fb950",
  },
  "p95": {
    tip: "95th percentile. Only 5% of requests were slower than this.",
    plot: "latency-time",
    trace: 2,
    color: "#d29922",
  },
  "p99": {
    tip:
      "99th percentile. Only 1% of requests were slower. This is your worst-case for most users.",
    plot: "latency-time",
    trace: 3,
    color: "#da3633",
  },
  "median": {
    tip:
      "The middle value — 50% of requests are faster, 50% slower. Same as p50.",
    plot: "latency-time",
    trace: 1,
    color: "#3fb950",
  },
  "tail latency": {
    tip:
      "The gap between typical (p50) and worst-case (p99) latency. A long tail means unpredictable performance for some users.",
    plot: "latency-time",
    trace: 3,
    color: "#da3633",
  },
  "throughput": {
    tip:
      "Requests completed per second. Higher is better. Plateaus indicate the server's capacity limit.",
    plot: "throughput",
    trace: 0,
    color: "#238636",
  },
  "req/s": {
    tip: "Requests per second — the rate at which the server processes work.",
    plot: "throughput",
    trace: 0,
    color: "#238636",
  },
  "concurrency": {
    tip:
      "Number of simultaneous in-flight requests. Higher concurrency tests how the server handles parallel load.",
    plot: "concurrency",
    trace: 1,
    color: "#bc8cff",
  },
  "IQR": {
    tip:
      "Interquartile Range — the span from p25 to p75, covering the middle 50% of latencies. A narrow IQR means consistent performance; a wide one means high variance.",
    plot: "latency-box",
    trace: 0,
    color: "#58a6ff",
  },
  "rolling mean": {
    tip:
      "Average latency over a sliding 10-second window. Anomalies are detected when p99 exceeds 3x this value.",
    plot: "latency-time",
    trace: 1,
    color: "#3fb950",
  },
  "CV": {
    tip:
      "Coefficient of Variation — standard deviation divided by mean. Below 20% = stable, above 50% = volatile.",
    plot: "throughput",
    trace: 0,
    color: "#238636",
  },
  "error rate": {
    tip:
      "Percentage of requests that returned errors. Any sustained error rate above 1% warrants investigation.",
    plot: "throughput",
    trace: 1,
    color: "#da3633",
  },
  "saturation": {
    tip:
      "The point where adding more concurrency no longer increases throughput — only latency. This is the server's practical limit.",
    plot: "concurrency",
    trace: 0,
    color: "#238636",
  },
};

const kw = (word, displayText) => {
  const entry = KW[word];
  if (!entry) return displayText || word;
  const label = displayText || word;
  return `<span class="kw" data-kw-plot="${entry.plot}" data-kw-trace="${entry.trace}" data-kw-color="${entry.color}">${label}<span class="kw-tip">${entry.tip}</span></span>`;
};

// ─── Keyword tooltip positioning ───

document.addEventListener("mouseover", (e) => {
  const kwEl = e.target.closest(".kw");
  if (!kwEl) return;
  const tip = kwEl.querySelector(".kw-tip");
  if (!tip) return;
  const rect = kwEl.getBoundingClientRect();
  tip.classList.add("visible");
  let top = rect.top - tip.offsetHeight - 6;
  let left = rect.left + rect.width / 2 - tip.offsetWidth / 2;
  if (top < 4) top = rect.bottom + 6;
  if (left < 4) left = 4;
  if (left + tip.offsetWidth > window.innerWidth - 4) {
    left = window.innerWidth - tip.offsetWidth - 4;
  }
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
});

document.addEventListener("mouseout", (e) => {
  const kwEl = e.target.closest(".kw");
  if (!kwEl) return;
  if (kwEl.contains(e.relatedTarget)) return;
  const tip = kwEl.querySelector(".kw-tip");
  if (tip) tip.classList.remove("visible");
});

// ─── Keyword hover → highlight trace ───

const defaultOpacities = {};

const storeDefaults = (plotId) => {
  const el = document.getElementById(plotId);
  if (!el || !el.data || defaultOpacities[plotId]) return;
  defaultOpacities[plotId] = el.data.map((t) =>
    t.opacity !== undefined ? t.opacity : 1
  );
};

document.addEventListener("mouseover", (e) => {
  const el = e.target.closest(".kw[data-kw-plot]");
  if (!el) return;
  const plotId = el.getAttribute("data-kw-plot");
  const traceIdx = parseInt(el.getAttribute("data-kw-trace"));
  const plotEl = document.getElementById(plotId);
  if (!plotEl || !plotEl.data || traceIdx >= plotEl.data.length) return;
  storeDefaults(plotId);
  el.style.borderBottomColor = el.getAttribute("data-kw-color");
  for (let i = 0; i < plotEl.data.length; i++) {
    Plotly.restyle(plotId, { opacity: i === traceIdx ? 1 : 0.08 }, [i]);
  }
});

document.addEventListener("mouseout", (e) => {
  const el = e.target.closest(".kw[data-kw-plot]");
  if (!el) return;
  el.style.borderBottomColor = "";
  const plotId = el.getAttribute("data-kw-plot");
  const plotEl = document.getElementById(plotId);
  if (!plotEl || !plotEl.data) return;
  const defaults = defaultOpacities[plotId] || plotEl.data.map(() => 1);
  for (let i = 0; i < plotEl.data.length; i++) {
    Plotly.restyle(plotId, { opacity: defaults[i] }, [i]);
  }
});

// ─── Legend toggle ───

const legendItem = (plotId, traceIndex, color, label) =>
  `<span class="legend-item" data-plot="${plotId}" data-trace="${traceIndex}"><span class="legend-dot" style="background:${color}"></span> ${label}</span>`;

document.addEventListener("click", (e) => {
  const item = e.target.closest(".legend-item[data-plot]");
  if (!item) return;
  const plotId = item.getAttribute("data-plot");
  const traceIdx = parseInt(item.getAttribute("data-trace"));
  const el = document.getElementById(plotId);
  if (!el || !el.data || !el.data[traceIdx]) return;
  const current = el.data[traceIdx].visible;
  const next = current === "legendonly" ? true : "legendonly";
  Plotly.restyle(plotId, { visible: next }, [traceIdx]);
  item.classList.toggle("hidden", next === "legendonly");
});

// ─── Insight hover → highlight chart region ───

let activeHighlight = null;

document.addEventListener("mouseover", (e) => {
  const insight = e.target.closest(".insight[data-highlight]");
  if (!insight) return;
  if (activeHighlight === insight) return;
  activeHighlight = insight;

  const plotId = insight.getAttribute("data-highlight");
  const regionStart = parseFloat(
    insight.getAttribute("data-region-start") || "0",
  );
  const regionEnd = parseFloat(insight.getAttribute("data-region-end") || "0");
  const traceIdxs = (insight.getAttribute("data-traces") || "").split(",").map(
    Number,
  );

  const el = document.getElementById(plotId);
  if (!el || !el.data) return;
  storeDefaults(plotId);
  for (let i = 0; i < el.data.length; i++) {
    Plotly.restyle(plotId, { opacity: traceIdxs.indexOf(i) >= 0 ? 1 : 0.15 }, [
      i,
    ]);
  }

  const shapes = (el.layout.shapes || []).filter((s) => !s._isHighlight);
  shapes.push({
    type: "rect",
    xref: "x",
    yref: "paper",
    x0: regionStart,
    x1: regionEnd,
    y0: 0,
    y1: 1,
    fillcolor: "rgba(88,166,255,0.08)",
    line: { color: "rgba(88,166,255,0.4)", width: 1 },
    _isHighlight: true,
  });
  Plotly.relayout(plotId, { shapes });
});

document.addEventListener("mouseout", (e) => {
  const insight = e.target.closest(".insight[data-highlight]");
  if (!insight || !activeHighlight) return;
  if (insight.contains(e.relatedTarget)) return;
  activeHighlight = null;

  const plotId = insight.getAttribute("data-highlight");
  const el = document.getElementById(plotId);
  if (!el || !el.data) return;

  const defaults = defaultOpacities[plotId] || el.data.map(() => 1);
  for (let i = 0; i < el.data.length; i++) {
    Plotly.restyle(plotId, { opacity: defaults[i] }, [i]);
  }
  const shapes = (el.layout.shapes || []).filter((s) => !s._isHighlight);
  Plotly.relayout(plotId, { shapes });
});

// ─── Copy repro command ───

document.addEventListener("click", (e) => {
  const repro = e.target.closest("#repro-cmd");
  if (!repro) return;
  const hint = document.getElementById("repro-hint");
  if (!hint) return;
  const text = repro.textContent.replace(hint.textContent, "").trim();
  navigator.clipboard.writeText(text).then(() => {
    hint.textContent = "copied!";
    hint.classList.add("copied");
    setTimeout(() => {
      hint.textContent = "click to copy";
      hint.classList.remove("copied");
    }, 2000);
  });
});
