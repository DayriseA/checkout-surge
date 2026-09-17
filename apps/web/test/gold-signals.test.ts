import { runSignalBucketCount } from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GoldSignals, scale } from "../src/app/components/gold-signals.js";

describe("Gold Signals", () => {
  it("marks a single arrival sample and retains its text equivalent", () => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 1,
        arrivalSummary: {
          firstAttemptStartedAt: "2026-06-20T00:01:00.000Z",
          peakArrivalRatePerSecond: 10,
          peakArrivalWindowSeconds: 1,
          dispatchDurationSeconds: 0.164,
          arrivalRateSeries: [{ windowStartedAt: "2026-06-20T00:01:00.000Z", ratePerSecond: 10 }],
          arrivalWindowCountObserved: 1,
          arrivalWindowCountRetained: 1,
          arrivalSeriesLimit: 120,
        },
        liveSamples: [],
        oversoldUnits: null,
        runStatus: "completed",
        terminalSummary: null,
      }),
    );

    expect(markup).toContain('<circle class="fill-accent"');
    expect(markup).toContain('aria-label="Request arrival timeline"');
    expect(markup).toContain("<li>0s: 10</li>");
  });

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
            hasBusinessOutcomeEvidence: true,
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
        runStatus: "completed",
        terminalSummary: timelineFixture(),
      }),
    );

    expect(markup.match(/role="img"/g)).toHaveLength(4);
    expect(markup.match(/viewBox="0 0 640 96"/g)).toHaveLength(4);
    expect(markup).toContain(
      'class="m-0 mb-4 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2" data-signal-headlines=""',
    );
    expect(markup).toContain("Peak 10 attempts/s");
    expect(markup).toContain(
      "Checkout attempts started by the load generator in 1-second windows.",
    );
    expect(markup).toContain("0 of 10 left · 0 oversold");
    expect(markup).toContain("Peak 6 · drained in 10 s");
    expect(markup).toContain("9/10 confirmed · 0 pending · p95 3 s · Converged in 118 s");
    expect(markup).toContain("1 failed · lag avg 2 s, max 4 s");
    expect(markup).not.toContain("999 of 10 left");
    expect(markup).not.toContain("Peak 999");
    expect(markup).not.toContain("999/10 confirmed");
    expect(markup).toContain(
      "All panels cover the completed run from its first checkout attempt to its final timeline boundary.",
    );
    expect(markup).not.toContain("buckets of");
    expect(markup).toContain(
      "Shared axis: 0s first checkout attempt · 120s final timeline boundary",
    );
    expect(markup).toContain("<title>first checkout attempt</title>");
    expect(markup).toContain("<title>final timeline boundary</title>");
    expect(markup).toContain('x1="0"');
    expect(markup).toContain("stroke-danger");
    for (const name of [
      "Request arrival timeline",
      "Inventory timeline",
      "Processing backlog timeline",
      "Confirmation timeline",
    ]) {
      expect(markup).toContain(`aria-label="${name}"`);
    }
    expect(markup).not.toMatch(/aria-label="[^"]*Peak 10 attempts\/s/);
    expect(markup).not.toMatch(/aria-label="[^"]*0 of 10 left/);
    expect(markup).not.toMatch(/aria-label="[^"]*Peak 6/);
    expect(markup).not.toMatch(/aria-label="[^"]*9\/10 confirmed/);
    const visibleText = markup.replace(/<[^>]+>/g, "");
    for (const headline of [
      "Peak 10 attempts/s",
      "0 of 10 left · 0 oversold",
      "Peak 6 · drained in 10 s",
      "9/10 confirmed · 0 pending · p95 3 s · Converged in 118 s",
    ]) {
      expect(visibleText.split(headline)).toHaveLength(2);
    }
  });

  it("uses lifecycle-aware absence without zero claims or empty charts", () => {
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
            hasBusinessOutcomeEvidence: true,
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
        runStatus: "active",
        startingStock: 10,
        terminalSummary: null,
      }),
    );
    const historyMarkup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 0,
        arrivalSummary: null,
        liveSamples: [],
        oversoldUnits: 0,
        runStatus: "completed",
        terminalSummary: null,
      }),
    );
    const failedMarkup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 0,
        arrivalSummary: null,
        liveSamples: [],
        oversoldUnits: 0,
        runStatus: "failed",
        terminalSummary: null,
      }),
    );

    expect(liveMarkup.match(/Not yet available/g)).toHaveLength(3);
    expect(liveMarkup).toContain("0/0 confirmed · 0 pending");
    expect(historyMarkup.match(/Not recorded for this run/g)).toHaveLength(4);
    expect(failedMarkup.match(/Not recorded for this run/g)).toHaveLength(4);
    expect(`${historyMarkup}${failedMarkup}`).not.toContain("Not yet available");
    expect(`${liveMarkup}${historyMarkup}${failedMarkup}`).not.toContain('role="img"');
    expect(`${liveMarkup}${historyMarkup}${failedMarkup}`).not.toContain("Peak 0");
    expect(`${liveMarkup}${historyMarkup}${failedMarkup}`).not.toContain("0 remaining");
  });

  it("does not present zero-filled live samples as confirmation evidence", () => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: null,
        arrivalSummary: null,
        liveLag: {
          confirmedOrderCount: 3,
          pendingConfirmationCount: 2,
          averageLagMs: 200,
          p95LagMs: 300,
          maxLagMs: 400,
          oldestPendingAgeSeconds: 1,
          measuredAt: "2026-06-20T00:00:01.000Z",
        },
        liveSamples: [
          {
            recoveredAt: "2026-06-20T00:00:01.000Z",
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
      }),
    );

    expect(markup).toContain("3/Not yet available confirmed · 2 pending · p95 300 ms");
    expect(markup.match(/role="img"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="Confirmation timeline"');
  });

  it.each([
    "completed",
    "failed",
  ] as const)("uses final incomplete wording for retained partial evidence from a %s run", (runStatus) => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: null,
        arrivalSummary: null,
        liveLag: null,
        liveSamples: [
          {
            recoveredAt: "2026-06-20T00:00:01.000Z",
            hasBusinessOutcomeEvidence: false,
            arrivalRatePerSecond: 8,
            remainingStock: null,
            queueBacklog: null,
            confirmedOrderCount: 0,
            settledOrderCount: 0,
            failedOrderCount: 0,
            pendingOrderCount: 0,
          },
        ],
        oversoldUnits: null,
        runStatus,
        startingStock: null,
        terminalSummary: null,
      }),
    );

    expect(markup).toContain(
      "Final timeline evidence was not recorded; the run evidence that was recorded is shown where available.",
    );
    expect(markup).toContain("Peak 8 attempts/s");
    expect(markup).toContain("Not recorded for this run");
    expect(markup).not.toContain("Live panels");
    expect(markup).not.toContain("in progress");
    expect(markup.toLowerCase()).not.toContain("not yet");
  });

  it("keeps recorded arrival evidence when neither a timeline nor browser samples exist", () => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 4,
        arrivalSummary: {
          firstAttemptStartedAt: "2026-06-20T00:01:00.000Z",
          peakArrivalRatePerSecond: 10,
          peakArrivalWindowSeconds: 1,
          dispatchDurationSeconds: 2,
          arrivalRateSeries: [
            { windowStartedAt: "2026-06-20T00:01:00.000Z", ratePerSecond: 10 },
            { windowStartedAt: "2026-06-20T00:01:02.000Z", ratePerSecond: 6 },
          ],
          arrivalWindowCountObserved: 2,
          arrivalWindowCountRetained: 2,
          arrivalSeriesLimit: 120,
        },
        liveSamples: [],
        oversoldUnits: null,
        runStatus: "completed",
        terminalSummary: null,
      }),
    );

    expect(markup).toContain("Peak 10 attempts/s");
    expect(markup.match(/role="img"/g)).toHaveLength(1);
    expect(markup).toContain("<li>0s: 10</li>");
    expect(markup).toContain("<li>2s: 6</li>");
    expect(markup).toContain(
      "Shared axis: 0s first checkout attempt · 2s last recorded arrival window",
    );
    expect(markup.match(/Not recorded for this run/g)).toHaveLength(3);
    expect(markup).not.toContain("Not yet available");
  });

  it("refuses to publish an unobserved arrival summary as a measured zero peak", () => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 0,
        arrivalSummary: {
          firstAttemptStartedAt: null,
          peakArrivalRatePerSecond: 0,
          peakArrivalWindowSeconds: 1,
          dispatchDurationSeconds: 0,
          arrivalRateSeries: [],
          arrivalWindowCountObserved: 0,
          arrivalWindowCountRetained: 0,
          arrivalSeriesLimit: 120,
        },
        liveSamples: [],
        oversoldUnits: null,
        runStatus: "failed",
        terminalSummary: null,
      }),
    );

    expect(markup).not.toContain("Peak 0");
    expect(markup.match(/Not recorded for this run/g)).toHaveLength(4);
  });

  it("names the run its terminal timeline actually covers", () => {
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
        liveSamples: [],
        oversoldUnits: null,
        runStatus: "failed",
        terminalSummary: timelineFixture(),
      }),
    );

    expect(markup).toContain(
      "All panels cover the failed run from its first checkout attempt to its final timeline boundary.",
    );
    expect(markup).not.toContain("completed run");
    expect(markup).toContain("0 of 10 left · oversell unknown");
  });

  it("does not claim full coverage while the arrival panel has no evidence", () => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 10,
        arrivalSummary: null,
        liveSamples: [],
        oversoldUnits: 0,
        runStatus: "completed",
        terminalSummary: timelineFixture(),
      }),
    );

    expect(markup).toContain(
      "The timeline panels cover the completed run through its final timeline boundary; request-arrival evidence was not recorded.",
    );
    expect(markup).not.toContain("All panels cover");
    expect(markup).toContain(
      '<dt class="text-xs font-bold text-muted">Request arrival</dt><dd class="m-0 mt-1 font-semibold text-ink">Not recorded for this run</dd>',
    );
    expect(markup.match(/role="img"/g)).toHaveLength(3);
  });

  it("reports load-generator absence as final once a draining run has ended its traffic", () => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 3,
        arrivalSummary: null,
        liveSamples: [],
        oversoldUnits: null,
        runStatus: "draining",
        terminalSummary: null,
      }),
    );

    expect(markup).toContain(
      '<dt class="text-xs font-bold text-muted">Request arrival</dt><dd class="m-0 mt-1 font-semibold text-ink">Not recorded for this run</dd>',
    );
    expect(markup.match(/Not yet available/g)).toHaveLength(3);
  });

  it("uses live lag evidence without treating browser collection as run evidence", () => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 7,
        arrivalSummary: null,
        failedOrders: 0,
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
            hasBusinessOutcomeEvidence: false,
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
            hasBusinessOutcomeEvidence: false,
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
            hasBusinessOutcomeEvidence: true,
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
            hasBusinessOutcomeEvidence: true,
            arrivalRatePerSecond: 2,
            remainingStock: 3,
            queueBacklog: 1,
            confirmedOrderCount: 4,
            settledOrderCount: 4,
            failedOrderCount: 0,
            pendingOrderCount: 3,
          },
        ],
        oversoldUnits: 0,
        runStatus: "active",
        startingStock: 10,
        terminalSummary: null,
      }),
    );

    expect(markup).toContain("3 of 10 left · 0 oversold");
    expect(markup).toContain("6/7 confirmed · 1 pending · p95 1.2 s");
    expect(markup).toContain("0 failed · lag avg 900 ms, max 1.5 s");
    expect(markup).toContain("Shared axis: 0s first available update · 2s latest available update");
    expect(markup).toContain(
      "Checkout attempts started by the load generator in 1-second windows.",
    );
    expect(markup).toContain("<li>0s: 12</li>");
    expect(markup).not.toContain("120s:");
    expect(markup).not.toContain("0s first checkout attempt");
    expect(markup).not.toContain("Reloading restarts");
  });

  it("starts a reloaded mid-drain timeline from fallback durable activity", () => {
    const markup = renderToStaticMarkup(
      createElement(GoldSignals, {
        acceptedReservations: 5,
        arrivalSummary: null,
        liveSamples: [
          {
            recoveredAt: "2026-06-20T00:00:01.000Z",
            hasBusinessOutcomeEvidence: true,
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
            hasBusinessOutcomeEvidence: true,
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
            hasBusinessOutcomeEvidence: true,
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
        runStatus: "active",
        startingStock: 10,
        terminalSummary: null,
      }),
    );

    expect(markup.match(/role="img"/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="Confirmation timeline"');
    expect(markup).toContain("<li>2s: 2</li>");
    expect(markup).toContain("Request arrival</h3><p");
    expect(markup).toContain("Not yet available");
    expect(markup).toContain("5 of 10 left · 0 oversold");
    expect(markup).toContain("2 waiting · peak 2");
    expect(markup).toContain("<li>0s: 7</li>");
    expect(markup).toContain("Shared axis: 0s first available update · 2s latest available update");
    expect(markup).not.toContain("60s:");
    expect(markup).not.toContain("Latest/retained peak 0");
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
