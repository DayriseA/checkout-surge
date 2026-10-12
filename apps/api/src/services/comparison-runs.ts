import {
  type Comparison,
  type ComparisonMode,
  comparisonModes,
  comparisonPartnerStartGraceMs,
} from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoPresets, demoRuns } from "@checkout-surge/db";
import { and, desc, eq, gte, ne } from "drizzle-orm";

/** Path prefix of the buy route that waits for the order's confirmation. */
export const synchronousConfirmationBuyPathPrefix = "/synchronous-confirmation";

/** Path prefix of the buy route where PostgreSQL decides the stock. */
export const postgresStockBuyPathPrefix = "/stock-in-postgres";

/**
 * The base URL the runner's k6 posts `/buy` to. A run without the order queue targets the waiting
 * route, and a run whose stock PostgreSQL decides targets that route, so the buy path needs no
 * per-request lookup of the run's mode.
 */
export function buyTargetBaseUrl(apiBaseUrl: string, mode: ComparisonMode | null | undefined) {
  const prefix =
    mode === "synchronous_confirmation"
      ? synchronousConfirmationBuyPathPrefix
      : mode === "postgres"
        ? postgresStockBuyPathPrefix
        : null;
  return prefix ? `${apiBaseUrl.replace(/\/+$/, "")}${prefix}` : apiBaseUrl;
}

/**
 * The last run to finish, when it is a completed first run of a comparison, finalized recently,
 * and no run was created since: its second run is due, and until it starts it holds the run slot.
 * Any later run, the second one included, ends this; a run in another mode never counts as a
 * first run, even if its link was deleted.
 */
export async function findRunAwaitingComparisonPartner(
  db: Pick<CheckoutSurgeDatabase, "select">,
  now: Date,
): Promise<{ run: typeof demoRuns.$inferSelect; comparison: Comparison } | null> {
  const [latest] = await db
    .select({ run: demoRuns, comparison: demoPresets.comparison })
    .from(demoRuns)
    .innerJoin(demoPresets, eq(demoPresets.id, demoRuns.presetId))
    .where(
      and(
        eq(demoRuns.status, "completed"),
        gte(demoRuns.finalizedAt, new Date(now.getTime() - comparisonPartnerStartGraceMs)),
      ),
    )
    .orderBy(desc(demoRuns.finalizedAt))
    .limit(1);
  const finalizedAt = latest?.run.finalizedAt;
  if (
    !latest?.comparison ||
    !finalizedAt ||
    latest.run.comparisonMode !== comparisonModes[latest.comparison][0]
  )
    return null;
  const [later] = await db
    .select({ id: demoRuns.id })
    .from(demoRuns)
    .where(and(ne(demoRuns.id, latest.run.id), gte(demoRuns.createdAt, finalizedAt)))
    .limit(1);
  return later ? null : { run: latest.run, comparison: latest.comparison };
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
