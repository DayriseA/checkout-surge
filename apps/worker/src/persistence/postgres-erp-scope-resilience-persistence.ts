import {
  type CheckoutSurgeDatabase,
  erpScopeResilienceState,
  orderRecoveryJobs,
  orders,
} from "@checkout-surge/db";
import { and, asc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import type {
  AdaptiveErpSafetyPersistence,
  AdaptiveErpSafetyRecord,
} from "../application/order-process-admission.js";

export interface ErpScopeResilienceExpiries {
  scope: string;
  cooldownExpiresAt: Date | null;
  circuitOpenExpiresAt: Date | null;
  updatedAt: Date;
}

/**
 * Durable per-scope restart-safety state (D07): cooldown and circuit-open
 * expiries for one downstream capacity scope (`catalog` or `run:<id>`). The
 * adaptive controller reads and writes this state during operation; learned
 * rate and latency state remain process-local.
 */
export class PostgresErpScopeResiliencePersistence implements AdaptiveErpSafetyPersistence {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async get(scope: string): Promise<ErpScopeResilienceExpiries | null> {
    const [row] = await this.db
      .select()
      .from(erpScopeResilienceState)
      .where(eq(erpScopeResilienceState.scope, scope))
      .limit(1);
    if (!row) return null;
    return {
      scope: row.scope,
      cooldownExpiresAt: row.cooldownExpiresAt,
      circuitOpenExpiresAt: row.circuitOpenExpiresAt,
      updatedAt: row.updatedAt,
    };
  }

  async setExpiries(input: {
    scope: string;
    cooldownExpiresAt?: Date | null;
    circuitOpenExpiresAt?: Date | null;
  }): Promise<void> {
    await this.db
      .insert(erpScopeResilienceState)
      .values({
        scope: input.scope,
        ...(input.cooldownExpiresAt !== undefined
          ? { cooldownExpiresAt: input.cooldownExpiresAt }
          : {}),
        ...(input.circuitOpenExpiresAt !== undefined
          ? { circuitOpenExpiresAt: input.circuitOpenExpiresAt }
          : {}),
      })
      .onConflictDoUpdate({
        target: erpScopeResilienceState.scope,
        set: {
          ...(input.cooldownExpiresAt !== undefined
            ? { cooldownExpiresAt: input.cooldownExpiresAt }
            : {}),
          ...(input.circuitOpenExpiresAt !== undefined
            ? { circuitOpenExpiresAt: input.circuitOpenExpiresAt }
            : {}),
          updatedAt: new Date(),
        },
      });
  }

  async listActive(nowMs: number): Promise<AdaptiveErpSafetyRecord[]> {
    const now = new Date(nowMs);
    const rows = await this.db.select().from(erpScopeResilienceState).where(activeObligation(now));
    return rows.flatMap(toSafetyRecord);
  }

  async readActive(scope: AdaptiveErpSafetyRecord["scope"], nowMs: number) {
    const [row] = await this.db
      .select()
      .from(erpScopeResilienceState)
      .where(and(eq(erpScopeResilienceState.scope, scope), activeObligation(new Date(nowMs))))
      .limit(1);
    return row ? (toSafetyRecord(row)[0] ?? null) : null;
  }

  async listUnresolvedScopes(limit: number): Promise<AdaptiveErpSafetyRecord["scope"][]> {
    const scope = scopeExpression();
    const rows = await this.db
      .selectDistinct({ scope })
      .from(orderRecoveryJobs)
      .innerJoin(orders, eq(orders.id, orderRecoveryJobs.orderId))
      .where(runnableReconciliationObligation())
      .limit(limit);
    return rows.flatMap((row) => (isAdmissionScope(row.scope) ? [row.scope] : []));
  }

  async readReconciliationGate(scope: AdaptiveErpSafetyRecord["scope"]) {
    const [row] = await this.db
      .select({
        nextAttemptAt: orderRecoveryJobs.nextAttemptAt,
        leaseExpiresAt: orderRecoveryJobs.leaseExpiresAt,
      })
      .from(orderRecoveryJobs)
      .innerJoin(orders, eq(orders.id, orderRecoveryJobs.orderId))
      .where(and(eq(scopeExpression(), scope), runnableReconciliationObligation()))
      .orderBy(
        asc(
          sql`greatest(coalesce(${orderRecoveryJobs.nextAttemptAt}, 'epoch'::timestamptz), coalesce(${orderRecoveryJobs.leaseExpiresAt}, 'epoch'::timestamptz))`,
        ),
      )
      .limit(1);
    return {
      pending: Boolean(row),
      nextEligibleAtMs: row
        ? Math.max(row.nextAttemptAt?.getTime() ?? 0, row.leaseExpiresAt?.getTime() ?? 0)
        : 0,
    };
  }

  async save(record: AdaptiveErpSafetyRecord): Promise<void> {
    const updatedAt = new Date();
    const values = {
      scope: record.scope,
      cooldownExpiresAt: toDate(record.cooldownUntilMs),
      availabilityRetryAt: toDate(record.availabilityRetryAtMs),
      availabilityCircuitOpen: record.availabilityCircuitOpen,
      circuitOpenExpiresAt: toDate(record.circuitOpenUntilMs),
      nextProbeAt: toDate(record.nextProbeAtMs),
      updatedAt,
    };
    await this.db.insert(erpScopeResilienceState).values(values).onConflictDoUpdate({
      target: erpScopeResilienceState.scope,
      set: values,
    });
  }
}

function activeObligation(now: Date) {
  return or(
    gt(erpScopeResilienceState.cooldownExpiresAt, now),
    gt(erpScopeResilienceState.availabilityRetryAt, now),
    gt(erpScopeResilienceState.circuitOpenExpiresAt, now),
    gt(erpScopeResilienceState.nextProbeAt, now),
  );
}

function scopeExpression() {
  return sql<string>`case when ${orders.runId} is null then 'catalog' else 'run:' || ${orders.runId}::text end`;
}

function runnableReconciliationObligation() {
  return and(
    isNotNull(orderRecoveryJobs.unresolvedErpCallId),
    inArray(orderRecoveryJobs.status, ["pending", "enqueued"]),
    inArray(orders.status, ["queued", "processing"]),
  );
}

function toSafetyRecord(
  row: typeof erpScopeResilienceState.$inferSelect,
): AdaptiveErpSafetyRecord[] {
  if (!isAdmissionScope(row.scope)) return [];
  return [
    {
      scope: row.scope,
      cooldownUntilMs: row.cooldownExpiresAt?.getTime() ?? 0,
      availabilityRetryAtMs: row.availabilityRetryAt?.getTime() ?? 0,
      availabilityCircuitOpen: row.availabilityCircuitOpen,
      circuitOpenUntilMs: row.circuitOpenExpiresAt?.getTime() ?? 0,
      nextProbeAtMs: row.nextProbeAt?.getTime() ?? 0,
    },
  ];
}

function toDate(timestampMs: number): Date | null {
  return timestampMs > 0 ? new Date(timestampMs) : null;
}

function isAdmissionScope(scope: string): scope is AdaptiveErpSafetyRecord["scope"] {
  return scope === "catalog" || scope.startsWith("run:");
}
