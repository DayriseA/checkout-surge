import { z } from "zod";
import { largestAllowedErpLatencyMs } from "./erp.js";
import { inventoryConfigSchema, trafficConfigSchema } from "./load.js";
import { nonnegativeNumberSchema, percentageSchema, positiveIntegerSchema } from "./primitives.js";
import { type EnginePolicyIdentity, enginePolicyIdentitySchema } from "./processing-control.js";

/**
 * Initial estimated demo-occupancy ceiling (D11). Inclusive, in seconds,
 * measured from run acceptance through expected business settlement. This is a
 * provisional value: the number is calibrated and frozen only by task 20 with
 * explicit user approval. Admission is granted when the conservative estimate
 * is at most this ceiling.
 */
export const estimatedDemoOccupancyCeilingSeconds = 600 as const;
export const automaticRunResetDeadlineSeconds = 900 as const;
/**
 * From this many seconds after acceptance (D10), and only then, the dashboard
 * shows the grace-period notice with the time left before the automatic reset.
 */
export const automaticRunResetGraceNoticeSeconds = estimatedDemoOccupancyCeilingSeconds;

/** Single estimator identity; provisional constants are frozen only by task 20. */
export const conservativeDurationEstimatorIdentity = {
  name: "conservative-duration-estimator",
  version: 2,
} as const satisfies EnginePolicyIdentity;

/**
 * Declared scenario conditions consumed by the API-owned estimator (D11). The
 * estimator service owns all estimation logic; contracts describe only the
 * input and result shapes. `declaredErpForcedOutage` is the declared base
 * outage flag kept by D13: a permanently unavailable ERP has no admissible
 * finite estimate and must be rejected, not estimated as zero duration.
 */
export const estimatorInputSchema = z
  .object({
    trafficConfig: trafficConfigSchema,
    inventoryConfig: inventoryConfigSchema,
    effectiveWorkerConcurrency: positiveIntegerSchema,
    declaredErpCapacityPerSecond: positiveIntegerSchema,
    declaredErpLatencyMs: nonnegativeNumberSchema.max(largestAllowedErpLatencyMs),
    declaredErpForcedOutage: z.boolean().default(false),
    errorRateAssumption: percentageSchema.default(0),
  })
  .strict();
export type EstimatorInput = z.infer<typeof estimatorInputSchema>;

export const estimatorBottleneckValues = [
  "traffic_dispatch",
  "erp_capacity",
  "worker_concurrency",
  "erp_latency",
  "declared_outage",
  "unestimable",
] as const;
export const estimatorBottleneckSchema = z.enum(estimatorBottleneckValues);
export type EstimatorBottleneck = z.infer<typeof estimatorBottleneckSchema>;

/** One stated modeling assumption behind an estimate (no confidence-interval claims). */
export const estimateAssumptionSchema = z
  .object({
    code: z.string().trim().min(1),
    detail: z.string().trim().min(1),
  })
  .strict();

export const estimatorDecisionValues = ["admitted", "rejected"] as const;
export const estimatorDecisionSchema = z.enum(estimatorDecisionValues);

/**
 * Why a scenario has no admissible finite estimate (plan section 7, D11).
 * An unestimable result is always a rejection and carries no fabricated
 * durations.
 */
export const estimatorUnestimableReasonValues = [
  "declared_permanent_outage",
  "error_rate_above_policy_maximum",
  "unsupported_scenario",
] as const;
export const estimatorUnestimableReasonSchema = z.enum(estimatorUnestimableReasonValues);
export type EstimatorUnestimableReason = z.infer<typeof estimatorUnestimableReasonSchema>;

const estimatorResultBaseShape = {
  bottleneck: estimatorBottleneckSchema,
  assumptions: z.array(estimateAssumptionSchema),
  reasons: z.array(z.string().trim().min(1)).optional(),
  estimatorIdentity: enginePolicyIdentitySchema,
  policyIdentity: enginePolicyIdentitySchema,
  effectiveCeilingSeconds: nonnegativeNumberSchema,
};

/**
 * Estimator result (D11/D12). Two mutually exclusive shapes enforced here:
 *
 * - An estimable result carries both durations and no `unestimableReason`.
 *   It is `admitted` if and only if the conservative duration is at most the
 *   effective ceiling (inclusive: at 600 of 600 admitted, at 601 rejected).
 * - An unestimable result is always a `rejected` decision with a reason and
 *   no duration figures.
 */
export const estimatorResultSchema = z
  .object({
    ...estimatorResultBaseShape,
    decision: estimatorDecisionSchema,
    explanatoryDurationSeconds: nonnegativeNumberSchema.optional(),
    conservativeDurationSeconds: nonnegativeNumberSchema.optional(),
    unestimableReason: estimatorUnestimableReasonSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.unestimableReason !== undefined) {
      if (result.decision !== "rejected") {
        context.addIssue({
          code: "custom",
          path: ["decision"],
          message: "An unestimable scenario is always rejected.",
        });
      }
      if (result.explanatoryDurationSeconds !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["explanatoryDurationSeconds"],
          message: "An unestimable result carries no fabricated duration.",
        });
      }
      if (result.conservativeDurationSeconds !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["conservativeDurationSeconds"],
          message: "An unestimable result carries no fabricated duration.",
        });
      }
      if (result.bottleneck !== "unestimable") {
        context.addIssue({
          code: "custom",
          path: ["bottleneck"],
          message: "An unestimable result reports the unestimable bottleneck.",
        });
      }
      return;
    }
    if (result.bottleneck === "unestimable") {
      context.addIssue({
        code: "custom",
        path: ["bottleneck"],
        message: "The unestimable bottleneck requires an unestimableReason.",
      });
    }
    if (result.explanatoryDurationSeconds === undefined) {
      context.addIssue({
        code: "custom",
        path: ["explanatoryDurationSeconds"],
        message: "Required for an estimable result.",
      });
    }
    if (result.conservativeDurationSeconds === undefined) {
      context.addIssue({
        code: "custom",
        path: ["conservativeDurationSeconds"],
        message: "Required for an estimable result.",
      });
    }
    if (
      result.explanatoryDurationSeconds !== undefined &&
      result.conservativeDurationSeconds !== undefined
    ) {
      if (result.decision === "admitted") {
        if (result.conservativeDurationSeconds > result.effectiveCeilingSeconds) {
          context.addIssue({
            code: "custom",
            path: ["conservativeDurationSeconds"],
            message: "Admission requires the conservative duration to be at most the ceiling.",
          });
        }
      } else if (result.conservativeDurationSeconds <= result.effectiveCeilingSeconds) {
        context.addIssue({
          code: "custom",
          path: ["decision"],
          message: "An over-ceiling rejection requires a conservative duration above the ceiling.",
        });
      }
    }
  });
export type EstimatorResult = z.infer<typeof estimatorResultSchema>;

export const estimatePreviewSchema = z.object({ result: estimatorResultSchema }).strict();

/** Start rejection details, consumed by the dashboard before any run exists. */
export const estimateAdmissionRejectionDetailsSchema = z.discriminatedUnion("reason", [
  z
    .object({
      ...estimatorResultBaseShape,
      reasons: z.array(z.string().trim().min(1)).min(1),
      reason: z.literal("over_ceiling"),
      conservativeDurationSeconds: nonnegativeNumberSchema,
    })
    .strict()
    .refine(
      (value) => value.conservativeDurationSeconds > value.effectiveCeilingSeconds,
      "An over-ceiling rejection requires a duration above the ceiling.",
    ),
  z
    .object({
      ...estimatorResultBaseShape,
      reasons: z.array(z.string().trim().min(1)).min(1),
      reason: z.literal("unestimable"),
      bottleneck: z.literal("unestimable"),
      unestimableReason: estimatorUnestimableReasonSchema,
    })
    .strict(),
]);
export type EstimateAdmissionRejectionDetails = z.infer<
  typeof estimateAdmissionRejectionDetailsSchema
>;
