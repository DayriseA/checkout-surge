import { runSignalBucketCount, toRunSignalTimelineHeadline } from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GoldSignalHeadlines, GoldSignals, scale } from "../src/app/components/gold-signals.js";

describe("Gold Signals", () => {
  it("uses one aligned axis and terminal evidence instead of a low-volume live tail", () => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 10,
        arrivalSummary: {
          firstAttemptStartedAt: "2026-06-20T00:01:00.000Z",
          peakArrivalRatePerSecond: 10,
          peakArrivalWindowSeconds: 1,
          dispatchDurationSeconds: 2,
          arrivalRateSeries: [{ windowStartedAt: "2026-06-20T00:01:00.000Z", ratePerSecond: 10 }],
          arrivalWindowCountObserved: 1,
          arrivalWindowCountRetained: 1,
          arrivalSeriesLimit: 120,
        },
        liveSamples: [
          {
            recoveredAt: "2026-06-20T00:03:00.000Z",
            arrivalRatePerSecond: 1,
            remainingStock: 999,
            queueBacklog: 999,
            confirmedOrderCount: 999,
            settledOrderCount: 999,
            failedOrderCount: 0,
            pendingOrderCount: 0,
          },
        ],
        oversoldUnits: 0,
        retryingOrderCount: 2,
        terminalSummary: timelineFixture(),
      }),
    );

    expect(markup.match(/role="img"/g)).toHaveLength(4);
    expect(markup.match(/viewBox="0 0 640 96"/g)).toHaveLength(4);
    expect(markup).toContain("Peak 10 attempts/s");
    expect(markup).toContain(
      "Checkout attempts started by k6 in 1-second producer event-time windows.",
    );
    expect(markup).toContain("Start 10 · 0 remaining · 0 oversold · depleted in 5s");
    expect(markup).toContain("Peak 6 orders · drained in 10s");
    expect(markup).toContain("9/10 confirmed · 1 failed · 0 pending");
    expect(markup).toContain("Lag avg 2,000ms, p95 3,000ms, max 4,000ms · Converged in 118s");
    expect(markup).not.toContain("999 remaining");
    expect(markup).not.toContain("Peak 999 orders");
    expect(markup).not.toContain("999/10 confirmed");
    expect(markup).toContain("120 buckets of 1s each");
    expect(markup).toContain(
      "Shared axis: 0s first checkout attempt · 120s terminal timeline boundary",
    );
    expect(markup).toContain("<title>first checkout attempt</title>");
    expect(markup).toContain("<title>terminal timeline boundary</title>");
    expect(markup).toContain('x1="0"');
    expect(markup).toContain("stroke-danger");
  });

  it("renders neutral field-specific absence without zero claims or empty charts", () => {
    const liveMarkup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 0,
        arrivalSummary: null,
        liveLag: {
          confirmedOrderCount: 0,
          pendingConfirmationCount: 0,
          averageLagMs: null,
          p95LagMs: null,
          maxLagMs: null,
          oldestPendingAgeSeconds: null,
          measuredAt: "2026-06-20T00:00:01.000Z",
        },
        liveSamples: [
          {
            recoveredAt: "2026-06-20T00:00:01.000Z",
            arrivalRatePerSecond: null,
            remainingStock: 10,
            queueBacklog: 0,
            confirmedOrderCount: 0,
            settledOrderCount: 0,
            failedOrderCount: 0,
            pendingOrderCount: 0,
          },
        ],
        oversoldUnits: 0,
        startingStock: 10,
        terminalSummary: null,
      }),
    );
    const historyMarkup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 0,
        arrivalSummary: null,
        oversoldUnits: 0,
        terminalSummary: null,
      }),
    );

    expect(liveMarkup.match(/Not yet available/g)).toHaveLength(4);
    expect(historyMarkup.match(/Unavailable for this run/g)).toHaveLength(4);
    expect(`${liveMarkup}${historyMarkup}`).not.toContain('role="img"');
    expect(`${liveMarkup}${historyMarkup}`).not.toContain("Peak 0");
    expect(`${liveMarkup}${historyMarkup}`).not.toContain("0 remaining");
  });

  it("uses live lag evidence and labels the reloadable live origin honestly", () => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 7,
        arrivalSummary: null,
        liveLag: {
          confirmedOrderCount: 6,
          pendingConfirmationCount: 1,
          averageLagMs: 900,
          p95LagMs: 1_200,
          maxLagMs: 1_500,
          oldestPendingAgeSeconds: 2,
          measuredAt: "2026-06-20T00:00:02.000Z",
        },
        liveSamples: [
          {
            recoveredAt: "2026-06-20T00:00:01.000Z",
            arrivalRatePerSecond: null,
            remainingStock: 10,
            queueBacklog: 0,
            confirmedOrderCount: 0,
            settledOrderCount: 0,
            failedOrderCount: 0,
            pendingOrderCount: 0,
          },
          {
            recoveredAt: "2026-06-20T00:01:31.000Z",
            arrivalRatePerSecond: null,
            remainingStock: 10,
            queueBacklog: 0,
            confirmedOrderCount: 0,
            settledOrderCount: 0,
            failedOrderCount: 0,
            pendingOrderCount: 0,
          },
          {
            recoveredAt: "2026-06-20T00:02:01.000Z",
            arrivalRatePerSecond: 12,
            remainingStock: 10,
            queueBacklog: 5,
            confirmedOrderCount: 0,
            settledOrderCount: 0,
            failedOrderCount: 0,
            pendingOrderCount: 7,
          },
          {
            recoveredAt: "2026-06-20T00:02:03.000Z",
            arrivalRatePerSecond: 2,
            remainingStock: 3,
            queueBacklog: 1,
            confirmedOrderCount: 6,
            settledOrderCount: 6,
            failedOrderCount: 0,
            pendingOrderCount: 1,
          },
        ],
        oversoldUnits: 0,
        startingStock: 10,
        terminalSummary: null,
      }),
    );

    expect(markup).toContain("Start 10 · 3 remaining · 0 oversold");
    expect(markup).toContain(
      "Lag avg 900ms, p95 1,200ms, max 1,500ms · Convergence in progress · 1 pending",
    );
    expect(markup).toContain(
      "Shared axis: 0s first retained live projection · 2s latest retained live projection",
    );
    expect(markup).toContain(
      "Checkout attempts started by k6 in one-second producer event-time windows.",
    );
    expect(markup).toContain("<li>0s: 12</li>");
    expect(markup).not.toContain("120s:");
    expect(markup).not.toContain("0s first checkout attempt");
  });

  it("starts a reloaded mid-drain timeline from fallback durable activity", () => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 5,
        arrivalSummary: null,
        liveSamples: [
          {
            recoveredAt: "2026-06-20T00:00:01.000Z",
            arrivalRatePerSecond: null,
            remainingStock: 10,
            queueBacklog: 0,
            confirmedOrderCount: 0,
            settledOrderCount: 0,
            failedOrderCount: 0,
            pendingOrderCount: 0,
          },
          {
            recoveredAt: "2026-06-20T00:01:01.000Z",
            arrivalRatePerSecond: null,
            remainingStock: 7,
            queueBacklog: 0,
            confirmedOrderCount: 0,
            settledOrderCount: 0,
            failedOrderCount: 0,
            pendingOrderCount: 0,
          },
          {
            recoveredAt: "2026-06-20T00:01:03.000Z",
            arrivalRatePerSecond: null,
            remainingStock: 5,
            queueBacklog: 2,
            confirmedOrderCount: 2,
            settledOrderCount: 2,
            failedOrderCount: 0,
            pendingOrderCount: 2,
          },
        ],
        oversoldUnits: 0,
        startingStock: 10,
        terminalSummary: null,
      }),
    );

    expect(markup.match(/role="img"/g)).toHaveLength(3);
    expect(markup).toContain("Request arrival</h3><p");
    expect(markup).toContain("Not yet available");
    expect(markup).toContain("Start 10 · 5 remaining · 0 oversold");
    expect(markup).toContain("Peak 2 orders");
    expect(markup).toContain("<li>0s: 7</li>");
    expect(markup).toContain(
      "Shared axis: 0s first retained live projection · 2s latest retained live projection",
    );
    expect(markup).not.toContain("60s:");
    expect(markup).not.toContain("Latest/retained peak 0");
  });

  it("renders all four run-history headlines from retained terminal evidence", () => {
    const terminal = timelineFixture();
    const markup = renderToStaticMarkup(
      createElement(GoldSignalHeadlines, {
        arrivalSummary: {
          firstAttemptStartedAt: terminal.window.anchoredAt,
          peakArrivalRatePerSecond: 10,
          peakArrivalWindowSeconds: 1,
          dispatchDurationSeconds: 2,
          arrivalRateSeries: [],
          arrivalWindowCountObserved: 0,
          arrivalWindowCountRetained: 0,
          arrivalSeriesLimit: 120,
        },
        headline: toRunSignalTimelineHeadline(terminal),
        oversoldUnits: 0,
      }),
    );

    expect(markup).toContain("Request arrival");
    expect(markup).toContain("Peak 10 attempts/s · dispatched in 2s");
    expect(markup).toContain("Start 10 · 0 remaining · 0 oversold · depleted in 5s");
    expect(markup).toContain("Peak 6 · drained in 10s");
    expect(markup).toContain(
      "9 confirmed · 1 failed · 0 pending · lag avg 2,000ms, p95 3,000ms, max 4,000ms · converged in 118s",
    );
  });

  it("scales every panel against the same bounded x-domain", () => {
    expect(scale(0, 120, 640)).toBe(0);
    expect(scale(60, 120, 640)).toBe(320);
    expect(scale(200, 120, 640)).toBe(640);
  });
});

function timelineFixture() {
  const elapsed = Array.from({ length: runSignalBucketCount }, (_, index) => index + 1);
  return {
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
      remainingStockSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        remainingStock: Math.max(0, 10 - elapsedSeconds * 2),
      })),
    },
    queueBacklog: {
      peakBacklog: 6,
      peakAtElapsedSeconds: 3,
      backlogDrainedAt: "2026-06-20T00:01:11.000Z",
      drainDurationSeconds: 10,
      drainDurationBoundary: "first_order_queued_to_final_backlog_zero" as const,
      definition: "accepted_awaiting_first_processing_start" as const,
      backlogSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        backlog: elapsedSeconds <= 6 ? elapsedSeconds : Math.max(0, 12 - elapsedSeconds),
      })),
    },
    confirmationConvergence: {
      confirmedOrderCount: 9,
      failedOrderCount: 1,
      pendingAtCaptureCount: 0,
      averageLagMs: 2_000,
      p95LagMs: 3_000,
      maxLagMs: 4_000,
      boundary: "reservation_secured_to_order_confirmed" as const,
      convergenceSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        cumulativeConfirmedOrderCount: Math.min(9, elapsedSeconds),
        cumulativeSettledOrderCount: Math.min(10, elapsedSeconds),
      })),
    },
    convergenceDurationSeconds: 118,
  };
}
