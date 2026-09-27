// @vitest-environment jsdom

import {
  deriveRunResult,
  type RunResultEvidence,
  type TrafficDeliveryStatus,
} from "@checkout-surge/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PublicRunConclusion } from "../src/app/components/run-conclusion.js";
import { deriveTransportObservation } from "../src/app/components/transport-observation.js";
import {
  derivePublicRunSummary,
  type PublicRunSummaryInput,
} from "../src/app/lib/presentation/public-run-summary.js";

const cleanDurable: NonNullable<RunResultEvidence["durable"]> = {
  reservedUnits: 250,
  uniqueReservations: 250,
  soldOutDecisions: 750,
  confirmedOrders: 250,
  failedOrders: 0,
  businessRejectedOrders: 0,
  technicallyFailedOrders: 0,
  queuedOrders: 0,
  processingOrders: 0,
  durablePendingPersistenceRecords: 0,
  notificationsRecorded: 250,
};

const cleanHttpSummary: NonNullable<RunResultEvidence["generator"]>["httpSummary"] = {
  failedRequests: 0,
  acceptedResponses: 250,
  soldOutResponses: 750,
  transportFailures: 0,
  unexpectedResponses: 0,
  p95LatencyMs: 42,
  failureRate: 0,
};

const cleanEvidence: RunResultEvidence = {
  runStatus: "completed",
  failureCategory: null,
  startingStock: 250,
  remainingStock: 0,
  durable: cleanDurable,
  heldReservationsAwaitingPersistence: 0,
  replayPossible: false,
  generator: {
    transportAttemptCounts: {
      plannedRequests: 1_000,
      startedRequests: 1_000,
      completedRequests: 1_000,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    httpSummary: cleanHttpSummary,
  },
};

function summaryInput(
  overrides: Partial<Omit<PublicRunSummaryInput, "result">> = {},
  evidence: RunResultEvidence = cleanEvidence,
): PublicRunSummaryInput {
  return {
    result: deriveRunResult(evidence),
    trafficDeliveryStatus: null,
    transportObservation: null,
    ...overrides,
  };
}

describe("public run summary", () => {
  it("avoids repeating explained coverage gaps while retaining unrelated missing evidence", () => {
    const evidence: RunResultEvidence = {
      ...cleanEvidence,
      runStatus: "failed",
      failureCategory: "traffic",
      generator: {
        httpSummary: cleanHttpSummary,
        transportAttemptCounts: {
          plannedRequests: 1100,
          startedRequests: 1000,
          completedRequests: 1000,
          unstartedRequests: 100,
          interruptedRequests: 0,
        },
      },
    };
    const options = { hasFailureExplanation: true, trafficDeliveryStatus: "failed" as const };
    expect(derivePublicRunSummary(summaryInput(options, evidence)).caveats).toEqual([]);
    expect(
      derivePublicRunSummary(summaryInput(options, { ...evidence, remainingStock: null })).caveats,
    ).toEqual([
      expect.objectContaining({ message: expect.stringContaining("Evidence incomplete") }),
    ]);
  });

  it("identifies unsent requests separately from missing replies", () => {
    const observation = deriveTransportObservation(
      {
        plannedRequests: 1100,
        startedRequests: 1000,
        completedRequests: 1000,
        unstartedRequests: 100,
        interruptedRequests: 0,
      },
      0,
    );
    const summary = derivePublicRunSummary(summaryInput({ transportObservation: observation }));
    expect(summary.caveats[0]?.message).toContain(
      "100 planned requests were never sent. All sent requests completed.",
    );
    expect(summary.caveats[0]?.message).not.toContain("Reply observation incomplete");
  });
  it("keeps a clean sellout free of alarms and exposes known counts", () => {
    const summary = derivePublicRunSummary(summaryInput({ trafficDeliveryStatus: "complete" }));

    expect(summary.title).toBe("Completed");
    expect(summary.sentence).toBe("All 250 available units were reserved without overselling.");
    expect(summary.counts).toEqual({
      startingStock: 250,
      remainingStock: 0,
      reservedUnits: 250,
      uniqueReservations: 250,
      soldOutDecisions: 750,
      confirmedOrders: 250,
      failedOrders: 0,
      pendingOrders: 0,
      oversoldUnits: 0,
    });
    expect(summary.caveats).toEqual([]);
    expect(summary.hasMeasurementCaveat).toBe(false);
    expect(summary.failure).toBeNull();
  });

  it("reports partial and failed delivery only when the delivery summary is supplied", () => {
    const degraded = derivePublicRunSummary(
      summaryInput({ trafficDeliveryStatus: "degraded" satisfies TrafficDeliveryStatus }),
    );
    const failed = derivePublicRunSummary(
      summaryInput({ trafficDeliveryStatus: "failed" satisfies TrafficDeliveryStatus }),
    );

    expect(degraded.caveats).toEqual([
      {
        message: "Partial delivery: not all planned checkout attempts were delivered.",
        tone: "warning",
      },
    ]);
    expect(failed.caveats).toEqual([
      {
        message: "Delivery failed: the load generator could not deliver the planned traffic.",
        tone: "danger",
      },
    ]);
  });

  it("does not turn expected duplicate-population differences into a caveat", () => {
    const summary = derivePublicRunSummary(
      summaryInput(
        {},
        {
          ...cleanEvidence,
          replayPossible: true,
          startingStock: 200,
          durable: {
            ...cleanDurable,
            reservedUnits: 200,
            uniqueReservations: 200,
            soldOutDecisions: 0,
            confirmedOrders: 200,
            notificationsRecorded: 200,
          },
          generator: {
            transportAttemptCounts: {
              plannedRequests: 400,
              startedRequests: 400,
              completedRequests: 400,
              interruptedRequests: 0,
              unstartedRequests: 0,
            },
            httpSummary: {
              failedRequests: 0,
              acceptedResponses: 400,
              soldOutResponses: 0,
              transportFailures: 0,
              unexpectedResponses: 0,
              p95LatencyMs: 42,
              failureRate: 0,
            },
          },
        },
      ),
    );

    expect(summary.title).toBe("Completed");
    expect(summary.caveats).toEqual([]);
  });

  it("keeps partial reply observation visible as an incomplete-evidence caveat", () => {
    const summary = derivePublicRunSummary(
      summaryInput(
        {},
        {
          ...cleanEvidence,
          generator: {
            transportAttemptCounts: {
              plannedRequests: 1_000,
              startedRequests: 900,
              completedRequests: 850,
              interruptedRequests: 50,
              unstartedRequests: 100,
            },
            httpSummary: {
              ...cleanHttpSummary,
              transportFailures: 0,
            },
          },
        },
      ),
    );

    expect(summary.title).toBe("Completed");
    expect(summary.caveats).toEqual([
      {
        message:
          "Evidence incomplete: some final evidence was unavailable, so the result could not be fully verified.",
        tone: "warning",
      },
    ]);
  });

  it("distinguishes incomplete from contradictory evidence and keeps a second warning visible", () => {
    const incomplete = derivePublicRunSummary(
      summaryInput({}, { ...cleanEvidence, startingStock: null, remainingStock: null }),
    );
    const contradictory = derivePublicRunSummary(
      summaryInput(
        {},
        {
          ...cleanEvidence,
          durable: {
            ...cleanDurable,
            reservedUnits: 249,
            uniqueReservations: 249,
            confirmedOrders: 249,
            notificationsRecorded: 100,
          },
        },
      ),
    );

    expect(incomplete.sentence).toBe(
      "The run outcome is indeterminate because authoritative evidence is incomplete.",
    );
    expect(contradictory.sentence).toBe(
      "The completed run has contradictory authoritative evidence: one or more invariants are broken.",
    );
    expect(contradictory.title).toBe("Result not fully verified");
    // The notification reconciliation warning stays visible behind the contradictory headline.
    expect(contradictory.caveats).toEqual([
      {
        message:
          "Reconciliation warning: some final evidence populations disagree and need investigation.",
        tone: "warning",
      },
    ]);
  });

  it("reads failed, pending and oversell orders before technical disclosure", () => {
    const orderFailures = derivePublicRunSummary(
      summaryInput(
        {},
        {
          ...cleanEvidence,
          durable: {
            ...cleanDurable,
            confirmedOrders: 200,
            failedOrders: 50,
            technicallyFailedOrders: 50,
          },
        },
      ),
    );
    const unsettled = derivePublicRunSummary(
      summaryInput(
        {},
        {
          ...cleanEvidence,
          durable: {
            ...cleanDurable,
            confirmedOrders: 200,
            queuedOrders: 30,
            processingOrders: 20,
          },
        },
      ),
    );
    const oversell = derivePublicRunSummary(
      summaryInput(
        {},
        {
          ...cleanEvidence,
          durable: { ...cleanDurable, reservedUnits: 260, uniqueReservations: 260 },
        },
      ),
    );

    expect(orderFailures.title).toBe("Completed with order failures");
    expect(orderFailures.sentence).toBe(
      "200 orders were confirmed, 0 business-rejected, 50 technically failed, and 0 remain pending.",
    );
    expect(orderFailures.counts.failedOrders).toBe(50);

    expect(unsettled.title).toBe("Completed with unsettled orders");
    expect(unsettled.sentence).toBe(
      "200 orders were confirmed, 0 business-rejected, 0 technically failed, and 50 remain pending.",
    );
    expect(unsettled.counts.pendingOrders).toBe(50);

    expect(oversell.title).toBe("Oversell detected");
    expect(oversell.sentence).toBe(
      "Durable records show 260 units reserved against 250 starting units, so 10 units were oversold.",
    );
    expect(oversell.counts.oversoldUnits).toBe(10);
  });

  it("keeps known failed and pending quantities beside headlines that omit them", () => {
    const oversellWithPending = derivePublicRunSummary(
      summaryInput(
        {},
        {
          ...cleanEvidence,
          durable: {
            ...cleanDurable,
            reservedUnits: 260,
            uniqueReservations: 260,
            confirmedOrders: 240,
            queuedOrders: 20,
          },
        },
      ),
    );
    const failedWithPending = derivePublicRunSummary(
      summaryInput(
        {},
        {
          ...cleanEvidence,
          runStatus: "failed",
          failureCategory: "traffic",
          durable: {
            ...cleanDurable,
            reservedUnits: 249,
            uniqueReservations: 249,
            confirmedOrders: 199,
            failedOrders: 50,
            technicallyFailedOrders: 50,
            queuedOrders: 10,
            notificationsRecorded: 199,
          },
        },
      ),
    );

    expect(oversellWithPending.sentence).toBe(
      "Durable records show 260 units reserved against 250 starting units, so 10 units were oversold. 240 orders were confirmed, 0 business-rejected, 0 technically failed, and 20 remain pending.",
    );
    // The failed headline already states the failed count, so only pending is appended.
    expect(failedWithPending.sentence).toBe(
      "The run failed due to a traffic failure with 50 failed orders. 10 orders remain pending.",
    );
  });

  it("keeps contradictory evidence readable beside a failure headline", () => {
    const summary = derivePublicRunSummary(
      summaryInput(
        {},
        {
          ...cleanEvidence,
          runStatus: "failed",
          failureCategory: "traffic",
          durable: {
            ...cleanDurable,
            reservedUnits: 249,
            uniqueReservations: 249,
            confirmedOrders: 199,
            failedOrders: 50,
            technicallyFailedOrders: 50,
            notificationsRecorded: 199,
          },
        },
      ),
    );

    expect(summary.title).toBe("Failed");
    expect(summary.caveats).toEqual([
      {
        message:
          "Contradictory evidence: the final stock and order records disagree, so this result needs investigation.",
        tone: "danger",
      },
      {
        message:
          "Reconciliation warning: some final evidence populations disagree and need investigation.",
        tone: "warning",
      },
    ]);
  });

  it("keeps an incomplete-evidence caveat when a contradictory headline hides a not-evaluable invariant", () => {
    const summary = derivePublicRunSummary(
      summaryInput(
        {},
        {
          ...cleanEvidence,
          heldReservationsAwaitingPersistence: 2,
          durable: {
            ...cleanDurable,
            reservedUnits: 100,
            uniqueReservations: 120,
            confirmedOrders: 100,
            notificationsRecorded: 100,
          },
        },
      ),
    );

    expect(summary.sentence).toBe(
      "The completed run has contradictory authoritative evidence: one or more invariants are broken.",
    );
    // The not-evaluable stock invariant keeps its own incomplete-evidence caveat beside the
    // contradictory headline.
    expect(summary.caveats.map((caveat) => caveat.message)).toEqual([
      "Reconciliation warning: some final evidence populations disagree and need investigation.",
      "Evidence incomplete: some final evidence was unavailable, so the result could not be fully verified.",
    ]);
  });

  it("qualifies incomplete reply observation even when delivery status is complete", () => {
    const summary = derivePublicRunSummary(
      summaryInput({
        trafficDeliveryStatus: "complete",
        transportObservation: deriveTransportObservation(
          {
            plannedRequests: 20,
            startedRequests: 20,
            completedRequests: 20,
            interruptedRequests: 0,
            unstartedRequests: 0,
          },
          3,
        ),
      }),
    );

    expect(summary.caveats).toEqual([
      {
        message: "Reply observation incomplete: outcomes and latency cover 17 of 20 attempts.",
        tone: "warning",
      },
    ]);
    expect(summary.hasMeasurementCaveat).toBe(true);
  });

  it("exposes the public failure explanation for a failed run and never fakes zero stock", () => {
    const failed = derivePublicRunSummary(
      summaryInput(
        {},
        {
          ...cleanEvidence,
          runStatus: "failed",
          failureCategory: "traffic",
          startingStock: null,
          remainingStock: null,
          generator: null,
        },
      ),
    );

    expect(failed.title).toBe("Failed");
    expect(failed.failure).toEqual({
      explanation:
        "The load generator could not deliver the planned traffic, so this run's evidence is incomplete.",
      action: "Start a new run to try again.",
    });
    expect(failed.counts.startingStock).toBeNull();
    expect(failed.sentence).toBe("The run failed due to a traffic failure.");
  });
});

describe("public run conclusion", () => {
  afterEach(cleanup);

  // Transport failures count as completed attempts in the canonical result, so a run can read as
  // "complete" while replies are missing — exactly what the reply caveat must qualify.
  const interruptedReplies = deriveTransportObservation(
    {
      plannedRequests: 20,
      startedRequests: 20,
      completedRequests: 20,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    3,
  );

  function renderConclusion(
    evidence: RunResultEvidence = cleanEvidence,
    overrides: Partial<Omit<PublicRunSummaryInput, "result">> = {},
  ) {
    return render(
      <PublicRunConclusion
        result={deriveRunResult(evidence)}
        runStatus={evidence.runStatus}
        trafficDeliveryStatus={overrides.trafficDeliveryStatus ?? null}
        transportObservation={overrides.transportObservation ?? null}
      />,
    );
  }

  function innermostByText(container: HTMLElement, needle: string): HTMLElement | null {
    const match = [...container.querySelectorAll("*")].find(
      (element) =>
        element.textContent?.includes(needle) &&
        ![...element.children].some((child) => child.textContent?.includes(needle)),
    );
    return (match as HTMLElement) ?? null;
  }

  function expectVisible(container: HTMLElement, needle: string): void {
    const element = innermostByText(container, needle);
    expect(element).not.toBeNull();
    expect(element?.closest("[hidden]")).toBeNull();
  }

  it("renders the visible summary and caveats", () => {
    const overrides = {
      trafficDeliveryStatus: "degraded" as TrafficDeliveryStatus,
      transportObservation: interruptedReplies,
    };

    const { container } = renderConclusion(cleanEvidence, overrides);
    expectVisible(container, "Completed");
    expectVisible(container, "All 250 available units were reserved without overselling.");
    expectVisible(container, "Partial delivery: not all planned checkout attempts were delivered.");
    expectVisible(
      container,
      "Reply observation incomplete: outcomes and latency cover 17 of 20 attempts.",
    );
  });

  it("keeps the full proof visible", () => {
    const { container } = renderConclusion();
    expect(container.querySelector('[tabindex="-1"]')).not.toBeNull();
    for (const marker of [
      "reserved units = starting stock − remaining stock",
      "Evidence and reconciliation proof",
    ]) {
      expectVisible(container, marker);
    }
    expectVisible(container, "Checkout-Surge recorded 750 sold-out rejections");
  });
});
