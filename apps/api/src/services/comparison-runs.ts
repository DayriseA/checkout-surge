import type { Comparison, ComparisonMode } from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoPresets, demoRuns } from "@checkout-surge/db";
import { and, desc, eq, gte, isNotNull, isNull, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

/** Path prefix of the buy route that waits for the order's confirmation. */
export const synchronousConfirmationBuyPathPrefix = "/synchronous-confirmation";

/** After this long, a first comparison run whose partner never started stops holding the slot. */
const partnerStartGraceMs = 60_000;

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
 * A completed first run of a comparison, finalized recently, whose second run has not started.
 * Until the second run starts, it holds the run slot.
 */
export async function findRunAwaitingComparisonPartner(
  db: Pick<CheckoutSurgeDatabase, "select">,
  now: Date,
): Promise<{ run: typeof demoRuns.$inferSelect; comparison: Comparison } | null> {
  const partners = alias(demoRuns, "comparison_partner");
  const [row] = await db
    .select({ run: demoRuns, comparison: demoPresets.comparison })
    .from(demoRuns)
    .innerJoin(demoPresets, eq(demoPresets.id, demoRuns.presetId))
    .where(
      and(
        eq(demoRuns.status, "completed"),
        isNotNull(demoRuns.comparisonMode),
        isNull(demoRuns.comparisonFirstRunId),
        gte(demoRuns.finalizedAt, new Date(now.getTime() - partnerStartGraceMs)),
        notExists(
          db
            .select({ id: partners.id })
            .from(partners)
            .where(eq(partners.comparisonFirstRunId, demoRuns.id)),
        ),
      ),
    )
    .orderBy(desc(demoRuns.finalizedAt))
    .limit(1);
  return row?.comparison ? { run: row.run, comparison: row.comparison } : null;
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
