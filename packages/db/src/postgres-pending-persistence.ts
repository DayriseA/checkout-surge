import type { SqlClient } from "./client.js";
import type {
  deferPendingPersistenceRecord,
  PendingPersistencePage,
  PendingPersistenceRecord,
} from "./redis-stock-reservation.js";

/** Retained recovery metadata is independent of the expiring idempotency key. */
export class PostgresPendingPersistence {
  constructor(private readonly sql: SqlClient) {}

  async readPage(input: {
    runId: string;
    saleOfferId: string;
    limit: number;
    dueAt: Date;
  }): Promise<PendingPersistencePage> {
    const limit = Math.max(1, Math.min(input.limit, 1000));
    const rows = await this.sql<{ pending_record: PendingPersistenceRecord }[]>`
      select h.pending_record from postgres_reservation_holds h
      join demo_runs r on r.id=h.run_id
      where h.run_id=${input.runId} and h.sale_offer_id=${input.saleOfferId}
        and r.execution_mode='without_redis' and h.reversed_at is null
        and h.pending_record is not null and h.pending_record->>'recoveryStatus'='pending'
        and h.pending_record->>'nextRecoveryAt'<=${input.dueAt.toISOString()}
      order by h.pending_record->>'nextRecoveryAt',h.id limit ${limit}`;
    return { records: rows.map((row) => row.pending_record), issues: [] };
  }

  async readRecord(input: {
    saleOfferId: string;
    reservationId: string;
  }): Promise<{ record: PendingPersistenceRecord | null }> {
    const [row] = await this.sql<{ pending_record: PendingPersistenceRecord | null }[]>`
      select h.pending_record from postgres_reservation_holds h
      join demo_runs r on r.id=h.run_id
      where h.id=${input.reservationId} and h.sale_offer_id=${input.saleOfferId}
        and r.execution_mode='without_redis' and h.reversed_at is null`;
    return { record: row?.pending_record ?? null };
  }

  async defer(
    input: Parameters<typeof deferPendingPersistenceRecord>[1],
  ): Promise<"deferred" | "exhausted" | "removed"> {
    const result = await this.sql.begin(async (tx) => {
      const [row] = await tx<{ pending_record: PendingPersistenceRecord | null }[]>`
        select h.pending_record from postgres_reservation_holds h
        join demo_runs r on r.id=h.run_id
        where h.id=${input.reservationId} and h.sale_offer_id=${input.saleOfferId}
          and r.execution_mode='without_redis' and h.reversed_at is null
        for update of h`;
      const current = row?.pending_record;
      if (!current) return { disposition: "removed" as const };
      if (current.recoveryStatus === "exhausted") return { disposition: "exhausted" as const };
      // An older attempt cannot overwrite a newer attempt's eligibility or errors.
      if (current.recoveryAttemptCount > input.attemptCount)
        return { disposition: "deferred" as const };
      const next: PendingPersistenceRecord = {
        ...current,
        recoveryAttemptCount: input.attemptCount,
        recoveryStatus: input.status,
        nextRecoveryAt: input.nextRecoveryAt.toISOString(),
        recoveryDeadlineAt: input.recoveryDeadlineAt.toISOString(),
        lastRecoveryError: input.lastError.slice(0, 500),
      };
      await tx`update postgres_reservation_holds set pending_record=${JSON.stringify(next)}::jsonb
        where id=${input.reservationId}`;
      return {
        disposition: input.status === "exhausted" ? ("exhausted" as const) : ("deferred" as const),
      };
    });
    return result.disposition;
  }
}
