import { z } from "zod";

/** A preset-only field: a comparison preset runs its two modes as two chained runs. */
export const comparisonValues = ["order_queue"] as const;
export const comparisonSchema = z.enum(comparisonValues);
export type Comparison = z.infer<typeof comparisonSchema>;

/** A property of the run, set only by a comparison preset. */
export const comparisonModeValues = ["demo", "synchronous_confirmation"] as const;
export const comparisonModeSchema = z.enum(comparisonModeValues);
export type ComparisonMode = z.infer<typeof comparisonModeSchema>;

/** The modes of each comparison, in the order their runs are chained. */
export const comparisonModes = {
  order_queue: ["demo", "synchronous_confirmation"],
} as const satisfies Record<Comparison, readonly [ComparisonMode, ComparisonMode]>;

/**
 * Without the order queue, a winner's request stays open until the worker confirms its order.
 * Counted from the request's arrival; past it, the buyer gets the queued mode's own answer and
 * the order is confirmed later as usual. Below the generated k6 request timeout.
 */
export const synchronousConfirmationDeadlineMs = 45_000;
