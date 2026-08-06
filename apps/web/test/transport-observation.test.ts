import type {
  HttpTimingBreakdownSummary,
  ServerReservationTimingSummary,
  TrafficHttpSummary,
  TransportAttemptCounts,
} from "@checkout-surge/contracts";
import {
  deriveRecordedReplyCount,
  emptyRequestArrivalSummary,
  evaluateFastReservationTarget,
} from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  deriveTransportObservation,
  TransportObservationPanelBlock,
  TransportObservationSection,
} from "../src/app/components/transport-observation.js";

describe("transport observation coverage", () => {
  it("reports full coverage when every dispatched attempt recorded a reply", () => {
    const observation = deriveTransportObservation(counts({ completedRequests: 10 }), 0);

    expect(observation.coveragePercent).toBe(100);
    expect(observation.hasUnrecordedReplies).toBe(false);
    expect(observation.hasUndispatchedAttempts).toBe(false);
  });

  it("reports partial coverage when replies went unrecorded", () => {
    const observation = deriveTransportObservation(
      counts({ completedRequests: 7, interruptedRequests: 3 }),
      0,
    );

    expect(observation.coveragePercent).toBe(70);
    expect(observation.hasUnrecordedReplies).toBe(true);
  });

  it("never rounds up into a claim of full coverage while replies are missing", () => {
    const observation = deriveTransportObservation(
      {
        plannedRequests: 5_000,
        startedRequests: 5_000,
        completedRequests: 4_999,
        interruptedRequests: 1,
        unstartedRequests: 0,
      },
      0,
    );

    expect(observation.coveragePercent).toBe(99);
  });

  it("returns no coverage figure when nothing was dispatched", () => {
    const observation = deriveTransportObservation(
      {
        plannedRequests: 10,
        startedRequests: 0,
        completedRequests: 0,
        interruptedRequests: 0,
        unstartedRequests: 10,
      },
      0,
    );

    expect(observation.coveragePercent).toBeNull();
    expect(observation.hasUndispatchedAttempts).toBe(true);
  });

  it("excludes completed status-zero attempts from reply coverage", () => {
    const observation = deriveTransportObservation(counts({ completedRequests: 10 }), 3);

    expect(observation.repliesRecorded).toBe(7);
    expect(observation.coveragePercent).toBe(70);
    expect(observation.hasUnrecordedReplies).toBe(true);
  });
});

describe("transport observation section", () => {
  it("keeps the funnel clean when nothing was interrupted or undispatched", () => {
    const markup = renderSection(counts({ completedRequests: 10 }));

    expect(markup).toContain("Load generator");
    expect(markup).toContain("Planned attempts");
    expect(markup).toContain("Replies not recorded");
    expect(markup).toContain("Never dispatched");
    expect(markup).not.toContain("<meter");
    expect(markup).not.toContain("recorded a reply");
    expect(markup).not.toContain("load generator stopped before the reply arrived");
    expect(markup).not.toContain("scenario window closed before these were sent");
    expect(markup).not.toContain("Outcomes and latency");
    expect(markup).not.toContain("observed replies only");
  });

  it("leads with the server boundary, target verdict, and shared-host caveat", () => {
    const markup = renderSection(counts({ completedRequests: 10 }));

    expect(markup.indexOf("Fast inventory reservation")).toBeLessThan(
      markup.indexOf("Request arrival"),
    );
    expect(markup).toContain("Inventory reservation target");
    expect(markup).toContain("Observed reservation p95");
    // The declared target and the observed bound sit adjacent and must spell milliseconds the
    // same way, so the panel's whole comparison reads in one unit.
    expect(markup).toMatch(/Inventory reservation target<\/dt><dd[^>]*>≤ 1ms<\/dd>/);
    expect(markup).toContain("≤ 25ms");
    expect(markup).not.toContain("≤ 1 ms");
    expect(markup).toContain("Target verdict");
    expect(markup).toMatch(/Target verdict<\/dt><dd[^>]*>fail<\/dd>/);
    expect(markup).toContain("Reservation processing p95 bound");
    expect(markup).toContain("≤ 100ms");
    expect(markup).toContain("bounded p95 estimate");
    expect(markup).toContain("not hosted benchmark evidence");
  });

  it("discloses coverage, cause, and survivorship bias when replies went unrecorded", () => {
    const markup = renderSection(counts({ completedRequests: 7, interruptedRequests: 3 }));

    expect(markup).toContain("<meter");
    expect(markup).toContain('value="70"');
    expect(markup).toContain("70% of dispatched attempts recorded a reply");
    expect(markup).toContain("load generator stopped before the reply arrived");
    expect(markup).toContain("observed replies only");
    expect(markup).toContain(
      "Outcomes and latency above cover 7 of 10 attempts. The p95 describes replies received only. Durable checkout records are the authoritative record.",
    );
  });

  it("distinguishes connection failures from shutdown-interrupted replies", () => {
    const markup = renderSection(
      counts({ completedRequests: 10 }),
      httpSummary({ failedRequests: 3, transportFailures: 3 }),
    );

    expect(markup).toContain('value="70"');
    expect(markup).toContain("Generator received no reply");
    expect(markup).toContain("connection failed before a reply");
    expect(markup).not.toContain("load generator stopped before the reply arrived");
    expect(markup).toContain("Outcomes and latency above cover 7 of 10 attempts.");
  });

  it("explains undispatched attempts without raising the survivorship caveat", () => {
    const markup = renderSection({
      plannedRequests: 10,
      startedRequests: 6,
      completedRequests: 6,
      interruptedRequests: 0,
      unstartedRequests: 4,
    });

    expect(markup).toContain("scenario window closed before these were sent");
    expect(markup).not.toContain("<meter");
    expect(markup).not.toContain("Outcomes and latency");
  });

  it("renders without a coverage figure when nothing was dispatched", () => {
    const markup = renderSection({
      plannedRequests: 10,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: 10,
    });

    expect(markup).toContain("scenario window closed before these were sent");
    expect(markup).not.toContain("<meter");
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Infinity");
  });

  it("shortens the survivorship caveat on the run-history list", () => {
    const markup = renderToStaticMarkup(
      createElement(TransportObservationSection, {
        arrivalSummary: emptyRequestArrivalSummary,
        counts: counts({ completedRequests: 7, interruptedRequests: 3 }),
        ...timingProps(7),
        httpSummary: httpSummary(),
        surface: "list",
      }),
    );

    expect(markup).toContain("Outcomes and latency cover 7 of 10 attempts.");
    expect(markup).not.toContain("the true p95 is higher");
  });

  it("separates configured delay from the remaining time before checkout attempts begin", () => {
    const markup = renderToStaticMarkup(
      createElement(TransportObservationSection, {
        arrivalSummary: {
          ...emptyRequestArrivalSummary,
          firstAttemptStartedAt: "2026-06-20T12:00:10.000Z",
        },
        counts: counts({ completedRequests: 10 }),
        ...timingProps(10),
        httpSummary: httpSummary(),
        startDelaySeconds: 3,
        surface: "detail",
        trafficStartedAt: "2026-06-20T12:00:00.000Z",
      }),
    );

    expect(markup).toContain("Configured start delay");
    expect(markup).toContain(">3 s<");
    expect(markup).toContain("Time until checkout attempts begin");
    expect(markup).toContain(">7 s<");
  });

  it("does not expose arrival-series retention bookkeeping", () => {
    const arrivalRateSeries = Array.from({ length: 15 }, (_, index) => ({
      windowStartedAt: new Date(Date.UTC(2026, 5, 20, 12, 0, index)).toISOString(),
      ratePerSecond: index + 1,
    }));
    const markup = renderToStaticMarkup(
      createElement(TransportObservationSection, {
        arrivalSummary: {
          firstAttemptStartedAt: "2026-06-20T12:00:01.000Z",
          peakArrivalRatePerSecond: 20,
          peakArrivalWindowSeconds: 1,
          dispatchDurationSeconds: 1,
          arrivalRateSeries,
          arrivalWindowCountObserved: 20,
          arrivalWindowCountRetained: 15,
          arrivalSeriesLimit: 120,
        },
        counts: counts({ completedRequests: 10 }),
        ...timingProps(10),
        httpSummary: httpSummary(),
        surface: "detail",
      }),
    );

    expect(markup).not.toContain("retained windows");
    expect(markup).not.toContain("observed windows");
  });
});

describe("transport observation panel block", () => {
  it("qualifies the live rate metrics rendered above it", () => {
    const markup = renderToStaticMarkup(
      createElement(TransportObservationPanelBlock, {
        counts: counts({ completedRequests: 7, interruptedRequests: 3 }),
        httpSummary: httpSummary(),
      }),
    );

    expect(markup).toContain("Load generator");
    expect(markup).toContain("what the load generator observed");
    expect(markup).toContain("70% of dispatched attempts recorded a reply");
    expect(markup).toContain(
      "Reply-dependent outcomes and latency cover 7 of 10 attempts. The HTTP failure rate above is a separate load-generator measure and can include connection failures. Durable checkout records below are the authoritative record.",
    );
  });

  it("stays quiet on a run that recorded every reply", () => {
    const markup = renderToStaticMarkup(
      createElement(TransportObservationPanelBlock, {
        counts: counts({ completedRequests: 10 }),
        httpSummary: httpSummary(),
      }),
    );

    expect(markup).toContain("Replies recorded");
    expect(markup).not.toContain("<meter");
    expect(markup).not.toContain("The rates above cover");
  });
});

function renderSection(
  transportAttemptCounts: TransportAttemptCounts,
  summary = httpSummary(),
): string {
  return renderToStaticMarkup(
    createElement(TransportObservationSection, {
      arrivalSummary: emptyRequestArrivalSummary,
      counts: transportAttemptCounts,
      ...timingProps(deriveRecordedReplyCount(transportAttemptCounts, summary.transportFailures)),
      httpSummary: summary,
      httpTimingBreakdownSummary: timingBreakdown(),
      surface: "detail",
    }),
  );
}

function timingProps(expectedResponseCount: number) {
  const serverReservationTimingSummary: ServerReservationTimingSummary = {
    redisAtomicReservation: { sampleCount: 10, averageMs: 4, p95Ms: 25 },
    reserveOrderService: { sampleCount: 10, averageMs: 30, p95Ms: 100 },
  };
  return {
    serverReservationTimingSummary,
    fastReservationTargetEvaluation: evaluateFastReservationTarget(
      serverReservationTimingSummary,
      expectedResponseCount,
    ),
  };
}

function timingBreakdown(): HttpTimingBreakdownSummary {
  return {
    blocked: { averageMs: 2, p95Ms: 5 },
    connecting: { averageMs: 1, p95Ms: 4 },
    tlsHandshaking: { averageMs: 0, p95Ms: 0 },
    sending: { averageMs: 0.2, p95Ms: 1 },
    waiting: { averageMs: 30, p95Ms: 42 },
    receiving: { averageMs: 0.1, p95Ms: 0.5 },
  };
}

function counts(overrides: Partial<TransportAttemptCounts>): TransportAttemptCounts {
  return {
    plannedRequests: 10,
    startedRequests: 10,
    completedRequests: 10,
    interruptedRequests: 0,
    unstartedRequests: 0,
    ...overrides,
  };
}

function httpSummary(overrides: Partial<TrafficHttpSummary> = {}): TrafficHttpSummary {
  return {
    failedRequests: 0,
    acceptedResponses: 4,
    soldOutResponses: 3,
    transportFailures: 0,
    unexpectedResponses: 0,
    p95LatencyMs: 42,
    failureRate: 0,
    ...overrides,
  };
}
