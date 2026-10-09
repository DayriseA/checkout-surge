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
    expect(screen.getByText("All 1,500 accepted orders were confirmed and notified.")).toBeTruthy();
    expect(
      screen.getByText(
        "2,557 planned requests were never sent. Outcomes and latency cover only the recorded answers.",
      ),
    ).toBeTruthy();
    const details = screen.getByText("Why this diagnosis?").closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Why this diagnosis?"));
    expect(details?.open).toBe(true);
    expect(screen.getByText(warning)).toBeTruthy();
    expect(screen.getByText("< 1 ms")).toBeTruthy();
  });
  it("explains late answers the server still handled as orders", () => {
    const input = evidence();
    input.failureDiagnostic = { cause: "interrupted_requests" };
    input.transportAttemptCounts = {
      plannedRequests: 10000,
      startedRequests: 10000,
      completedRequests: 6590,
      interruptedRequests: 3410,
      unstartedRequests: 0,
    };
    input.httpSummary = { ...input.httpSummary, acceptedResponses: 6590, soldOutResponses: 0 };
    input.businessOutcomeSummary = {
      ...input.businessOutcomeSummary,
      acceptedReservations: 10000,
      reservedUnits: 10000,
      soldOutRejections: 0,
      confirmedOrders: 10000,
      notificationsRecorded: 10000,
    };
    render(<RunFailureExplanation evidence={input} />);
    expect(screen.getByRole("heading", { name: "Answers arrived too late" })).toBeTruthy();
    expect(
      screen.getByText(
        "The server needed more time than the load generator waits: 3,410 buyers were still waiting for their answer when the generator stopped listening, 30 seconds after its sending window closed.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("3,410 of 10,000 answers arrived too late (34.1%).")).toBeTruthy();
    expect(
      screen.getByText(
        "The server still handled those requests: all 10,000 orders were reserved, confirmed and notified. Only their answers came too late to be recorded. These buyers waited at least 30 seconds without an answer, so the run counts as failed.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "All 10,000 accepted orders were confirmed and notified, including those whose answer arrived too late.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Accepted orders are the slow path: each one is written to the database before the buyer gets an answer. A lower request rate or less stock lets the server answer everyone in time.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "3,410 answers arrived too late to be recorded; outcomes and latency cover only the recorded answers.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/never sent|requests completed|launched requests/)).toBeNull();
  });
  it("words a single late answer in the singular", () => {
    const input = evidence();
    input.failureDiagnostic = { cause: "interrupted_requests" };
    input.transportAttemptCounts = {
      plannedRequests: 10000,
      startedRequests: 10000,
      completedRequests: 9999,
      interruptedRequests: 1,
      unstartedRequests: 0,
    };
    input.businessOutcomeSummary = {
      ...input.businessOutcomeSummary,
      acceptedReservations: 10000,
      reservedUnits: 10000,
      confirmedOrders: 10000,
      notificationsRecorded: 10000,
    };
    render(<RunFailureExplanation evidence={input} />);
    expect(
      screen.getByText(
        "The server needed more time than the load generator waits: 1 buyer was still waiting for their answer when the generator stopped listening, 30 seconds after its sending window closed.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "The server still handled that request: all 10,000 orders were reserved, confirmed and notified. Only its answer came too late to be recorded. This buyer waited at least 30 seconds without an answer, so the run counts as failed.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "All 10,000 accepted orders were confirmed and notified, including the one whose answer arrived too late.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "1 answer arrived too late to be recorded; outcomes and latency cover only the recorded answers.",
      ),
    ).toBeTruthy();
  });
  it("does not claim the server handled late answers its own counts do not cover", () => {
    const input = evidence();
    input.failureDiagnostic = { cause: "interrupted_requests" };
    input.transportAttemptCounts = {
      plannedRequests: 10000,
      startedRequests: 9998,
      completedRequests: 7767,
      interruptedRequests: 2231,
      unstartedRequests: 2,
    };
    input.httpSummary.soldOutResponses = 6267;
    input.businessOutcomeSummary.soldOutRejections = 8498;
    render(<RunFailureExplanation evidence={input} />);
    expect(screen.getByText("2 planned requests were never sent.")).toBeTruthy();
    expect(screen.getByText("2,231 of 9,998 answers arrived too late (22.31%).")).toBeTruthy();
    expect(
      screen.getByText(
        "These buyers waited at least 30 seconds without an answer, so the run counts as failed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/The server still handled those requests/)).toBeNull();
    expect(screen.getByText("All 1,500 accepted orders were confirmed and notified.")).toBeTruthy();
    expect(
      screen.getByText(
        "2 planned requests were never sent. 2,231 answers arrived too late to be recorded; outcomes and latency cover only the recorded answers.",
      ),
    ).toBeTruthy();
  });
  it("counts interrupted requests in the shortfall of an unidentified failure", () => {
    const input = evidence();
    input.failureDiagnostic = { cause: "unidentified" };
    input.transportAttemptCounts = {
      plannedRequests: 100,
      startedRequests: 97,
      completedRequests: 93,
      interruptedRequests: 4,
      unstartedRequests: 3,
    };
    input.httpSummary = { ...input.httpSummary, acceptedResponses: 50, soldOutResponses: 43 };
    input.businessOutcomeSummary = {
      ...input.businessOutcomeSummary,
      acceptedReservations: 50,
      reservedUnits: 50,
      soldOutRejections: 43,
      confirmedOrders: 50,
      notificationsRecorded: 50,
    };
    render(<RunFailureExplanation evidence={input} />);
    expect(screen.getByText("3 planned requests were never sent.")).toBeTruthy();
    expect(screen.getByText(/93 of 100 requests completed \(7% shortfall\)/)).toBeTruthy();
    expect(screen.getByText("4 answers arrived too late to be recorded.")).toBeTruthy();
  });
  it("preserves transport losses and unsettled business outcomes without guessing a cause", () => {
    const input = evidence();
    input.failureDiagnostic = { cause: "unidentified" };
    input.transportAttemptCounts.completedRequests = 27441;
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
    expect(screen.getByText("2 answers arrived too late to be recorded.")).toBeTruthy();
    expect(screen.queryByText("Recorded k6 output")).toBeNull();
  });
});
