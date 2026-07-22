import { randomUUID } from "node:crypto";
import type {
  AcceptedOrderSummary,
  AcceptedReservationSummary,
  SecuredReservationHold,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  createAbortableSqlClient,
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
  isPersistedBuyForReservation,
  type PersistedBuyAcceptance,
  TerminalRunPersistenceRejectionError,
} from "./reserve-order-service.js";
import { terminalDemoRunTransitionLockKey } from "./terminal-demo-run-transition.js";

const acceptingPersistenceRunStatuses = new Set(["starting", "active", "draining"]);
const recoverableReservationConstraints = new Set([
  "reservations_pkey",
  "reservations_reservation_token_unique",
]);
type PostgresTransaction = Parameters<Parameters<CheckoutSurgeDatabase["transaction"]>[0]>[0];
type DatabaseWithClient = CheckoutSurgeDatabase & { $client: SqlClient };
type ReservedClient = Awaited<ReturnType<SqlClient["reserve"]>>;

export class PostgresBuyPersistence implements BuyPersistence {
  constructor(
    private readonly db: CheckoutSurgeDatabase,
    private readonly signal?: AbortSignal,
  ) {}

  async persistSecuredReservation(input: {
    reservation: SecuredReservationHold;
  }): Promise<PersistedBuyAcceptance> {
    return this.databaseOperations(this.db).persistSecuredReservation(input);
  }

  private async persistSecuredReservationInTransaction(
    tx: PostgresTransaction,
    hold: SecuredReservationHold,
    runAdmissionVerified = false,
  ): Promise<PersistedBuyAcceptance> {
    if (hold.runId && !runAdmissionVerified) {
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
        queuedAt: orders.queuedAt,
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
        },
        source: "api",
        occurredAt: new Date(hold.securedAt),
      },
    ]);

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
    const operationClient = this.operationClient(reservedClient);
    const reservedDb = createDatabase(operationClient);
    let locked = false;
    try {
      await operationClient`select pg_advisory_lock_shared(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`;
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
      // shared session-level advisory lock remains held through BullMQ enqueue.
      // The callback must not check out another connection from the base pool.
      return await input.operation(this.databaseOperations(reservedDb, operationClient));
    } finally {
      try {
        if (locked) {
          await operationClient`select pg_advisory_unlock_shared(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`;
        }
      } finally {
        reservedClient.release();
      }
    }
  }

  async withRunPendingPersistenceLock<T>(input: {
    reservation: SecuredReservationHold;
    operation: (
      persistence: BuyPersistenceOperations,
      runDisposition: "admissible" | "terminal" | "invalid",
    ) => Promise<T>;
  }): Promise<T> {
    const runId = input.reservation.runId;
    if (!runId) {
      return input.operation(this, "admissible");
    }

    return this.withSharedRunLock(runId, async (reservedDb, reservedClient) => {
      const [run] = await reservedDb
        .select({ saleOfferId: demoRuns.saleOfferId, status: demoRuns.status })
        .from(demoRuns)
        .where(eq(demoRuns.id, runId))
        .limit(1);
      const runDisposition =
        !run || run.saleOfferId !== input.reservation.saleOfferId
          ? "invalid"
          : acceptingPersistenceRunStatuses.has(run.status)
            ? "admissible"
            : "terminal";
      return input.operation(this.databaseOperations(reservedDb, reservedClient), runDisposition);
    });
  }

  async getPersistedBuyByReservationId(
    reservationId: string,
  ): Promise<PersistedBuyAcceptance | null> {
    return this.databaseOperations(this.db).getPersistedBuyByReservationId(reservationId);
  }

  async recordPendingPersistenceAttempt(input: {
    reservation: SecuredReservationHold;
    attemptCount: number;
    attemptedAt: Date;
  }): Promise<void> {
    await this.db.transaction((tx) => this.recordPendingPersistenceAttemptInTransaction(tx, input));
  }

  private async recordPendingPersistenceAttemptInTransaction(
    tx: PostgresTransaction,
    input: {
      reservation: SecuredReservationHold;
      attemptCount: number;
      attemptedAt: Date;
    },
  ): Promise<void> {
    const hold = input.reservation;
    await tx
      .insert(reservationPendingPersistence)
      .values({
        reservationId: hold.id,
        saleOfferId: hold.saleOfferId,
        correlationId: hold.correlationId,
        ...(hold.runId ? { runId: hold.runId } : {}),
        status: "pending_reconciliation",
        attemptCount: input.attemptCount,
        updatedAt: input.attemptedAt,
      })
      .onConflictDoUpdate({
        target: reservationPendingPersistence.reservationId,
        set: {
          saleOfferId: hold.saleOfferId,
          correlationId: hold.correlationId,
          runId: hold.runId ?? null,
          status: "pending_reconciliation",
          attemptCount: input.attemptCount,
          lastError: null,
          exhaustedAt: null,
          updatedAt: input.attemptedAt,
        },
      });
  }

  async markPendingPersistenceResolved(input: {
    reservationId: string;
    resolvedAt: Date;
  }): Promise<void> {
    await this.db.transaction((tx) => this.markPendingPersistenceResolvedInTransaction(tx, input));
  }

  private async markPendingPersistenceResolvedInTransaction(
    tx: PostgresTransaction,
    input: { reservationId: string; resolvedAt: Date },
  ): Promise<void> {
    const resolved = await tx
      .update(reservationPendingPersistence)
      .set({
        status: "reconciled",
        updatedAt: input.resolvedAt,
      })
      .where(eq(reservationPendingPersistence.reservationId, input.reservationId))
      .returning({ id: reservationPendingPersistence.id });
    if (resolved.length !== 1) {
      throw new Error(`Pending-persistence audit ${input.reservationId} was not found.`);
    }
  }

  async markPendingPersistenceExhausted(input: {
    reservation: SecuredReservationHold;
    attemptCount: number;
    exhaustedAt: Date;
    error: string;
  }): Promise<void> {
    const hold = input.reservation;
    await this.db
      .insert(reservationPendingPersistence)
      .values({
        reservationId: hold.id,
        saleOfferId: hold.saleOfferId,
        correlationId: hold.correlationId,
        ...(hold.runId ? { runId: hold.runId } : {}),
        status: "exhausted",
        attemptCount: input.attemptCount,
        lastError: input.error.slice(0, 500),
        exhaustedAt: input.exhaustedAt,
        updatedAt: input.exhaustedAt,
      })
      .onConflictDoUpdate({
        target: reservationPendingPersistence.reservationId,
        set: {
          saleOfferId: hold.saleOfferId,
          correlationId: hold.correlationId,
          runId: hold.runId ?? null,
          status: "exhausted",
          attemptCount: input.attemptCount,
          lastError: input.error.slice(0, 500),
          exhaustedAt: input.exhaustedAt,
          updatedAt: input.exhaustedAt,
        },
      });
  }

  private databaseOperations(
    database: CheckoutSurgeDatabase,
    reservedClient?: SqlClient,
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
      persistSecuredReservation: async (input) => {
        try {
          return await runTransaction((tx) =>
            this.persistSecuredReservationInTransaction(
              tx,
              input.reservation,
              Boolean(reservedClient),
            ),
          );
        } catch (error) {
          if (!isRecoverableReservationConflict(error)) {
            throw error;
          }

          // runTransaction has fully unwound here, so this fresh read never
          // uses an aborted transaction (including on a reserved session).
          const persisted = await this.getPersistedBuyByReservationIdInDatabase(
            database,
            input.reservation.id,
          );
          if (!persisted || !isPersistedBuyForReservation(persisted, input.reservation)) {
            throw error;
          }

          return persisted;
        }
      },
      getPersistedBuyByReservationId: (reservationId) =>
        this.getPersistedBuyByReservationIdInDatabase(database, reservationId),
    };
  }

  private async withSharedRunLock<T>(
    runId: string,
    operation: (database: CheckoutSurgeDatabase, client: SqlClient) => Promise<T>,
  ): Promise<T> {
    const client = (this.db as DatabaseWithClient).$client;
    const reservedClient = await client.reserve();
    Object.defineProperty(reservedClient, "options", { value: client.options });
    const operationClient = this.operationClient(reservedClient);
    const reservedDb = createDatabase(operationClient);
    let locked = false;
    try {
      await operationClient`select pg_advisory_lock_shared(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`;
      locked = true;
      return await operation(reservedDb, operationClient);
    } finally {
      try {
        if (locked) {
          await operationClient`select pg_advisory_unlock_shared(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`;
        }
      } finally {
        reservedClient.release();
      }
    }
  }

  private operationClient(reservedClient: ReservedClient): SqlClient {
    const client = reservedClient as SqlClient;
    return this.signal ? createAbortableSqlClient(client, this.signal) : client;
  }

  private async runReservedTransaction<T>(
    client: SqlClient,
    operation: () => Promise<T>,
  ): Promise<T> {
    await client`begin`;
    try {
      const result = await operation();
      await client`commit`;
      return result;
    } catch (error) {
      // If rollback fails, propagate that failure rather than exposing the
      // uniqueness error as recoverable while the session may remain aborted.
      await client`rollback`;
      throw error;
    }
  }

  private async getPersistedBuyByReservationIdInDatabase(
    database: CheckoutSurgeDatabase,
    reservationId: string,
  ): Promise<PersistedBuyAcceptance | null> {
    const [row] = await database
      .select({
        reservation: {
          id: reservations.id,
          saleOfferId: reservations.saleOfferId,
          correlationId: reservations.correlationId,
          runId: reservations.runId,
          quantity: reservations.quantity,
          reservationToken: reservations.reservationToken,
          expiresAt: reservations.expiresAt,
          securedAt: reservations.securedAt,
        },
        order: {
          id: orders.id,
          publicOrderId: orders.publicOrderId,
          saleOfferId: orders.saleOfferId,
          reservationId: orders.reservationId,
          correlationId: orders.correlationId,
          runId: orders.runId,
          quantity: orders.quantity,
          queuedAt: orders.queuedAt,
        },
      })
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

function isRecoverableReservationConflict(error: unknown): boolean {
  let candidate = error;
  const visited = new Set<unknown>();
  while (typeof candidate === "object" && candidate !== null && !visited.has(candidate)) {
    visited.add(candidate);
    const postgresError = candidate as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    const constraint = postgresError.constraint_name ?? postgresError.constraint;
    if (
      postgresError.code === "23505" &&
      typeof constraint === "string" &&
      recoverableReservationConstraints.has(constraint)
    ) {
      return true;
    }
    candidate = postgresError.cause;
  }
  return false;
}

function toReservationSummary(row: {
  id: string;
  saleOfferId: string;
  correlationId: string;
  runId: string | null;
  quantity: number;
  reservationToken: string;
  expiresAt: Date;
  securedAt: Date;
}): AcceptedReservationSummary {
  return {
    id: row.id,
    saleOfferId: row.saleOfferId,
    correlationId: row.correlationId,
    ...(row.runId ? { runId: row.runId } : {}),
    quantity: row.quantity,
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
  queuedAt: Date;
}): AcceptedOrderSummary {
  return {
    id: row.id,
    publicOrderId: row.publicOrderId,
    saleOfferId: row.saleOfferId,
    reservationId: row.reservationId,
    correlationId: row.correlationId,
    ...(row.runId ? { runId: row.runId } : {}),
    quantity: row.quantity,
    status: "queued",
    queuedAt: row.queuedAt.toISOString(),
  };
}
