/**
 * `compare` command — compare two test runs, detect regressions.
 */

import { type ParsedNdjson, readNdjson } from "../metrics/ndjson.ts";
import { effectSize, percentile, welchTTest } from "../metrics/stats.ts";
import { renderHtml } from "../dashboard/render.ts";
import { evaluateAssertions, parseAssertions } from "../engine/assertions.ts";
import { looksLikeFilePath, resolveRunPath } from "../history.ts";

export interface CompareCommandOptions {
  runsDir: string;
  baselinePath: string;
  currentPath: string;
  outputPath?: string;
  open: boolean;
  json: boolean;
  asserts: string[];
}

interface WindowStat {
  t: number;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
}

interface MetricDiff {
  metric: string;
  baseline: number;
  current: number;
  deltaAbs: number;
  deltaPct: number;
  status: "improved" | "regressed" | "unchanged";
  pValue: number;
  effectSize: number;
}

interface CompareResult {
  diffs: MetricDiff[];
  regressions: MetricDiff[];
  baselineFile: string;
  currentFile: string;
}

export async function compareCommand(
  opts: CompareCommandOptions,
): Promise<number> {
  const baselinePath = await resolveRunPath(opts.runsDir, opts.baselinePath);
  const currentPath = await resolveRunPath(opts.runsDir, opts.currentPath);

  const [baseline, current] = await Promise.all([
    readNdjson(baselinePath),
    readNdjson(currentPath),
  ]);

  if (baseline.events.length === 0) {
    console.error(`No events in baseline file: ${baselinePath}`);
    return 1;
  }
  if (current.events.length === 0) {
    console.error(`No events in current file: ${currentPath}`);
    return 1;
  }

  const bWindows = computeWindows(baseline);
  const cWindows = computeWindows(current);

  const bLatencies = baseline.events.map((e) => e.latencyMs).sort((a, b) =>
    a - b
  );
  const cLatencies = current.events.map((e) => e.latencyMs).sort((a, b) =>
    a - b
  );

  const bMaxT = baseline.events[baseline.events.length - 1].t;
  const cMaxT = current.events[current.events.length - 1].t;
  const bErrors = baseline.events.filter((e) => !e.ok).length;
  const cErrors = current.events.filter((e) => !e.ok).length;

  const metrics: Array<
    {
      name: string;
      bVal: number;
      cVal: number;
      bSamples: number[];
      cSamples: number[];
    }
  > = [
    {
      name: "p50",
      bVal: percentile(bLatencies, 0.5),
      cVal: percentile(cLatencies, 0.5),
      bSamples: bWindows.map((w) => w.p50),
      cSamples: cWindows.map((w) => w.p50),
    },
    {
      name: "p95",
      bVal: percentile(bLatencies, 0.95),
      cVal: percentile(cLatencies, 0.95),
      bSamples: bWindows.map((w) => w.p95),
      cSamples: cWindows.map((w) => w.p95),
    },
    {
      name: "p99",
      bVal: percentile(bLatencies, 0.99),
      cVal: percentile(cLatencies, 0.99),
      bSamples: bWindows.map((w) => w.p99),
      cSamples: cWindows.map((w) => w.p99),
    },
    {
      name: "rps",
      bVal: baseline.events.length / (bMaxT / 1000),
      cVal: current.events.length / (cMaxT / 1000),
      bSamples: bWindows.map((w) => w.count),
      cSamples: cWindows.map((w) => w.count),
    },
    {
      name: "error_rate",
      bVal: bErrors / baseline.events.length * 100,
      cVal: cErrors / current.events.length * 100,
      bSamples: bWindows.map((w) => w.errors / Math.max(w.count, 1) * 100),
      cSamples: cWindows.map((w) => w.errors / Math.max(w.count, 1) * 100),
    },
  ];

  const diffs: MetricDiff[] = metrics.map((m) => {
    const deltaAbs = m.cVal - m.bVal;
    const deltaPct = m.bVal !== 0
      ? (deltaAbs / m.bVal) * 100
      : (m.cVal !== 0 ? 100 : 0);
    const pVal = welchTTest(m.bSamples, m.cSamples);
    const d = effectSize(m.bSamples, m.cSamples);

    // For latency metrics, increase = regression. For rps, decrease = regression.
    const isLatency = m.name.startsWith("p") || m.name === "error_rate";
    let status: "improved" | "regressed" | "unchanged";
    if (Math.abs(deltaPct) < 2) {
      status = "unchanged";
    } else if (isLatency) {
      status = deltaAbs > 0 ? "regressed" : "improved";
    } else {
      status = deltaAbs < 0 ? "regressed" : "improved";
    }

    return {
      metric: m.name,
      baseline: m.bVal,
      current: m.cVal,
      deltaAbs,
      deltaPct,
      status,
      pValue: pVal,
      effectSize: Math.abs(d),
    };
  });

  // Regressions: statistically significant AND meaningful effect size
  const regressions = diffs.filter((d) =>
    d.status === "regressed" && d.pValue < 0.05 && d.effectSize > 0.2
  );

  const result: CompareResult = {
    diffs,
    regressions,
    baselineFile: baselinePath,
    currentFile: currentPath,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printCompareResult(result);
  }

  // Always generate HTML (--open just controls whether to launch browser)
  let outputPath: string;
  if (opts.outputPath) {
    outputPath = opts.outputPath;
  } else if (looksLikeFilePath(opts.currentPath)) {
    outputPath = opts.currentPath.replace(/\.ndjson$/, "-compare.html");
  } else {
    outputPath = `${opts.currentPath}-compare.html`;
  }
  const html = renderHtml({
    mode: "compare",
    baseline: {
      meta: baseline.meta,
      events: baseline.events,
      summary: baseline.summary,
    },
    current: {
      meta: current.meta,
      events: current.events,
      summary: current.summary,
    },
  });
  await Deno.writeTextFile(outputPath, html);
  console.log(`\n  Comparison chart: ${outputPath}`);

  if (opts.open) {
    openFile(outputPath);
  }

  // Handle assertions
  if (opts.asserts.length > 0) {
    const assertions = parseAssertions(opts.asserts);
    const statsMap: Record<string, number> = {};
    for (const d of diffs) {
      statsMap[d.metric + "_delta"] = Math.abs(d.deltaPct);
      statsMap[d.metric] = d.current;
    }
    const assertResults = evaluateAssertions(assertions, statsMap);
    const failures = assertResults.filter((r) => !r.passed);

    if (!opts.json) {
      console.log("\n  Assertions:");
      for (const r of assertResults) {
        const icon = r.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
        console.log(
          `    [${icon}] ${r.assertion.raw}  (actual: ${
            isNaN(r.actual) ? "N/A" : r.actual.toFixed(1)
          })`,
        );
      }
    }

    if (failures.length > 0) {
      if (!opts.json) {
        console.error(`\n  ${failures.length} assertion(s) failed.`);
      }
      return 1;
    }
  }

  return regressions.length > 0 ? 1 : 0;
}

function computeWindows(data: ParsedNdjson): WindowStat[] {
  const events = data.events;
  const maxT = events.length > 0 ? events[events.length - 1].t : 0;
  const durationSec = maxT / 1000;
  const windowMs = durationSec <= 60
    ? 1000
    : durationSec <= 300
    ? 5000
    : durationSec <= 600
    ? 10000
    : 30000;
  const windows: WindowStat[] = [];

  let idx = 0;
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
      });
      continue;
    }

    const w = events.slice(start, idx);
    const lat = w.map((e) => e.latencyMs).sort((a, b) => a - b);
    const errs = w.filter((e) => !e.ok).length;
    windows.push({
      t: ws / 1000,
      count: w.length,
      errors: errs,
      p50: percentile(lat, 0.5),
      p95: percentile(lat, 0.95),
      p99: percentile(lat, 0.99),
    });
  }

  return windows;
}

function openFile(path: string): void {
  const cmd = Deno.build.os === "darwin"
    ? "open"
    : Deno.build.os === "windows"
    ? "start"
    : "xdg-open";
  try {
    new Deno.Command(cmd, { args: [path], stdout: "null", stderr: "null" })
      .spawn();
  } catch (e) {
    console.error(
      `  Could not open file: ${e instanceof Error ? e.message : e}`,
    );
    console.error(`  Open manually: ${path}`);
  }
}

function printCompareResult(result: CompareResult) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  COMPARISON");
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  Baseline: ${result.baselineFile}`);
  console.log(`  Current:  ${result.currentFile}\n`);

  const pad = (s: string, n: number) => s.padEnd(n);
  const fmtNum = (n: number) => n.toFixed(1);
  const fmtPct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";

  console.log(
    `  ${pad("Metric", 14)} ${pad("Baseline", 12)} ${pad("Current", 12)} ${
      pad("Delta", 12)
    } Status`,
  );
  console.log(`  ${"-".repeat(62)}`);

  for (const d of result.diffs) {
    const statusIcon = d.status === "regressed"
      ? "\x1b[31m REGRESSED\x1b[0m"
      : d.status === "improved"
      ? "\x1b[32m IMPROVED\x1b[0m"
      : " unchanged";
    const unit = d.metric === "rps"
      ? ""
      : d.metric === "error_rate"
      ? "%"
      : "ms";
    console.log(
      `  ${pad(d.metric, 14)} ${pad(fmtNum(d.baseline) + unit, 12)} ${
        pad(fmtNum(d.current) + unit, 12)
      } ${pad(fmtPct(d.deltaPct), 12)}${statusIcon}`,
    );
  }

  if (result.regressions.length > 0) {
    console.log(
      `\n  \x1b[31m${result.regressions.length} regression(s) detected:\x1b[0m`,
    );
    for (const r of result.regressions) {
      console.log(
        `    ${r.metric}: ${fmtPct(r.deltaPct)} (p=${r.pValue.toFixed(4)}, d=${
          r.effectSize.toFixed(2)
        })`,
      );
    }
  } else {
    console.log("\n  \x1b[32mNo regressions detected.\x1b[0m");
  }

  console.log("\n═══════════════════════════════════════════════════════════");
}
