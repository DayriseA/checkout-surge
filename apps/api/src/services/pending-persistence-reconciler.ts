import {
  idempotencyKeySchema,
  type OrderProcessJob,
  type SecuredReservationHold,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeRedis,
  deferPendingPersistenceIndexMember,
  pendingPersistenceIndexKey,
  readPendingPersistenceRecords,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { OrderProcessJobPublisher } from "./order-process-job-publisher.js";
import type {
  BuyPersistence,
  PersistedBuy,
  StockReservationGateway,
} from "./reserve-order-service.js";
import { isDefinitivePersistenceRejection } from "./reserve-order-service.js";

export interface PendingPersistenceReconciliationSummary {
  found: number;
  materialized: number;
  reconciled: number;
  reversed: number;
  failed: number;
}

/**
 * Re-drives the durable reservation -> deterministic queue -> Redis accepted
 * handoff. It deliberately does not call ReserveOrderService.reserve(), since
 * generated-run admission is closed by the time this service runs.
 */
export class PendingPersistenceReconciler {
  constructor(
    private readonly options: {
      redis: CheckoutSurgeRedis;
      persistence: BuyPersistence;
      stockReservations: Pick<StockReservationGateway, "promoteAccepted"> &
        Partial<Pick<StockReservationGateway, "reverse">>;
      orderProcessJobPublisher: OrderProcessJobPublisher;
      logger: CheckoutSurgeLogger;
      batchSize?: number;
      now?: () => Date;
    },
  ) {}

  async reconcileSaleOffer(
    saleOfferId: string,
    input: { runId?: string } = {},
  ): Promise<PendingPersistenceReconciliationSummary> {
    const records = await readPendingPersistenceRecords(this.options.redis, {
      saleOfferId,
      limit: this.options.batchSize ?? 100,
    });
    const candidates = input.runId
      ? records.filter((record) => record.runId === input.runId)
      : records;
    const summary: PendingPersistenceReconciliationSummary = {
      found: candidates.length,
      materialized: 0,
      reconciled: 0,
      reversed: 0,
      failed: 0,
    };

    for (const record of candidates) {
      try {
        const result = await this.reconcileRecord(
          {
            id: record.id,
            saleOfferId: record.saleOfferId,
            correlationId: record.correlationId,
            ...(record.runId ? { runId: record.runId } : {}),
            quantity: record.quantity,
            status: "secured",
            reservationToken: record.reservationToken,
            securedAt: record.securedAt,
            expiresAt: record.expiresAt,
          },
          idempotencyKeySchema.parse(record.idempotencyKey),
        );
        if (result.status === "reversed") {
          summary.reversed += 1;
        } else {
          summary.reconciled += 1;
          if (result.materialized) {
            summary.materialized += 1;
          }
        }
      } catch (error) {
        summary.failed += 1;
        this.options.logger.warn(
          {
            err: error,
            saleOfferId: record.saleOfferId,
            reservationId: record.id,
            ...(record.runId ? { runId: record.runId } : {}),
            correlationId: record.correlationId,
          },
          "Pending Redis reservation reconciliation remains retryable.",
        );
      }
    }

    if (summary.found > 0) {
      this.options.logger.info(
        { saleOfferId, ...summary },
        "Pending Redis reservation reconciliation completed.",
      );
    }
    return summary;
  }

  async reconcileAll(): Promise<PendingPersistenceReconciliationSummary> {
    // The normal lifecycle invokes reconcileSaleOffer for known run sale offers.
    // This method is also useful at startup for catalog records. The global
    // index is intentionally read through a bounded Redis command, never SCAN.
    const scanLimit = Math.max((this.options.batchSize ?? 100) * 10, 100);
    const indexMembers = await this.options.redis.zrange(
      pendingPersistenceIndexKey,
      0,
      scanLimit - 1,
    );
    const membersBySaleOffer = new Map<string, string[]>();
    for (const member of indexMembers) {
      const separator = member.indexOf(":");
      if (separator > 0) {
        const saleOfferId = member.slice(0, separator);
        const members = membersBySaleOffer.get(saleOfferId) ?? [];
        members.push(member);
        membersBySaleOffer.set(saleOfferId, members);
      } else {
        // No valid namespaced marker can be represented by this member.
        await this.options.redis.zrem(pendingPersistenceIndexKey, member);
      }
    }

    const total: PendingPersistenceReconciliationSummary = {
      found: 0,
      materialized: 0,
      reconciled: 0,
      reversed: 0,
      failed: 0,
    };
    for (const [saleOfferId, members] of membersBySaleOffer) {
      const records = await readPendingPersistenceRecords(this.options.redis, {
        saleOfferId,
        limit: scanLimit,
      });
      const validIds = new Set(records.map((record) => record.id));
      await Promise.all(
        members
          .filter((member) => !validIds.has(member.slice(member.indexOf(":") + 1)))
          .map((member) =>
            deferPendingPersistenceIndexMember(this.options.redis, {
              saleOfferId,
              reservationId: member.slice(member.indexOf(":") + 1),
              now: this.now(),
            }),
          ),
      );
      const result = await this.reconcileSaleOffer(saleOfferId);
      total.found += result.found;
      total.materialized += result.materialized;
      total.reconciled += result.reconciled;
      total.reversed += result.reversed;
      total.failed += result.failed;
    }
    return total;
  }

  private async reconcileRecord(
    reservation: SecuredReservationHold,
    idempotencyKey: string,
  ): Promise<{ status: "reconciled" | "reversed"; materialized: boolean }> {
    let persisted = await this.options.persistence.getPersistedBuyByReservationId(reservation.id);
    let materialized = false;

    if (!persisted) {
      try {
        persisted = await this.options.persistence.persistSecuredReservation({ reservation });
        materialized = true;
      } catch (error) {
        // Concurrent request/reconciler may have committed between the read and
        // insert. Re-read before classifying the original write as a failure.
        persisted = await this.options.persistence.getPersistedBuyByReservationId(reservation.id);
        if (!persisted) {
          if (isDefinitivePersistenceRejection(error) && this.options.stockReservations.reverse) {
            await this.options.stockReservations.reverse({
              idempotencyKey,
              reservation,
              occurredAt: this.now(),
            });
            await this.markPendingReconciled(reservation.id);
            return { status: "reversed", materialized: false };
          }
          throw error;
        }
      }
    }

    await this.options.orderProcessJobPublisher.enqueue(toOrderProcessJob(persisted));
    // Marking the durable pending row before promotion keeps Redis discoverable
    // if the promotion fails; Redis is the final source of truth for pending
    // stock and will be retried by the next reconciliation pass.
    await this.markPendingReconciled(reservation.id);
    await this.options.stockReservations.promoteAccepted({ idempotencyKey, reservation });
    return { status: "reconciled", materialized };
  }

  private async markPendingReconciled(reservationId: string): Promise<void> {
    if (!this.options.persistence.markPendingPersistenceReconciled) {
      return;
    }
    await this.options.persistence.markPendingPersistenceReconciled({ reservationId });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function toOrderProcessJob(persisted: PersistedBuy): OrderProcessJob {
  return {
    orderId: persisted.order.id,
    publicOrderId: persisted.order.publicOrderId,
    reservationId: persisted.order.reservationId,
    saleOfferId: persisted.order.saleOfferId,
    correlationId: persisted.order.correlationId,
    ...(persisted.order.runId ? { runId: persisted.order.runId } : {}),
    quantity: persisted.order.quantity,
    queuedAt: persisted.order.queuedAt,
  };
}
