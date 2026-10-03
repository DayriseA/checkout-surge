import { z } from "zod";
import { nonnegativeIntegerSchema } from "./primitives.js";

/**
 * Canonical transport-attempt accounting for generated load traffic.
 *
 * These five counts describe client-side attempts truthfully:
 * - `plannedRequests`: configured number of client attempts.
 * - `startedRequests`: attempts for which the generated script incremented a
 *   counter immediately before calling `http.post()`.
 * - `completedRequests`: attempts for which `http.post()` returned to script
 *   code and the script incremented a completion counter.
 * - `interruptedRequests`: started attempts that did not reach the
 *   response-completed counter before shutdown.
 * - `unstartedRequests`: planned attempts that never reached the
 *   attempt-started counter.
 *
 * A started attempt is client-side evidence only; it must never be relabeled
 * as "API received". The reconciliation equations are:
 *
 *   plannedRequests = startedRequests + unstartedRequests
 *   startedRequests = completedRequests + interruptedRequests
 *
 * Planned requests remain known from the accepted configuration. When no
 * report or definitive no-start evidence exists, all four observed counts
 * must be null together; reconciliation equations apply only to known counts.
 */
export const transportAttemptCountsShape = {
  plannedRequests: nonnegativeIntegerSchema,
  startedRequests: nonnegativeIntegerSchema.nullable(),
  completedRequests: nonnegativeIntegerSchema.nullable(),
  interruptedRequests: nonnegativeIntegerSchema.nullable(),
  unstartedRequests: nonnegativeIntegerSchema.nullable(),
} as const;

export interface TransportAttemptCounts {
  plannedRequests: number;
  startedRequests: number | null;
  completedRequests: number | null;
  interruptedRequests: number | null;
  unstartedRequests: number | null;
}

/** Reusable cross-field validation for the two transport reconciliation equations. */
export function refineTransportAttemptCounts(
  value: TransportAttemptCounts,
  context: z.RefinementCtx,
): void {
  const observed = [
    value.startedRequests,
    value.completedRequests,
    value.interruptedRequests,
    value.unstartedRequests,
  ];
  if (
    value.startedRequests === null ||
    value.completedRequests === null ||
    value.interruptedRequests === null ||
    value.unstartedRequests === null
  ) {
    if (!observed.every((count) => count === null)) {
      context.addIssue({
        code: "custom",
        message: "Observed transport counts must be all known or all unknown",
      });
    }
    return;
  }
  if (value.plannedRequests !== value.startedRequests + value.unstartedRequests) {
    context.addIssue({
      code: "custom",
      path: ["unstartedRequests"],
      message: "plannedRequests must equal startedRequests + unstartedRequests",
    });
  }
  if (value.startedRequests !== value.completedRequests + value.interruptedRequests) {
    context.addIssue({
      code: "custom",
      path: ["interruptedRequests"],
      message: "startedRequests must equal completedRequests + interruptedRequests",
    });
  }
}

export const transportAttemptCountsSchema = z
  .object(transportAttemptCountsShape)
  .strict()
  .superRefine(refineTransportAttemptCounts);

/** Completion reports carry measured counts; only API synthetic summaries may be unknown. */
export const measuredTransportAttemptCountsSchema = transportAttemptCountsSchema.safeExtend({
  startedRequests: nonnegativeIntegerSchema,
  completedRequests: nonnegativeIntegerSchema,
  interruptedRequests: nonnegativeIntegerSchema,
  unstartedRequests: nonnegativeIntegerSchema,
});
