import {
  applyInventoryCountBatch,
  type BusinessOutcomePublicationScheduler,
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  markReservationPendingPersistence,
  promoteReservationIdempotencyToAccepted,
  reserveInventoryStock,
  reverseReservation,
  type SqlClient,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { BatchedInventoryCounts } from "../services/batched-inventory-counts.js";
import type { DashboardSourceDirtyScheduler } from "../services/dashboard-source-dirty-scheduler.js";
import {
  OrderConfirmationWaiter,
  PostgresOrderConfirmationReader,
} from "../services/order-confirmation-waiter.js";
import type { OrderProcessJobPublisher } from "../services/order-process-job-publisher.js";
import type { PostgresBuyPersistence } from "../services/postgres-buy-persistence.js";
import { PostgresStockBuyService } from "../services/postgres-stock-buy-service.js";
import { PostgresStockPersistence } from "../services/postgres-stock-persistence.js";
import type { ReservationTimingObservationScheduler } from "../services/reservation-timing-observation.js";
import {
  type BusinessOutcomeUpdateFailureReport,
  type OrderEnqueueFailureReport,
  type PendingPersistenceRecovery,
  type ReservationPartialFailureReport,
  ReserveOrderService,
  type StockReservationGateway,
} from "../services/reserve-order-service.js";
import { SynchronousConfirmationBuyService } from "../services/synchronous-confirmation-buy-service.js";
import type { ApiConfig } from "./config.js";

export function createStockReservationGateway(redis: CheckoutSurgeRedis): StockReservationGateway {
  return {
    reserve: (input) => reserveInventoryStock(redis, input),
    markPendingPersistence: (input) => markReservationPendingPersistence(redis, input),
    promoteAccepted: (input) =>
      promoteReservationIdempotencyToAccepted(redis, input).then(() => undefined),
    reverse: (input) => reverseReservation(redis, input),
  };
}

/**
 * The buy routes' services, built the same way in the control API and in a buy-only process:
 * the normal path, the path that waits for confirmation, and the path where PostgreSQL decides
 * the stock.
 */
export function createBuyPath(deps: {
  config: Pick<
    ApiConfig,
    "reservationHoldMinutes" | "idempotencyTtlSeconds" | "pendingPersistenceRetryAfterSeconds"
  >;
  logger: CheckoutSurgeLogger;
  db: CheckoutSurgeDatabase;
  sql: SqlClient;
  redis: CheckoutSurgeRedis;
  persistence: PostgresBuyPersistence;
  stockReservations: StockReservationGateway;
  orderProcessJobPublisher: OrderProcessJobPublisher;
  pendingPersistenceRecovery: PendingPersistenceRecovery;
  dashboardSourceDirtyScheduler: DashboardSourceDirtyScheduler;
  businessOutcomePublications: BusinessOutcomePublicationScheduler;
  reservationTiming: ReservationTimingObservationScheduler;
}) {
  const { config, logger } = deps;
  const inventoryCounts = new BatchedInventoryCounts({
    apply: (batch) => applyInventoryCountBatch(deps.redis, batch),
    onError: (error, batch) => {
      logger.warn(
        { err: error, runId: batch.runId, saleOfferId: batch.saleOfferId },
        "Could not add batched inventory counts to the run's live counters.",
      );
    },
  });
  const reserveOrderService = new ReserveOrderService({
    persistence: deps.persistence,
    orderProcessJobPublisher: deps.orderProcessJobPublisher,
    stockReservations: deps.stockReservations,
    reservationHoldMinutes: config.reservationHoldMinutes,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    pendingPersistenceRetryAfterSeconds: config.pendingPersistenceRetryAfterSeconds,
    pendingPersistenceRecovery: deps.pendingPersistenceRecovery,
    dashboardSourceDirtyScheduler: deps.dashboardSourceDirtyScheduler,
    soldOutObservations: deps.dashboardSourceDirtyScheduler,
    reservationTimingObservations: deps.reservationTiming,
    reportPersistenceFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Redis secured a reservation but PostgreSQL persistence failed.",
      );
    },
    reportPendingPersistenceEnsureFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Could not ensure the Redis pending-persistence marker.",
      );
    },
    reportPromotionFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Durable reservation succeeded but Redis idempotency promotion failed.",
      );
    },
    reportOrderEnqueueFailure: (report) => {
      logger.error(
        orderEnqueueFailureLogContext(report),
        "Durable reservation succeeded but order-processing enqueue failed.",
      );
    },
    reportReservationReversalFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Could not reverse a definitively rejected Redis reservation hold.",
      );
    },
    publishBusinessOutcomeUpdate: async (input) =>
      deps.businessOutcomePublications.markDirty(input),
    scheduleBusinessOutcomeUpdate: (task) => task(),
    reportBusinessOutcomeUpdateFailure: (report) => {
      logger.error(
        businessOutcomeUpdateFailureLogContext(report),
        "Durable reservation succeeded but dashboard business outcome publication failed.",
      );
    },
  });
  const confirmationWaiter = new OrderConfirmationWaiter({
    reader: new PostgresOrderConfirmationReader(deps.db),
    onReadError: (error) => {
      logger.warn({ err: error }, "Could not read the confirmations of waiting buy requests.");
    },
  });
  return {
    inventoryCounts,
    confirmationWaiter,
    reserveOrderService,
    synchronousConfirmationBuyService: new SynchronousConfirmationBuyService({
      reserveOrderService,
      waiter: confirmationWaiter,
    }),
    postgresStockBuyService: new PostgresStockBuyService({
      stock: new PostgresStockPersistence(deps.db, deps.sql, deps.persistence),
      counts: inventoryCounts,
      reservationHoldMinutes: config.reservationHoldMinutes,
      dashboardSourceDirtyScheduler: deps.dashboardSourceDirtyScheduler,
      soldOutObservations: deps.dashboardSourceDirtyScheduler,
      businessOutcomeUpdates: deps.businessOutcomePublications,
      reservationTimingObservations: deps.reservationTiming,
    }),
  };
}

function orderEnqueueFailureLogContext(report: OrderEnqueueFailureReport) {
  return {
    ...partialFailureLogContext(report),
    orderId: report.orderId,
  };
}

function partialFailureLogContext(report: ReservationPartialFailureReport) {
  return {
    err: report.error,
    reservationId: report.reservationId,
    saleOfferId: report.saleOfferId,
    runId: report.runId,
    correlationId: report.correlationId,
    idempotencyKey: report.idempotencyKey,
  };
}

function businessOutcomeUpdateFailureLogContext(report: BusinessOutcomeUpdateFailureReport) {
  return {
    err: report.error,
    saleOfferId: report.saleOfferId,
    runId: report.runId,
    correlationId: report.correlationId,
  };
}
