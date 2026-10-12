import {
  type Comparison,
  type ComparisonMode,
  comparisonModes,
  comparisonPartnerStartGraceMs,
} from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoPresets, demoRuns } from "@checkout-surge/db";
import { desc, eq } from "drizzle-orm";

/** Path prefix of the buy route that waits for the order's confirmation. */
export const synchronousConfirmationBuyPathPrefix = "/synchronous-confirmation";

/**
 * The base URL the runner's k6 posts `/buy` to. A run without the order queue targets the waiting
 * route, so the buy path needs no per-request lookup of the run's mode.
 */
export function buyTargetBaseUrl(apiBaseUrl: string, mode: ComparisonMode | null | undefined) {
  return mode === "synchronous_confirmation"
    ? `${apiBaseUrl.replace(/\/+$/, "")}${synchronousConfirmationBuyPathPrefix}`
    : apiBaseUrl;
}

/**
 * The latest run, when it is a completed first run of a comparison, finalized recently: its second
 * run is due, and until it starts it holds the run slot. Any later run, the second one included,
 * ends this; a run in another mode never counts as a first run, even if its link was deleted.
 */
export async function findRunAwaitingComparisonPartner(
  db: Pick<CheckoutSurgeDatabase, "select">,
  now: Date,
): Promise<{ run: typeof demoRuns.$inferSelect; comparison: Comparison } | null> {
  const [latest] = await db
    .select({ run: demoRuns, comparison: demoPresets.comparison })
    .from(demoRuns)
    .innerJoin(demoPresets, eq(demoPresets.id, demoRuns.presetId))
    .orderBy(desc(demoRuns.createdAt))
    .limit(1);
  if (!latest?.comparison) return null;
  const { run, comparison } = latest;
  const due =
    run.status === "completed" &&
    run.comparisonMode === comparisonModes[comparison][0] &&
    run.finalizedAt !== null &&
    run.finalizedAt.getTime() >= now.getTime() - comparisonPartnerStartGraceMs;
  return due ? { run, comparison } : null;
}

/** The other run of a comparison: the first run it continues, or the run continuing it. */
export async function readComparisonPartnerRunId(
  db: Pick<CheckoutSurgeDatabase, "select">,
  run: Pick<typeof demoRuns.$inferSelect, "id" | "comparisonFirstRunId">,
): Promise<string | null> {
  if (run.comparisonFirstRunId) return run.comparisonFirstRunId;
  const [partner] = await db
    .select({ id: demoRuns.id })
    .from(demoRuns)
    .where(eq(demoRuns.comparisonFirstRunId, run.id))
    .limit(1);
  return partner?.id ?? null;
}
