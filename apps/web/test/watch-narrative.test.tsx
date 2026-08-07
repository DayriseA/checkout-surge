import {
  type DashboardProjection,
  type DemoRunSnapshot,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
  type RunHistoryListItem,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WatchNarrative } from "../src/app/components/operator-dashboard.js";
import type { BackendRead } from "../src/app/lib/api.js";
import type { RetainedTerminalRun } from "../src/app/lib/dashboard-projection-state.js";
import { deriveWatchComposition } from "../src/app/lib/presentation/watch-composition.js";

describe("watch narrative", () => {
  it("renders one idle action state with and without latest history", () => {
    const withoutHistory = markup(available(projection(null)));
    expect(withoutHistory).toContain("Start a demo");
    expect(withoutHistory).toContain("No completed runs yet");
    expect(withoutHistory).not.toContain("Sale evidence");

    const withHistory = markup(available(projection(null)), null, latestRun);
    expect(withHistory).toContain("View the full result for Preview 1k (2026-07-30 12:00:02 UTC)");
    expect(withHistory).toContain('href="/run-history/11111111-1111-4111-8111-111111111111"');
    expect(withHistory).not.toContain("No completed runs yet");
  });

  it("leads with checking instead of an idle claim while the read is loading", () => {
    const output = markup({ status: "loading" });

    expect(output).toContain("Checking availability");
    expect(output).not.toContain("Start a demo");
  });

  it("leads with the watch-read error and retry action when data is unavailable", () => {
    const output = markup({
      status: "unavailable",
      errorCode: "dashboard_recovery_unavailable",
    });

    expect(output).toContain("The latest information is temporarily unavailable");
    expect(output).toContain("Check again");
    expect(output).not.toContain("Start a demo");
  });

  it("renders starting with frozen scenario facts and no fake signals", () => {
    const output = markup(available(projection(run("starting"))));

    expect(output).toContain("Setting up the flash sale");
    expect(output).toContain("Buyers / planned attempts");
    expect(output).toContain("1,000 / 1,000");
    expect(output).toContain("80 ms");
    expect(output).toContain("250 orders/s");
    expect(output).toContain("5 workers; excess work waits in the queue");
    expect(output).not.toContain("Sale evidence");
  });

  it("renders active signals before interpretation and ERP/consistency evidence", () => {
    const output = markup(available(projection(run("active"))));

    expect(output).toContain("The surge is under way");
    expect(output).toContain("Sale evidence");
    expect(output.indexOf("Frozen scenario")).toBeLessThan(output.indexOf("Sale evidence"));
    expect(output.indexOf("Sale evidence")).toBeLessThan(output.indexOf("What is happening now"));
    expect(output.indexOf("What is happening now")).toBeLessThan(
      output.indexOf("Simulated ERP outcomes"),
    );
    expect(output).toContain("Fast reservation vs final confirmation");
  });

  it("promotes drain work and protection before the signals recap", () => {
    const output = markup(available(projection(run("draining"))));

    expect(output).toContain("Following the drain");
    expect(output).toContain("Reservation and confirmation summary");
    expect(output).toContain("Simulated ERP outcomes");
    expect(output).toContain("Fast reservation vs final confirmation");
    expect(output.indexOf("Reservation and confirmation summary")).toBeLessThan(
      output.indexOf("Sale evidence"),
    );
  });

  it("renders completed before and after projection clearing with an exact durable handoff", () => {
    const terminal = terminalProjection("completed");
    const beforeClear = markup(available(terminal));
    const retained = retainedTerminal(terminal);
    const afterClear = markup(available(projection(null)), retained);

    for (const output of [beforeClear, afterClear]) {
      expect(output).toContain("Final result");
      expect(output).toContain("Frozen scenario");
      expect(output).toContain("Sale evidence");
      expect(output).toContain("View the full result for Preview 1k (2026-07-30 12:00:02 UTC)");
      expect(output.replace(/<[^>]+>/g, "")).not.toMatch(/\b\d{2}:\d{2}:\d{2}(?! UTC)/);
    }
  });

  it("keeps the failure headline, scenario, conclusion, and result handoff", () => {
    const terminal = terminalProjection("failed");
    const output = markup(available(projection(null)), retainedTerminal(terminal));

    expect(output).toContain("The run could not complete");
    expect(output).toContain("load generator could not deliver");
    expect(output).toContain("Frozen scenario");
    expect(output).toContain("The run failed due to a traffic failure");
    expect(output).toContain("View the full result for Preview 1k");
    expect(output).not.toContain("Ready when you are");
  });
});

const runId = "11111111-1111-4111-8111-111111111111";
const saleOfferId = "33333333-3333-4333-8333-333333333333";
const startedAt = "2026-07-30T12:00:00.000Z";
const latestRun: RunHistoryListItem = {
  runId,
  presetName: "Preview 1k",
  occurredAt: "2026-07-30T12:00:02.000Z",
  overallDurationMs: 2_000,
  resultOutcome: "completed-successfully",
  plannedAttempts: 1_000,
  startingStock: 250,
  uniqueReservations: 250,
  soldOutRejections: 750,
  confirmedOrders: 250,
  failedOrders: 0,
  convergenceDurationSeconds: 1,
};

function markup(
  recovery: BackendRead<DashboardProjection>,
  retainedTerminalRun: RetainedTerminalRun | null = null,
  latestCompletedRun: RunHistoryListItem | null = null,
): string {
  const composition = deriveWatchComposition({
    recovery,
    retainedTerminalRun,
    latestCompletedRun: { status: "available", data: latestCompletedRun },
    signalSamples: [],
    transportStatus: "connected",
    now: new Date("2026-07-30T12:00:04.000Z"),
  });
  return renderToStaticMarkup(
    createElement(WatchNarrative, { composition, onRetry: () => undefined }),
  );
}

function retainedTerminal(terminalRecap: DashboardProjection): RetainedTerminalRun {
  if (!terminalRecap.currentRun) throw new Error("Expected terminal run.");
  return {
    runId: terminalRecap.currentRun.runId,
    configSnapshot: terminalRecap.currentRun.configSnapshot,
    terminalRecap,
  };
}

function terminalProjection(status: "completed" | "failed"): DashboardProjection {
  const terminal = projection(run(status));
  terminal.inventory = {
    saleOfferId,
    allocatedStock: 250,
    remainingStock: 0,
    reservedStock: 250,
    pendingPersistenceCount: 0,
    expiredReservationCount: 0,
    oldestPendingPersistenceAgeSeconds: 0,
    reservationThroughput: {
      windowSeconds: 60,
      successfulReservationCount: 250,
      peakRatePerSecond: 250,
      peakWindowSeconds: 1,
      unit: "reservations_per_second",
      measuredAt: "2026-07-30T12:00:02.000Z",
    },
    soldOutPressure: {
      rejectionCount: 750,
      latestObservedAt: "2026-07-30T12:00:02.000Z",
    },
    observedAt: "2026-07-30T12:00:02.000Z",
    lastUpdatedAt: "2026-07-30T12:00:02.000Z",
  };
  terminal.businessOutcome = {
    acceptedReservations: 250,
    reservedUnits: 250,
    soldOutRejections: 750,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: status === "completed" ? 250 : 0,
    failedOrders: status === "failed" ? 250 : 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: status === "completed" ? 250 : 0,
  };
  return terminal;
}

function run(status: DemoRunSnapshot["status"]): DemoRunSnapshot {
  const base = {
    runId,
    presetId: "22222222-2222-4222-8222-222222222222",
    presetName: "Preview 1k",
    operatorMode: "public" as const,
    saleOfferId,
    configSnapshot: previewRunConfigSnapshotFixture(),
    startedAt,
  };
  if (status === "starting") return { ...base, status, trafficStatus: "starting" };
  if (status === "active") {
    return { ...base, status, trafficStatus: "active", trafficStartedAt: startedAt };
  }
  if (status === "draining") {
    return {
      ...base,
      status,
      trafficStatus: "succeeded",
      trafficStartedAt: startedAt,
      trafficEndedAt: "2026-07-30T12:00:01.000Z",
    };
  }
  if (status === "completed") {
    return {
      ...base,
      status,
      trafficStatus: "succeeded",
      trafficStartedAt: startedAt,
      trafficEndedAt: "2026-07-30T12:00:01.000Z",
      finalizedAt: "2026-07-30T12:00:02.000Z",
    };
  }
  return {
    ...base,
    status,
    trafficStatus: "failed",
    trafficStartedAt: startedAt,
    trafficEndedAt: "2026-07-30T12:00:01.000Z",
    finalizedAt: "2026-07-30T12:00:02.000Z",
    failureCategory: "traffic",
  };
}

function projection(currentRun: DemoRunSnapshot | null): DashboardProjection {
  const scope = currentRun ? { runId: currentRun.runId, saleOfferId } : null;
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    correlationId: "corr-watch",
    scopeId: dashboardProjectionScopeId(scope),
    scope,
    revision: 1,
    recoveredAt: "2026-07-30T12:00:03.000Z",
    currentRun,
    inventory: null,
    recentMetrics: [],
    erp: null,
    systemStatus: null,
    businessOutcome: null,
    consistencyLag: null,
    transportAttemptCounts: null,
    httpSummary: null,
    requestArrivalSummary: null,
    runSignalTimelineSummary: null,
  };
}

function available(data: DashboardProjection) {
  return { status: "available" as const, data, httpStatus: 200 };
}
