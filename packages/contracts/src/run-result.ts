import { z } from "zod";
import { demoRunStatusSchema } from "./lifecycle.js";
import { trafficHttpSummarySchema } from "./load.js";
import { nonnegativeIntegerSchema } from "./primitives.js";
import { transportAttemptCountsSchema } from "./traffic-transport-counts.js";

/** The persisted failure vocabulary. Keep this closed: it is mapped before public projection. */
export const internalRunFailureReasonValues = [
  "reconciliation_escalated",
  "pending_persistence_reconciliation_timeout",
  "business_drain_timeout",
  "accepted_response_accounting_timeout",
  "traffic_delivery_major_shortfall",
  "traffic_outcome_unexpected_responses",
  "traffic_transport_major_loss",
  "traffic_failed",
  "inventory_initialization_failed",
  "load_orchestrator_unavailable",
  "admin_reset",
] as const;
export const internalRunFailureReasonSchema = z.enum(internalRunFailureReasonValues);
export type InternalRunFailureReason = z.infer<typeof internalRunFailureReasonSchema>;

export const publicRunFailureCategoryValues = [
  "reconciliation",
  "business",
  "traffic",
  "inventory",
  "operator",
] as const;
export const publicRunFailureCategorySchema = z.enum(publicRunFailureCategoryValues);
export type PublicRunFailureCategory = z.infer<typeof publicRunFailureCategorySchema>;

export function toPublicRunFailureCategory(
  reason: InternalRunFailureReason,
): PublicRunFailureCategory {
  switch (reason) {
    case "reconciliation_escalated":
    case "pending_persistence_reconciliation_timeout":
      return "reconciliation";
    case "business_drain_timeout":
    case "accepted_response_accounting_timeout":
      return "business";
    case "traffic_delivery_major_shortfall":
    case "traffic_outcome_unexpected_responses":
    case "traffic_transport_major_loss":
    case "traffic_failed":
    case "load_orchestrator_unavailable":
      return "traffic";
    case "inventory_initialization_failed":
      return "inventory";
    case "admin_reset":
      return "operator";
  }
}

export const runResultInvariantStatusValues = ["holds", "broken", "not_evaluable"] as const;
export const runResultInvariantStatusSchema = z.enum(runResultInvariantStatusValues);
export type RunResultInvariantStatus = z.infer<typeof runResultInvariantStatusSchema>;

export const runResultClassificationValues = [
  "expected_population_difference",
  "evidence_incomplete",
  "warning",
  "correctness_failure",
] as const;
export const runResultClassificationSchema = z.enum(runResultClassificationValues);
export type RunResultClassification = z.infer<typeof runResultClassificationSchema>;

export const runResultEvidenceIncompleteReasonSchema = z.enum(["unavailable", "partial"]);

const runResultDurableEvidenceSchema = z
  .object({
    reservedUnits: nonnegativeIntegerSchema,
    uniqueReservations: nonnegativeIntegerSchema,
    soldOutDecisions: nonnegativeIntegerSchema,
    confirmedOrders: nonnegativeIntegerSchema,
    businessRejectedOrders: nonnegativeIntegerSchema.optional(),
    technicallyFailedOrders: nonnegativeIntegerSchema.optional(),
    failedOrders: nonnegativeIntegerSchema,
    queuedOrders: nonnegativeIntegerSchema,
    processingOrders: nonnegativeIntegerSchema,
    durablePendingPersistenceRecords: nonnegativeIntegerSchema,
    notificationsRecorded: nonnegativeIntegerSchema,
  })
  .strict();

const runResultGeneratorEvidenceSchema = z
  .object({
    transportAttemptCounts: transportAttemptCountsSchema,
    httpSummary: trafficHttpSummarySchema,
  })
  .strict();

export const runResultEvidenceSchema = z
  .object({
    runStatus: demoRunStatusSchema,
    failureCategory: publicRunFailureCategorySchema.nullable(),
    startingStock: nonnegativeIntegerSchema.nullable(),
    remainingStock: nonnegativeIntegerSchema.nullable(),
    durable: runResultDurableEvidenceSchema.nullable(),
    heldReservationsAwaitingPersistence: nonnegativeIntegerSchema.nullable(),
    replayPossible: z.boolean().nullable(),
    generator: runResultGeneratorEvidenceSchema.nullable(),
  })
  .strict();
export type RunResultEvidence = z.infer<typeof runResultEvidenceSchema>;

export const runResultInvariantSchema = z
  .object({
    name: z.enum(["stock", "orders", "oversell"]),
    expression: z.string().trim().min(1),
    status: runResultInvariantStatusSchema,
    actual: z.number().int().nullable(),
    expected: z.number().int().nullable(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export const runResultReconciliationSchema = z
  .object({
    code: z.string().trim().min(1),
    leftPopulation: z.string().trim().min(1),
    leftValue: z.number().int().nullable(),
    rightPopulation: z.string().trim().min(1),
    rightValue: z.number().int().nullable(),
    classification: runResultClassificationSchema,
    reason: z.string().trim().min(1).optional(),
    incompleteReason: runResultEvidenceIncompleteReasonSchema.optional(),
  })
  .strict();

export const runResultOutcomeSchema = z.enum([
  "failed",
  "outcome-indeterminate",
  "completed-with-oversell",
  "completed-with-order-failures",
  "completed-with-unsettled-orders",
  "completed-successfully",
]);
export type RunResultOutcome = z.infer<typeof runResultOutcomeSchema>;

export const runResultSchema = z
  .object({
    outcome: runResultOutcomeSchema,
    failureCategory: publicRunFailureCategorySchema.nullable(),
    startingStock: nonnegativeIntegerSchema.nullable(),
    remainingStock: nonnegativeIntegerSchema.nullable(),
    uniqueReservations: nonnegativeIntegerSchema.nullable(),
    reservedUnits: nonnegativeIntegerSchema.nullable(),
    soldOutDecisions: nonnegativeIntegerSchema.nullable(),
    confirmedOrders: nonnegativeIntegerSchema.nullable(),
    businessRejectedOrders: nonnegativeIntegerSchema.nullable(),
    technicallyFailedOrders: nonnegativeIntegerSchema.nullable(),
    failedOrders: nonnegativeIntegerSchema.nullable(),
    pendingOrders: nonnegativeIntegerSchema.nullable(),
    oversoldUnits: nonnegativeIntegerSchema.nullable(),
    invariants: z.array(runResultInvariantSchema),
    reconciliations: z.array(runResultReconciliationSchema),
    maximumClassification: runResultClassificationSchema.nullable(),
  })
  .strict();
export type RunResult = z.infer<typeof runResultSchema>;

const classificationRank: Record<RunResultClassification, number> = {
  expected_population_difference: 0,
  evidence_incomplete: 1,
  warning: 2,
  correctness_failure: 3,
};

function maxClassification(values: RunResultClassification[]): RunResultClassification | null {
  return values.reduce<RunResultClassification | null>(
    (current, candidate) =>
      !current || classificationRank[candidate] > classificationRank[current] ? candidate : current,
    null,
  );
}

export function isReplayPossible(config: {
  trafficConfig: { mode: string; duplicateEachBuyerAttempt?: boolean };
}): boolean {
  return (
    config.trafficConfig.mode === "buyer-spike" &&
    config.trafficConfig.duplicateEachBuyerAttempt === true
  );
}

export function deriveRunResult(input: RunResultEvidence): RunResult {
  const durable = input.durable;
  const stockEvaluable =
    durable !== null &&
    input.startingStock !== null &&
    input.remainingStock !== null &&
    input.heldReservationsAwaitingPersistence === 0;
  const reservedUnits = durable ? durable.reservedUnits : null;
  const stockExpected =
    input.startingStock !== null && input.remainingStock !== null
      ? input.startingStock - input.remainingStock
      : null;
  const oversoldUnits =
    durable !== null && input.startingStock !== null
      ? Math.max(0, durable.reservedUnits - input.startingStock)
      : null;
  const pendingOrders = durable ? durable.queuedOrders + durable.processingOrders : null;
  const invariants: RunResult["invariants"] = [
    {
      name: "stock",
      expression: "reserved units = starting stock − remaining stock",
      status: stockEvaluable
        ? reservedUnits === stockExpected
          ? "holds"
          : "broken"
        : "not_evaluable",
      actual: reservedUnits,
      expected: stockExpected,
      ...(!stockEvaluable
        ? { reason: "Stock, durable reservation, or pending-persistence evidence is unavailable." }
        : {}),
    },
    {
      name: "orders",
      expression: "confirmed + failed + pending = unique reservations",
      status:
        durable === null || pendingOrders === null
          ? "not_evaluable"
          : durable.confirmedOrders + durable.failedOrders + pendingOrders ===
              durable.uniqueReservations
            ? "holds"
            : "broken",
      actual:
        durable === null
          ? null
          : durable.confirmedOrders + durable.failedOrders + (pendingOrders ?? 0),
      expected: durable?.uniqueReservations ?? null,
      ...(durable === null ? { reason: "Durable business evidence is unavailable." } : {}),
    },
    {
      name: "oversell",
      expression: "oversold units = 0",
      status: oversoldUnits === null ? "not_evaluable" : oversoldUnits === 0 ? "holds" : "broken",
      actual: oversoldUnits,
      expected: 0,
      ...(oversoldUnits === null
        ? { reason: "Stock or durable reservation evidence is unavailable." }
        : {}),
    },
  ];

  const reconciliations: RunResult["reconciliations"] = [];
  const classes: RunResultClassification[] = invariants
    .filter((invariant) => invariant.status !== "holds")
    .map((invariant) =>
      invariant.status === "broken" ? "correctness_failure" : "evidence_incomplete",
    );

  if (
    input.heldReservationsAwaitingPersistence !== null &&
    input.heldReservationsAwaitingPersistence > 0
  ) {
    reconciliations.push({
      code: "pending_persistence",
      leftPopulation: "Redis holds awaiting persistence",
      leftValue: input.heldReservationsAwaitingPersistence,
      rightPopulation: "PostgreSQL pending-persistence rows",
      rightValue: durable?.durablePendingPersistenceRecords ?? null,
      classification: "evidence_incomplete",
      incompleteReason: "partial",
      reason: "Redis stock has been decremented before PostgreSQL evidence exists.",
    });
    classes.push("evidence_incomplete");
  }

  if (
    durable &&
    input.heldReservationsAwaitingPersistence !== null &&
    input.heldReservationsAwaitingPersistence !== durable.durablePendingPersistenceRecords
  ) {
    reconciliations.push({
      code: "pending_persistence_evidence_mismatch",
      leftPopulation: "Redis holds awaiting persistence",
      leftValue: input.heldReservationsAwaitingPersistence,
      rightPopulation: "PostgreSQL pending-persistence rows",
      rightValue: durable.durablePendingPersistenceRecords,
      classification: "warning",
      reason: "The stores report different pending-persistence populations.",
    });
    classes.push("warning");
  }

  if (durable && input.generator) {
    const accepted = input.generator.httpSummary.acceptedResponses;
    const unique = durable.uniqueReservations;
    const generatorCoveragePartial =
      input.generator.transportAttemptCounts.unstartedRequests > 0 ||
      input.generator.transportAttemptCounts.interruptedRequests > 0;
    const classification =
      accepted >= unique && input.replayPossible === true
        ? generatorCoveragePartial
          ? "evidence_incomplete"
          : "expected_population_difference"
        : accepted === unique
          ? generatorCoveragePartial
            ? "evidence_incomplete"
            : "expected_population_difference"
          : accepted < unique
            ? generatorCoveragePartial
              ? "evidence_incomplete"
              : "warning"
            : "warning";
    reconciliations.push({
      code: "accepted_responses_vs_unique_reservations",
      leftPopulation: "accepted responses observed by generator",
      leftValue: accepted,
      rightPopulation: "unique reservations secured",
      rightValue: unique,
      classification,
      ...(classification === "evidence_incomplete" ? { incompleteReason: "partial" as const } : {}),
      ...(classification === "expected_population_difference"
        ? {
            reason: input.replayPossible
              ? "Idempotent replay responses are included."
              : "The populations represent different observations.",
          }
        : {}),
    });
    classes.push(classification);

    const soldOutObserved = input.generator.httpSummary.soldOutResponses;
    const soldOutClassification = generatorCoveragePartial
      ? "evidence_incomplete"
      : soldOutObserved <= durable.soldOutDecisions
        ? "expected_population_difference"
        : "warning";
    reconciliations.push({
      code: "sold_out_decisions_vs_responses",
      leftPopulation: "sold-out responses observed by generator",
      leftValue: soldOutObserved,
      rightPopulation: "sold-out decisions recorded by system",
      rightValue: durable.soldOutDecisions,
      classification: soldOutClassification,
      ...(soldOutClassification === "evidence_incomplete"
        ? { incompleteReason: "partial" as const }
        : {}),
      ...(soldOutClassification === "expected_population_difference"
        ? { reason: "Observed replies and durable decisions are separate populations." }
        : {}),
      ...(soldOutClassification === "warning"
        ? { reason: "Observed sold-out replies exceed recorded server decisions." }
        : {}),
    });
    classes.push(soldOutClassification);

    if (generatorCoveragePartial) {
      reconciliations.push({
        code: "partial_generator_coverage",
        leftPopulation: "planned checkout attempts",
        leftValue: input.generator.transportAttemptCounts.plannedRequests,
        rightPopulation: "attempts completed by generator",
        rightValue: input.generator.transportAttemptCounts.completedRequests,
        classification: "evidence_incomplete",
        incompleteReason: "partial",
        reason: "Survivorship limits the observed response population.",
      });
      classes.push("evidence_incomplete");
    }
  } else if (input.generator && durable === null) {
    reconciliations.push(
      {
        code: "accepted_responses_vs_unique_reservations",
        leftPopulation: "accepted responses observed by generator",
        leftValue: input.generator.httpSummary.acceptedResponses,
        rightPopulation: "unique reservations secured",
        rightValue: null,
        classification: "evidence_incomplete",
        incompleteReason: "unavailable",
        reason: "Durable reservation evidence is unavailable.",
      },
      {
        code: "sold_out_decisions_vs_responses",
        leftPopulation: "sold-out responses observed by generator",
        leftValue: input.generator.httpSummary.soldOutResponses,
        rightPopulation: "sold-out decisions recorded by system",
        rightValue: null,
        classification: "evidence_incomplete",
        incompleteReason: "unavailable",
        reason: "Durable sold-out decision evidence is unavailable.",
      },
    );
    classes.push("evidence_incomplete", "evidence_incomplete");
  } else if (input.generator === null) {
    reconciliations.push({
      code: "generator_evidence_unavailable",
      leftPopulation: "accepted responses observed by generator",
      leftValue: null,
      rightPopulation: "durable reservations",
      rightValue: durable?.uniqueReservations ?? null,
      classification: "evidence_incomplete",
      incompleteReason: "unavailable",
      reason: "Generator evidence is unavailable.",
    });
    classes.push("evidence_incomplete");
  }

  if (
    durable &&
    input.startingStock !== null &&
    input.remainingStock !== null &&
    input.remainingStock > 0 &&
    durable.soldOutDecisions > 0
  ) {
    reconciliations.push({
      code: "sold_out_with_stock_remaining",
      leftPopulation: "sold-out decisions recorded by system",
      leftValue: durable.soldOutDecisions,
      rightPopulation: "remaining stock observed by Redis",
      rightValue: input.remainingStock,
      classification: "warning",
      reason: "Sold-out decisions while stock remained need investigation.",
    });
    classes.push("warning");
  }

  if (durable && durable.notificationsRecorded < durable.confirmedOrders) {
    reconciliations.push({
      code: "notifications_below_confirmations",
      leftPopulation: "notifications recorded",
      leftValue: durable.notificationsRecorded,
      rightPopulation: "orders confirmed",
      rightValue: durable.confirmedOrders,
      classification: "warning",
      reason: "Not every confirmed order has a recorded notification.",
    });
    classes.push("warning");
  }

  const nonOversellInvariantBroken = invariants.some(
    (invariant) => invariant.name !== "oversell" && invariant.status === "broken",
  );
  const outcome: RunResultOutcome =
    input.runStatus === "failed"
      ? "failed"
      : oversoldUnits !== null && oversoldUnits > 0
        ? "completed-with-oversell"
        : input.runStatus !== "completed" ||
            durable === null ||
            !stockEvaluable ||
            nonOversellInvariantBroken
          ? "outcome-indeterminate"
          : durable.failedOrders > 0
            ? "completed-with-order-failures"
            : pendingOrders !== null && pendingOrders > 0
              ? "completed-with-unsettled-orders"
              : "completed-successfully";

  return runResultSchema.parse({
    outcome,
    failureCategory: input.failureCategory,
    startingStock: input.startingStock,
    remainingStock: input.remainingStock,
    uniqueReservations: durable?.uniqueReservations ?? null,
    reservedUnits,
    soldOutDecisions: durable?.soldOutDecisions ?? null,
    confirmedOrders: durable?.confirmedOrders ?? null,
    businessRejectedOrders: durable?.businessRejectedOrders ?? null,
    technicallyFailedOrders: durable?.technicallyFailedOrders ?? null,
    failedOrders: durable?.failedOrders ?? null,
    pendingOrders,
    oversoldUnits,
    invariants,
    reconciliations,
    maximumClassification: maxClassification(classes),
  });
}
