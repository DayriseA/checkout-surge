import { z } from "zod";

/** A preset-only field: a comparison preset runs its two modes as two chained runs. */
export const comparisonValues = ["order_queue", "redis"] as const;
export const comparisonSchema = z.enum(comparisonValues);
export type Comparison = z.infer<typeof comparisonSchema>;

/**
 * A property of the run, set only by a comparison preset. Each mode belongs to one comparison:
 * `redis` runs the normal buy path, `postgres` decides the stock and queues orders in PostgreSQL.
 */
export const comparisonModeValues = [
  "demo",
  "synchronous_confirmation",
  "redis",
  "postgres",
] as const;
export const comparisonModeSchema = z.enum(comparisonModeValues);
export type ComparisonMode = z.infer<typeof comparisonModeSchema>;

/** The modes of each comparison, in the order their runs are chained. */
export const comparisonModes = {
  order_queue: ["demo", "synchronous_confirmation"],
  redis: ["redis", "postgres"],
} as const satisfies Record<Comparison, readonly [ComparisonMode, ComparisonMode]>;

/** The comparison a run's mode belongs to. */
export function comparisonOfMode(mode: ComparisonMode): Comparison {
  return mode === "demo" || mode === "synchronous_confirmation" ? "order_queue" : "redis";
}

/** True for the mode of a comparison's first run. */
export function isFirstComparisonMode(mode: ComparisonMode): boolean {
  return comparisonModes[comparisonOfMode(mode)][0] === mode;
}

/** After this long, a completed first run whose second run never started stops holding the slot. */
export const comparisonPartnerStartGraceMs = 60_000;

/**
 * Without the order queue, a winner's request stays open until the worker confirms its order.
 * Counted from the request's arrival; past it, the buyer gets the queued mode's own answer and
 * the order is confirmed later as usual. Below the generated k6 request timeout.
 */
export const synchronousConfirmationDeadlineMs = 45_000;

/**
 * PostgreSQL publishes a connection's statistics up to 10 s after it goes idle. A run whose store
 * load is measured finalizes no sooner than this after its traffic ended, so its window is complete.
 */
export const storeLoadSettleMs = 12_000;

/**
 * The work PostgreSQL and Redis did during a measured run, from their own statistics: the whole
 * database's transactions and busy (statement execution) time, and the Redis process's CPU time.
 */
export const storeLoadSchema = z
  .object({
    postgresTransactions: z.number().int().nonnegative(),
    postgresBusyMs: z.number().nonnegative(),
    redisCpuMs: z.number().nonnegative(),
  })
  .strict();
export type StoreLoad = z.infer<typeof storeLoadSchema>;
