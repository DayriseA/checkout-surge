import {
  type ErpConfirmationRequest,
  type ErpConfirmationResponse,
  erpConfirmationLookupPath,
  erpConfirmationPath,
  erpConfirmationRequestSchema,
  type OrderProcessJob,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  erpAttempts,
  orderEvents,
  orders,
  products,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { fastify } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { HttpErpOrderConfirmation } from "../../src/application/erp-confirmation-client.js";
import {
  ErpUnresolvedCallReconciler,
  ScheduledErpOrderConfirmation,
} from "../../src/application/erp-reconciliation.js";
import { erpResiliencePolicy } from "../../src/application/erp-resilience-policy.js";
import { AdaptiveErpRuntimeAdmission } from "../../src/application/order-process-admission.js";
import {
  createOrderProcessJobHandler,
  type OrderTransitionPersistence,
} from "../../src/application/order-process-job-handler.js";
import {
  ErpAttemptContradictionError,
  PostgresErpAttemptPersistence,
} from "../../src/persistence/postgres-erp-attempt-persistence.js";
import { PostgresOrderRecoveryPersistence } from "../../src/persistence/postgres-order-recovery-persistence.js";
import { PostgresOrderTransitionPersistence } from "../../src/persistence/postgres-order-transition-persistence.js";

const databaseUrl = requireTestDatabaseUrl();
const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  offer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  reservation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  order: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;
const job: OrderProcessJob = {
  orderId: ids.order,
  publicOrderId: "ord_erp_attempt_recovery",
  reservationId: ids.reservation,
  saleOfferId: ids.offer,
  correlationId: "corr-erp-attempt-recovery",
  quantity: 1,
  queuedAt: "2026-06-22T00:00:00.000Z",
  processingGeneration: 0,
};

describe("PostgreSQL ERP attempt recovery", () => {
  const connection = databaseUrl ? createDatabaseConnection(databaseUrl, { max: 4 }) : null;
  const requireConnection = () => {
    if (!connection) throw new Error("TEST_DATABASE_URL is required for integration tests.");
    return connection;
  };
  const persistence = connection
    ? new PostgresErpAttemptPersistence(connection.db, () => new Date("2026-06-22T00:00:01.000Z"))
    : null;
  const requirePersistence = () => {
    if (!persistence) throw new Error("TEST_DATABASE_URL is required for integration tests.");
    return persistence;
  };

  beforeEach(async () => {
    await resetTestDatabase({
      databaseUrl,
      migrationsFolder: "../../packages/db/drizzle",
    });
    await requireConnection().db.insert(products).values({
      id: ids.product,
      sku: "ERP-ATTEMPT-TEST",
      slug: "erp-attempt-test",
      name: "ERP Attempt Test",
    });
    await requireConnection()
      .db.insert(saleOffers)
      .values({
        id: ids.offer,
        productId: ids.product,
        name: "ERP Attempt Offer",
        allocatedStock: 10,
        saleStartsAt: new Date("2026-01-01"),
        saleEndsAt: new Date("2030-01-01"),
      });
    await requireConnection()
      .db.insert(reservations)
      .values({
        id: ids.reservation,
        saleOfferId: ids.offer,
        correlationId: job.correlationId,
        quantity: 1,
        reservationToken: "erp-attempt-token",
        securedAt: new Date("2026-06-22T00:00:00Z"),
        expiresAt: new Date("2026-06-22T00:15:00Z"),
      });
    await requireConnection()
      .db.insert(orders)
      .values({
        id: ids.order,
        publicOrderId: job.publicOrderId,
        saleOfferId: ids.offer,
        reservationId: ids.reservation,
        correlationId: job.correlationId,
        quantity: 1,
        status: "queued",
        queuedAt: new Date("2026-06-22T00:00:00Z"),
      });
  });
  afterAll(() => requireConnection().close());

  it("keeps original failure and recovery success attempt one distinct, replay-safe", async () => {
    const startedAt = new Date("2026-06-22T00:00:01Z");
    await requirePersistence().recordAttempt({
      job,
      delivery: {
        attemptNumber: 1,
        attemptsMade: 0,
        deliveryId: "original-job",
      },
      status: "failed",
      terminal: false,
      httpStatus: 503,
      errorCode: "ERP_UNAVAILABLE",
      errorMessage: "offline",
      latencyMs: 1,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 1),
    });
    const response = {
      status: "succeeded" as const,
      confirmationId: "recovery-confirmation",
      httpStatus: 200 as const,
      latencyMs: 1,
      timestamp: "2026-06-22T00:00:02.000Z",
    };
    const recovery = {
      job,
      delivery: {
        attemptNumber: 1,
        attemptsMade: 0,
        deliveryId: "recovery-dddddddd-dddd-4ddd-8ddd-dddddddddddd-1",
      },
      status: "succeeded" as const,
      terminal: true,
      httpStatus: 200,
      latencyMs: 1,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 2),
      response,
    };
    await requirePersistence().recordAttempt(recovery);
    await requirePersistence().recordAttempt(recovery);
    await requirePersistence().recordAttempt({
      ...recovery,
      delivery: {
        ...recovery.delivery,
        deliveryId: "recovery-dddddddd-dddd-4ddd-8ddd-dddddddddddd-2",
      },
    });
    const attempts = await requireConnection()
      .db.select()
      .from(erpAttempts)
      .where(eq(erpAttempts.orderId, ids.order));
    const events = await requireConnection()
      .db.select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, ids.order));
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((attempt) => attempt.deliveryId))).toEqual(
      new Set(["original-job", "recovery-dddddddd-dddd-4ddd-8ddd-dddddddddddd-1"]),
    );
    expect(events).toHaveLength(2);
  });

  it("rejects a contradictory replay for one delivery identity", async () => {
    const startedAt = new Date("2026-06-22T00:00:01Z");
    const base = {
      job,
      delivery: {
        attemptNumber: 1,
        attemptsMade: 0,
        deliveryId: "recovery-contradiction",
      },
      status: "succeeded" as const,
      terminal: true,
      httpStatus: 200,
      latencyMs: 1,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 1),
      response: {
        status: "succeeded" as const,
        confirmationId: "one",
        httpStatus: 200 as const,
        latencyMs: 1,
        timestamp: "2026-06-22T00:00:02.000Z",
      },
    };
    await requirePersistence().recordAttempt(base);
    await expect(
      requirePersistence().recordAttempt({ ...base, httpStatus: 201 }),
    ).rejects.toBeInstanceOf(ErpAttemptContradictionError);
  });

  it("replays a durably accepted ERP result after the ERP is replaced", async () => {
    const transitionPersistence = new PostgresOrderTransitionPersistence(
      requireConnection().db,
      sequenceClock(
        new Date("2026-06-22T00:00:01.000Z"),
        new Date("2026-06-22T00:00:32.000Z"),
        new Date("2026-06-22T00:00:33.000Z"),
      ),
    );
    const confirmedPersistenceError = new Error(
      "interrupted before the confirmed order transition",
    );
    const interruptedPersistence: OrderTransitionPersistence = {
      transitionToProcessing: (...args) => transitionPersistence.transitionToProcessing(...args),
      transitionToConfirmed: async () => {
        throw confirmedPersistenceError;
      },
      transitionToFailed: (...args) => transitionPersistence.transitionToFailed(...args),
    };
    const originalErp = await startInMemoryErpService("original");

    let interruption: unknown;
    try {
      const originalHandler = createHandler(
        createHttpConfirmation(originalErp.baseUrl, requirePersistence()),
        interruptedPersistence,
        requireConnection(),
      );
      interruption = await originalHandler
        .handle(job, {
          attemptNumber: 1,
          attemptsMade: 0,
          deliveryId: "original-delivery",
        })
        .catch((error: unknown) => error);
    } finally {
      await originalErp.close();
    }

    expect(interruption).toBe(confirmedPersistenceError);
    expect(originalErp.receivedRequests).toEqual([
      expect.objectContaining({
        orderId: ids.order,
        idempotencyKey: `erp-confirmation:${ids.order}`,
      }),
    ]);
    await expect(readRecoveryState(requireConnection())).resolves.toMatchObject({
      orderStatus: "processing",
      successfulAttemptCount: 1,
      confirmedEventCount: 0,
      confirmationIds: ["original-confirmation-1"],
    });

    const replacementErp = await startInMemoryErpService("replacement");
    try {
      const claim = await new PostgresOrderRecoveryPersistence(
        requireConnection().db,
      ).claimForPublication({
        recoveryKey: `order:${job.orderId}`,
        now: new Date("2026-06-22T00:00:32.000Z"),
        leaseMs: 30_000,
      });
      if (!claim) throw new Error("Expected recovery publication ownership.");
      const replayJob = { ...job, processingGeneration: claim.processingGeneration };
      const replayHandler = createHandler(
        createHttpConfirmation(replacementErp.baseUrl, requirePersistence()),
        transitionPersistence,
        requireConnection(),
      );
      await replayHandler.handle(replayJob, {
        attemptNumber: 2,
        attemptsMade: 1,
        deliveryId: claim.jobId,
      });

      expect(replacementErp.receivedRequests).toEqual([]);
      await expect(readRecoveryState(requireConnection())).resolves.toMatchObject({
        orderStatus: "confirmed",
        successfulAttemptCount: 1,
        confirmedEventCount: 1,
        confirmationIds: ["original-confirmation-1"],
      });
    } finally {
      await replacementErp.close();
    }
  });

  it.each([
    "lookup_success",
    "unknown_replay",
  ] as const)("reconciles %s without duplicating the external effect", async (scenario) => {
    const transition = new PostgresOrderTransitionPersistence(
      requireConnection().db,
      () => new Date("2026-06-22T00:00:00.500Z"),
    );
    const processing = await transition.transitionToProcessing(job, {
      attemptNumber: 1,
      attemptsMade: 0,
      deliveryId: "uncertain-delivery",
    });
    const delivery = {
      attemptNumber: 2,
      attemptsMade: 1,
      deliveryId: "reconciliation-delivery",
      processingGeneration: processing.processingGeneration ?? 0,
    };
    const call = await requirePersistence().recordDispatchIntent({
      job,
      idempotencyKey: `erp-confirmation:${job.orderId}`,
      dispatchedAt: new Date("2026-06-22T00:00:01.000Z"),
      expectedProcessingGeneration: delivery.processingGeneration,
    });
    await requirePersistence().recordAttempt({
      job,
      delivery,
      call,
      status: "timed_out",
      terminal: false,
      errorCode: "erp_request_timeout",
      latencyMs: 1_000,
      startedAt: new Date("2026-06-22T00:00:01.000Z"),
      finishedAt: new Date("2026-06-22T00:00:02.000Z"),
    });
    const erp = await startInMemoryErpService("reconciliation");
    try {
      if (scenario === "lookup_success") {
        await fetch(`${erp.baseUrl}${erpConfirmationPath}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orderId: job.orderId,
            publicOrderId: job.publicOrderId,
            reservationId: job.reservationId,
            saleOfferId: job.saleOfferId,
            idempotencyKey: call.idempotencyKey,
            correlationId: job.correlationId,
            quantity: job.quantity,
          }),
        });
      }
      const client = createHttpConfirmation(erp.baseUrl, requirePersistence());
      const admission = testAdmission();
      const reconciler = new ErpUnresolvedCallReconciler({
        client,
        callResolution: new PostgresOrderRecoveryPersistence(requireConnection().db),
        admission,
      });

      const result = await reconciler.reconcile({
        job,
        delivery,
        call,
        context: { scope: "catalog", configuredConcurrency: 1 },
      });

      expect(result.disposition).toBe("succeeded");
      expect(erp.receivedRequests).toHaveLength(1);
      await expect(readRecoveryState(requireConnection())).resolves.toMatchObject({
        successfulAttemptCount: 1,
        confirmationIds: expect.arrayContaining([null, "reconciliation-confirmation-1"]),
      });
    } finally {
      await erp.close();
    }
  });

  it("reconciles one late canonical success after timeout and lease expiry without another POST", async () => {
    const startedAt = new Date("2026-06-22T00:00:00.000Z");
    let now = startedAt;
    const transition = new PostgresOrderTransitionPersistence(
      requireConnection().db,
      () => now,
      80,
    );
    const processing = await transition.transitionToProcessing(job, {
      attemptNumber: 1,
      attemptsMade: 0,
      deliveryId: "late-canonical-initial",
    });
    const delivery = {
      attemptNumber: 1,
      attemptsMade: 0,
      deliveryId: "late-canonical-initial",
      processingGeneration: processing.processingGeneration ?? 0,
    };
    const attemptPersistence = new PostgresErpAttemptPersistence(requireConnection().db, () => now);
    const erp = await startInMemoryErpService("late-canonical", { latencyMs: 50 });
    try {
      const client = new HttpErpOrderConfirmation({
        baseUrl: erp.baseUrl,
        lookupTimeoutMs: erpResiliencePolicy.initialRequestDeadlineMs,
        retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
        attemptPersistence,
        now: () => now,
      });
      await expect(client.dispatch(job, delivery, 10)).resolves.toMatchObject({
        disposition: "uncertain_result",
        errorCode: "erp_request_timeout",
      });
      await erp.confirmationCompleted;

      now = new Date(startedAt.getTime() + 100);
      const recovery = new PostgresOrderRecoveryPersistence(requireConnection().db, () => now);
      const claim = await recovery.claimForPublication({
        recoveryKey: `order:${job.orderId}`,
        now,
        leaseMs: 40,
      });
      expect(claim).not.toBeNull();
      const unresolved = await client.findUnresolvedCall(job.orderId);
      if (!unresolved || !claim)
        throw new Error("Expected expired-lease reconciliation ownership.");
      const reconciler = new ErpUnresolvedCallReconciler({
        client,
        callResolution: recovery,
        admission: testAdmission(() => now.getTime()),
      });

      await expect(
        reconciler.reconcile({
          job,
          delivery: {
            ...delivery,
            deliveryId: claim.jobId,
            processingGeneration: claim.processingGeneration,
          },
          call: unresolved,
          context: { scope: "catalog", configuredConcurrency: 1 },
        }),
      ).resolves.toMatchObject({ operation: "status_lookup", disposition: "succeeded" });
      expect(erp.receivedRequests).toHaveLength(1);
      await expect(readRecoveryState(requireConnection())).resolves.toMatchObject({
        successfulAttemptCount: 1,
        confirmationIds: expect.arrayContaining(["late-canonical-confirmation-1", null]),
      });
    } finally {
      await erp.close();
    }
  });
});

function createHttpConfirmation(
  baseUrl: string,
  attemptPersistence: PostgresErpAttemptPersistence,
): HttpErpOrderConfirmation {
  let now = new Date("2026-06-22T00:00:01.000Z");
  return new HttpErpOrderConfirmation({
    baseUrl,
    lookupTimeoutMs: erpResiliencePolicy.initialRequestDeadlineMs,
    retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
    attemptPersistence,
    now: () => {
      const current = now;
      now = new Date(now.getTime() + 20);
      return current;
    },
  });
}

function testAdmission(now: () => number = Date.now): AdaptiveErpRuntimeAdmission {
  return AdaptiveErpRuntimeAdmission.create({
    pauseDelivery: async () => {},
    persistence: {
      listActive: async () => [],
      readActive: async () => null,
      listUnresolvedScopes: async () => [],
      readReconciliationGate: async () => ({ pending: false, nextEligibleAtMs: 0 }),
      save: async () => undefined,
    },
    runConfigReader: { read: async () => null },
    fallbackConcurrency: 1,
    now,
    random: () => 0,
  });
}

function createHandler(
  client: HttpErpOrderConfirmation,
  persistence: OrderTransitionPersistence,
  connection: ReturnType<typeof createDatabaseConnection>,
) {
  const admission = testAdmission();
  const control = new PostgresOrderRecoveryPersistence(connection.db);
  return createOrderProcessJobHandler({
    confirmation: new ScheduledErpOrderConfirmation({
      client,
      reconciler: new ErpUnresolvedCallReconciler({ client, callResolution: control, admission }),
      admission,
      control,
    }),
    persistence,
    logger: createSilentLogger("worker"),
    publishBusinessOutcomeUpdate: async () => undefined,
    notificationRecordPublisher: { publishForConfirmedOrder: async () => undefined },
    recovery: { handoff: async () => undefined, resolve: async () => undefined },
  });
}

async function startInMemoryErpService(
  instanceName: string,
  options: { latencyMs?: number } = {},
): Promise<{
  baseUrl: string;
  receivedRequests: ErpConfirmationRequest[];
  confirmationCompleted: Promise<void>;
  close(): Promise<void>;
}> {
  const receivedRequests: ErpConfirmationRequest[] = [];
  let completeConfirmation!: () => void;
  const confirmationCompleted = new Promise<void>((resolve) => {
    completeConfirmation = resolve;
  });
  const confirmationsByIdempotencyKey = new Map<
    string,
    { request: ErpConfirmationRequest; response: ErpConfirmationResponse }
  >();
  const server = fastify({ logger: false });

  server.post(erpConfirmationPath, async (request) => {
    const confirmationRequest = erpConfirmationRequestSchema.parse(request.body);
    receivedRequests.push(confirmationRequest);
    if (options.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    }
    const existing = confirmationsByIdempotencyKey.get(confirmationRequest.idempotencyKey);
    if (existing) return existing.response;

    const response: ErpConfirmationResponse = {
      status: "succeeded",
      confirmationId: `${instanceName}-confirmation-${confirmationsByIdempotencyKey.size + 1}`,
      httpStatus: 200,
      latencyMs: 20,
      timestamp: "2026-06-22T00:00:01.020Z",
    };
    confirmationsByIdempotencyKey.set(confirmationRequest.idempotencyKey, {
      request: confirmationRequest,
      response,
    });
    completeConfirmation();
    return response;
  });

  server.get(erpConfirmationLookupPath, async (request) => {
    const { idempotencyKey } = request.params as { idempotencyKey: string };
    const existing = confirmationsByIdempotencyKey.get(idempotencyKey);
    return {
      lookup: existing
        ? {
            status: "succeeded",
            identity: {
              orderId: existing.request.orderId,
              publicOrderId: existing.request.publicOrderId,
              reservationId: existing.request.reservationId,
              saleOfferId: existing.request.saleOfferId,
              ...(existing.request.runId ? { runId: existing.request.runId } : {}),
              idempotencyKey,
              quantity: existing.request.quantity,
            },
            result: existing.response,
          }
        : { status: "unknown", idempotencyKey },
      timestamp: "2026-06-22T00:00:02.000Z",
    };
  });

  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  return { baseUrl, receivedRequests, confirmationCompleted, close: () => server.close() };
}

async function readRecoveryState(connection: ReturnType<typeof createDatabaseConnection>): Promise<{
  orderStatus: string | undefined;
  successfulAttemptCount: number;
  confirmedEventCount: number;
  confirmationIds: Array<string | null>;
}> {
  const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
  const attempts = await connection.db
    .select()
    .from(erpAttempts)
    .where(eq(erpAttempts.orderId, ids.order));
  const events = await connection.db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, ids.order));

  return {
    orderStatus: order?.status,
    successfulAttemptCount: attempts.filter((attempt) => attempt.status === "succeeded").length,
    confirmedEventCount: events.filter((event) => event.eventName === "order.confirmed").length,
    confirmationIds: attempts.map((attempt) => attempt.confirmationId),
  };
}

function sequenceClock(...dates: Date[]): () => Date {
  let index = 0;
  return () => {
    const date = dates[index];
    index += 1;
    if (!date) throw new Error("Test clock exhausted.");
    return date;
  };
}
