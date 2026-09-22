import { describe, expect, it } from "vitest";
import {
  businessOutcomeSummarySchema,
  demoRunSnapshotSchema,
  startDemoRunResponseSchema,
} from "../src/demo.js";
import { demoRunSummaryShapeSchema } from "../src/entities.js";
import {
  deriveRunResult,
  internalRunFailureReasonValues,
  isReplayPossible,
  type RunResultEvidence,
  toPublicRunFailureCategory,
} from "../src/run-result.js";
import { previewRunConfigSnapshotFixture } from "../src/testing.js";
import type { TransportAttemptCounts } from "../src/traffic-transport-counts.js";

type DurableEvidence = NonNullable<RunResultEvidence["durable"]>;

function evidence(): RunResultEvidence & { durable: DurableEvidence };
function evidence(overrides: Partial<RunResultEvidence>): RunResultEvidence;
function evidence(overrides: Partial<RunResultEvidence> = {}): RunResultEvidence {
  return {
    runStatus: "completed",
    failureCategory: null,
    startingStock: 10,
    remainingStock: 0,
    durable: {
      reservedUnits: 10,
      uniqueReservations: 10,
      soldOutDecisions: 3,
      confirmedOrders: 10,
      failedOrders: 0,
      queuedOrders: 0,
      processingOrders: 0,
      durablePendingPersistenceRecords: 0,
      notificationsRecorded: 10,
    },
    heldReservationsAwaitingPersistence: 0,
    replayPossible: false,
    generator: null,
    ...overrides,
  };
}

describe("deriveRunResult", () => {
  it("holds the unit, order, and oversell invariants for a clean sellout", () => {
    const result = deriveRunResult(evidence());
    expect(result.outcome).toBe("completed-successfully");
    expect(result.invariants.every((item) => item.status === "holds")).toBe(true);
  });

  it("reports oversell as a correctness failure", () => {
    const result = deriveRunResult(
      evidence({
        durable: { ...evidence().durable, reservedUnits: 11 },
      }),
    );
    expect(result.outcome).toBe("completed-with-oversell");
    expect(result.maximumClassification).toBe("correctness_failure");
  });

  it("gives a failed run precedence over oversell and indeterminate evidence", () => {
    const result = deriveRunResult(
      evidence({
        runStatus: "failed",
        failureCategory: "traffic",
        remainingStock: null,
        durable: { ...evidence().durable, reservedUnits: 11 },
      }),
    );

    expect(result.outcome).toBe("failed");
    expect(result.failureCategory).toBe("traffic");
  });

  it("marks each authoritative invariant as broken when its equation disagrees", () => {
    const stock = deriveRunResult(
      evidence({
        durable: { ...evidence().durable, reservedUnits: 9 },
      }),
    );
    expect(stock.invariants.find((item) => item.name === "stock")?.status).toBe("broken");
    expect(stock.outcome).toBe("outcome-indeterminate");

    const orders = deriveRunResult(
      evidence({
        durable: { ...evidence().durable, queuedOrders: 1 },
      }),
    );
    expect(orders.invariants.find((item) => item.name === "orders")?.status).toBe("broken");
    expect(orders.pendingOrders).toBe(1);
    expect(orders.outcome).toBe("outcome-indeterminate");
  });

  it("lets oversell outrank missing remaining stock and order failures", () => {
    const result = deriveRunResult(
      evidence({
        remainingStock: null,
        durable: {
          ...evidence().durable,
          reservedUnits: 11,
          failedOrders: 1,
          confirmedOrders: 8,
          queuedOrders: 1,
        },
      }),
    );
    expect(result.outcome).toBe("completed-with-oversell");
    expect(result.invariants.find((item) => item.name === "stock")?.status).toBe("not_evaluable");
  });

  it("does not claim success while Redis holds await persistence", () => {
    const result = deriveRunResult(
      evidence({
        heldReservationsAwaitingPersistence: 1,
        durable: { ...evidence().durable, durablePendingPersistenceRecords: 1 },
      }),
    );
    expect(result.invariants[0]?.status).toBe("not_evaluable");
    expect(result.maximumClassification).toBe("evidence_incomplete");
  });

  it("warns when Redis and PostgreSQL pending-persistence counts disagree", () => {
    const result = deriveRunResult(
      evidence({
        heldReservationsAwaitingPersistence: 1,
        durable: { ...evidence().durable, durablePendingPersistenceRecords: 0 },
      }),
    );
    expect(
      result.reconciliations.find((item) => item.code === "pending_persistence_evidence_mismatch")
        ?.classification,
    ).toBe("warning");
  });

  it("uses reserved units rather than reservation rows for a multi-unit sellout", () => {
    const result = deriveRunResult(
      evidence({
        startingStock: 12,
        remainingStock: 0,
        durable: {
          ...evidence().durable,
          reservedUnits: 12,
          uniqueReservations: 4,
          confirmedOrders: 4,
          soldOutDecisions: 2,
        },
      }),
    );
    expect(result.outcome).toBe("completed-successfully");
    expect(result.invariants.map((item) => item.status)).toEqual(["holds", "holds", "holds"]);
    expect(result.oversoldUnits).toBe(0);
  });

  it("ranks order failures and unsettled orders after oversell", () => {
    const failed = deriveRunResult(
      evidence({
        durable: {
          ...evidence().durable,
          confirmedOrders: 8,
          failedOrders: 2,
        },
      }),
    );
    expect(failed.outcome).toBe("completed-with-order-failures");

    const pending = deriveRunResult(
      evidence({
        durable: {
          ...evidence().durable,
          confirmedOrders: 8,
          queuedOrders: 2,
        },
      }),
    );
    expect(pending.outcome).toBe("completed-with-unsettled-orders");

    const oversold = deriveRunResult(
      evidence({
        durable: {
          ...evidence().durable,
          reservedUnits: 11,
          confirmedOrders: 8,
          failedOrders: 1,
          queuedOrders: 1,
        },
      }),
    );
    expect(oversold.outcome).toBe("completed-with-oversell");
  });

  it.each([
    { name: "missing terminal stock", startingStock: null, remainingStock: null },
    { name: "missing durable business evidence", durable: null },
    { name: "pending Redis persistence", heldReservationsAwaitingPersistence: 1 },
  ])("returns indeterminate for $name", (overrides) => {
    const result = deriveRunResult(evidence(overrides));
    expect(result.outcome).toBe("outcome-indeterminate");
  });

  it("classifies replay responses as expected, but non-replay excess as a warning", () => {
    const generator = completeGenerator({ acceptedResponses: 6 });
    const replay = deriveRunResult(
      evidence({
        replayPossible: true,
        generator,
        durable: { ...evidence().durable, uniqueReservations: 4 },
      }),
    );
    expect(
      replay.reconciliations.find(
        (item) => item.code === "accepted_responses_vs_unique_reservations",
      )?.classification,
    ).toBe("expected_population_difference");

    const mismatch = deriveRunResult(
      evidence({
        replayPossible: false,
        generator,
        durable: { ...evidence().durable, uniqueReservations: 4 },
      }),
    );
    expect(
      mismatch.reconciliations.find(
        (item) => item.code === "accepted_responses_vs_unique_reservations",
      )?.classification,
    ).toBe("warning");

    const underreported = deriveRunResult(
      evidence({
        generator: completeGenerator({ acceptedResponses: 3 }),
        durable: { ...evidence().durable, uniqueReservations: 4 },
      }),
    );
    expect(
      underreported.reconciliations.find(
        (item) => item.code === "accepted_responses_vs_unique_reservations",
      )?.classification,
    ).toBe("warning");
  });

  it("keeps replay possible true when duplicate delivery is incomplete", () => {
    const config = {
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 200,
        duplicateEachBuyerAttempt: true,
      },
    };
    expect(isReplayPossible(config)).toBe(true);

    const result = deriveRunResult(
      evidence({
        replayPossible: true,
        generator: completeGenerator({
          acceptedResponses: 100,
          transportAttemptCounts: {
            plannedRequests: 400,
            startedRequests: 399,
            completedRequests: 399,
            interruptedRequests: 0,
            unstartedRequests: 1,
          },
        }),
        durable: { ...evidence().durable, uniqueReservations: 50 },
      }),
    );

    expect(
      result.reconciliations.find(
        (item) => item.code === "accepted_responses_vs_unique_reservations",
      )?.classification,
    ).toBe("evidence_incomplete");
  });

  it("marks interrupted generator coverage as incomplete", () => {
    const result = deriveRunResult(
      evidence({
        generator: completeGenerator({
          transportAttemptCounts: {
            plannedRequests: 10,
            startedRequests: 10,
            completedRequests: 9,
            interruptedRequests: 1,
            unstartedRequests: 0,
          },
        }),
      }),
    );
    expect(
      result.reconciliations.find((item) => item.code === "partial_generator_coverage")
        ?.classification,
    ).toBe("evidence_incomplete");
  });

  it("reports sold-out decisions with stock remaining as a warning", () => {
    const result = deriveRunResult(
      evidence({
        startingStock: 10,
        remainingStock: 2,
        durable: { ...evidence().durable, reservedUnits: 8, soldOutDecisions: 1 },
      }),
    );
    expect(
      result.reconciliations.find((item) => item.code === "sold_out_with_stock_remaining")
        ?.classification,
    ).toBe("warning");
  });

  it.each([
    {
      name: "fewer observed responses",
      generator: completeGenerator({ soldOutResponses: 2 }),
      classification: "expected_population_difference",
      reason: "Observed replies and durable decisions are separate populations.",
    },
    {
      name: "equal observed responses",
      generator: completeGenerator({ soldOutResponses: 3 }),
      classification: "expected_population_difference",
      reason: "Observed replies and durable decisions are separate populations.",
    },
    {
      name: "more observed responses",
      generator: completeGenerator({ soldOutResponses: 4 }),
      classification: "warning",
      reason: "Observed sold-out replies exceed recorded server decisions.",
    },
    {
      name: "partial generator coverage",
      generator: completeGenerator({
        acceptedResponses: 5,
        soldOutResponses: 4,
        transportAttemptCounts: {
          plannedRequests: 10,
          startedRequests: 10,
          completedRequests: 9,
          interruptedRequests: 1,
          unstartedRequests: 0,
        },
      }),
      classification: "evidence_incomplete",
      incompleteReason: "partial",
    },
  ] as const)("classifies $name sold-out evidence", (example) => {
    const result = deriveRunResult(
      evidence({
        generator: example.generator,
      }),
    );
    expect(
      result.reconciliations.find((item) => item.code === "sold_out_decisions_vs_responses"),
    ).toMatchObject({
      classification: example.classification,
      ...(example.reason ? { reason: example.reason } : {}),
      ...(example.incompleteReason ? { incompleteReason: example.incompleteReason } : {}),
    });
  });

  it("keeps failed start responses category-only at the public contract boundary", () => {
    const failedRun = {
      runId: "11111111-1111-4111-8111-111111111111",
      presetId: "22222222-2222-4222-8222-222222222222",
      presetName: "Preview 1k",
      operatorMode: "public",
      configSnapshot: previewRunConfigSnapshotFixture(),
      startedAt: "2026-06-20T12:00:00.000Z",
      status: "failed",
      trafficStatus: "failed",
      finalizedAt: "2026-06-20T12:00:01.000Z",
      failureCategory: "traffic",
    } as const;
    expect(demoRunSnapshotSchema.safeParse(failedRun).success).toBe(true);
    expect(
      demoRunSnapshotSchema.safeParse({ ...failedRun, failureReason: "traffic_failed" }).success,
    ).toBe(false);
    expect(
      startDemoRunResponseSchema.safeParse({
        run: failedRun,
        recovery: { establishedAt: "2026-06-20T12:00:01.000Z" },
        correlationId: "contract-test",
        timestamp: "2026-06-20T12:00:01.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects missing unit evidence at the business-summary boundary", () => {
    const valid = {
      acceptedReservations: 1,
      reservedUnits: 1,
      soldOutRejections: 0,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 1,
      failedOrders: 0,
      pendingPersistenceCount: 0,
      notificationsRecorded: 1,
    };
    expect(businessOutcomeSummarySchema.safeParse(valid).success).toBe(true);
    const { reservedUnits: _reservedUnits, ...missing } = valid;
    expect(businessOutcomeSummarySchema.safeParse(missing).success).toBe(false);
  });

  it("rejects a summary missing required replayPossible", () => {
    const valid = {
      id: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      presetName: "Preview 1k",
      status: "completed",
      replayPossible: false,
      endedAt: "2026-06-20T12:00:00.000Z",
      transportAttemptCounts: {},
      httpSummary: {},
      trafficDeliverySummary: {},
      businessOutcomeSummary: {},
      capturedAt: "2026-06-20T12:00:00.000Z",
    } as const;

    expect(demoRunSummaryShapeSchema.safeParse(valid).success).toBe(true);
    const { replayPossible: _replayPossible, ...missing } = valid;
    expect(demoRunSummaryShapeSchema.safeParse(missing).success).toBe(false);
  });

  it("maps every persisted failure reason to a bounded public category", () => {
    for (const reason of internalRunFailureReasonValues) {
      expect(["traffic", "inventory", "operator", "automatic_reset"]).toContain(
        toPublicRunFailureCategory(reason),
      );
    }
  });
});

function completeGenerator(
  overrides: {
    acceptedResponses?: number;
    soldOutResponses?: number;
    transportAttemptCounts?: TransportAttemptCounts;
  } = {},
): NonNullable<RunResultEvidence["generator"]> {
  return {
    transportAttemptCounts: overrides.transportAttemptCounts ?? {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: overrides.acceptedResponses ?? 10,
      soldOutResponses: overrides.soldOutResponses ?? 3,
      transportFailures: 0,
      unexpectedResponses: 0,
      p95LatencyMs: 42,
      failureRate: 0,
    },
  };
}
