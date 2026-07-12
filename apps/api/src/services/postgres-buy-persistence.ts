import { randomUUID } from "node:crypto";
import type {
  OrderSummary,
  ReservationSummary,
  SecuredReservationHold,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  createDatabase,
  demoRuns,
  orderEvents,
  orders,
  reservationPendingPersistence,
  reservations,
  type SqlClient,
} from "@checkout-surge/db";
import { eq } from "drizzle-orm";
import {
  type BuyPersistence,
  type BuyPersistenceOperations,
  DefinitivePersistenceRejectionError,
  type PersistedBuy,
  TerminalRunPersistenceRejectionError,
} from "./reserve-order-service.js";
import { terminalDemoRunTransitionLockKey } from "./terminal-demo-run-transition.js";

const acceptingPersistenceRunStatuses = new Set(["starting", "active", "draining"]);
type PostgresTransaction = Parameters<Parameters<CheckoutSurgeDatabase["transaction"]>[0]>[0];
type DatabaseWithClient = CheckoutSurgeDatabase & { $client: SqlClient };
type ReservedClient = Awaited<ReturnType<SqlClient["reserve"]>>;

export class PostgresBuyPersistence implements BuyPersistence {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async persistSecuredReservation(input: {
    reservation: SecuredReservationHold;
  }): Promise<PersistedBuy> {
    return this.databaseOperations(this.db).persistSecuredReservation(input);
  }

  private async persistSecuredReservationInTransaction(
    tx: PostgresTransaction,
    hold: SecuredReservationHold,
  ): Promise<PersistedBuy> {
    if (hold.runId) {
      const [run] = await tx
        .select({ saleOfferId: demoRuns.saleOfferId, status: demoRuns.status })
        .from(demoRuns)
        .where(eq(demoRuns.id, hold.runId))
        .limit(1)
        .for("update");
      if (!run || run.saleOfferId !== hold.saleOfferId) {
        throw new DefinitivePersistenceRejectionError();
      }
      if (!acceptingPersistenceRunStatuses.has(run.status)) {
        throw new TerminalRunPersistenceRejectionError();
      }
    }

    const [reservation] = await tx
      .insert(reservations)
      .values({
        id: hold.id,
        saleOfferId: hold.saleOfferId,
        ...(hold.runId ? { runId: hold.runId } : {}),
        quantity: hold.quantity,
        correlationId: hold.correlationId,
        status: "secured",
        reservationToken: hold.reservationToken,
        securedAt: new Date(hold.securedAt),
        expiresAt: new Date(hold.expiresAt),
      })
      .returning({
        id: reservations.id,
        saleOfferId: reservations.saleOfferId,
        correlationId: reservations.correlationId,
        runId: reservations.runId,
        quantity: reservations.quantity,
        status: reservations.status,
        reservationToken: reservations.reservationToken,
        expiresAt: reservations.expiresAt,
        securedAt: reservations.securedAt,
      });

    if (!reservation) {
      throw new Error("Failed to persist reservation.");
    }

    const [order] = await tx
      .insert(orders)
      .values({
        publicOrderId: `ord_${randomUUID()}`,
        saleOfferId: hold.saleOfferId,
        reservationId: reservation.id,
        ...(hold.runId ? { runId: hold.runId } : {}),
        quantity: hold.quantity,
        correlationId: hold.correlationId,
        status: "queued",
        queuedAt: new Date(hold.securedAt),
      })
      .returning({
        id: orders.id,
        publicOrderId: orders.publicOrderId,
        saleOfferId: orders.saleOfferId,
        reservationId: orders.reservationId,
        correlationId: orders.correlationId,
        runId: orders.runId,
        quantity: orders.quantity,
        status: orders.status,
        failureCode: orders.failureCode,
        failureMessage: orders.failureMessage,
        queuedAt: orders.queuedAt,
        processingAt: orders.processingAt,
        confirmedAt: orders.confirmedAt,
        failedAt: orders.failedAt,
      });

    if (!order) {
      throw new Error("Failed to persist order.");
    }

    await tx.insert(orderEvents).values([
      {
        orderId: order.id,
        reservationId: reservation.id,
        saleOfferId: hold.saleOfferId,
        ...(hold.runId ? { runId: hold.runId } : {}),
        correlationId: hold.correlationId,
        eventName: "reservation.secured",
        payload: {
          quantity: hold.quantity,
          reservationStatus: "secured",
        },
        source: "api",
        occurredAt: new Date(hold.securedAt),
      },
      {
        orderId: order.id,
        reservationId: reservation.id,
        saleOfferId: hold.saleOfferId,
        ...(hold.runId ? { runId: hold.runId } : {}),
        correlationId: hold.correlationId,
        eventName: "order.queued",
        payload: {
          quantity: hold.quantity,
          orderStatus: "queued",
        },
        source: "api",
        occurredAt: new Date(hold.securedAt),
      },
    ]);

    await tx
      .update(reservationPendingPersistence)
      .set({
        status: "reconciled",
        updatedAt: new Date(),
      })
      .where(eq(reservationPendingPersistence.reservationId, reservation.id));

    return {
      reservation: toReservationSummary(reservation),
      order: toOrderSummary(order),
    };
  }

  async withRunAdmissionLock<T>(input: {
    reservation: SecuredReservationHold;
    operation: (persistence: BuyPersistenceOperations) => Promise<T>;
  }): Promise<T> {
    const runId = input.reservation.runId;
    if (!runId) {
      return input.operation(this);
    }

    const client = (this.db as DatabaseWithClient).$client;
    const reservedClient = await client.reserve();
    // postgres-js ReservedSql intentionally omits pool options at runtime, but
    // Drizzle's Postgres.js adapter uses the parser/serializer maps while
    // constructing a database facade. Reuse the base client's maps on the
    // reserved session; all queries still execute on the reserved connection.
    Object.defineProperty(reservedClient, "options", { value: client.options });
    const reservedDb = createDatabase(reservedClient as SqlClient);
    let locked = false;
    try {
      await reservedClient`select pg_advisory_lock(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`;
      locked = true;
      const [run] = await reservedDb
        .select({ saleOfferId: demoRuns.saleOfferId, status: demoRuns.status })
        .from(demoRuns)
        .where(eq(demoRuns.id, runId))
        .limit(1);
      if (!run || run.saleOfferId !== input.reservation.saleOfferId) {
        throw new DefinitivePersistenceRejectionError();
      }
      if (!acceptingPersistenceRunStatuses.has(run.status)) {
        throw new TerminalRunPersistenceRejectionError();
      }

      // Each persistence operation commits on the reserved session while this
      // session-level advisory lock remains held through BullMQ enqueue.
      return await input.operation(this.databaseOperations(reservedDb, reservedClient));
    } finally {
      try {
        if (locked) {
          await reservedClient`select pg_advisory_unlock(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`;
        }
      } finally {
        reservedClient.release();
      }
    }
  }

  async getPersistedBuyByReservationId(reservationId: string): Promise<PersistedBuy | null> {
    return this.databaseOperations(this.db).getPersistedBuyByReservationId(reservationId);
  }

  async recordPendingPersistence(input: {
    reservation: SecuredReservationHold;
    idempotencyKey: string;
  }): Promise<void> {
    await this.databaseOperations(this.db).recordPendingPersistence?.(input);
  }

  private async recordPendingPersistenceInTransaction(
    tx: PostgresTransaction,
    input: {
      reservation: SecuredReservationHold;
      idempotencyKey: string;
    },
  ): Promise<void> {
    const hold = input.reservation;
    const now = new Date();

    await tx
      .insert(reservationPendingPersistence)
      .values({
        reservationId: hold.id,
        saleOfferId: hold.saleOfferId,
        correlationId: hold.correlationId,
        ...(hold.runId ? { runId: hold.runId } : {}),
        idempotencyKey: input.idempotencyKey,
        quantity: hold.quantity,
        reservationToken: hold.reservationToken,
        status: "pending_reconciliation",
        securedAt: new Date(hold.securedAt),
        expiresAt: new Date(hold.expiresAt),
      })
      .onConflictDoUpdate({
        target: reservationPendingPersistence.reservationId,
        set: {
          saleOfferId: hold.saleOfferId,
          correlationId: hold.correlationId,
          runId: hold.runId ?? null,
          idempotencyKey: input.idempotencyKey,
          quantity: hold.quantity,
          reservationToken: hold.reservationToken,
          status: "pending_reconciliation",
          securedAt: new Date(hold.securedAt),
          expiresAt: new Date(hold.expiresAt),
          updatedAt: now,
        },
      });
  }

  async markPendingPersistenceReconciled(input: { reservationId: string }): Promise<void> {
    await this.databaseOperations(this.db).markPendingPersistenceReconciled?.(input);
  }

  private async markPendingPersistenceReconciledInTransaction(
    tx: PostgresTransaction,
    input: { reservationId: string },
  ): Promise<void> {
    await tx
      .update(reservationPendingPersistence)
      .set({
        status: "reconciled",
        updatedAt: new Date(),
      })
      .where(eq(reservationPendingPersistence.reservationId, input.reservationId));
  }

  private databaseOperations(
    database: CheckoutSurgeDatabase,
    reservedClient?: ReservedClient,
  ): BuyPersistenceOperations {
    const runTransaction = <T>(operation: (tx: PostgresTransaction) => Promise<T>): Promise<T> => {
      if (reservedClient) {
        return this.runReservedTransaction(reservedClient, () =>
          operation(database as unknown as PostgresTransaction),
        );
      }
      return database.transaction(operation);
    };

    return {
      persistSecuredReservation: (input) =>
        runTransaction((tx) => this.persistSecuredReservationInTransaction(tx, input.reservation)),
      getPersistedBuyByReservationId: (reservationId) =>
        this.getPersistedBuyByReservationIdInDatabase(database, reservationId),
      recordPendingPersistence: (input) =>
        runTransaction((tx) => this.recordPendingPersistenceInTransaction(tx, input)),
      markPendingPersistenceReconciled: (input) =>
        runTransaction((tx) => this.markPendingPersistenceReconciledInTransaction(tx, input)),
    };
  }

  private async runReservedTransaction<T>(
    client: ReservedClient,
    operation: () => Promise<T>,
  ): Promise<T> {
    await client`begin`;
    try {
      const result = await operation();
      await client`commit`;
      return result;
    } catch (error) {
      try {
        await client`rollback`;
      } catch {
        // Preserve the original persistence error; the reserved session is
        // released by the outer finally regardless of rollback failure.
      }
      throw error;
    }
  }

  private async getPersistedBuyByReservationIdInDatabase(
    database: CheckoutSurgeDatabase,
    reservationId: string,
  ): Promise<PersistedBuy | null> {
    const [row] = await database
      .select({ reservation: reservations, order: orders })
      .from(reservations)
      .innerJoin(orders, eq(orders.reservationId, reservations.id))
      .where(eq(reservations.id, reservationId))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      reservation: toReservationSummary(row.reservation),
      order: toOrderSummary(row.order),
    };
  }
}

function toReservationSummary(row: {
  id: string;
  saleOfferId: string;
  correlationId: string;
  runId: string | null;
  quantity: number;
  status: ReservationSummary["status"];
  reservationToken: string;
  expiresAt: Date;
  securedAt: Date;
}): ReservationSummary {
  return {
    id: row.id,
    saleOfferId: row.saleOfferId,
    correlationId: row.correlationId,
    ...(row.runId ? { runId: row.runId } : {}),
    quantity: row.quantity,
    status: row.status,
    reservationToken: row.reservationToken,
    expiresAt: row.expiresAt.toISOString(),
    securedAt: row.securedAt.toISOString(),
  };
}

function toOrderSummary(row: {
  id: string;
  publicOrderId: string;
  saleOfferId: string;
  reservationId: string;
  correlationId: string;
  runId: string | null;
  quantity: number;
  status: OrderSummary["status"];
  failureCode: string | null;
  failureMessage: string | null;
  queuedAt: Date;
  processingAt: Date | null;
  confirmedAt: Date | null;
  failedAt: Date | null;
}): OrderSummary {
  return {
    id: row.id,
    publicOrderId: row.publicOrderId,
    saleOfferId: row.saleOfferId,
    reservationId: row.reservationId,
    correlationId: row.correlationId,
    ...(row.runId ? { runId: row.runId } : {}),
    quantity: row.quantity,
    status: row.status,
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
    ...(row.failureMessage ? { failureMessage: row.failureMessage } : {}),
    queuedAt: row.queuedAt.toISOString(),
    ...(row.processingAt ? { processingAt: row.processingAt.toISOString() } : {}),
    ...(row.confirmedAt ? { confirmedAt: row.confirmedAt.toISOString() } : {}),
    ...(row.failedAt ? { failedAt: row.failedAt.toISOString() } : {}),
  };
}
