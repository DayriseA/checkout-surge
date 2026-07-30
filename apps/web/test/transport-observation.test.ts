import type { TrafficHttpSummary, TransportAttemptCounts } from "@checkout-surge/contracts";
import { emptyRequestArrivalSummary } from "@checkout-surge/contracts";
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
    expect(markup).not.toContain("generator shut down before the reply arrived");
    expect(markup).not.toContain("scenario window closed before these were sent");
    expect(markup).not.toContain("Outcomes and latency");
    expect(markup).not.toContain("observed replies only");
  });

  it("discloses coverage, cause, and survivorship bias when replies went unrecorded", () => {
    const markup = renderSection(counts({ completedRequests: 7, interruptedRequests: 3 }));

    expect(markup).toContain("<meter");
    expect(markup).toContain('value="70"');
    expect(markup).toContain("70% of dispatched attempts recorded a reply");
    expect(markup).toContain("generator shut down before the reply arrived");
    expect(markup).toContain("observed replies only");
    expect(markup).toContain(
      "Outcomes and latency above cover 7 of 10 attempts. The p95 describes replies received only. Server-side totals are the authoritative record.",
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
    expect(markup).not.toContain("generator shut down before the reply arrived");
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
        httpSummary: httpSummary(),
        surface: "list",
      }),
    );

    expect(markup).toContain("Outcomes and latency cover 7 of 10 attempts.");
    expect(markup).not.toContain("the true p95 is higher");
  });

  it("discloses terminal arrival-series storage and display truncation", () => {
    const arrivalRateSeries = Array.from({ length: 15 }, (_, index) => ({
      windowStartedAt: new Date(Date.UTC(2026, 5, 20, 12, 0, index)).toISOString(),
      ratePerSecond: index + 1,
    }));
    const markup = renderToStaticMarkup(
      createElement(TransportObservationSection, {
        arrivalSummary: {
          peakArrivalRatePerSecond: 20,
          peakArrivalWindowSeconds: 1,
          dispatchDurationSeconds: 1,
          arrivalRateSeries,
          arrivalWindowCountObserved: 20,
          arrivalWindowCountRetained: 15,
          arrivalSeriesLimit: 120,
        },
        counts: counts({ completedRequests: 10 }),
        httpSummary: httpSummary(),
        surface: "detail",
      }),
    );

    expect(markup).toContain("Showing the last 12 of 15 retained windows (20 observed).");
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
    expect(markup).toContain("what k6 observed");
    expect(markup).toContain("70% of dispatched attempts recorded a reply");
    expect(markup).toContain(
      "Reply-dependent outcomes and latency cover 7 of 10 attempts. The HTTP failure rate above is a separate k6 measure and can include connection failures. Run outcomes below are the authoritative record.",
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
      httpSummary: summary,
      surface: "detail",
    }),
  );
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
