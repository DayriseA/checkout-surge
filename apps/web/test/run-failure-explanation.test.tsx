// @vitest-environment jsdom
import { emptyHttpTimingBreakdownSummary } from "@checkout-surge/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunFailureExplanation } from "../src/app/components/run-failure-explanation.js";
import type { RunFailureExplanationEvidence } from "../src/app/lib/presentation/run-failure-explanation.js";

function evidence(): RunFailureExplanationEvidence {
  return {
    failureDiagnostic: { cause: "virtual_user_limit", maxVus: 4000 },
    transportAttemptCounts: {
      plannedRequests: 30000,
      startedRequests: 27443,
      completedRequests: 27443,
      unstartedRequests: 2557,
      interruptedRequests: 0,
    },
    httpSummary: {
      acceptedResponses: 1500,
      soldOutResponses: 25943,
      unexpectedResponses: 0,
      transportFailures: 0,
      failedRequests: 0,
      failureRate: 0,
      p95LatencyMs: 14666.74,
    },
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    businessOutcomeSummary: {
      acceptedReservations: 1500,
      reservedUnits: 1500,
      soldOutRejections: 25943,
      confirmedOrders: 1500,
      notificationsRecorded: 1500,
      failedOrders: 0,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      pendingPersistenceCount: 0,
    },
  };
}
afterEach(cleanup);
describe("failure explanation", () => {
  it("leads with the established cause and lets admins open the original evidence", () => {
    const warning = "Insufficient VUs, reached 4000 active VUs and cannot initialize more";
    const input = evidence();
    input.httpTimingBreakdownSummary = {
      ...emptyHttpTimingBreakdownSummary,
      connecting: { averageMs: 0.1, p95Ms: 0.19 },
    };
    render(<RunFailureExplanation evidence={input} stderrLines={[warning]} />);
    expect(screen.getByRole("heading", { name: "Virtual user limit reached" })).toBeTruthy();
    expect(screen.getByText("2,557 planned requests were never sent.")).toBeTruthy();
    expect(screen.getByText(/8.52% shortfall/)).toBeTruthy();
    expect(screen.getByText(/All 1,500 accepted orders/)).toBeTruthy();
    const details = screen.getByText("Why this diagnosis?").closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Why this diagnosis?"));
    expect(details?.open).toBe(true);
    expect(screen.getByText(warning)).toBeTruthy();
    expect(screen.getByText("< 1 ms")).toBeTruthy();
  });
  it("preserves transport losses and unsettled business outcomes without guessing a cause", () => {
    const input = evidence();
    input.failureDiagnostic = { cause: "unidentified" };
    input.transportAttemptCounts.completedRequests -= 2;
    input.transportAttemptCounts.interruptedRequests = 2;
    input.httpSummary.transportFailures = 3;
    input.httpSummary.unexpectedResponses = 1;
    input.businessOutcomeSummary.notificationsRecorded = 1499;
    render(<RunFailureExplanation evidence={input} />);
    expect(
      screen.getByRole("heading", { name: "Traffic failed — exact cause not identified" }),
    ).toBeTruthy();
    expect(screen.queryByText(/All 1,500 accepted orders/)).toBeNull();
    expect(screen.queryByText(/All sent requests completed/)).toBeNull();
    expect(screen.getByText("3 attempts ended in transport failure.")).toBeTruthy();
    expect(screen.getByText("Unexpected responses recorded: 1.")).toBeTruthy();
    expect(screen.getByText("2 launched requests did not complete.")).toBeTruthy();
    expect(screen.queryByText("Recorded k6 output")).toBeNull();
  });
});
