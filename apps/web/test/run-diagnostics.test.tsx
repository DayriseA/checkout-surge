import type { LoadRunDiagnosticsSummary } from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDiagnostics } from "../src/app/components/run-diagnostics.js";

describe("run diagnostics", () => {
  it("renders every populated diagnostics group and stays collapsed by default", () => {
    const markup = render(diagnostics(), 4);

    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).toMatch(/<summary[^>]*><h2[^>]*>Generator diagnostics<\/h2>/);
    for (const label of [
      "Generator host",
      "Generator capacity",
      "Generator utilisation",
      "Generator network",
      "k6 process",
      "k6 metric provenance",
      "k6 stderr",
    ]) {
      expect(markup).toContain(label);
    }
    for (const [label, value] of populatedFacts) {
      expectFact(markup, label, value);
    }
    expect(markup).toContain(
      "Generator CPU scope differs: 8 host logical CPUs; 0.5 cgroup CPU quota.",
    );
    expect(markup).toContain("request failed");
    expect(markup).toContain("2026-06-20 00:00:00 UTC");
    expect(markup).toContain('title="2026-06-20T00:00:00.000Z"');
    expect(markup).toContain("retained point-stream fallback");
    expect(markup).toContain("<code>point_stream</code>");
    expect(markup).toContain("The k6 summary export was not present.");
    expect(markup).toContain("<code>summary_export_missing</code>");
    expect(markup).toContain("4 warnings");
    expect(markup).toContain("1 stderr retained");
    expect(markup).toContain("truncated · 0 unavailable probes · 1 fallback metric sources");
  });

  it("distinguishes unavailable blocks, unknown values, unlimited limits, and zero", () => {
    const summary = diagnostics({
      nproc: null,
      ulimitNofile: null,
      processMaxOpenFiles: null,
      generatorCapacity: {
        memTotalBytes: null,
        memAvailableBytes: null,
        swapTotalBytes: 0,
        cgroupMemoryLimitBytes: null,
        cgroupMemoryLimitUnlimited: true,
        cgroupCpuQuota: null,
        cgroupCpuQuotaUnlimited: null,
      },
      generatorUtilisation: null,
      networkDiagnostics: null,
      k6Version: null,
      stderrLines: [],
      stderrLineCountObserved: 0,
      stderrLineCountRetained: 0,
      terminalMetricSources: undefined,
      summaryExportWarnings: undefined,
    });
    const markup = render(summary, 28);

    expect(markup).toContain("Generator host diagnostics were unavailable.");
    expect(markup).toContain("Generator utilisation diagnostics were unavailable.");
    expect(markup).toContain("Generator network diagnostics were unavailable.");
    expectFact(markup, "k6 terminal metric sources", "Could not determine");
    expect(markup).toContain("Could not determine");
    expect(markup).toContain("Unlimited");
    expect(markup).toMatch(/Generator host swap<\/dt><dd[^>]*><span[^>]*>0 B<\/span>/);
    expect(markup).toContain("No retained generator stderr lines.");
    expect(markup).toMatch(/k6 stderr lines observed<\/dt><dd[^>]*>0<\/dd>/);
    expect(markup).not.toContain("null");
    expect(markup).toContain("28 unavailable probes");
  });

  it("explains unavailable metric sources with empty or populated warning arrays", () => {
    const emptyWarnings = render(
      diagnostics({
        terminalMetricSources: undefined,
        summaryExportWarnings: [],
      }),
    );

    expect(emptyWarnings).toContain("8 unavailable probes");
    expectFact(emptyWarnings, "k6 terminal metric sources", "Could not determine");

    const populatedWarnings = render(
      diagnostics({
        terminalMetricSources: undefined,
        summaryExportWarnings: ["summary_export_missing"],
      }),
      1,
    );

    expect(populatedWarnings).toContain("8 unavailable probes");
    expectFact(populatedWarnings, "k6 terminal metric sources", "Could not determine");
    expect(populatedWarnings).toContain("The k6 summary export was not present.");
    expect(populatedWarnings).toContain("<code>summary_export_missing</code>");
  });

  it("renders a single unavailable message when the whole summary is absent", () => {
    const markup = render(null, 30);

    expect(markup).toContain("Generator diagnostics were unavailable for this run.");
    expect(markup).not.toContain("Generator capacity diagnostics were unavailable.");
    expect(markup).not.toContain("null");
    expect(markup).toContain("30 warnings");
    expect(markup).toContain("30 unavailable probes");
  });

  it("renders zero CPU utilisation and every constant-arrival execution-plan field", () => {
    const populated = diagnostics();
    const markup = render(
      diagnostics({
        generatorUtilisation: populated.generatorUtilisation
          ? { ...populated.generatorUtilisation, peakCpuUtilisationPercent: 0 }
          : null,
        executionPlan: {
          trafficMode: "constant-arrival-rate",
          ratePerSecond: 5,
          durationSeconds: 2,
          plannedEmittedAttempts: 10,
          startDelaySeconds: 0,
          preAllocatedVus: 3,
          maxVus: 10,
        },
      }),
    );

    expect(markup).toMatch(/k6 process peak CPU utilisation<\/dt><dd[^>]*>0%<\/dd>/);
    expect(markup).toContain("constant arrival rate");
    expect(markup).toMatch(/k6 scheduled rate<\/dt><dd[^>]*>5\/s<\/dd>/);
    expect(markup).toMatch(/k6 duration<\/dt><dd[^>]*>2s<\/dd>/);
    expect(markup).toMatch(/k6 pre-allocated VUs<\/dt><dd[^>]*>3<\/dd>/);
    expect(markup).toMatch(/k6 maximum VUs<\/dt><dd[^>]*>10<\/dd>/);
  });

  it("does not render small nonzero quota or utilisation values as zero", () => {
    const populated = diagnostics();
    const markup = render(
      diagnostics({
        generatorCapacity: populated.generatorCapacity
          ? { ...populated.generatorCapacity, cgroupCpuQuota: 0.001 }
          : null,
        generatorUtilisation: populated.generatorUtilisation
          ? { ...populated.generatorUtilisation, peakCpuUtilisationPercent: 0.004 }
          : null,
      }),
    );

    expectFact(markup, "Generator cgroup CPU quota", "0.001");
    expectFact(markup, "k6 process peak CPU utilisation", "0.004%");
  });

  it("does not call out CPU scope when the cgroup quota is not below the host count", () => {
    const populated = diagnostics();
    const markup = render(
      diagnostics({
        generatorCapacity: populated.generatorCapacity
          ? { ...populated.generatorCapacity, cgroupCpuQuota: 8 }
          : null,
      }),
    );

    expect(markup).not.toContain("Generator CPU scope differs");
  });
});

function render(summary: LoadRunDiagnosticsSummary | null, warningCount = 0): string {
  return renderToStaticMarkup(createElement(RunDiagnostics, { summary, warningCount }));
}

const populatedFacts = [
  ["Generator host logical CPUs", "8"],
  ["Generator process ulimit -n", "1,048,576"],
  ["k6 process open-files soft limit", "1,048,576"],
  ["k6 process open-files hard limit", "1,048,576"],
  ["Generator host total memory", "8 GiB"],
  ["Generator host available memory", "512 B"],
  ["Generator host swap", "0 B"],
  ["Generator cgroup memory limit", "4 GiB"],
  ["Generator cgroup CPU quota", "0.5"],
  ["k6 process peak RSS", "256 MiB"],
  ["Generator cgroup peak memory", "512 MiB"],
  ["Generator host minimum available memory", "2 GiB"],
  ["k6 process peak CPU utilisation", "100%"],
  ["k6 process mean CPU utilisation", "12.5%"],
  ["Generator cgroup peak swap", "0 B"],
  ["Generator cgroup memory high events", "0"],
  ["Generator cgroup memory max events", "0"],
  ["Generator cgroup OOM kills", "0"],
  ["Generator utilisation samples", "10"],
  ["Generator sampling interval", "1,000ms"],
  ["Generator local TCP port range", "1024 65535"],
  ["Generator tcp_tw_reuse", "1"],
  ["Generator tcp_timestamps", "1"],
  ["k6 version", "k6 v1.0.0"],
  ["k6 traffic mode", "buyer spike"],
  ["k6 buyer count", "10"],
  ["k6 duplicate each buyer attempt", "no"],
  ["k6 iterations per VU", "1"],
  ["k6 planned emitted attempts", "10"],
  ["k6 start delay", "0s"],
  ["k6 maximum duration", "30s"],
  ["k6 stderr lines observed", "302"],
  ["k6 stderr lines retained", "1"],
  ["k6 stderr retained-line limit", "50"],
  ["k6 stderr line-length limit", "500 characters"],
  ["k6 stderr lines truncated", "1"],
] as const;

function expectFact(markup: string, label: string, value: string): void {
  expect(markup).toMatch(
    new RegExp(
      `${escapeRegex(label)}</dt><dd[^>]*>(?:<span[^>]*>)?${escapeRegex(value)}(?:</span>)?</dd>`,
    ),
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function diagnostics(
  overrides: Partial<LoadRunDiagnosticsSummary> = {},
): LoadRunDiagnosticsSummary {
  return {
    startedAt: "2026-06-20T00:00:00.000Z",
    completedAt: "2026-06-20T00:00:10.000Z",
    nproc: 8,
    ulimitNofile: 1_048_576,
    processMaxOpenFiles: { soft: 1_048_576, hard: 1_048_576 },
    generatorCapacity: {
      memTotalBytes: 8 * 1_024 ** 3,
      memAvailableBytes: 512,
      swapTotalBytes: 0,
      cgroupMemoryLimitBytes: 4 * 1_024 ** 3,
      cgroupMemoryLimitUnlimited: false,
      cgroupCpuQuota: 0.5,
      cgroupCpuQuotaUnlimited: false,
    },
    generatorUtilisation: {
      peakK6RssBytes: 256 * 1_024 ** 2,
      peakCgroupMemoryBytes: 512 * 1_024 ** 2,
      minimumHostMemAvailableBytes: 2 * 1_024 ** 3,
      peakCpuUtilisationPercent: 100,
      meanCpuUtilisationPercent: 12.5,
      peakCgroupSwapBytes: 0,
      finalMemoryEventsHighCount: 0,
      finalMemoryEventsMaxCount: 0,
      finalMemoryEventsOomKillCount: 0,
      sampleCount: 10,
      effectiveIntervalMs: 1_000,
    },
    networkDiagnostics: {
      ipLocalPortRange: "1024 65535",
      tcpTwReuse: 1,
      tcpTimestamps: 1,
    },
    k6Version: "k6 v1.0.0",
    executionPlan: {
      trafficMode: "buyer-spike",
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      iterationsPerVu: 1,
      plannedEmittedAttempts: 10,
      startDelaySeconds: 0,
      maxDurationSeconds: 30,
    },
    stderrLines: ["request failed"],
    stderrLineCountObserved: 302,
    stderrLineCountRetained: 1,
    stderrRetainedLineLimit: 50,
    stderrLineTruncationLength: 500,
    stderrLineTruncatedCount: 1,
    terminalMetricSources: {
      startedRequests: "summary_export",
      completedRequests: "summary_export",
      acceptedResponses: "summary_export",
      soldOutResponses: "summary_export",
      transportFailures: "point_stream",
      unexpectedResponses: "summary_export",
      droppedIterations: "summary_export",
      completedIterations: "summary_export",
    },
    summaryExportWarnings: ["summary_export_missing"],
    ...overrides,
  };
}
