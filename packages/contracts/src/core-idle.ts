import { z } from "zod";

/** Countdown status of the hosted core's idle stop. Reading it never counts as activity. */
export const coreIdleStatusPath = "/core/idle-status" as const;
/** Records counted activity ("stay awake", visitor requests) and answers the new status. */
export const coreActivityPath = "/core/activity" as const;

/**
 * `disabled` outside the hosted runtime, where the core never stops on its own. `awake` carries
 * the time left before the core stops, counted from the last activity.
 */
export const coreIdleStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disabled") }).strict(),
  z.object({ state: z.literal("run_in_progress") }).strict(),
  z.object({ state: z.literal("awake"), sleepsInSeconds: z.number().int().nonnegative() }).strict(),
]);
export type CoreIdleStatus = z.infer<typeof coreIdleStatusSchema>;
