import { PostgresBuyPersistence } from "../../apps/api/dist/services/postgres-buy-persistence.js";
import { contracts, db, toJob } from "./common.mjs";

export class PostgresStockReservations {
  constructor(sql) {
    this.sql = sql;
  }
  async reserve({ reservation, idempotencyKey, idempotencyTtlSeconds }) {
    const [row] = await this.sql`select proof_reserve(${JSON.stringify(reservation)}::jsonb,
      ${idempotencyKey}, ${idempotencyTtlSeconds}) as decision`;
    return contracts.stockReservationDecisionSchema.parse(row.decision);
  }
  async markPendingPersistence({ reservation }) {
    const [row] = await this.sql`select reservation_id from proof_holds
      where reservation_id=${reservation.id} and status='pending_persistence'`;
    if (!row) throw new Error("Pending PostgreSQL hold is missing.");
  }
  async promoteAccepted({ reservation, idempotencyKey, idempotencyTtlSeconds }) {
    const rows = await this.sql`update proof_holds set status='accepted',
      expires_at=now()+make_interval(secs=>${idempotencyTtlSeconds})
      where run_id=${reservation.runId} and idempotency_key=${idempotencyKey}
        and reservation_id=${reservation.id} returning reservation_id`;
    if (rows.length !== 1) throw new Error("PostgreSQL hold promotion lost identity.");
  }
  async reverse({ reservation, idempotencyKey }) {
    const rows = await this.sql`
      with removed as (
        delete from proof_holds where run_id=${reservation.runId}
          and idempotency_key=${idempotencyKey} and reservation_id=${reservation.id}
          and status='pending_persistence' returning (hold->>'quantity')::integer as quantity
      ) update proof_inventory set remaining=remaining+removed.quantity,
        reserved=reserved-removed.quantity from removed
        where run_id=${reservation.runId} returning run_id`;
    return rows.length ? "reversed" : "not_held";
  }
  async pending(run) {
    const rows = await this.sql`select hold, idempotency_key as "idempotencyKey"
      from proof_holds where run_id=${run.runId} and status='pending_persistence' limit 100`;
    return rows.map((r) => ({ reservation: r.hold, idempotencyKey: r.idempotencyKey }));
  }
}

export async function enqueuePostgres(sql, job) {
  await sql`insert into proof_queue(order_id,run_id,job)
    values(${job.orderId},${job.runId},${JSON.stringify(job)}::jsonb) on conflict(order_id) do nothing`;
}

/** One instance per HTTP request: the publication callback receives its exact admission session. */
export function admissionPersistence(database, publish) {
  const base = new PostgresBuyPersistence(database);
  let session;
  return {
    persistence: {
      persistSecuredReservation: (input) => base.persistSecuredReservation(input),
      getPersistedBuyByReservationId: (id) => base.getPersistedBuyByReservationId(id),
      withRunPendingPersistenceLock: (input) => base.withRunPendingPersistenceLock(input),
      withRunAdmissionLock: (input) =>
        base.withRunAdmissionLockAndSession({
          reservation: input.reservation,
          operation: async (operations, reserved) => {
            session = reserved;
            try {
              return await input.operation(operations);
            } finally {
              session = undefined;
            }
          },
        }),
    },
    publisher: {
      enqueue: async (job) => {
        if (!session) throw new Error("Publication requires this request's admission session.");
        await publish(session, job);
      },
    },
    hasAdmissionSession: () => session !== undefined,
  };
}

export async function recoverAcceptance(scope, stock, input) {
  const persisted = await scope.persistence.withRunAdmissionLock({
    reservation: input.reservation,
    operation: async (operations) => {
      const accepted =
        (await operations.getPersistedBuyByReservationId(input.reservation.id)) ??
        (await operations.persistSecuredReservation({ reservation: input.reservation }));
      await scope.publisher.enqueue(toJob(accepted));
      return accepted;
    },
  });
  await stock.promoteAccepted({ ...input, idempotencyTtlSeconds: 86400 });
  return persisted;
}

export class PostgresOrderQueue {
  constructor(sql, leaseMs = 30_000) {
    this.sql = sql;
    this.leaseMs = leaseMs;
  }
  async claim() {
    const [row] = await this.sql`
      with candidate as (
        select q.order_id from proof_queue q join proof_runs l on l.run_id=q.run_id
        where not l.closed and q.next_at<=now()
          and (q.lease_until is null or q.lease_until<=now())
        order by q.next_at,q.order_id for update of q skip locked limit 1
      ) update proof_queue q set lease_until=now()+make_interval(secs=>${this.leaseMs / 1000}),
        generation=q.generation+1,attempts=q.attempts+1 from candidate c
        where q.order_id=c.order_id returning q.*`;
    return row ?? null;
  }
  async renew(claim) {
    return this
      .sql`update proof_queue set lease_until=now()+make_interval(secs=>${this.leaseMs / 1000})
      where order_id=${claim.order_id} and generation=${claim.generation}`;
  }
  async settle(claim, nextAt) {
    if (nextAt) {
      return this
        .sql`update proof_queue set lease_until=null,next_at=${new Date(nextAt).toISOString()}::timestamptz
        where order_id=${claim.order_id} and generation=${claim.generation}`;
    }
    return this.sql`delete from proof_queue where order_id=${claim.order_id}
      and generation=${claim.generation}`;
  }
}

export async function withRunFence(sql, runId, operation) {
  const session = await sql.reserve();
  const key = db.terminalDemoRunTransitionLockKey(runId);
  try {
    await session`select pg_advisory_lock(hashtext(${key}))`;
    return await operation(session);
  } finally {
    try {
      await session`select pg_advisory_unlock(hashtext(${key}))`;
    } finally {
      session.release();
    }
  }
}
