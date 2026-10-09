import {
  type DashboardProjection,
  dashboardProjectionSchema,
  dashboardProjectionSchemaName,
  dashboardProjectionScopeId,
  demoRunSnapshotSchema,
  deriveRunResult,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  emptyServerReservationTimingSummary,
  type PublicRunHistoryDetailResponse,
  publicRunHistoryDetailResponseSchema,
  publicRunHistorySummarySchema,
  type RunHistorySummary,
  type RunResultEvidence,
  runHistorySummarySchema,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunConclusion } from "../src/app/components/run-conclusion.js";
import {
  evidenceFromDashboard,
  evidenceFromRunHistoryDetail,
  evidenceFromRunHistorySummary,
  runConclusionSentence,
} from "../src/app/lib/presentation/run-result-presentation.js";

const runId = "11111111-1111-4111-8111-111111111111";
const saleOfferId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-07-30T12:00:00.000Z";

const cleanDurable: NonNullable<RunResultEvidence["durable"]> = {
  reservedUnits: 250,
  uniqueReservations: 250,
  soldOutDecisions: 750,
  confirmedOrders: 250,
  failedOrders: 0,
  queuedOrders: 0,
  processingOrders: 0,
  durablePendingPersistenceRecords: 0,
  notificationsRecorded: 250,
};

const cleanEvidence: RunResultEvidence = {
  runStatus: "completed",
  failureCategory: null,
  startingStock: 250,
  remainingStock: 0,
  durable: cleanDurable,
  heldReservationsAwaitingPersistence: 0,
  replayPossible: false,
  generator: completeGenerator(),
};

describe("run result presentation", () => {
  it.each([
    {
      name: "clean sellout",
      evidence: cleanEvidence,
      sentence:
        "All 250 available units were reserved without overselling. Checkout-Surge recorded 750 sold-out rejections. The orders for all 250 reservations were confirmed, with no failed orders.",
    },
    {
      name: "stock remaining",
      evidence: withEvidence({
        startingStock: 250,
        remainingStock: 100,
        durable: {
          reservedUnits: 150,
          uniqueReservations: 150,
          soldOutDecisions: 0,
          confirmedOrders: 150,
        },
      }),
      sentence:
        "150 units were reserved from 250, and 100 units remain. No units were oversold. The orders for all 150 reservations were confirmed, with no failed orders.",
    },
    {
      name: "order failures",
      evidence: withEvidence({
        durable: { confirmedOrders: 200, failedOrders: 50 },
      }),
      sentence:
        "All 250 available units were reserved without overselling. Checkout-Surge recorded 750 sold-out rejections. 200 orders were confirmed, 50 failed, and 0 remain pending.",
    },
    {
      name: "pending outcomes",
      evidence: withEvidence({
        durable: { confirmedOrders: 200, queuedOrders: 30, processingOrders: 20 },
      }),
      sentence:
        "All 250 available units were reserved without overselling. Checkout-Surge recorded 750 sold-out rejections. 200 orders were confirmed, 0 failed, and 50 remain pending.",
    },
    {
      name: "oversell",
      evidence: withEvidence({ durable: { reservedUnits: 260, uniqueReservations: 260 } }),
      sentence:
        "Durable records show 260 units reserved against 250 starting units, so 10 units were oversold. Checkout-Surge recorded 750 sold-out rejections. Order outcomes: 250 confirmed, 0 failed, and 0 pending.",
    },
    {
      name: "partial generator observation",
      evidence: withEvidence({
        generator: completeGenerator({
          transportAttemptCounts: {
            plannedRequests: 1_000,
            startedRequests: 900,
            completedRequests: 850,
            interruptedRequests: 50,
            unstartedRequests: 100,
          },
        }),
      }),
      sentence:
        "All 250 available units were reserved without overselling. Checkout-Surge recorded 750 sold-out rejections. The orders for all 250 reservations were confirmed, with no failed orders.",
    },
    {
      name: "missing terminal snapshot",
      evidence: withEvidence({ startingStock: null, remainingStock: null }),
      sentence: "The run outcome is indeterminate because authoritative evidence is incomplete.",
    },
    {
      name: "failed category",
      evidence: withEvidence({
        runStatus: "failed",
        failureCategory: "traffic",
        durable: { reservedUnits: 260 },
      }),
      sentence:
        "The load generator could not deliver the planned traffic, so this run's evidence is incomplete.",
    },
    {
      name: "provider capacity failure",
      evidence: withEvidence({
        runStatus: "failed",
        failureCategory: "provider_capacity",
        durable: { reservedUnits: 0 },
      }),
      sentence:
        "The hosting provider (Fly.io) had no room for the load generator, so no traffic was sent.",
    },
    {
      name: "load generator that did not start",
      evidence: withEvidence({
        runStatus: "failed",
        failureCategory: "not_started",
        durable: { reservedUnits: 0 },
      }),
      sentence: "The load generator could not be started, so no traffic was sent.",
    },
    {
      name: "failure with one failed order",
      evidence: withEvidence({
        runStatus: "failed",
        failureCategory: "traffic",
        durable: { failedOrders: 1 },
      }),
      sentence:
        "The load generator could not deliver the planned traffic, so this run's evidence is incomplete. 1 order failed.",
    },
    {
      name: "single-unit sellout",
      evidence: withEvidence({
        startingStock: 1,
        remainingStock: 0,
        durable: {
          reservedUnits: 1,
          uniqueReservations: 1,
          soldOutDecisions: 1,
          confirmedOrders: 1,
          notificationsRecorded: 1,
        },
      }),
      sentence:
        "The only available unit was reserved without overselling. Checkout-Surge recorded 1 sold-out rejection. The order for the only reservation was confirmed, with no failed orders.",
    },
    {
      name: "one unit left",
      evidence: withEvidence({
        startingStock: 2,
        remainingStock: 1,
        durable: {
          reservedUnits: 1,
          uniqueReservations: 1,
          soldOutDecisions: 0,
          confirmedOrders: 1,
          notificationsRecorded: 1,
        },
      }),
      sentence:
        "1 unit was reserved from 2, and 1 unit remains. No units were oversold. The order for the only reservation was confirmed, with no failed orders.",
    },
  ] as const)("states $name", ({ evidence, sentence }) => {
    expect(runConclusionSentence(deriveRunResult(evidence))).toBe(sentence);
  });

  it("reports failed orders", () => {
    const result = deriveRunResult({
      ...cleanEvidence,
      durable: {
        ...cleanDurable,
        confirmedOrders: 247,
        failedOrders: 3,
        notificationsRecorded: 247,
      },
    });

    expect(runConclusionSentence(result)).toContain(
      "247 orders were confirmed, 3 failed, and 0 remain pending.",
    );
  });

  it("uses units, not reservation rows, for a multi-unit clean sellout", () => {
    const result = deriveRunResult(
      withEvidence({
        startingStock: 12,
        remainingStock: 0,
        durable: {
          reservedUnits: 12,
          uniqueReservations: 4,
          confirmedOrders: 4,
          soldOutDecisions: 2,
          notificationsRecorded: 4,
        },
      }),
    );

    expect(runConclusionSentence(result)).toContain("All 12 available units were reserved");
  });

  it("keeps durable sold-out rejections distinct from generator responses", () => {
    const sentence = runConclusionSentence(deriveRunResult(cleanEvidence));
    expect(sentence).toContain("Checkout-Surge recorded 750 sold-out rejections");
    expect(sentence).toContain("no failed orders");
    expect(sentence).not.toContain("sold-out responses");
  });

  it("states unsettled orders even when some orders failed", () => {
    const result = deriveRunResult(
      withEvidence({
        durable: {
          uniqueReservations: 260,
          confirmedOrders: 200,
          failedOrders: 50,
          queuedOrders: 10,
        },
      }),
    );

    expect(result.outcome).toBe("completed-with-order-failures");
    expect(runConclusionSentence(result)).toContain(
      "200 orders were confirmed, 50 failed, and 10 remain pending.",
    );
  });

  it("summarizes contradictory completed evidence as broken invariants", () => {
    const evidence = withEvidence({ durable: { reservedUnits: 249 } });
    const result = deriveRunResult(evidence);

    expect(runConclusionSentence(result)).toBe(
      "The completed run has contradictory authoritative evidence: one or more invariants are broken.",
    );
  });

  it.each([
    [
      "pending persistence",
      withEvidence({ heldReservationsAwaitingPersistence: 1 }),
      "pending_persistence",
      "Inventory reservations can precede durable checkout records.",
    ],
    [
      "pending mismatch",
      withEvidence({ heldReservationsAwaitingPersistence: 1 }),
      "pending_persistence_evidence_mismatch",
      "Live reservations and durable pending records differ.",
    ],
    [
      "accepted without replay",
      cleanEvidence,
      "accepted_responses_vs_unique_reservations",
      "Accepted checkout responses and unique reservations measure different stages of the run.",
    ],
    [
      "accepted with replay",
      withEvidence({
        replayPossible: true,
        generator: completeGenerator({ acceptedResponses: 251 }),
      }),
      "accepted_responses_vs_unique_reservations",
      "Some accepted responses may repeat an existing reservation.",
    ],
    [
      "accepted evidence unavailable",
      { ...cleanEvidence, durable: null },
      "accepted_responses_vs_unique_reservations",
      "The durable reservation count is not available for comparison.",
    ],
    [
      "accepted warning",
      withEvidence({ generator: completeGenerator({ acceptedResponses: 249 }) }),
      "accepted_responses_vs_unique_reservations",
      null,
    ],
    [
      "accepted partial",
      withEvidence({ generator: partialGenerator() }),
      "accepted_responses_vs_unique_reservations",
      "The load generator did not record an answer for every planned request, so its count cannot match the server&#x27;s.",
    ],
    [
      "sold out expected",
      cleanEvidence,
      "sold_out_decisions_vs_responses",
      "Load-generator reply observations and durable rejection records are separate populations.",
    ],
    [
      "sold out warning",
      withEvidence({ generator: completeGenerator({ soldOutResponses: 751 }) }),
      "sold_out_decisions_vs_responses",
      "Sold-out rejections seen by the load generator exceed durable sold-out rejections.",
    ],
    [
      "sold out evidence unavailable",
      { ...cleanEvidence, durable: null },
      "sold_out_decisions_vs_responses",
      "Durable sold-out rejection evidence is unavailable.",
    ],
    [
      "sold out partial",
      withEvidence({ generator: partialGenerator() }),
      "sold_out_decisions_vs_responses",
      null,
    ],
    [
      "partial generator coverage",
      withEvidence({ generator: partialGenerator() }),
      "partial_generator_coverage",
      "Only attempts that reached a response are included in the load-generator evidence.",
    ],
    [
      "generator unavailable",
      withEvidence({ generator: null }),
      "generator_evidence_unavailable",
      "Load-generator evidence is unavailable.",
    ],
    [
      "sold out with stock",
      withEvidence({ remainingStock: 1, durable: { reservedUnits: 249 } }),
      "sold_out_with_stock_remaining",
      "Sold-out rejections while stock remained need investigation.",
    ],
    [
      "notifications below confirmations",
      withEvidence({ durable: { notificationsRecorded: 249 } }),
      "notifications_below_confirmations",
      "Not every confirmed order has a recorded simulated email.",
    ],
  ] as const)("presents $0 reconciliation", (_name, evidence, code, sentence) => {
    const markup = renderToStaticMarkup(
      createElement(RunConclusion, {
        result: deriveRunResult(evidence),
        runStatus: "completed",
        showCanonicalCodes: true,
      }),
    );
    const row = markup
      .match(/<p class="m-0 text-muted">.*?<\/p>/g)
      ?.find((item) => item.includes(`<code>${code}</code>`));

    expect(row).toBeDefined();
    expect(row?.split(" — ")[1] ?? null).toBe(sentence ? `${sentence}</p>` : null);
  });

  it("fails closed for unexpected reconciliation populations", () => {
    const result = deriveRunResult(cleanEvidence);
    const accepted = result.reconciliations[0];
    const soldOut = result.reconciliations[1];
    if (!accepted || !soldOut) throw new Error("Expected reconciliation fixtures.");
    const tainted: typeof result = {
      ...result,
      reconciliations: [
        {
          ...accepted,
          leftPopulation: "UNSAFE ACCEPTED POPULATION",
          rightPopulation: "UNSAFE RESERVATION POPULATION",
        },
        {
          ...soldOut,
          leftPopulation: "UNSAFE SOLD OUT POPULATION",
          rightPopulation: "UNSAFE DECISION POPULATION",
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(RunConclusion, { result: tainted, runStatus: "completed" }),
    );

    expect(markup).not.toContain("UNSAFE");
  });

  it("renders nothing for a draining lifecycle even when given a derived result", () => {
    const result = deriveRunResult(withEvidence({ runStatus: "draining" }));
    const markup = renderToStaticMarkup(
      createElement(RunConclusion, { result, runStatus: "draining" }),
    );

    expect(markup).toBe("");
  });

  it("states confirmations neutrally when they exceed starting stock", () => {
    const sentence = runConclusionSentence(
      deriveRunResult(
        withEvidence({
          durable: {
            reservedUnits: 255,
            uniqueReservations: 255,
            confirmedOrders: 255,
            notificationsRecorded: 255,
          },
        }),
      ),
    );

    expect(sentence).toContain("Order outcomes: 255 confirmed, 0 failed, and 0 pending.");
    expect(sentence).not.toContain("All 255");
  });

  it("keeps idempotent replay out of oversell and corruption copy", () => {
    const result = deriveRunResult(
      withEvidence({
        startingStock: 200,
        durable: {
          reservedUnits: 200,
          uniqueReservations: 200,
          soldOutDecisions: 0,
          confirmedOrders: 200,
          notificationsRecorded: 200,
        },
        replayPossible: true,
        generator: completeGenerator({
          acceptedResponses: 400,
          soldOutResponses: 0,
          transportAttemptCounts: {
            plannedRequests: 400,
            startedRequests: 400,
            completedRequests: 400,
            interruptedRequests: 0,
            unstartedRequests: 0,
          },
        }),
      }),
    );
    const sentence = runConclusionSentence(result).toLowerCase();
    const markup = renderToStaticMarkup(
      createElement(RunConclusion, { result, runStatus: "completed" }),
    );
    expect(sentence).not.toContain("oversold");
    expect(sentence).not.toContain("corruption");
    expect(markup).toContain("accepted responses observed by the load generator");
    expect(markup).toContain("(400) vs Unique reservations secured (200)");
    expect(markup).toContain("expected population difference");
    expect(markup).toContain("Some accepted responses may repeat an existing reservation.");
  });

  it("groups six-figure narrative counts instead of rendering a digit wall", () => {
    // Stock is operator-editable and order/decision counts are bounded by `maxTotalRequests`,
    // whose shipped default is 100,000.
    const result = deriveRunResult(
      withEvidence({
        startingStock: 100_000,
        remainingStock: 0,
        durable: {
          reservedUnits: 100_000,
          uniqueReservations: 100_000,
          soldOutDecisions: 250_000,
          confirmedOrders: 100_000,
          notificationsRecorded: 100_000,
        },
        generator: {
          transportAttemptCounts: {
            plannedRequests: 350_000,
            startedRequests: 350_000,
            completedRequests: 350_000,
            interruptedRequests: 0,
            unstartedRequests: 0,
          },
          httpSummary: {
            failedRequests: 0,
            acceptedResponses: 100_000,
            soldOutResponses: 250_000,
            transportFailures: 0,
            unexpectedResponses: 0,
            p95LatencyMs: 42,
            failureRate: 0,
          },
        },
      }),
    );

    const sentence = runConclusionSentence(result);

    expect(result.outcome).toBe("completed-successfully");
    expect(sentence).toBe(
      "All 100,000 available units were reserved without overselling. Checkout-Surge recorded 250,000 sold-out rejections. The orders for all 100,000 reservations were confirmed, with no failed orders.",
    );
    expect(sentence).not.toContain("100000");
    expect(sentence).not.toContain("250000");
  });

  it("groups six-figure order counts in the failed and unsettled narratives", () => {
    const orderFailures = runConclusionSentence(
      deriveRunResult(
        withEvidence({
          startingStock: 500_000,
          remainingStock: 0,
          durable: {
            reservedUnits: 500_000,
            uniqueReservations: 500_000,
            soldOutDecisions: 250_000,
            confirmedOrders: 100_000,
            failedOrders: 250_000,
            queuedOrders: 150_000,
            notificationsRecorded: 100_000,
          },
          generator: {
            transportAttemptCounts: {
              plannedRequests: 750_000,
              startedRequests: 750_000,
              completedRequests: 750_000,
              interruptedRequests: 0,
              unstartedRequests: 0,
            },
            httpSummary: {
              failedRequests: 0,
              acceptedResponses: 500_000,
              soldOutResponses: 250_000,
              transportFailures: 0,
              unexpectedResponses: 0,
              p95LatencyMs: 42,
              failureRate: 0,
            },
          },
        }),
      ),
    );
    const failedRun = runConclusionSentence(
      deriveRunResult(withEvidence({ runStatus: "failed", durable: { failedOrders: 100_000 } })),
    );

    expect(orderFailures).toContain(
      "100,000 orders were confirmed, 250,000 failed, and 150,000 remain pending.",
    );
    expect(failedRun).toContain("100,000 orders failed.");
  });

  it("produces the same sentence through dashboard, history, and detail adapters", () => {
    const dashboard = evidenceFromDashboard(dashboardFixture(cleanEvidence));
    const summary = evidenceFromRunHistorySummary(summaryFixture(cleanEvidence));
    const detail = evidenceFromRunHistoryDetail(detailFixture(cleanEvidence));
    const sentences = [dashboard, summary, detail].map((evidence) =>
      runConclusionSentence(deriveRunResult(evidence)),
    );

    expect(dashboard).toEqual(cleanEvidence);
    expect(summary).toEqual(cleanEvidence);
    expect(detail).toEqual(cleanEvidence);
    expect(sentences[0]).toBe(sentences[1]);
    expect(sentences[1]).toBe(sentences[2]);
  });
});

function withEvidence(
  overrides: {
    runStatus?: RunResultEvidence["runStatus"];
    failureCategory?: RunResultEvidence["failureCategory"];
    startingStock?: number | null;
    remainingStock?: number | null;
    heldReservationsAwaitingPersistence?: number | null;
    replayPossible?: boolean | null;
    durable?: Partial<NonNullable<RunResultEvidence["durable"]>>;
    generator?: RunResultEvidence["generator"];
  } = {},
): RunResultEvidence {
  return {
    ...cleanEvidence,
    ...overrides,
    durable: {
      ...cleanDurable,
      ...overrides.durable,
    },
  };
}

function completeGenerator(
  overrides: {
    acceptedResponses?: number;
    soldOutResponses?: number;
    transportAttemptCounts?: NonNullable<RunResultEvidence["generator"]>["transportAttemptCounts"];
  } = {},
): NonNullable<RunResultEvidence["generator"]> {
  return {
    transportAttemptCounts: overrides.transportAttemptCounts ?? {
      plannedRequests: 1_000,
      startedRequests: 1_000,
      completedRequests: 1_000,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: overrides.acceptedResponses ?? 250,
      soldOutResponses: overrides.soldOutResponses ?? 750,
      transportFailures: 0,
      unexpectedResponses: 0,
      p95LatencyMs: 42,
      failureRate: 0,
    },
  };
}

function partialGenerator(): NonNullable<RunResultEvidence["generator"]> {
  return completeGenerator({
    transportAttemptCounts: {
      plannedRequests: 1_001,
      startedRequests: 1_000,
      completedRequests: 1_000,
      interruptedRequests: 0,
      unstartedRequests: 1,
    },
  });
}

function runFixture(evidence: RunResultEvidence) {
  return demoRunSnapshotSchema.parse({
    runId,
    presetId: "33333333-3333-4333-8333-333333333333",
    presetName: "Presentation fixture",
    operatorMode: "public",
    status: evidence.runStatus,
    trafficStatus: evidence.runStatus === "failed" ? "failed" : "succeeded",
    saleOfferId,
    configSnapshot: previewRunConfigSnapshotFixture(),
    startedAt: timestamp,
    autoResetAt: timestamp,
    trafficStartedAt: timestamp,
    trafficEndedAt: timestamp,
    finalizedAt: timestamp,
    ...(evidence.failureCategory ? { failureCategory: evidence.failureCategory } : {}),
  });
}

function dashboardFixture(evidence: RunResultEvidence): DashboardProjection {
  const durable = evidence.durable ?? cleanDurable;
  const inventory =
    evidence.startingStock === null || evidence.remainingStock === null
      ? null
      : {
          saleOfferId,
          allocatedStock: evidence.startingStock,
          remainingStock: evidence.remainingStock,
          reservedStock: evidence.startingStock - evidence.remainingStock,
          pendingPersistenceCount: evidence.heldReservationsAwaitingPersistence ?? 0,
          expiredReservationCount: 0,
          oldestPendingPersistenceAgeSeconds: 0,
          reservationThroughput: {
            windowSeconds: 60,
            successfulReservationCount: durable.uniqueReservations,
            peakRatePerSecond: durable.uniqueReservations,
            peakWindowSeconds: 1,
            unit: "reservations_per_second",
            measuredAt: timestamp,
          },
          soldOutPressure: {
            rejectionCount: durable.soldOutDecisions,
            latestObservedAt: timestamp,
          },
          observedAt: timestamp,
          lastUpdatedAt: timestamp,
        };
  const scope = { runId, saleOfferId };
  return dashboardProjectionSchema.parse({
    schema: dashboardProjectionSchemaName,
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    correlationId: "corr-presentation",
    scopeId: dashboardProjectionScopeId(scope),
    scope,
    revision: 1,
    recoveredAt: timestamp,
    currentRun: runFixture(evidence),
    inventory,
    erp: null,
    systemStatus: null,
    businessOutcome: {
      acceptedReservations: durable.uniqueReservations,
      reservedUnits: durable.reservedUnits,
      soldOutRejections: durable.soldOutDecisions,
      queuedOrders: durable.queuedOrders,
      processingOrders: durable.processingOrders,
      confirmedOrders: durable.confirmedOrders,
      failedOrders: durable.failedOrders,
      retryingOrders: 0,
      pendingPersistenceCount: durable.durablePendingPersistenceRecords,
      notificationsRecorded: durable.notificationsRecorded,
    },
    consistencyLag: null,
    transportAttemptCounts: evidence.generator?.transportAttemptCounts ?? null,
    httpSummary: evidence.generator?.httpSummary ?? null,
    requestArrivalSummary: null,
    runSignalTimelineSummary: null,
  });
}

function summaryFixture(evidence: RunResultEvidence): RunHistorySummary {
  const durable = evidence.durable ?? cleanDurable;
  const generator = evidence.generator ?? completeGenerator();
  return runHistorySummarySchema.parse({
    id: "44444444-4444-4444-8444-444444444444",
    runId,
    presetName: "Presentation fixture",
    status: evidence.runStatus,
    replayPossible: evidence.replayPossible ?? false,
    ...(evidence.failureCategory ? { failureCategory: evidence.failureCategory } : {}),
    transportAttemptCounts: generator.transportAttemptCounts,
    httpSummary: generator.httpSummary,
    trafficDeliverySummary: {
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      requestArrivalSummary: emptyRequestArrivalSummary,
      trafficDeliveryStatus: "complete",
      notes: [],
    },
    serverReservationTimingSummary: emptyServerReservationTimingSummary,
    businessOutcomeSummary: {
      acceptedReservations: durable.uniqueReservations,
      reservedUnits: durable.reservedUnits,
      soldOutRejections: durable.soldOutDecisions,
      queuedOrders: durable.queuedOrders,
      processingOrders: durable.processingOrders,
      retryingOrders: 0,
      confirmedOrders: durable.confirmedOrders,
      failedOrders: durable.failedOrders,
      pendingPersistenceCount: durable.durablePendingPersistenceRecords,
      notificationsRecorded: durable.notificationsRecorded,
    },
    terminalInventorySnapshot:
      evidence.startingStock !== null && evidence.remainingStock !== null
        ? {
            saleOfferId,
            startingStock: evidence.startingStock,
            remainingStock: evidence.remainingStock,
            reservedStock: evidence.startingStock - evidence.remainingStock,
            acceptedReservations: durable.uniqueReservations,
            soldOutRejections: durable.soldOutDecisions,
            pendingPersistenceCount: evidence.heldReservationsAwaitingPersistence ?? 0,
            capturedAt: timestamp,
            source: "redis",
          }
        : undefined,
    runSignalTimelineSummary: null,
    startedAt: timestamp,
    endedAt: timestamp,
    capturedAt: timestamp,
  });
}

function detailFixture(evidence: RunResultEvidence): PublicRunHistoryDetailResponse {
  const { id: _id, terminalInventorySnapshot, ...summary } = summaryFixture(evidence);
  const { notes: _notes, ...trafficDeliverySummary } = summary.trafficDeliverySummary;
  const publicSummary = publicRunHistorySummarySchema.parse({
    ...summary,
    trafficDeliverySummary,
    ...(terminalInventorySnapshot
      ? {
          terminalInventorySnapshot: (({ saleOfferId: _saleOfferId, source: _source, ...value }) =>
            value)(terminalInventorySnapshot),
        }
      : {}),
  });
  return publicRunHistoryDetailResponseSchema.parse({
    failureDiagnostic: null,
    summary: publicSummary,
    run: {
      runId,
      presetName: "Presentation fixture",
      operatorMode: "public",
      status: evidence.runStatus,
      trafficStatus: evidence.runStatus === "failed" ? "failed" : "succeeded",
      configSnapshot: previewRunConfigSnapshotFixture(),
      startedAt: timestamp,
      trafficStartedAt: timestamp,
      trafficEndedAt: timestamp,
      finalizedAt: timestamp,
    },
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    result: deriveRunResult(evidence),
    overallDurationMs: 0,
    plannedAttempts: 10,
    erpAttempts: {
      totalCount: 0,
      byStatus: { succeeded: 0, failed: 0, timedOut: 0 },
      averageLatencyMs: null,
      p95LatencyMs: null,
    },
    runSignalTimelineSummary: null,
    timestamp,
  });
}
