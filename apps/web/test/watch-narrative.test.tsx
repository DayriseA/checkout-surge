import {
  type DashboardProjection,
  type DemoRunSnapshot,
  dashboardProjectionSchemaName,
  dashboardProjectionScopeId,
  type RunHistoryListItem,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatorDashboard, WatchNarrative } from "../src/app/components/operator-dashboard.js";
import type { BackendRead } from "../src/app/lib/api.js";
import type { RetainedTerminalRun } from "../src/app/lib/dashboard-projection-state.js";
import { deriveWatchComposition } from "../src/app/lib/presentation/watch-composition.js";

describe("watch narrative", () => {
  it.each([
    "operator",
    "automatic_reset",
  ] as const)("keeps %s discarded live and retained runs neutral", (failureCategory) => {
    const terminal = terminalProjection("failed");
    if (terminal.currentRun?.status !== "failed") throw new Error("Expected failed run");
    terminal.currentRun = { ...terminal.currentRun, failureCategory, dataDiscarded: true };
    const retained = {
      runId,
      configSnapshot: terminal.currentRun.configSnapshot,
      terminalRecap: terminal,
    };
    for (const html of [
      markup(available(terminal)),
      markup(available(projection(null)), retained),
      dashboardMarkup(available(terminal)),
    ]) {
      expect(html).toContain("Cancelled");
      expect(html).toContain(failureCategory === "automatic_reset" ? "an automatic" : "an admin");
      expect(html).toContain(`/run-history/${runId}`);
      for (const copy of [
        "orders remain pending",
        "Reconciliation warning",
        "The run failed",
        "Confirmed orders",
      ])
        expect(html).not.toContain(copy);
    }
    const successor = projection({
      ...run("active"),
      runId: "99999999-9999-4999-8999-999999999999",
    });
    const next = markup(available(successor), retained);
    expect(next).toContain("The surge is under way");
    expect(next).not.toContain("Cancelled");
  });

  it("shows global operator recovery on fresh idle navigation without substituting previous history", () => {
    const output = markup(
      available({
        ...projection(null),
        resetRecoveryRunId: "11111111-1111-4111-8111-111111111111",
        resetRecovery: "incomplete",
      }),
      null,
      latestRun,
    );
    expect(output).toContain("Operator stop recovery");
    expect(output).toContain("this report is unavailable");
    expect(output).not.toContain("Choose a simulation");
    expect(output).not.toContain("/run-history/");
    expect(output).not.toContain("Start");
  });

  it("keeps run availability and update facts consistent through reset recovery and idle", () => {
    const incomplete = projection(null);
    incomplete.resetRecoveryRunId = "11111111-1111-4111-8111-111111111111";
    incomplete.resetRecovery = "incomplete";

    const recovering = dashboardMarkup(available(incomplete));
    expect(recovering).toContain("Run: recovery incomplete");
    for (const label of ["Current scenario", "Run", "Load generator"]) {
      expect(recovering).toMatch(
        new RegExp(`${label}</dt><dd[^>]*>Unavailable until operator recovery completes</dd>`),
      );
    }
    expect(recovering).not.toContain("No run has started");

    const idle = dashboardMarkup(available(projection(null)));
    expect(idle).toContain("Run: ready");
    for (const label of ["Current scenario", "Run", "Load generator"]) {
      expect(idle).toMatch(new RegExp(`${label}</dt><dd[^>]*>No run has started</dd>`));
    }
    expect(idle).not.toContain("recovery incomplete");
  });

  it("renders one idle action state with and without latest history", () => {
    const withoutHistory = markup(available(projection(null)));
    expect(withoutHistory).toContain("Choose a simulation");
    expect(withoutHistory).toContain("See run history");
    expect(withoutHistory).toContain('href="/run-history"');
    expect(withoutHistory).not.toContain("data-watch-signals");

    const withHistory = markup(available(projection(null)), null, latestRun);
    expect(withHistory).toContain("See run history");
    expect(withHistory).toContain('href="/run-history"');
    expect(withHistory).not.toContain("Latest saved report:");
    expect(withHistory).not.toContain('href="/run-history/11111111-1111-4111-8111-111111111111"');
    expect(withHistory).not.toContain("No completed runs yet");
  });

  it("leads with checking instead of an idle claim while the read is loading", () => {
    const output = markup({ status: "loading" });

    expect(output).toContain("Checking availability");
    expect(output).not.toContain("Choose a simulation");
  });

  it("leads with the watch-read error and retry action when data is unavailable", () => {
    const output = markup({
      status: "unavailable",
      errorCode: "dashboard_recovery_unavailable",
    });

    expect(output).toContain("The latest information is temporarily unavailable");
    expect(output).toContain("Check again");
    expect(output).not.toContain("Choose a simulation");
  });

  it("renders starting with an identity line and truthful unavailable readings", () => {
    const output = markup(available(projection(run("starting"))));

    expect(output).toContain("Preparing the flash sale");
    expect(output).not.toContain("Try another scenario");
    expect(output).toContain("Preview 1k · 1,000 buyers · 250 units");
    expect(output).toContain('aria-label="Run phase"');
    expect(output).toContain("Preparing");
    // Preparation and missing readings are unavailable, never zero-valued activity.
    for (const label of [
      "Units left",
      "Orders confirmed",
      "Awaiting confirmation",
      "Business-rejected orders",
      "Technically failed orders",
    ]) {
      expect(output).toContain(label);
    }
    expect(output).not.toContain("<polyline");
    // The strip keeps lifecycle-aware absence captions instead of inventing evidence.
    expect(output.match(/Not yet available/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the frozen configuration reachable in local technical details while starting", () => {
    const output = dashboardMarkup(available(projection(run("starting"))));

    expect(output).toContain("Scenario settings");
    expect(output).toContain("Buyers / planned attempts");
    expect(output).toContain("1,000 / 1,000");
    expect(output).toContain("80 ms");
    expect(output).toContain("250 orders/s");
    expect(output).toContain("5 workers; excess work waits in the queue");
    expect(output).toContain('id="watch-advanced-scenario"');
  });

  it("renders active with the identity, verdict, counts, and signal strip in order", () => {
    const output = markup(available(projection(run("active"))));

    expect(output).toContain("The surge is under way");
    expect(output).toContain("Checkout attempts are being accepted.");
    const identity = output.indexOf('aria-label="Run phase"');
    const verdict = output.indexOf("The surge is under way");
    const counts = output.indexOf("Units left");
    const strip = output.indexOf('data-watch-signals=""');
    expect(identity).toBeGreaterThan(-1);
    expect(verdict).toBeGreaterThan(identity);
    expect(counts).toBeGreaterThan(verdict);
    expect(strip).toBeGreaterThan(counts);
  });

  it("shows a progress bar against unique reservations only after traffic ends", () => {
    const activeProjection = projection(run("active"));
    activeProjection.businessOutcome = partialOutcome();
    const active = markup(available(activeProjection));
    expect(active).not.toContain("of 250 orders confirmed");

    const drainingProjection = projection(run("draining"));
    drainingProjection.businessOutcome = partialOutcome();
    const draining = markup(available(drainingProjection));
    expect(draining).toContain('aria-label="120 of 250 orders confirmed"');
    expect(draining).toContain("Confirming remaining orders");
  });

  it("keeps all three durable outcome totals distinct while draining", () => {
    const current = projection(run("draining"));
    current.businessOutcome = {
      ...partialOutcome(),
      failedOrders: 3,
      // The permanent-rejection vocabulary is empty, so zero business rejections is the
      // reachable reading; 0 and 3 still detect a swapped label mapping.
      businessRejectedOrders: 0,
      technicallyFailedOrders: 3,
    };
    const output = markup(available(current));
    for (const [count, label] of [
      [120, "Orders confirmed"],
      [0, "Business-rejected orders"],
      [3, "Technically failed orders"],
    ]) {
      expect(output).toMatch(new RegExp(`>${count}</p><p[^>]*>${label}</p>`));
    }
    expect(output).not.toContain("Orders failed");
  });

  it("omits the progress bar when the confirmed count contradicts the reservation total", () => {
    const contradictoryProjection = projection(run("draining"));
    contradictoryProjection.businessOutcome = {
      ...partialOutcome(),
      confirmedOrders: 300,
    };
    const output = markup(available(contradictoryProjection));

    expect(output).not.toContain("of 250 orders confirmed");
    // The contradictory counts still render; only the bar is dropped.
    expect(output).toContain("Orders confirmed");
  });

  it("keeps units and reservations distinct when each checkout reserves two units", () => {
    const drainingProjection = projection(run("draining"));
    const currentRun = drainingProjection.currentRun;
    if (!currentRun) throw new Error("Expected a run.");
    currentRun.configSnapshot = {
      ...currentRun.configSnapshot,
      trafficConfig: {
        ...currentRun.configSnapshot.trafficConfig,
        quantityPerAttempt: 2,
      },
    };
    drainingProjection.inventory = {
      ...inventoryFixture,
      allocatedStock: 250,
      remainingStock: 20,
      reservedStock: 230,
    };
    drainingProjection.businessOutcome = {
      acceptedReservations: 115,
      reservedUnits: 230,
      soldOutRejections: 375,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 115,
      failedOrders: 0,
      pendingPersistenceCount: 0,
      notificationsRecorded: 115,
    };
    const output = markup(available(drainingProjection));

    // Units and orders are different populations: the tile pair reads units (20 left of which
    // 230 are reserved), while the meter denominator uses unique reservations (115), not units.
    expect(output).toContain(">20</p>");
    expect(output).toContain("230 reserved");
    expect(output).toContain('aria-label="115 of 115 orders confirmed"');
    expect(output).not.toContain("of 230 orders confirmed");
  });

  it("renders zero starting stock without a meter or zero-as-success wording", () => {
    const completedProjection = projection(run("completed"));
    completedProjection.inventory = {
      ...inventoryFixture,
      allocatedStock: 0,
      remainingStock: 0,
      reservedStock: 0,
      reservationThroughput: {
        ...inventoryFixture.reservationThroughput,
        successfulReservationCount: 0,
        peakRatePerSecond: 0,
      },
      soldOutPressure: {
        ...inventoryFixture.soldOutPressure,
        rejectionCount: 0,
      },
    };
    completedProjection.businessOutcome = {
      acceptedReservations: 0,
      reservedUnits: 0,
      soldOutRejections: 0,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 0,
      failedOrders: 0,
      pendingPersistenceCount: 0,
      notificationsRecorded: 0,
    };
    const output = markup(available(completedProjection));

    expect(output).toContain("The sale started with no stock available to reserve.");
    expect(output).not.toContain("All 0 available units");
    expect(output).not.toContain("<meter");
  });

  it("keeps the run story bands ahead of the grouped technical sections", () => {
    for (const status of ["active", "draining", "completed", "failed"] as const) {
      const currentProjection =
        status === "completed" || status === "failed"
          ? terminalProjection(status)
          : projection(run(status));
      const output = renderToStaticMarkup(
        createElement(OperatorDashboard, {
          initialRecovery: available(currentProjection),
        }),
      );
      const identity = output.indexOf('aria-label="Run phase"');
      const strip = output.indexOf('data-watch-signals=""');
      const signals = output.indexOf('id="watch-advanced-signals"');
      const scenario = output.indexOf('id="watch-advanced-scenario"');
      const processing = output.indexOf('id="watch-advanced-processing"');
      const consistency = output.indexOf('id="watch-advanced-consistency"');
      const connection = output.indexOf('id="watch-advanced-connection"');

      expect(identity).toBeGreaterThan(-1);
      expect(strip).toBeGreaterThan(identity);
      if (status === "active" || status === "draining") {
        // Live mode: the board follows the strip inside the run card, and technical details hold
        // only the scenario and connection groups.
        const board = output.indexOf('id="watch-signal-arrival"');
        const verdict = output.indexOf(
          status === "active" ? "The surge is under way" : "Confirming remaining orders",
        );
        expect(board).toBeGreaterThan(strip);
        expect(scenario).toBeGreaterThan(board);
        expect(verdict).toBeGreaterThan(identity);
        expect(output).not.toContain("Try another scenario");
        expect(output).not.toContain("View run report");
        if (status === "draining") {
          // dashboard-phase6 pins the active group order, so draining is this test's own charge.
          expect(signals).toBe(-1);
          expect(connection).toBeGreaterThan(scenario);
          expect(processing).toBe(-1);
          expect(consistency).toBe(-1);
        }
      } else {
        expect(scenario).toBeGreaterThan(strip);
        expect(output.indexOf("Preparing saved report…")).toBeGreaterThan(strip);
        expect(output.indexOf("Try another scenario")).toBeGreaterThan(strip);
        if (status === "failed") {
          // dashboard-phase6 pins the completed group order, so failed is this test's own charge.
          expect(signals).toBeGreaterThan(scenario);
          expect(processing).toBeGreaterThan(signals);
          expect(consistency).toBeGreaterThan(processing);
          expect(connection).toBeGreaterThan(consistency);
        }
      }
    }
  });

  it("renders completed before and after projection clearing with one report handoff", () => {
    const terminal = terminalProjection("completed");
    const beforeClear = markup(available(terminal));
    const retained = retainedTerminal(terminal);
    const afterClear = markup(available(projection(null)), retained);

    for (const output of [beforeClear, afterClear]) {
      expect(output).toContain("Final result");
      expect(output.split("Final result")).toHaveLength(2);
      expect(output).toContain("All 250 available units were reserved without overselling.");
      expect(output).toContain("250 reserved");
      expect(output).toContain('data-watch-signals=""');
      expect(output).toContain("View run report");
      expect(output).toContain('href="/run-history/11111111-1111-4111-8111-111111111111"');
      expect(output).toContain("Try another scenario");
      expect(output.replace(/<[^>]+>/g, "")).not.toMatch(/\b\d{2}:\d{2}:\d{2}(?! UTC)/);
    }
  });

  it("keeps the failure headline, explanation, action, and report handoff together", () => {
    const terminal = terminalProjection("failed");
    const output = markup(available(projection(null)), retainedTerminal(terminal));

    expect(output).toContain(">Failed</h2>");
    expect(output).toContain("The run failed due to a traffic failure with 250 failed orders.");
    expect(output).toContain("load generator could not deliver");
    expect(output).toContain("Start a new run to try again");
    expect(output).toContain("View run report");
    expect(output).not.toContain("Choose a simulation");
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

function dashboardMarkup(recovery: BackendRead<DashboardProjection>): string {
  return renderToStaticMarkup(createElement(OperatorDashboard, { initialRecovery: recovery }));
}

function retainedTerminal(terminalRecap: DashboardProjection): RetainedTerminalRun {
  if (!terminalRecap.currentRun) throw new Error("Expected terminal run.");
  return {
    runId: terminalRecap.currentRun.runId,
    configSnapshot: terminalRecap.currentRun.configSnapshot,
    terminalRecap,
  };
}

function partialOutcome(): NonNullable<DashboardProjection["businessOutcome"]> {
  return {
    acceptedReservations: 250,
    reservedUnits: 250,
    soldOutRejections: 500,
    queuedOrders: 80,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: 120,
    failedOrders: 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: 120,
  };
}

const inventoryFixture: NonNullable<DashboardProjection["inventory"]> = {
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
    measuredAt: "2026-07-30T12:00:01.000Z",
  },
  soldOutPressure: {
    rejectionCount: 750,
    latestObservedAt: "2026-07-30T12:00:01.000Z",
  },
  observedAt: "2026-07-30T12:00:01.000Z",
  lastUpdatedAt: "2026-07-30T12:00:01.000Z",
};

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
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    correlationId: "corr-watch",
    scopeId: dashboardProjectionScopeId(scope),
    scope,
    revision: 1,
    recoveredAt: "2026-07-30T12:00:03.000Z",
    runtimeProgress: null,
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
