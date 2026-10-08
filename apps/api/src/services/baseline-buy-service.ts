import { randomUUID } from "node:crypto";
import {
  type AcceptedRunConfigSnapshot,
  type BuyRequest,
  type BuyResponse,
  buyResponseSchema,
  erpConfirmationPath,
  erpDispatchSafetyMargin,
} from "@checkout-surge/contracts";
import type { SqlClient } from "@checkout-surge/db";

// Throwaway prototype for the comparative-runs study (backlog 21): the buy path without
// the Redis layer and the queue. PostgreSQL decides the stock with one conditional update,
// and the ERP is called inside the buyer's request, paced at the run's declared capacity.

interface RunContext {
  erpConfig: AcceptedRunConfigSnapshot["erpConfig"];
  pacer: Pacer;
  slots: Semaphore;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Pacer {
  private nextAt = 0;
  constructor(private readonly intervalMs: number) {}
  async acquire(): Promise<void> {
    const now = performance.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.intervalMs;
    if (at > now) await sleep(at - now);
  }
}

class Semaphore {
  private readonly waiters: (() => void)[] = [];
  constructor(private free: number) {}
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free += 1;
  }
}

export class BaselineBuyService {
  private readonly runs = new Map<string, Promise<RunContext>>();
  private table: Promise<unknown> | undefined;
  private readonly confirmationUrl: URL;

  constructor(
    private readonly sql: SqlClient,
    erpBaseUrl: string,
    private readonly holdMinutes: number,
  ) {
    this.confirmationUrl = new URL(erpConfirmationPath, erpBaseUrl);
  }

  async reserve(input: { request: BuyRequest; correlationId: string }): Promise<BuyResponse> {
    const { request, correlationId } = input;
    const run = await this.runContext(request.runId, request.saleOfferId);
    const securedAt = new Date();
    const expiresAt = new Date(securedAt.getTime() + this.holdMinutes * 60_000);
    const reservationId = randomUUID();
    const reservationToken = `res_${randomUUID()}`;
    const publicOrderId = `ord_${randomUUID()}`;
    const quantity = request.quantity;

    const [decision] = await this.sql<{ accepting: boolean; orderId: string | null }[]>`
      with accepting as (
        select 1 from demo_runs
        where id = ${request.runId} and sale_offer_id = ${request.saleOfferId}
          and status in ('starting', 'active')
      ), decided as (
        update baseline_stock set remaining = remaining - ${quantity}
        where sale_offer_id = ${request.saleOfferId} and remaining >= ${quantity}
          and exists (select 1 from accepting)
        returning 1
      ), reservation as (
        insert into reservations (id, sale_offer_id, run_id, quantity, correlation_id,
          reservation_token, secured_at, expires_at)
        select ${reservationId}, ${request.saleOfferId}, ${request.runId}, ${quantity},
          ${correlationId}, ${reservationToken}, ${securedAt.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz
        from decided
        returning id
      ), placed as (
        insert into orders (public_order_id, sale_offer_id, reservation_id, run_id, quantity,
          correlation_id, status, queued_at, processing_at)
        select ${publicOrderId}, ${request.saleOfferId}, id, ${request.runId}, ${quantity},
          ${correlationId}, 'processing', ${securedAt.toISOString()}::timestamptz, ${securedAt.toISOString()}::timestamptz
        from reservation
        returning id
      ), events as (
        insert into order_events (order_id, reservation_id, sale_offer_id, run_id,
          correlation_id, event_name, payload, source, occurred_at)
        select placed.id, ${reservationId}, ${request.saleOfferId}, ${request.runId},
          ${correlationId}, e.name::order_event_name, ${JSON.stringify({ quantity })}::jsonb, 'api',
          ${securedAt.toISOString()}::timestamptz
        from placed cross join (values ('reservation.secured'), ('order.processing')) e(name)
      )
      select exists (select 1 from accepting) as accepting, (select id from placed) as "orderId"`;

    if (!decision?.orderId) {
      return buyResponseSchema.parse({
        outcome: decision?.accepting ? "sold_out" : "run_not_accepting_traffic",
        correlationId,
        timestamp: securedAt.toISOString(),
        reservation: null,
        order: null,
      });
    }

    const orderId = decision.orderId;
    await this.confirmWithErp(run, {
      orderId,
      publicOrderId,
      reservationId,
      saleOfferId: request.saleOfferId,
      runId: request.runId,
      idempotencyKey: `erp-confirmation:${orderId}`,
      erpConfig: run.erpConfig,
      correlationId,
      quantity,
    });

    const confirmedAt = new Date();
    await this.sql`
      with confirmed as (
        update orders set status = 'confirmed', confirmed_at = ${confirmedAt.toISOString()}::timestamptz, updated_at = now()
        where id = ${orderId}
        returning id
      ), notified as (
        insert into simulated_notifications (order_id, sale_offer_id, correlation_id, run_id,
          recipient_placeholder, recorded_at)
        select id, ${request.saleOfferId}, ${correlationId}, ${request.runId},
          ${`simulated-buyer:${publicOrderId}`}, ${confirmedAt.toISOString()}::timestamptz
        from confirmed
      )
      insert into order_events (order_id, reservation_id, sale_offer_id, run_id, correlation_id,
        event_name, payload, source, occurred_at)
      select confirmed.id, ${reservationId}, ${request.saleOfferId}, ${request.runId},
        ${correlationId}, e.name::order_event_name, ${JSON.stringify({ quantity })}::jsonb, 'api',
        ${confirmedAt.toISOString()}::timestamptz
      from confirmed cross join (values ('order.confirmed'), ('notification.recorded')) e(name)`;

    return buyResponseSchema.parse({
      outcome: "reservation_secured",
      correlationId,
      timestamp: securedAt.toISOString(),
      reservation: {
        id: reservationId,
        saleOfferId: request.saleOfferId,
        correlationId,
        runId: request.runId,
        quantity,
        reservationToken,
        expiresAt: expiresAt.toISOString(),
        securedAt: securedAt.toISOString(),
      },
      // The accepted contract only knows "queued"; the order is already confirmed here.
      order: {
        id: orderId,
        publicOrderId,
        saleOfferId: request.saleOfferId,
        reservationId,
        correlationId,
        runId: request.runId,
        quantity,
        status: "queued",
        queuedAt: securedAt.toISOString(),
      },
    });
  }

  // Paced at the declared capacity (same margin and concurrency as the worker); a capacity
  // or availability answer is retried after its Retry-After, with the same idempotency key.
  private async confirmWithErp(run: RunContext, body: Record<string, unknown>): Promise<void> {
    for (;;) {
      await run.slots.acquire();
      let response: Response;
      try {
        await run.pacer.acquire();
        response = await fetch(this.confirmationUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        await response.arrayBuffer();
      } catch {
        await sleep(1_000);
        continue;
      } finally {
        run.slots.release();
      }
      if (response.ok) return;
      if (response.status === 429 || response.status >= 500) {
        await sleep(Number(response.headers.get("retry-after") ?? "1") * 1_000);
        continue;
      }
      throw new Error(`ERP confirmation failed with HTTP ${response.status}.`);
    }
  }

  private runContext(runId: string, saleOfferId: string): Promise<RunContext> {
    let context = this.runs.get(runId);
    if (!context) {
      context = this.loadRunContext(runId, saleOfferId);
      context.catch(() => this.runs.delete(runId));
      this.runs.set(runId, context);
    }
    return context;
  }

  private async loadRunContext(runId: string, saleOfferId: string): Promise<RunContext> {
    this.table ??= this.sql`
      create table if not exists baseline_stock (
        sale_offer_id uuid primary key,
        remaining integer not null check (remaining >= 0)
      )`;
    await this.table;
    await this.sql`
      insert into baseline_stock (sale_offer_id, remaining)
      select id, allocated_stock from sale_offers where id = ${saleOfferId}
      on conflict do nothing`;
    const [row] = await this.sql<{ snapshot: AcceptedRunConfigSnapshot }[]>`
      select config_snapshot as snapshot from demo_runs where id = ${runId}`;
    if (!row) throw new Error(`Run ${runId} was not found.`);
    const { erpConfig, backpressureConfig } = row.snapshot;
    const ratePerSecond = erpConfig.maxTps * (1 - erpDispatchSafetyMargin);
    return {
      erpConfig,
      pacer: new Pacer(1_000 / ratePerSecond),
      slots: new Semaphore(backpressureConfig.orderProcessConcurrency),
    };
  }
}
