// ─── Data-driven insights ───
// Analyzes computed data and generates HTML for help panels.

const stat = (v, l) =>
  `<div class="stat"><div class="value">${v}</div><div class="label">${l}</div></div>`;

const kv = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;

const renderHeader = (D) => {
  const { meta } = D;
  const parts = [];
  if (meta) {
    parts.push(meta.profile);
    parts.push(`${D.totalRequests} requests over ${D.durationSec.toFixed(1)}s`);
    parts.push(meta.startedAt);
    parts.push(`${meta.transport}: ${meta.target}`);
  } else {
    parts.push(`${D.totalRequests} requests over ${D.durationSec.toFixed(1)}s`);
  }
  document.getElementById("meta").textContent = parts.join(" | ");
};

const renderStats = (D) => {
  const rps = D.totalRequests / D.durationSec;
  const errRate = D.totalErrors / D.totalRequests * 100;
  const errClass = errRate > 5 ? "bad" : errRate > 1 ? "warn" : "";
  document.getElementById("stats").innerHTML =
    stat(rps.toFixed(1), "avg req/s") +
    stat(D.totalRequests, "total requests") +
    stat(`${D.overallP50.toFixed(0)}ms`, "p50 latency") +
    stat(`${D.overallP95.toFixed(0)}ms`, "p95 latency") +
    stat(`${D.overallP99.toFixed(0)}ms`, "p99 latency") +
    stat(`${D.overallMin.toFixed(0)}ms`, "min") +
    stat(`${D.overallMax.toFixed(0)}ms`, "max") +
    `<div class="stat"><div class="value ${errClass}">${
      errRate.toFixed(1)
    }%</div><div class="label">error rate</div></div>`;
};

const renderRunParams = (D) => {
  const { meta } = D;
  let html = '<h2>Run parameters</h2><dl class="params">';
  if (meta) {
    html += kv("Profile", meta.profile);
    html += kv("Duration", `${meta.durationSec}s`);
    html += kv("Concurrency", meta.concurrency);
    if (meta.shape) html += kv("Shape", meta.shape);
    if (meta.tool) html += kv("Tool", meta.tool);
    html += kv("Timeout", `${meta.timeoutMs}ms`);
    html += kv("Transport", meta.transport);
    html += kv("Target", meta.target);
    if (meta.seed !== undefined) html += kv("Seed", meta.seed);
    html += kv("Started", meta.startedAt);
  }
  html += "</dl>";
  if (meta && meta.command) {
    html +=
      `<div class="repro" id="repro-cmd">${meta.command}<span class="repro-hint" id="repro-hint">click to copy</span></div>`;
  }
  document.getElementById("run-params").innerHTML = html;
};

const renderThroughputHelp = (D) => {
  const ws = D.windowSec ?? 1;
  const rpsValues = D.windows.map((w) => w.count / ws);
  const peakRps = Math.max(...rpsValues);
  const avgRps = rpsValues.reduce((a, b) => a + b, 0) / rpsValues.length;
  const rpsVariance = rpsValues.reduce((s, v) => s + (v - avgRps) ** 2, 0) /
    rpsValues.length;
  const rpsCV = avgRps > 0 ? Math.sqrt(rpsVariance) / avgRps : 0;

  let html = '<span class="title">Throughput over time</span>';
  html += '<div class="legend">';
  html += legendItem("throughput", 0, "#238636", "requests/sec");
  if (D.windows.some((w) => w.errors > 0)) {
    html += legendItem("throughput", 1, "#da3633", "errors/sec");
  }
  html += "</div>";

  html += `<div class="insight ${
    rpsCV < 0.3 ? "good" : rpsCV < 0.6 ? "warn" : "bad"
  }">`;
  html += `Peak: <strong>${peakRps.toFixed(1)} ${
    kw("req/s")
  }</strong>, avg: <strong>${avgRps.toFixed(1)} ${kw("req/s")}</strong>. `;
  if (rpsCV < 0.2) {
    html += `Very stable ${kw("throughput")} (${kw("CV")}=${
      (rpsCV * 100).toFixed(0)
    }%).`;
  } else if (rpsCV < 0.5) {
    html += `Moderate variation (${kw("CV")}=${(rpsCV * 100).toFixed(0)}%).`;
  } else {
    html += `High variation (${kw("CV")}=${
      (rpsCV * 100).toFixed(0)
    }%) — check for queueing, GC pauses, or rate limiting.`;
  }
  html += "</div>";
  if (D.totalErrors > 0) {
    html += `<div class="insight bad">${kw("error rate", "Error rate")}: ${
      (D.totalErrors / D.totalRequests * 100).toFixed(1)
    }%.</div>`;
  }
  const wLabel = ws >= 60 ? `${ws / 60} minute` : `${ws} second`;
  html +=
    `<div class="how-to">Each bar = ${wLabel} window. Drag to zoom, double-click to reset.</div>`;
  document.getElementById("help-throughput").innerHTML = html;
};

const renderLatencyTimeHelp = (D) => {
  const p99p50ratio = D.overallP99 / Math.max(D.overallP50, 1);

  let html = '<span class="title">Latency over time</span>';
  html += '<div class="legend">';
  html += legendItem("latency-time", 0, "#58a6ff", "requests");
  html += legendItem("latency-time", 1, "#3fb950", "p50");
  html += legendItem("latency-time", 2, "#d29922", "p95");
  html += legendItem("latency-time", 3, "#da3633", "p99");
  html += "</div>";

  html += `<div class="insight ${
    p99p50ratio < 2 ? "good" : p99p50ratio < 5 ? "warn" : "bad"
  }">`;
  html += `${kw("p50")}=${D.overallP50.toFixed(0)}ms, ${kw("p99")}=${
    D.overallP99.toFixed(0)
  }ms (ratio: ${p99p50ratio.toFixed(1)}x). `;
  if (p99p50ratio < 2) {
    html += "Tight tail — predictable performance.";
  } else if (p99p50ratio < 5) {
    html += `Noticeable ${kw("tail latency")} — typical under load.`;
  } else {
    html += `Very long ${kw("tail latency")} — investigate outliers.`;
  }
  html += "</div>";

  // Latency drift detection
  if (D.windows.length >= 4) {
    const q = Math.floor(D.windows.length / 4);
    const firstQuarter = D.windows.slice(0, q);
    const lastQuarter = D.windows.slice(q * 3);
    const firstP50 = firstQuarter.reduce((s, w) => s + w.p50, 0) /
      firstQuarter.length;
    const lastP50 = lastQuarter.reduce((s, w) => s + w.p50, 0) /
      lastQuarter.length;
    const drift = (lastP50 - firstP50) / Math.max(firstP50, 1);
    const q1End = D.windows[q]?.t ?? 0;
    const q3Start = D.windows[q * 3]?.t ?? 0;
    const lastT = D.windows[D.windows.length - 1]?.t ?? 0;
    if (drift > 0.3) {
      html +=
        `<div class="insight warn" data-highlight="latency-time" data-traces="1" data-region-start="${q3Start}" data-region-end="${lastT}">Latency drift: ${
          kw("p50")
        } increased ${
          (drift * 100).toFixed(0)
        }% from first to last quarter.</div>`;
    } else if (drift < -0.2) {
      html +=
        `<div class="insight good" data-highlight="latency-time" data-traces="1" data-region-start="0" data-region-end="${q1End}">Latency improved ${
          (Math.abs(drift) * 100).toFixed(0)
        }% — server warmed up.</div>`;
    }
  }

  // Anomalies
  if (D.anomalies && D.anomalies.length > 0) {
    html +=
      `<div style="margin-top:8px"><strong style="color:var(--text-heading);font-size:12px">Anomalies (${D.anomalies.length})</strong>`;
    const shown = D.anomalies.slice(0, 5);
    for (const a of shown) {
      html +=
        `<div class="insight warn" style="font-size:11px;padding:4px 8px;margin:3px 0" data-highlight="latency-time" data-traces="3" data-region-start="${
          a.t - 2
        }" data-region-end="${a.t + 2}">`;
      html += `<strong>t=${a.t.toFixed(0)}s</strong> ${kw("p99")}=${
        a.latencyMs.toFixed(0)
      }ms (${(a.latencyMs / a.rollingMean).toFixed(1)}x ${kw("rolling mean")})`;
      html += "</div>";
    }
    if (D.anomalies.length > 5) {
      html += `<div style="font-size:11px;color:var(--text-faint)">...and ${
        D.anomalies.length - 5
      } more</div>`;
    }
    html += "</div>";
  }
  html +=
    '<div class="how-to">Drag to zoom into a region. Double-click to reset.</div>';
  document.getElementById("help-latency-time").innerHTML = html;
};

const renderHistHelp = (D) => {
  const allLat = D.events.map((e) => e.latencyMs).sort((a, b) => a - b);
  const iqr = pct(allLat, 0.75) - pct(allLat, 0.25);
  const skew = (D.overallMean - D.overallP50) / Math.max(iqr, 1);

  let html = '<span class="title">Latency distribution</span>';
  html += `<div class="insight ${Math.abs(skew) < 0.5 ? "good" : "warn"}">`;
  html += `Range: ${D.overallMin.toFixed(0)}–${D.overallMax.toFixed(0)}ms. ${
    kw("IQR", "IQR (middle 50%)")
  }: ${iqr.toFixed(0)}ms. `;
  if (Math.abs(skew) < 0.3) {
    html += "Symmetric distribution.";
  } else if (skew > 0) {
    html += "Right-skewed — a minority of requests are significantly slower.";
  } else {
    html += "Left-skewed — unusual.";
  }
  html += "</div>";
  document.getElementById("help-latency-hist").innerHTML = html;
};

const renderBoxHelp = (D) => {
  let html = '<span class="title">Latency by method</span>';
  if (D.methods.length === 1) {
    html += `<div class="insight">Single method (${
      D.methods[0]
    }). Box shows p25–p75, line = median, whiskers = p5–p95.</div>`;
  } else {
    html +=
      `<div class="insight">Comparing ${D.methods.length} methods. Look for boxes at different heights.</div>`;
  }
  document.getElementById("help-latency-box").innerHTML = html;
};

const renderConcurrencyHelp = (D) => {
  const el = document.getElementById("help-concurrency");
  if (!el) return;

  let html = '<span class="title">Concurrency vs Throughput vs Latency</span>';
  html += '<div class="legend">';
  html += legendItem("concurrency", 0, "#238636", "throughput (req/s)");
  html += legendItem("concurrency", 1, "#bc8cff", "concurrency");
  html += legendItem("concurrency", 2, "#d29922", "p50 latency");
  html += "</div>";

  const peakWindow = D.windows.reduce(
    (best, w) => w.count > best.count ? w : best,
    D.windows[0],
  );
  html += `<div class="insight">Peak ${
    kw("throughput")
  }: <strong>${peakWindow.count} ${kw("req/s")}</strong> at ${
    kw("concurrency")
  } <strong>${peakWindow.concurrency || "?"}</strong> (t=${
    peakWindow.t.toFixed(0)
  }s). `;

  if (D.concChanges && D.concChanges.length >= 2) {
    const lastChange = D.concChanges[D.concChanges.length - 1];
    const prevChange = D.concChanges[D.concChanges.length - 2];
    const windowsAtLast = D.windows.filter((w) =>
      w.concurrency === lastChange.to
    );
    const windowsAtPrev = D.windows.filter((w) =>
      w.concurrency === prevChange.to
    );
    if (windowsAtLast.length && windowsAtPrev.length) {
      const rpsLast = windowsAtLast.reduce((s, w) => s + w.count, 0) /
        windowsAtLast.length;
      const rpsPrev = windowsAtPrev.reduce((s, w) => s + w.count, 0) /
        windowsAtPrev.length;
      const latLast = windowsAtLast.reduce((s, w) => s + w.p50, 0) /
        windowsAtLast.length;
      const latPrev = windowsAtPrev.reduce((s, w) => s + w.p50, 0) /
        windowsAtPrev.length;
      if (rpsLast <= rpsPrev * 1.1 && latLast > latPrev * 1.2) {
        html += `${
          kw("saturation", "Saturation")
        } point around c=${prevChange.to}.`;
      } else {
        html += `Throughput still scaling at c=${lastChange.to}.`;
      }
    }
  }
  html += "</div>";
  html +=
    '<div class="how-to">Three y-axes: left = req/s, right = concurrency + latency.</div>';
  el.innerHTML = html;
};

const renderAllInsights = (D) => {
  renderHeader(D);
  renderStats(D);
  renderRunParams(D);
  renderThroughputHelp(D);
  renderLatencyTimeHelp(D);
  renderHistHelp(D);
  renderBoxHelp(D);
  renderConcurrencyHelp(D);
};
