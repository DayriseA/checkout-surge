import { type OrderProcessJob, orderProcessJobSchema } from "@checkout-surge/contracts";
import type postgres from "postgres";
import type { SqlClient } from "./client.js";

export interface PostgresOrderDeliveryClaim {
  publicationId: string;
  deliveryGeneration: number;
  job: OrderProcessJob;
}

/** Unwired transport leases. Business processing ownership remains on the order. */
export class PostgresOrderDelivery {
  constructor(private readonly sql: SqlClient) {}

  /** Use the caller's admission session; never acquire another pooled connection. */
  async publish(
    session: SqlClient,
    input: OrderProcessJob,
    options: { jobId?: string; dueAt?: Date } = {},
  ): Promise<void> {
    const job = orderProcessJobSchema.parse(input);
    await session`insert into postgres_order_deliveries(publication_id,run_id,payload,due_at)
      values(${options.jobId ?? job.orderId},${job.runId},${JSON.stringify(job)}::jsonb,
        ${(options.dueAt ?? new Date()).toISOString()}::timestamptz)
      on conflict(publication_id) do update set
        payload=excluded.payload,due_at=excluded.due_at,lease_until=null,settled_at=null,
        delivery_generation=postgres_order_deliveries.delivery_generation+1
      where postgres_order_deliveries.settled_at is not null
        and postgres_order_deliveries.run_id=excluded.run_id`;
  }

  async claim(input: {
    limit: number;
    leaseSeconds: number;
  }): Promise<PostgresOrderDeliveryClaim[]> {
    positiveInteger(input.limit);
    positiveInteger(input.leaseSeconds);
    // Terminal runs can lose their last ACK. Reclaim only work whose business
    // and notification obligations are already durable; the handler then returns early.
    return this.sql.begin(async (tx) => {
      const rows = await tx`with candidates as (
        select d.publication_id from postgres_order_deliveries d
        join demo_runs r on r.id=d.run_id
        where r.execution_mode='without_redis' and (
          r.status in ('starting','active','draining') or (
            r.status in ('completed','failed') and exists (
              select 1 from orders o
              where o.id=(d.payload->>'orderId')::uuid and o.run_id=d.run_id
                and o.run_id::text=d.payload->>'runId'
                and o.public_order_id=d.payload->>'publicOrderId'
                and o.reservation_id::text=d.payload->>'reservationId'
                and o.sale_offer_id::text=d.payload->>'saleOfferId'
                and o.correlation_id=d.payload->>'correlationId'
                and to_jsonb(o.quantity)=d.payload->'quantity'
                and o.queued_at=(d.payload->>'queuedAt')::timestamptz
                and o.status in ('confirmed','failed')
                and (o.status='failed' or exists (
                  select 1 from simulated_notifications n where n.order_id=o.id
                    and n.run_id=o.run_id and n.sale_offer_id=o.sale_offer_id
                    and n.correlation_id=o.correlation_id
                ))
                and not exists (select 1 from erp_dispatch_calls e
                  where e.order_id=o.id and e.resolved_at is null)
                and not exists (select 1 from order_recovery_jobs c
                  where c.order_id=o.id and (c.status<>'resolved'
                    or c.unresolved_erp_call_id is not null))
            )
          )
        )
          and d.settled_at is null and d.due_at<=clock_timestamp()
          and (d.lease_until is null or d.lease_until<=clock_timestamp())
        order by d.due_at,d.publication_id limit ${input.limit} for update of d skip locked
      ) update postgres_order_deliveries d set delivery_generation=d.delivery_generation+1,
          lease_until=clock_timestamp()+make_interval(secs=>${input.leaseSeconds})
        from candidates c where d.publication_id=c.publication_id
        returning d.publication_id,d.delivery_generation,d.payload`;
      return rows.map((row) => ({
        publicationId: row.publication_id as string,
        deliveryGeneration: row.delivery_generation as number,
        job: orderProcessJobSchema.parse(row.payload),
      }));
    });
  }

  async renew(claim: PostgresOrderDeliveryClaim, leaseSeconds: number): Promise<boolean> {
    positiveInteger(leaseSeconds);
    return this.withClaimLock(claim, async (tx) => {
      const rows = await tx`update postgres_order_deliveries
      set lease_until=clock_timestamp()+make_interval(secs=>${leaseSeconds})
      where publication_id=${claim.publicationId} and delivery_generation=${claim.deliveryGeneration}
        and settled_at is null and lease_until>clock_timestamp() returning publication_id`;
      return rows.length === 1;
    });
  }

  async settle(claim: PostgresOrderDeliveryClaim): Promise<boolean> {
    // Retain the generation across settlement/republication to prevent stale ACK ABA.
    return this.withClaimLock(claim, async (tx) => {
      const rows = await tx`update postgres_order_deliveries
      set settled_at=clock_timestamp(),lease_until=null
      where publication_id=${claim.publicationId} and delivery_generation=${claim.deliveryGeneration}
        and settled_at is null and lease_until>clock_timestamp() returning publication_id`;
      return rows.length === 1;
    });
  }

  private async withClaimLock(
    claim: PostgresOrderDeliveryClaim,
    operation: (tx: postgres.TransactionSql) => Promise<boolean>,
  ): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`select publication_id from postgres_order_deliveries
        where publication_id=${claim.publicationId} and delivery_generation=${claim.deliveryGeneration}
        for update`;
      // Freshness must be checked in a later command: even a duplicate publication
      // can hold this row lock without changing the tuple until the lease expires.
      return rows.length === 1 ? operation(tx) : false;
    });
  }
}

function positiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Expected a positive integer.");
}
