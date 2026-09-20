import { type CheckoutSurgeDatabase, erpScopeResilienceState } from "@checkout-surge/db";
import { eq, sql } from "drizzle-orm";

export interface ErpScopeResilienceExpiries {
  scope: string;
  cooldownExpiresAt: Date | null;
  circuitOpenExpiresAt: Date | null;
  interventionReason: string | null;
  interventionOpenedAt: Date | null;
  updatedAt: Date;
}

/**
 * Durable per-scope restart-safety state (D07): cooldown and circuit-open
 * expiries for one downstream capacity scope (`catalog` or `run:<id>`). The
 * adaptive controller that reads and writes it during operation is introduced
 * by a later task; the state itself survives worker restarts.
 */
export class PostgresErpScopeResiliencePersistence {
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
      interventionReason: row.interventionReason,
      interventionOpenedAt: row.interventionOpenedAt,
      updatedAt: row.updatedAt,
    };
  }

  async openIntervention(input: { scope: string; reason: string; openedAt: Date }): Promise<void> {
    const openedAt = input.openedAt.toISOString();
    await this.db
      .insert(erpScopeResilienceState)
      .values({
        scope: input.scope,
        interventionReason: input.reason,
        interventionOpenedAt: input.openedAt,
      })
      .onConflictDoUpdate({
        target: erpScopeResilienceState.scope,
        set: {
          interventionReason: sql`coalesce(${erpScopeResilienceState.interventionReason}, ${input.reason})`,
          interventionOpenedAt: sql`coalesce(${erpScopeResilienceState.interventionOpenedAt}, ${openedAt}::timestamptz)`,
          updatedAt: sql`case when ${erpScopeResilienceState.interventionReason} is null then ${openedAt}::timestamptz else ${erpScopeResilienceState.updatedAt} end`,
        },
      });
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
}
