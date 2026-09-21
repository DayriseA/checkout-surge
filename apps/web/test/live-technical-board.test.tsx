// @vitest-environment jsdom

import {
  type DashboardProjection,
  type DemoRunSnapshot,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedLiveBoardKeys,
  deriveLiveTechnicalBoardValues,
  LiveTechnicalBoard,
} from "../src/app/components/live-technical-board.js";
import type { Freshness } from "../src/app/lib/presentation/freshness.js";

describe("live technical board", () => {
  afterEach(cleanup);

  it("derives the raw board values from a representative active projection", () => {
    const projection = activeProjection();
    const values = deriveLiveTechnicalBoardValues(projection, runFixture("active"));

    expect(values).toEqual({
      arrivalRate: 10,
      dispatched: [620, 1_000],
      responseRate: 9.5,
      latency: [42, "ms"],
      httpFailureRate: [0.01, "ratio"],
      remainingStock: 120,
      reservedStock: 380,
      // The live count reads the moving Redis-backed pressure counter (120), never the durable
      // outcome count (2) that only settles once traffic completes.
      soldOutRejections: 120,
      oversoldUnits: 0,
      pendingPersistence: 4,
      queuedOrders: 12,
      processingOrders: 8,
      retryingOrders: 2,
      erpFailures: [2, 1],
      erpProtection: "Constrained but keeping up",
      downstreamErpStatus: null,
      confirmationRate: null,
      confirmedOrders: 350,
      pendingConfirmation: 20,
      oldestPending: 8.5,
      businessRejectedOrders: null,
      technicallyFailedOrders: null,
      lagP95Average: [135, 128],
    });
    expect(values.soldOutRejections).not.toBe(projection.businessOutcome?.soldOutRejections);
  });

  it("derives the projected downstream status and confirmation rate from runtime progress", () => {
    const projection = activeProjection();
    projection.runtimeProgress = {
      runId,
      outstandingOrders: 20,
      oldestOutstandingAgeSeconds: 8.5,
      confirmationRatePerSecond: 0.2,
      confirmationRateWindowSeconds: 10,
      downstreamErpStatus: "erp_limiting",
      downstreamErpStatusReadStatus: "available",
      observedAt: "2026-07-30T12:00:30.000Z",
    };
    const values = deriveLiveTechnicalBoardValues(projection, runFixture("active"));

    expect(values.downstreamErpStatus).toBe("erp_limiting");
    expect(values.confirmationRate).toEqual([0.2, 10]);

    const { container } = render(
      createElement(LiveTechnicalBoard, {
        freshness: liveFreshness,
        projection,
        run: runFixture("active"),
      }),
    );

    // A slow drain reads as still processing, with the rate stated over its effective window.
    expect(rowByLabel(container, "Downstream ERP")?.textContent).toContain(
      "Still processing — the ERP is limiting the rate",
    );
    expect(rowByLabel(container, "Confirmation rate (10-second window)")?.textContent).toContain(
      "0.2 confirmations/s",
    );
  });

  it("keeps an unreadable downstream status and an unmeasurable rate distinct from zero", () => {
    const projection = activeProjection();
    projection.runtimeProgress = {
      runId,
      outstandingOrders: 20,
      oldestOutstandingAgeSeconds: 8.5,
      confirmationRatePerSecond: null,
      confirmationRateWindowSeconds: 10,
      downstreamErpStatus: null,
      downstreamErpStatusReadStatus: "unavailable",
      observedAt: "2026-07-30T12:00:30.000Z",
    };

    const { container } = render(
      createElement(LiveTechnicalBoard, {
        freshness: liveFreshness,
        projection,
        run: runFixture("active"),
      }),
    );

    expect(rowByLabel(container, "Downstream ERP")?.textContent).toContain("Status unavailable");
    const rateRow = rowByLabel(container, "Confirmation rate (10-second window)");
    expect(rateRow?.textContent).toContain("—");
    expect(rateRow?.textContent).not.toContain("0 confirmations/s");
  });

  it("shows business rejections and technical failures separately while draining", () => {
    const projection = activeProjection();
    if (!projection.businessOutcome) throw new Error("Expected business outcomes.");
    projection.businessOutcome = {
      ...projection.businessOutcome,
      failedOrders: 3,
      businessRejectedOrders: 2,
      technicallyFailedOrders: 1,
    };
    const { container } = render(
      createElement(LiveTechnicalBoard, {
        freshness: liveFreshness,
        projection,
        run: runFixture("draining"),
      }),
    );
    expect(
      rowByLabel(container, "Business-rejected orders")?.querySelector("dd")?.textContent,
    ).toBe("2");
    expect(
      rowByLabel(container, "Technically failed orders")?.querySelector("dd")?.textContent,
    ).toBe("1");
    expect(container.querySelector("#watch-signal-confirmation > p")?.textContent).toBe("350");
    expect(rowByLabel(container, "Failed")).toBeNull();
  });

  it("renders every board value as absent while starting without evidence", () => {
    const { container } = render(
      createElement(LiveTechnicalBoard, {
        freshness: liveFreshness,
        projection: startingProjection(),
        run: runFixture("starting"),
      }),
    );

    for (const id of [
      "watch-signal-arrival",
      "watch-signal-inventory",
      "watch-signal-backlog",
      "watch-signal-confirmation",
    ]) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
    const rows = [...container.querySelectorAll("dl > div")];
    expect(rows).toHaveLength(19);
    for (const row of rows) {
      expect(row.textContent).toContain("—");
    }
    for (const caption of ["of — left", "of — confirmed"]) {
      expect(container.textContent).toContain(caption);
    }
    // No evidence means no dispatch progress to show.
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelectorAll("[data-changed]")).toHaveLength(0);
  });

  it("compares raw values and marks nothing for a first projection", () => {
    const first = deriveLiveTechnicalBoardValues(activeProjection(), runFixture("active"));
    expect(changedLiveBoardKeys(null, first)).toEqual(new Set());

    const laterProjection = activeProjection();
    laterProjection.recoveredAt = "2026-07-30T12:00:32.000Z";
    laterProjection.recentMetrics = laterProjection.recentMetrics.map((sample) =>
      sample.metricName === "traffic.attempts_dispatched" ? { ...sample, value: 621 } : sample,
    );
    const inventory = laterProjection.inventory;
    if (inventory) laterProjection.inventory = { ...inventory, remainingStock: 119 };
    const second = deriveLiveTechnicalBoardValues(laterProjection, runFixture("active"));

    expect(changedLiveBoardKeys(first, second)).toEqual(new Set(["dispatched", "remainingStock"]));
  });

  it("marks the Dispatched row alone when a new projection changes the dispatched count", () => {
    const first = activeProjection();
    const { container, rerender } = render(
      createElement(LiveTechnicalBoard, {
        freshness: liveFreshness,
        projection: first,
        run: runFixture("active"),
      }),
    );
    expect(container.querySelectorAll("[data-changed]")).toHaveLength(0);

    const second = activeProjection();
    second.recoveredAt = "2026-07-30T12:00:32.000Z";
    second.recentMetrics = second.recentMetrics.map((sample) =>
      sample.metricName === "traffic.attempts_dispatched" ? { ...sample, value: 621 } : sample,
    );
    rerender(
      createElement(LiveTechnicalBoard, {
        freshness: liveFreshness,
        projection: second,
        run: runFixture("active"),
      }),
    );

    const dispatchedRow = rowByLabel(container, "Dispatched");
    expect(dispatchedRow?.querySelector("[data-changed]")).not.toBeNull();
    expect(dispatchedRow?.textContent).toContain("621 / 1,000");
    expect(rowByLabel(container, "Reserved")?.querySelector("[data-changed]")).toBeNull();
    // The lag row carries one trailing unit and per-part absence placeholders.
    expect(rowByLabel(container, "p95 · avg")?.textContent).toContain("135 · 128 ms");

    // Dispatch progress tracks attempts against the run's planned attempts.
    const progress = container.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute("aria-label")).toBe("Attempts dispatched");
    expect(progress?.getAttribute("aria-valuenow")).toBe("621");
    expect(progress?.getAttribute("aria-valuemax")).toBe("1000");

    // The 2-second clock re-render without a new projection keeps the markers.
    rerender(
      createElement(LiveTechnicalBoard, {
        freshness: liveFreshness,
        projection: second,
        run: runFixture("active"),
      }),
    );
    expect(dispatchedRow?.querySelector("[data-changed]")).not.toBeNull();
  });

  it("marks nothing on the first projection after recovery jumps to a newer run", () => {
    const runA = runFixture("active");
    const { container, rerender } = render(
      createElement(LiveTechnicalBoard, {
        freshness: liveFreshness,
        projection: activeProjection(),
        run: runA,
      }),
    );

    const second = activeProjection();
    second.recoveredAt = "2026-07-30T12:00:32.000Z";
    second.recentMetrics = second.recentMetrics.map((sample) =>
      sample.metricName === "traffic.attempts_dispatched" ? { ...sample, value: 621 } : sample,
    );
    rerender(
      createElement(LiveTechnicalBoard, {
        freshness: liveFreshness,
        projection: second,
        run: runA,
      }),
    );
    expect(container.querySelectorAll("[data-changed]").length).toBeGreaterThan(0);

    // A recoveredAt jump that also switches runs is the new run's first projection: the
    // differences from the previous run's last values must not be marked.
    const nextRunId = "66666666-6666-4666-8666-666666666666";
    const nextRun = { ...runA, runId: nextRunId };
    const firstOfNextRun = activeProjection();
    firstOfNextRun.recoveredAt = "2026-07-30T12:01:02.000Z";
    firstOfNextRun.currentRun = nextRun;
    firstOfNextRun.scope = { runId: nextRunId, saleOfferId };
    firstOfNextRun.scopeId = dashboardProjectionScopeId(firstOfNextRun.scope);
    firstOfNextRun.recentMetrics = firstOfNextRun.recentMetrics.map((sample) =>
      sample.metricName === "traffic.attempts_dispatched" ? { ...sample, value: 10 } : sample,
    );
    const inventory = firstOfNextRun.inventory;
    if (inventory) firstOfNextRun.inventory = { ...inventory, remainingStock: 480 };
    rerender(
      createElement(LiveTechnicalBoard, {
        freshness: liveFreshness,
        projection: firstOfNextRun,
        run: nextRun,
      }),
    );

    expect(container.querySelectorAll("[data-changed]")).toHaveLength(0);
  });
});

const liveFreshness: Freshness = {
  state: "live",
  observedAt: "2026-07-30T12:00:30.000Z",
  final: false,
};

const runId = "11111111-1111-4111-8111-111111111111";
const saleOfferId = "33333333-3333-4333-8333-333333333333";

function rowByLabel(container: HTMLElement, label: string): Element | null {
  return (
    [...container.querySelectorAll("dl > div")].find(
      (row) => row.querySelector("dt")?.textContent === label,
    ) ?? null
  );
}

function runFixture(status: "starting" | "active" | "draining"): DemoRunSnapshot {
  const base = {
    runId,
    presetId: "22222222-2222-4222-8222-222222222222",
    presetName: "Preview 1k",
    operatorMode: "public" as const,
    saleOfferId,
    configSnapshot: previewRunConfigSnapshotFixture(),
    startedAt: "2026-07-30T12:00:00.000Z",
  };
  if (status === "starting") return { ...base, status, trafficStatus: "starting" };
  if (status === "draining")
    return {
      ...base,
      status,
      trafficStatus: "succeeded",
      trafficStartedAt: base.startedAt,
      trafficEndedAt: "2026-07-30T12:00:20.000Z",
    };
  return { ...base, status, trafficStatus: "active", trafficStartedAt: base.startedAt };
}

function startingProjection(): DashboardProjection {
  return {
    ...activeProjection(),
    recoveredAt: "2026-07-30T12:00:01.000Z",
    currentRun: runFixture("starting"),
    inventory: null,
    recentMetrics: [],
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
  };
}

function activeProjection(): DashboardProjection {
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    scopeId: dashboardProjectionScopeId({ runId, saleOfferId }),
    scope: { runId, saleOfferId },
    revision: 7,
    correlationId: "corr-live-board",
    recoveredAt: "2026-07-30T12:00:30.000Z",
    runtimeProgress: null,
    currentRun: runFixture("active"),
    inventory: {
      saleOfferId,
      allocatedStock: 500,
      remainingStock: 120,
      reservedStock: 380,
      pendingPersistenceCount: 4,
      expiredReservationCount: 0,
      oldestPendingPersistenceAgeSeconds: 0,
      reservationThroughput: {
        windowSeconds: 60,
        successfulReservationCount: 380,
        peakRatePerSecond: 88,
        peakWindowSeconds: 1,
        unit: "reservations_per_second",
        measuredAt: "2026-07-30T12:00:29.000Z",
      },
      soldOutPressure: { rejectionCount: 120, latestObservedAt: "2026-07-30T12:00:29.000Z" },
      observedAt: "2026-07-30T12:00:29.000Z",
      lastUpdatedAt: "2026-07-30T12:00:29.000Z",
    },
    recentMetrics: [
      {
        metricName: "traffic.attempts_dispatched",
        value: 620,
        unit: "requests",
        timestamp: "2026-07-30T12:00:29.000Z",
      },
      {
        metricName: "traffic.request_arrival_rate",
        value: 10,
        unit: "requests_per_second",
        timestamp: "2026-07-30T12:00:29.000Z",
      },
      {
        metricName: "traffic.response_completion_rate",
        value: 9.5,
        unit: "requests_per_second",
        timestamp: "2026-07-30T12:00:29.000Z",
      },
      {
        metricName: "traffic.latency",
        value: 42,
        unit: "ms",
        timestamp: "2026-07-30T12:00:29.000Z",
      },
      {
        metricName: "traffic.failure_rate",
        value: 0.01,
        unit: "ratio",
        timestamp: "2026-07-30T12:00:29.000Z",
      },
    ],
    erp: {
      runId,
      circuit: {
        state: "closed",
        consecutiveFailureCount: 0,
        failureThreshold: 5,
        resetTimeoutMs: 10_000,
        openedAt: null,
        nextAttemptAt: null,
        halfOpenProbeInFlight: false,
        lastChangedAt: "2026-07-30T12:00:05.000Z",
      },
      circuitReadStatus: "available",
      latestAttempt: { runId, status: "succeeded", finishedAt: "2026-07-30T12:00:29.000Z" },
      recentAttemptWindowSeconds: 60,
      recentAttemptCount: 40,
      recentFailureCount: 2,
      recentTimeoutCount: 1,
      observedAt: "2026-07-30T12:00:29.000Z",
    },
    systemStatus: null,
    businessOutcome: {
      acceptedReservations: 380,
      reservedUnits: 380,
      soldOutRejections: 2,
      queuedOrders: 12,
      processingOrders: 8,
      retryingOrders: 2,
      confirmedOrders: 350,
      failedOrders: 8,
      pendingPersistenceCount: 4,
      notificationsRecorded: 350,
    },
    consistencyLag: {
      confirmedOrderCount: 350,
      pendingConfirmationCount: 20,
      averageLagMs: 128,
      p95LagMs: 135,
      maxLagMs: 400,
      oldestPendingAgeSeconds: 8.5,
      measuredAt: "2026-07-30T12:00:29.000Z",
    },
    transportAttemptCounts: null,
    httpSummary: null,
    requestArrivalSummary: null,
    runSignalTimelineSummary: null,
  };
}
