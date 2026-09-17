import {
  confirmationLagBoundary,
  emptyRequestArrivalSummary,
  queueBacklogDefinition,
  queueBacklogDrainDurationBoundary,
  runSignalBucketCount,
} from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import { deriveSignalHeadlines } from "../src/app/lib/presentation/signal-headlines.js";

describe("signal headlines", () => {
  it("derives the four minimum terminal values from contract-shaped evidence", () => {
    const headlines = deriveSignalHeadlines({
      acceptedReservations: 10,
      arrivalSummary: {
        ...emptyRequestArrivalSummary,
        firstAttemptStartedAt: "2026-06-20T00:01:00.000Z",
        peakArrivalRatePerSecond: 10,
        dispatchDurationSeconds: 2,
        arrivalWindowCountObserved: 1,
      },
      failedOrders: 1,
      liveLag: null,
      oversoldUnits: 0,
      runStatus: "completed",
      startingStock: 10,
      terminalSummary: terminalHeadline,
    });

    expect(headlines.arrival).toEqual({
      basicValue: "Peak 10 attempts/s",
      value: "Peak 10 attempts/s",
      detail: "Dispatched in 2 s",
    });
    expect(headlines.inventory).toEqual({
      basicValue: "0 of 10 left · 0 oversold",
      value: "0 of 10 left · 0 oversold",
      detail: "depleted in 5 s",
    });
    expect(headlines.backlog.value).toBe("Peak 6 · drained in 10 s");
    expect(headlines.confirmation.value).toBe(
      "9/10 confirmed · 0 pending · p95 3 s · Converged in 118 s",
    );
    expect(headlines.confirmation.basicValue).toBe(
      "9/10 confirmed · 0 pending · 95% of confirmed orders within 3 s · Converged in 118 s",
    );
    expect(headlines.confirmation.basicValue).not.toMatch(/\bp95\b/i);
    expect(headlines.confirmation.detail).toBe("1 failed · lag avg 2 s, max 4 s");
  });

  it.each([
    ["active", "Not yet available"],
    ["draining", "Not yet available"],
    ["completed", "Not recorded for this run"],
    ["failed", "Not recorded for this run"],
  ] as const)("uses lifecycle-aware absence for %s evidence", (runStatus, durableAbsence) => {
    const headlines = deriveSignalHeadlines({
      acceptedReservations: null,
      arrivalSummary: emptyRequestArrivalSummary,
      failedOrders: null,
      liveLag: null,
      oversoldUnits: null,
      runStatus,
      startingStock: null,
      terminalSummary: null,
    });

    expect(headlines.arrival.value).toBe(
      runStatus === "active" ? "Not yet available" : "Not recorded for this run",
    );
    expect(headlines.inventory.value).toBe(durableAbsence);
    expect(headlines.backlog.value).toBe(durableAbsence);
    expect(headlines.confirmation.value).toBe(durableAbsence);
  });

  it("preserves partial live evidence without inventing missing values", () => {
    const headlines = deriveSignalHeadlines({
      acceptedReservations: null,
      arrivalSummary: emptyRequestArrivalSummary,
      failedOrders: 1,
      liveLag: {
        confirmedOrderCount: 3,
        pendingConfirmationCount: 2,
        averageLagMs: null,
        p95LagMs: 350,
        maxLagMs: null,
        oldestPendingAgeSeconds: 1,
        measuredAt: "2026-06-20T00:00:02.000Z",
      },
      liveSamples: [
        {
          recoveredAt: "2026-06-20T00:00:02.000Z",
          hasBusinessOutcomeEvidence: true,
          arrivalRatePerSecond: 8,
          remainingStock: 5,
          queueBacklog: 2,
          confirmedOrderCount: 3,
          settledOrderCount: 3,
          failedOrderCount: 1,
          pendingOrderCount: 2,
        },
      ],
      oversoldUnits: null,
      runStatus: "active",
      startingStock: null,
      terminalSummary: null,
    });

    expect(headlines.arrival.value).toBe("Peak 8 attempts/s");
    expect(headlines.inventory.value).toBe("5 of Not yet available left · oversell unknown");
    expect(headlines.backlog.value).toBe("2 waiting · peak 2");
    expect(headlines.confirmation.value).toBe(
      "3/Not yet available confirmed · 2 pending · p95 350 ms",
    );
  });

  it("does not turn zero-filled samples into confirmation evidence", () => {
    const headlines = deriveSignalHeadlines({
      acceptedReservations: null,
      arrivalSummary: emptyRequestArrivalSummary,
      failedOrders: null,
      liveLag: null,
      liveSamples: [
        {
          recoveredAt: "2026-06-20T00:00:02.000Z",
          hasBusinessOutcomeEvidence: false,
          arrivalRatePerSecond: null,
          remainingStock: 9,
          queueBacklog: null,
          confirmedOrderCount: 0,
          settledOrderCount: 0,
          failedOrderCount: 0,
          pendingOrderCount: 0,
        },
      ],
      oversoldUnits: null,
      runStatus: "active",
      startingStock: 10,
      terminalSummary: null,
    });

    expect(headlines.confirmation).toEqual({
      basicValue: "Not yet available",
      value: "Not yet available",
      detail: null,
    });
  });
});

const terminalHeadline = {
  window: {
    anchoredAt: "2026-06-20T00:01:00.000Z",
    endedAt: "2026-06-20T00:03:00.000Z",
    bucketCount: runSignalBucketCount,
    bucketWidthSeconds: 1,
  },
  inventoryDrain: {
    startingStock: 10,
    remainingStock: 0,
    depletedAt: "2026-06-20T00:01:05.000Z",
    timeToDepletionSeconds: 5,
  },
  queueBacklog: {
    peakBacklog: 6,
    peakAtElapsedSeconds: 2,
    backlogDrainedAt: "2026-06-20T00:01:10.000Z",
    drainDurationSeconds: 10,
    drainDurationBoundary: queueBacklogDrainDurationBoundary,
    definition: queueBacklogDefinition,
  },
  confirmationConvergence: {
    confirmedOrderCount: 9,
    failedOrderCount: 1,
    pendingAtCaptureCount: 0,
    averageLagMs: 2_000,
    p95LagMs: 3_000,
    maxLagMs: 4_000,
    boundary: confirmationLagBoundary,
  },
  convergenceDurationSeconds: 118,
};
