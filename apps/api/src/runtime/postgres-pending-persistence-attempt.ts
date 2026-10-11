import {
  type DatabaseConnection,
  PostgresOrderDelivery,
  PostgresStockReservations,
} from "@checkout-surge/db";
import type { PendingPersistenceAttemptScope } from "../services/pending-persistence-recovery-service.js";
import { PostgresBuyPersistence } from "../services/postgres-buy-persistence.js";
import { createSessionBoundBuyAcceptance } from "../services/session-bound-buy-acceptance.js";

/** Unwired composition seam. The caller owns the operation connection and cancellation. */
export function createPostgresPendingPersistenceAttempt(input: {
  database: DatabaseConnection;
  signal: AbortSignal;
  close(): Promise<void>;
}): PendingPersistenceAttemptScope {
  const persistence = new PostgresBuyPersistence(input.database.db, input.signal);
  const delivery = new PostgresOrderDelivery(input.database.sql);
  const acceptance = createSessionBoundBuyAcceptance({
    persistence,
    publish: (session, job) => delivery.publish(session, job),
  });
  return {
    persistence: acceptance.persistence,
    audit: {
      recordAttempt: (value) => persistence.recordPendingPersistenceAttempt(value),
      markResolved: (value) => persistence.markPendingPersistenceResolved(value),
      markExhausted: (value) => persistence.markPendingPersistenceExhausted(value),
    },
    // Recovery promotes after the admission callback releases its reserved session.
    stockReservations: new PostgresStockReservations(input.database.sql),
    orderProcessJobPublisher: acceptance.publisher,
    close: input.close,
  };
}
