import {
  idempotencyKeySchema,
  type SecuredReservationHold,
  type StockReservationDecision,
  securedReservationHoldSchema,
} from "@checkout-surge/contracts";
import type postgres from "postgres";
import type { SqlClient } from "./client.js";
import { terminalDemoRunTransitionLockKey } from "./demo-run-locks.js";
import type { PendingPersistenceRecord } from "./redis-stock-reservation.js";

type ReservationInput = { idempotencyKey: string; reservation: SecuredReservationHold };
type ReserveInput = ReservationInput & { idempotencyTtlSeconds: number };
type StockSql = SqlClient | postgres.TransactionSql;
interface StockRead {
  run_id: string;
  accepting: boolean;
  status: string;
  remaining_stock: number;
  hold: SecuredReservationHold | null;
  accepted: boolean | null;
}

/** PostgreSQL stock/holds adapter only. Counters, delivery and runtime activation remain unwired. */
export class PostgresStockReservations {
  constructor(private readonly sql: SqlClient) {}

  async initialize(input: {
    runId: string;
    saleOfferId: string;
    allocatedStock: number;
    now?: Date;
  }): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock_shared(hashtext(${terminalDemoRunTransitionLockKey(input.runId)}))`;
      const inserted = await tx`insert into postgres_run_inventory
        (run_id,sale_offer_id,allocated_stock,remaining_stock,updated_at)
        select id,sale_offer_id,${input.allocatedStock},${input.allocatedStock},${(input.now ?? new Date()).toISOString()}::timestamptz
        from demo_runs where id=${input.runId} and sale_offer_id=${input.saleOfferId}
          and status in ('starting','active','draining') returning run_id`;
      if (inserted.length !== 1)
        throw new Error("PostgreSQL inventory requires an accepting generated run.");
    });
  }

  async close(input: { runId: string; saleOfferId: string }): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(input.runId)}))`;
      await tx`update postgres_run_inventory set accepting=false
        where run_id=${input.runId} and sale_offer_id=${input.saleOfferId}`;
    });
  }

  async reserve(input: ReserveInput): Promise<StockReservationDecision> {
    validate(input);
    const observed = await readStock(this.sql, input);
    const rejection = rejectStock(observed, input);
    if (rejection) return rejection;
    // Obvious sold-out requests stay read-only. A live idempotency record must still
    // take the key lock and re-read after any preceding promotion/compensation commits.
    if (observed && !observed.hold && observed.remaining_stock < input.reservation.quantity) {
      return { outcome: "sold_out", reservation: null };
    }
    return this.withKeyLock(input, async (tx) => {
      const state = await readStock(tx, input);
      const rejected = rejectStock(state, input);
      if (rejected) return rejected;
      if (state?.hold)
        return {
          outcome: state.accepted ? "idempotent_replay" : "reservation_pending_persistence",
          reservation: state.hold,
        };
      const hold = input.reservation;
      const pending: PendingPersistenceRecord = {
        ...hold,
        idempotencyKey: input.idempotencyKey,
        recoveryAttemptCount: 0,
        recoveryStatus: "pending",
        nextRecoveryAt: hold.securedAt,
      };
      const rows = await tx`with stock as (
          update postgres_run_inventory set remaining_stock=remaining_stock-${hold.quantity},
            reserved_stock=reserved_stock+${hold.quantity},updated_at=${hold.securedAt}::timestamptz
          where run_id=${hold.runId} and sale_offer_id=${hold.saleOfferId} and accepting
            and remaining_stock>=${hold.quantity} returning run_id
        ), held as (
          insert into postgres_reservation_holds(id,run_id,sale_offer_id,hold,pending_record)
          select ${hold.id},run_id,${hold.saleOfferId},${JSON.stringify(hold)}::jsonb,
            ${JSON.stringify(pending)}::jsonb from stock returning id,run_id
        ) insert into postgres_reservation_idempotency(run_id,idempotency_key,reservation_id,expires_at)
          select run_id,${input.idempotencyKey},id,now()+make_interval(secs=>${input.idempotencyTtlSeconds}) from held
          on conflict(run_id,idempotency_key) do update set reservation_id=excluded.reservation_id,
            accepted=false,expires_at=excluded.expires_at returning reservation_id`;
      return rows.length
        ? { outcome: "reservation_secured", reservation: hold }
        : { outcome: "sold_out", reservation: null };
    });
  }

  async markPendingPersistence(input: ReservationInput): Promise<void> {
    validate(input);
    await this.withKeyLock(input, async (tx) => {
      const [row] = await tx`select h.hold,h.pending_record from postgres_reservation_holds h
        join postgres_reservation_idempotency d on d.reservation_id=h.id
        where h.id=${input.reservation.id} and d.run_id=${input.reservation.runId}
          and d.idempotency_key=${input.idempotencyKey} and not d.accepted
          and d.expires_at>now() and h.reversed_at is null`;
      if (!row || !sameHold(row.hold, input.reservation) || !row.pending_record) {
        throw new Error("PostgreSQL pending hold identity does not match.");
      }
      // Reservation already atomically stored the complete recovery record. Do not
      // reset attempts, next eligibility or exhausted state when ensuring it again.
    });
  }

  async promoteAccepted(input: ReserveInput): Promise<void> {
    validate(input);
    await this.withKeyLock(input, async (tx) => {
      const [hold] = await tx`select hold from postgres_reservation_holds
        where id=${input.reservation.id} and run_id=${input.reservation.runId} and reversed_at is null`;
      const [existing] = await tx`select reservation_id from postgres_reservation_idempotency
        where run_id=${input.reservation.runId} and idempotency_key=${input.idempotencyKey} and expires_at>now()`;
      if (
        !hold ||
        !sameHold(hold.hold, input.reservation) ||
        (existing && existing.reservation_id !== input.reservation.id)
      )
        throw new Error("PostgreSQL promotion hold identity does not match.");
      await tx`insert into postgres_reservation_idempotency(run_id,idempotency_key,reservation_id,accepted,expires_at)
        values(${input.reservation.runId},${input.idempotencyKey},${input.reservation.id},true,
          now()+make_interval(secs=>${input.idempotencyTtlSeconds}))
        on conflict(run_id,idempotency_key) do update set reservation_id=excluded.reservation_id,
          accepted=true,expires_at=excluded.expires_at`;
      await tx`update postgres_reservation_holds set pending_record=null where id=${input.reservation.id}`;
    });
  }

  async reverse(input: ReservationInput & { occurredAt?: Date }): Promise<"reversed" | "not_held"> {
    validate(input);
    return this.withKeyLock(input, async (tx) => {
      const [row] = await tx`select hold,pending_record,reversed_at from postgres_reservation_holds
        where id=${input.reservation.id} and run_id=${input.reservation.runId} for update`;
      if (!row || row.reversed_at) return "not_held";
      const [idempotency] =
        await tx`select reservation_id,accepted from postgres_reservation_idempotency
        where run_id=${input.reservation.runId} and idempotency_key=${input.idempotencyKey} and expires_at>now()`;
      if (
        !sameHold(row.hold, input.reservation) ||
        !row.pending_record ||
        row.pending_record.idempotencyKey !== input.idempotencyKey ||
        (idempotency &&
          (idempotency.accepted || idempotency.reservation_id !== input.reservation.id))
      ) {
        throw new Error("PostgreSQL reversal hold identity does not match.");
      }
      const updated = await tx`update postgres_run_inventory
        set remaining_stock=remaining_stock+${input.reservation.quantity},
          reserved_stock=reserved_stock-${input.reservation.quantity},updated_at=${(input.occurredAt ?? new Date()).toISOString()}::timestamptz
        where run_id=${input.reservation.runId} and sale_offer_id=${input.reservation.saleOfferId} returning run_id`;
      if (updated.length !== 1) throw new Error("PostgreSQL inventory is missing during reversal.");
      await tx`update postgres_reservation_holds set pending_record=null,reversed_at=${(input.occurredAt ?? new Date()).toISOString()}::timestamptz
        where id=${input.reservation.id}`;
      await tx`delete from postgres_reservation_idempotency where run_id=${input.reservation.runId}
        and idempotency_key=${input.idempotencyKey} and reservation_id=${input.reservation.id}`;
      return "reversed";
    });
  }

  private async withKeyLock<T>(
    input: ReservationInput,
    operation: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    const result = await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock_shared(hashtext(${terminalDemoRunTransitionLockKey(input.reservation.runId)}))`;
      // READ COMMITTED takes a snapshot per command. Reads MUST be a later
      // command than this potentially waiting lock, never another CTE in it.
      await tx`select pg_advisory_xact_lock(hashtext(${postgresReservationKeyLock(input.reservation.runId, input.idempotencyKey)}))`;
      return { value: await operation(tx) };
    });
    return result.value;
  }
}

export function postgresReservationKeyLock(runId: string, key: string): string {
  return `postgres_reservation:${runId}:${key}`;
}

async function readStock(sql: StockSql, input: ReservationInput): Promise<StockRead | undefined> {
  const [row] = await sql<
    StockRead[]
  >`select i.run_id,i.accepting,i.remaining_stock,r.status,h.hold,d.accepted
    from postgres_run_inventory i join demo_runs r on r.id=i.run_id
    left join postgres_reservation_idempotency d on d.run_id=i.run_id
      and d.idempotency_key=${input.idempotencyKey} and d.expires_at>now()
    left join postgres_reservation_holds h on h.id=d.reservation_id and h.reversed_at is null
    where i.sale_offer_id=${input.reservation.saleOfferId}`;
  return row;
}

function rejectStock(
  state: StockRead | undefined,
  input: ReservationInput,
): StockReservationDecision | null {
  if (!state) return { outcome: "inventory_not_initialized", reservation: null };
  if (
    state.run_id !== input.reservation.runId ||
    !state.accepting ||
    !["starting", "active", "draining"].includes(state.status)
  )
    return { outcome: "run_not_accepting_traffic", reservation: null };
  if (state.hold && state.hold.quantity !== input.reservation.quantity)
    return { outcome: "idempotency_conflict", reservation: null };
  return null;
}

function validate(input: ReservationInput): void {
  idempotencyKeySchema.parse(input.idempotencyKey);
  securedReservationHoldSchema.parse(input.reservation);
  if (Date.parse(input.reservation.expiresAt) <= Date.parse(input.reservation.securedAt)) {
    throw new Error("Reservation expiresAt must be later than securedAt.");
  }
}

function sameHold(value: SecuredReservationHold, hold: SecuredReservationHold): boolean {
  return Object.keys(hold).every(
    (key) =>
      value[key as keyof SecuredReservationHold] === hold[key as keyof SecuredReservationHold],
  );
}
