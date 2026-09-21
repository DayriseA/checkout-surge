import { randomUUID } from "node:crypto";
import {
  type ErpCallReference,
  erpAttemptHistoryRetentionLimit,
  type OrderProcessJob,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import {
  createDatabaseConnection,
  demoPresets,
  demoRunSaleContexts,
  demoRuns,
  erpAttempts,
  erpDispatchCalls,
  orderEvents,
  orderRecoveryJobs,
  orders,
  products,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpErpOrderConfirmation } from "../../src/application/erp-confirmation-client.js";
import { erpResiliencePolicy } from "../../src/application/erp-resilience-policy.js";
import {
  createOrderProcessJobHandler,
  type OrderProcessDeliveryMetadata,
} from "../../src/application/order-process-job-handler.js";
import { createOrderRecoveryScanner } from "../../src/application/order-recovery-scanner.js";
import { PostgresErpAttemptPersistence } from "../../src/persistence/postgres-erp-attempt-persistence.js";
import { PostgresOrderRecoveryPersistence } from "../../src/persistence/postgres-order-recovery-persistence.js";
import { PostgresOrderTransitionPersistence } from "../../src/persistence/postgres-order-transition-persistence.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const requireDatabaseUrl = () => {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for integration tests.");
  return databaseUrl;
};

const baseTime = new Date("2026-06-22T00:00:00.000Z");
let sequence = 0;
let seedOrderCounter = 0;

interface SeededOrder {
  orderId: string;
  reservationId: string;
  correlationId: string;
  job: OrderProcessJob;
}

run("PostgreSQL durable processing control and dispatch intent", () => {
  const connection = databaseUrl ? createDatabaseConnection(databaseUrl, { max: 4 }) : null;
  const requireConnection = () => {
    if (!connection) throw new Error("TEST_DATABASE_URL is required for integration tests.");
    return connection;
  };
  let now = new Date(baseTime);
  let attemptPersistence: PostgresErpAttemptPersistence;
  let controlPersistence: PostgresOrderRecoveryPersistence;
  let transitionPersistence: PostgresOrderTransitionPersistence;

  beforeEach(async () => {
    now = new Date(baseTime);
    sequence += 1;
    await resetTestDatabase({
      databaseUrl: requireDatabaseUrl(),
      migrationsFolder: "../../packages/db/drizzle",
    });
    const db = requireConnection().db;
    await db.insert(products).values({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sku: `PROCESSING-CONTROL-${sequence}`,
      slug: `processing-control-${sequence}`,
      name: "Processing Control",
    });
    await db.insert(saleOffers).values({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Processing Control Offer",
      allocatedStock: 100,
      saleStartsAt: new Date("2026-01-01"),
      saleEndsAt: new Date("2030-01-01"),
    });
    attemptPersistence = new PostgresErpAttemptPersistence(db, () => now);
    controlPersistence = new PostgresOrderRecoveryPersistence(db, () => now);
    transitionPersistence = new PostgresOrderTransitionPersistence(db, () => now);
  });
  afterAll(() => connection?.close());

  async function seedOrder(input: {
    createdAt: Date;
    status?: "queued" | "processing" | "failed";
    runId?: string;
  }): Promise<SeededOrder> {
    const suffix = (sequence * 100 + ++seedOrderCounter).toString().padStart(12, "0");
    const orderId = `dddddddd-dddd-4ddd-8ddd-${suffix}`;
    const reservationId = `cccccccc-cccc-4ccc-8ccc-${suffix}`;
    const correlationId = `corr-processing-control-${suffix}`;
    const job: OrderProcessJob = {
      orderId,
      publicOrderId: `ord_processing_control_${suffix}`,
      reservationId,
      saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      correlationId,
      ...(input.runId ? { runId: input.runId } : {}),
      quantity: 1,
      queuedAt: input.createdAt.toISOString(),
      processingGeneration: 0,
    };
    const db = requireConnection().db;
    await db.insert(reservations).values({
      id: reservationId,
      saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      correlationId,
      quantity: 1,
      reservationToken: `token-${reservationId}`,
      ...(input.runId ? { runId: input.runId } : {}),
      securedAt: input.createdAt,
      expiresAt: new Date(input.createdAt.getTime() + 900_000),
      createdAt: input.createdAt,
    });
    await db.insert(orders).values({
      id: orderId,
      publicOrderId: job.publicOrderId,
      saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      reservationId,
      ...(input.runId ? { runId: input.runId } : {}),
      correlationId,
      quantity: 1,
      status: input.status ?? "queued",
      queuedAt: input.createdAt,
      ...(input.status && input.status !== "queued"
        ? { processingAt: new Date(input.createdAt.getTime() + 1) }
        : {}),
      ...(input.status === "failed" ? { failedAt: new Date(input.createdAt.getTime() + 2) } : {}),
      createdAt: input.createdAt,
    });
    return { orderId, reservationId, correlationId, job };
  }

  async function controlRow(orderId: string) {
    const [row] = await requireConnection()
      .db.select()
      .from(orderRecoveryJobs)
      .where(eq(orderRecoveryJobs.orderId, orderId));
    return row;
  }

  function handlerWith(
    confirmation: (
      job: OrderProcessJob,
      delivery: OrderProcessDeliveryMetadata,
    ) => Promise<unknown>,
  ) {
    return createOrderProcessJobHandler({
      confirmation: { confirm: confirmation },
      persistence: transitionPersistence,
      logger: createSilentLogger("worker"),
      publishBusinessOutcomeUpdate: async () => undefined,
      notificationRecordPublisher: { publishForConfirmedOrder: async () => undefined },
      recovery: { handoff: async () => undefined, resolve: async () => undefined },
    });
  }

  it("creates the control record and transitions the order in one transaction", async () => {
    const seeded = await seedOrder({ createdAt: now });

    const transition = await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "initial-delivery",
    });

    expect(transition).toEqual({
      changed: true,
      status: "processing",
      processingGeneration: 0,
      executionClaimed: true,
    });
    const [order] = await requireConnection()
      .db.select()
      .from(orders)
      .where(eq(orders.id, seeded.orderId));
    expect(order?.status).toBe("processing");
    const row = await controlRow(seeded.orderId);
    expect(row).toMatchObject({
      recoveryKey: `order:${seeded.orderId}`,
      status: "enqueued",
      processingGeneration: 0,
      publicationOwner: null,
      unresolvedErpCallId: null,
      attemptCounts: {},
    });
    expect(row?.leaseExpiresAt).toEqual(new Date(baseTime.getTime() + 30_000));
  });

  it("consumes one delivery owner before concurrent duplicate ERP dispatch", async () => {
    const seeded = await seedOrder({ createdAt: now });
    let completeRequest!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          completeRequest = resolve;
        }),
    );
    const confirmation = new HttpErpOrderConfirmation({
      baseUrl: "http://erp.test",
      lookupTimeoutMs: erpResiliencePolicy.initialRequestDeadlineMs,
      retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
      attemptPersistence,
      fetch,
      now: () => now,
    });
    const handler = handlerWith((job, delivery) =>
      confirmation.dispatch(job, delivery, erpResiliencePolicy.initialRequestDeadlineMs),
    );
    const delivery = {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 1,
      deliveryId: "duplicate-delivery",
    };

    const first = handler.handle(seeded.job, delivery);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await expect(handler.handle(seeded.job, delivery)).resolves.toBeUndefined();
    completeRequest(
      Response.json({
        status: "succeeded",
        confirmationId: "single-owner-confirmation",
        httpStatus: 200,
        latencyMs: 1,
        timestamp: now.toISOString(),
      }),
    );
    await first;

    expect(fetch).toHaveBeenCalledOnce();
    await expect(
      requireConnection()
        .db.select()
        .from(erpDispatchCalls)
        .where(eq(erpDispatchCalls.orderId, seeded.orderId)),
    ).resolves.toHaveLength(1);
    await expect(
      requireConnection()
        .db.select()
        .from(erpAttempts)
        .where(eq(erpAttempts.orderId, seeded.orderId)),
    ).resolves.toHaveLength(1);
  });

  it("resumes a pre-migration processing order without a control row through the handler", async () => {
    const seeded = await seedOrder({ createdAt: now, status: "processing" });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      expect(await controlRow(seeded.orderId)).toMatchObject({
        publicationOwner: null,
        processingGeneration: 0,
        unresolvedErpCallId: expect.any(String),
      });
      return Response.json({
        status: "succeeded",
        confirmationId: "legacy-confirmation",
        httpStatus: 200,
        latencyMs: 1,
        timestamp: now.toISOString(),
      });
    });
    const confirmation = new HttpErpOrderConfirmation({
      baseUrl: "http://erp.test",
      lookupTimeoutMs: erpResiliencePolicy.initialRequestDeadlineMs,
      retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
      attemptPersistence,
      fetch,
      now: () => now,
    });

    const handler = handlerWith((job, delivery) =>
      confirmation.dispatch(job, delivery, erpResiliencePolicy.initialRequestDeadlineMs),
    );
    await handler.handle(seeded.job, {
      attemptNumber: 2,
      attemptsMade: 1,
      maxAttempts: 4,
      deliveryId: "legacy-delivery",
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(await controlRow(seeded.orderId)).toMatchObject({ status: "resolved" });
    const [order] = await requireConnection()
      .db.select()
      .from(orders)
      .where(eq(orders.id, seeded.orderId));
    expect(order?.status).toBe("confirmed");
  });

  it("serializes result persistence behind an execution claim without lock inversion", async () => {
    const seeded = await seedOrder({ createdAt: now });
    const delivery = {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "overlapping-delivery",
    };
    await transitionPersistence.transitionToProcessing(seeded.job, delivery);
    const call = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey: `erp-confirmation:${seeded.orderId}`,
      dispatchedAt: now,
      expectedProcessingGeneration: 0,
    });
    const writer = createDatabaseConnection(requireDatabaseUrl(), { max: 1 });
    let result: Promise<PromiseSettledResult<boolean>[]> | undefined;
    try {
      const [backend] = await writer.sql`SELECT pg_backend_pid() AS pid`;
      await requireConnection().db.transaction(async (tx) => {
        // Pause execution after its first lock, then let the result writer block.
        await tx.select().from(orders).where(eq(orders.id, seeded.orderId)).for("update");
        result = Promise.allSettled([
          new PostgresErpAttemptPersistence(writer.db, () => now).recordAttempt({
            job: seeded.job,
            delivery,
            call,
            status: "succeeded",
            terminal: true,
            httpStatus: 200,
            latencyMs: 1,
            startedAt: now,
            finishedAt: now,
            response: {
              status: "succeeded",
              confirmationId: "overlapping-result",
              httpStatus: 200,
              latencyMs: 1,
              timestamp: now.toISOString(),
            },
          }),
        ]);
        await vi.waitFor(async () => {
          const [activity] = await requireConnection().sql`
            SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${backend?.pid}
          `;
          expect(activity?.wait_event_type).toBe("Lock");
        });
        // Previously the writer held control while waiting for the order FK;
        // this real execution claim then waited for control, creating a cycle.
        await expect(
          new PostgresOrderTransitionPersistence(tx, () => now).transitionToProcessing(
            seeded.job,
            delivery,
          ),
        ).resolves.toMatchObject({ executionClaimed: false });
      });
      expect(await result).toEqual([{ status: "fulfilled", value: true }]);
      expect(await controlRow(seeded.orderId)).toMatchObject({
        attemptCounts: { succeeded: 1 },
        unresolvedErpCallId: null,
      });
    } finally {
      await result;
      await writer.close();
    }
  });

  it("publishes the atomically claimed owner when its selected candidate is stale", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await controlPersistence.recordRecoverable({
      job: seeded.job,
      delivery: { attemptNumber: 1, attemptsMade: 0, maxAttempts: 4 },
      reason: "publication-retry",
      error: new Error("queue unavailable"),
    });
    const findRecoverable = controlPersistence.findRecoverable.bind(controlPersistence);
    vi.spyOn(controlPersistence, "findRecoverable").mockImplementationOnce(async (input) => {
      const candidates = await findRecoverable(input);
      const interveningClaim = await controlPersistence.claimForPublication({
        recoveryKey: `order:${seeded.orderId}`,
        now,
        leaseMs: 30_000,
      });
      if (!interveningClaim) throw new Error("Expected intervening claim");
      await controlPersistence.markPublicationFailed({
        recoveryKey: `order:${seeded.orderId}`,
        error: "queue unavailable",
        nextAttemptAt: now,
        processingGeneration: interveningClaim.processingGeneration,
      });
      return candidates;
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const scanner = createOrderRecoveryScanner({
      persistence: controlPersistence,
      handler: { handle: vi.fn() },
      publisher: { enqueue },
      deliveryStateReader: { isDeliveryPending: async () => false },
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1_000,
      batchSize: 1,
      now: () => now,
      failedJobReader: { findFailedOrderJobs: async () => [] },
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({ enqueued: 1 });

    const row = await controlRow(seeded.orderId);
    expect(row).toMatchObject({ attempts: 2, publicationOwner: `recovery-${seeded.orderId}-2` });
    expect(enqueue).toHaveBeenCalledWith(
      { ...seeded.job, processingGeneration: 2 },
      { jobId: row?.publicationOwner, attempts: 1 },
    );
    const confirmation = vi.fn().mockResolvedValue(undefined);
    await handlerWith(confirmation).handle(
      { ...seeded.job, processingGeneration: 2 },
      {
        attemptNumber: 1,
        attemptsMade: 0,
        maxAttempts: 1,
        deliveryId: row?.publicationOwner ?? "",
      },
    );
    expect(confirmation).toHaveBeenCalledOnce();
  });

  it("rolls back order transition and control-record creation together", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await requireConnection().sql`
      CREATE FUNCTION fail_processing_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_name = 'order.processing' THEN
          RAISE EXCEPTION 'forced processing event failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await requireConnection().sql`
      CREATE TRIGGER fail_processing_event
      BEFORE INSERT ON order_events
      FOR EACH ROW EXECUTE FUNCTION fail_processing_event()
    `;

    await expect(
      transitionPersistence.transitionToProcessing(seeded.job, {
        attemptNumber: 1,
        attemptsMade: 0,
        maxAttempts: 4,
        deliveryId: "crashing-delivery",
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "forced processing event failure" }),
    });

    const [order] = await requireConnection()
      .db.select()
      .from(orders)
      .where(eq(orders.id, seeded.orderId));
    expect(order?.status).toBe("queued");
    expect(order?.processingAt).toBeNull();
    expect(await controlRow(seeded.orderId)).toBeUndefined();
    await expect(
      requireConnection()
        .db.select()
        .from(orderEvents)
        .where(eq(orderEvents.orderId, seeded.orderId)),
    ).resolves.toHaveLength(0);
  });

  it("yields exactly one owner for concurrent claims and rejects stale generations", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "initial-delivery",
    });
    await requireConnection()
      .db.update(orderRecoveryJobs)
      .set({ status: "pending", leaseExpiresAt: null, publicationOwner: null })
      .where(eq(orderRecoveryJobs.orderId, seeded.orderId));

    const claims = await Promise.all([
      controlPersistence.claimForPublication({
        recoveryKey: `order:${seeded.orderId}`,
        now,
        leaseMs: 30_000,
      }),
      controlPersistence.claimForPublication({
        recoveryKey: `order:${seeded.orderId}`,
        now,
        leaseMs: 30_000,
      }),
    ]);
    expect(claims.map((claim) => claim === null).sort()).toEqual([false, true]);
    expect(claims.find((claim) => claim !== null)).toMatchObject({
      attempt: 1,
      processingGeneration: 1,
    });

    // A stale generation (0) cannot defer the work or overwrite the newer owner.
    await expect(
      controlPersistence.defer({
        orderId: seeded.orderId,
        waitingReason: "erp_capacity",
        nextEligibleAt: new Date(now.getTime() + 5_000),
        processingGeneration: 0,
      }),
    ).resolves.toBe(false);
    const afterStale = await controlPersistence.readControlRecord({ orderId: seeded.orderId });
    expect(afterStale).toMatchObject({
      processingGeneration: 1,
      waitingReason: null,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
    });

    // The current generation defers durably and releases the lease.
    await expect(
      controlPersistence.defer({
        orderId: seeded.orderId,
        waitingReason: "erp_capacity",
        nextEligibleAt: new Date(now.getTime() + 5_000),
        processingGeneration: 1,
      }),
    ).resolves.toBe(true);
    expect(await controlPersistence.readControlRecord({ orderId: seeded.orderId })).toMatchObject({
      processingGeneration: 1,
      waitingReason: "erp_capacity",
      nextAttemptAt: new Date(now.getTime() + 5_000),
      leaseExpiresAt: null,
      publicationOwner: null,
    });

    // Future-due work is not claimable before it becomes eligible.
    await expect(
      controlPersistence.claimForPublication({
        recoveryKey: `order:${seeded.orderId}`,
        now,
        leaseMs: 30_000,
      }),
    ).resolves.toBeNull();
    now = new Date(now.getTime() + 6_000);
    await expect(
      controlPersistence.claimForPublication({
        recoveryKey: `order:${seeded.orderId}`,
        now,
        leaseMs: 30_000,
      }),
    ).resolves.toMatchObject({ attempt: 2, processingGeneration: 2 });
  });

  it("renews the publication lease only for the unchanged owner and generation", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await controlPersistence.recordRecoverable({
      job: seeded.job,
      delivery: { attemptNumber: 1, attemptsMade: 0, maxAttempts: 4 },
      reason: "publication-retry",
      error: new Error("queue unavailable"),
    });
    const claim = await controlPersistence.claimForPublication({
      recoveryKey: `order:${seeded.orderId}`,
      now,
      leaseMs: 30_000,
    });
    if (!claim) throw new Error("Expected recovery claim");

    await expect(
      controlPersistence.renewPublicationLease({
        recoveryKey: `order:${seeded.orderId}`,
        processingGeneration: claim.processingGeneration,
        publicationOwner: claim.jobId,
        now,
        leaseMs: 30_000,
      }),
    ).resolves.toBe(true);
    expect(await controlRow(seeded.orderId)).toMatchObject({
      status: "enqueued",
      attempts: 1,
      processingGeneration: 1,
      publicationOwner: claim.jobId,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
    });

    // A cleared owner (deferred or failed publication) no longer matches.
    await controlPersistence.defer({
      orderId: seeded.orderId,
      waitingReason: "erp_unavailable",
      nextEligibleAt: now,
      processingGeneration: claim.processingGeneration,
    });
    await expect(
      controlPersistence.renewPublicationLease({
        recoveryKey: `order:${seeded.orderId}`,
        processingGeneration: claim.processingGeneration,
        publicationOwner: claim.jobId,
        now,
        leaseMs: 30_000,
      }),
    ).resolves.toBe(false);
    expect(await controlRow(seeded.orderId)).toMatchObject({
      publicationOwner: null,
      leaseExpiresAt: null,
    });

    // A moved generation no longer matches.
    const nextClaim = await controlPersistence.claimForPublication({
      recoveryKey: `order:${seeded.orderId}`,
      now,
      leaseMs: 30_000,
    });
    if (!nextClaim) throw new Error("Expected second recovery claim");
    await expect(
      controlPersistence.renewPublicationLease({
        recoveryKey: `order:${seeded.orderId}`,
        processingGeneration: claim.processingGeneration,
        publicationOwner: claim.jobId,
        now,
        leaseMs: 30_000,
      }),
    ).resolves.toBe(false);
    expect(await controlRow(seeded.orderId)).toMatchObject({
      processingGeneration: nextClaim.processingGeneration,
      publicationOwner: nextClaim.jobId,
    });
  });

  it("acknowledges an old initial delivery after recovery takes ownership", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "initial-delivery",
    });
    await requireConnection()
      .db.update(orderRecoveryJobs)
      .set({ status: "pending", leaseExpiresAt: null })
      .where(eq(orderRecoveryJobs.orderId, seeded.orderId));
    await controlPersistence.claimForPublication({
      recoveryKey: `order:${seeded.orderId}`,
      now,
      leaseMs: 30_000,
    });
    const confirmation = vi.fn().mockResolvedValue(undefined);

    const recoveryJob = { ...seeded.job, processingGeneration: 1 };
    await handlerWith(confirmation).handle(recoveryJob, {
      attemptNumber: 2,
      attemptsMade: 1,
      maxAttempts: 4,
      deliveryId: "initial-delivery",
    });

    expect(confirmation).not.toHaveBeenCalled();
    expect(await controlRow(seeded.orderId)).toMatchObject({
      processingGeneration: 1,
      publicationOwner: `recovery-${seeded.orderId}-1`,
    });
  });

  it("denies an expired delivery until recovery publishes a new owner", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "retry-delivery",
    });
    now = new Date(now.getTime() + 31_000);
    const confirmation = vi.fn().mockResolvedValue(undefined);

    await handlerWith(confirmation).handle(seeded.job, {
      attemptNumber: 2,
      attemptsMade: 1,
      maxAttempts: 4,
      deliveryId: "retry-delivery",
    });

    expect(confirmation).not.toHaveBeenCalled();
  });

  it("renews an expired publication lease for its recovery delivery", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "initial-delivery",
    });
    await requireConnection()
      .db.update(orderRecoveryJobs)
      .set({ status: "pending", leaseExpiresAt: null })
      .where(eq(orderRecoveryJobs.orderId, seeded.orderId));
    const recoveryDeliveryId = `recovery-${seeded.orderId}-1`;
    await controlPersistence.claimForPublication({
      recoveryKey: `order:${seeded.orderId}`,
      now,
      leaseMs: 30_000,
    });
    now = new Date(now.getTime() + 31_000);
    const confirmation = vi.fn().mockResolvedValue(undefined);

    const recoveryJob = { ...seeded.job, processingGeneration: 1 };
    await handlerWith(confirmation).handle(recoveryJob, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 1,
      deliveryId: recoveryDeliveryId,
      recoveryKey: `order:${seeded.orderId}`,
    });

    expect(confirmation).toHaveBeenCalledWith(
      recoveryJob,
      expect.objectContaining({ processingGeneration: 1 }),
    );
  });

  it("keeps ineligible work, including terminal-run work, out of a limited batch", async () => {
    const terminalRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const snapshot = previewRunConfigSnapshotFixture();
    await requireConnection()
      .db.insert(demoPresets)
      .values({
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        slug: `terminal-recovery-${sequence}`,
        visibility: "public",
        isEditable: false,
        isCustom: false,
        display: {
          name: "Terminal recovery",
          description: "Recovery eligibility fixture.",
          sortOrder: 1,
          outcomeFocus: ["run_history"],
        },
        ...snapshot,
      });
    await requireConnection().db.insert(demoRuns).values({
      id: terminalRunId,
      presetId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      presetName: "Terminal recovery",
      operatorMode: "public",
      status: "completed",
      trafficStatus: "succeeded",
      configSnapshot: snapshot,
      saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      finalizedAt: baseTime,
    });
    await requireConnection().db.insert(demoRunSaleContexts).values({
      runId: terminalRunId,
      saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const eligibleOld = await seedOrder({ createdAt: new Date(baseTime.getTime() - 40_000) });
    const eligibleNew = await seedOrder({ createdAt: new Date(baseTime.getTime() - 20_000) });
    const futureDue = await seedOrder({ createdAt: new Date(baseTime.getTime() - 30_000) });
    const leased = await seedOrder({ createdAt: new Date(baseTime.getTime() - 30_000) });
    const terminal = await seedOrder({
      createdAt: new Date(baseTime.getTime() - 30_000),
      status: "failed",
    });
    const terminalRunOld = await seedOrder({
      createdAt: new Date(baseTime.getTime() - 60_000),
      runId: terminalRunId,
    });
    const terminalRunNew = await seedOrder({
      createdAt: new Date(baseTime.getTime() - 50_000),
      runId: terminalRunId,
    });

    const due = new Date(baseTime.getTime() - 10_000);
    for (const seeded of [
      eligibleOld,
      eligibleNew,
      futureDue,
      leased,
      terminal,
      terminalRunOld,
      terminalRunNew,
    ]) {
      await requireConnection()
        .db.insert(orderRecoveryJobs)
        .values({
          recoveryKey: `order:${seeded.orderId}`,
          jobId: `job-${seeded.orderId}`,
          orderId: seeded.orderId,
          payload: seeded.job as unknown as Record<string, unknown>,
          reason: "test_setup",
          status: "pending",
          nextAttemptAt: due,
        });
    }
    await requireConnection()
      .db.update(orderRecoveryJobs)
      .set({ nextAttemptAt: new Date(baseTime.getTime() + 60_000) })
      .where(eq(orderRecoveryJobs.orderId, futureDue.orderId));
    await requireConnection()
      .db.update(orderRecoveryJobs)
      .set({ status: "enqueued", leaseExpiresAt: new Date(baseTime.getTime() + 60_000) })
      .where(eq(orderRecoveryJobs.orderId, leased.orderId));

    const batch = await controlPersistence.findRecoverable({ limit: 2, now });

    expect(batch.map((candidate) => candidate.recoveryKey)).toEqual([
      `order:${eligibleOld.orderId}`,
      `order:${eligibleNew.orderId}`,
    ]);
  });

  it("records dispatch intent only with ownership and keeps its immutable identity", async () => {
    const seeded = await seedOrder({ createdAt: now });
    const idempotencyKey = `erp-confirmation:${seeded.orderId}`;

    await expect(
      attemptPersistence.recordDispatchIntent({
        job: seeded.job,
        idempotencyKey,
        dispatchedAt: now,
        expectedProcessingGeneration: 0,
      }),
    ).rejects.toThrow(/No durable control record/);
    await expect(requireConnection().db.select().from(erpDispatchCalls)).resolves.toHaveLength(0);

    await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "initial-delivery",
    });
    await requireConnection()
      .db.update(orderRecoveryJobs)
      .set({ status: "pending", leaseExpiresAt: null, publicationOwner: null })
      .where(eq(orderRecoveryJobs.orderId, seeded.orderId));
    const claim = await controlPersistence.claimForPublication({
      recoveryKey: `order:${seeded.orderId}`,
      now,
      leaseMs: 30_000,
    });
    if (!claim) throw new Error("Expected the processing-control claim to succeed.");

    await expect(
      attemptPersistence.recordDispatchIntent({
        job: seeded.job,
        idempotencyKey,
        dispatchedAt: now,
        expectedProcessingGeneration: 0,
      }),
    ).rejects.toThrow(/not eligible for ERP dispatch/);

    const call = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey,
      dispatchedAt: now,
      expectedProcessingGeneration: claim.processingGeneration,
    });

    expect(call).toMatchObject({
      orderId: seeded.orderId,
      idempotencyKey,
      processingGeneration: 1,
      dispatchedAt: now.toISOString(),
    });
    const [intentRow] = await requireConnection()
      .db.select()
      .from(erpDispatchCalls)
      .where(eq(erpDispatchCalls.orderId, seeded.orderId));
    expect(intentRow).toMatchObject({
      id: call.erpCallId,
      processingGeneration: 1,
      publicOrderId: seeded.job.publicOrderId,
      reservationId: seeded.reservationId,
      saleOfferId: seeded.job.saleOfferId,
      correlationId: seeded.correlationId,
      quantity: 1,
      dispatchedAt: now,
    });
    expect(await controlPersistence.readControlRecord({ orderId: seeded.orderId })).toMatchObject({
      unresolvedErpCallId: call.erpCallId,
    });
  });

  it("retains uncertainty across lease expiry and resolves it idempotently", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "initial-delivery",
    });
    await requireConnection()
      .db.update(orderRecoveryJobs)
      .set({ status: "pending", leaseExpiresAt: null, publicationOwner: null })
      .where(eq(orderRecoveryJobs.orderId, seeded.orderId));

    const call = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey: `erp-confirmation:${seeded.orderId}`,
      dispatchedAt: now,
      expectedProcessingGeneration: 0,
    });

    // The recorded dispatched call survives the crash window: no attempt result
    // ever arrives, only time passes and the lease expires.
    now = new Date(baseTime.getTime() + 60_000);
    await expect(
      controlPersistence.claimForPublication({
        recoveryKey: `order:${seeded.orderId}`,
        now,
        leaseMs: 30_000,
      }),
    ).resolves.toMatchObject({ attempt: 1, processingGeneration: 1 });
    expect(await controlPersistence.readControlRecord({ orderId: seeded.orderId })).toMatchObject({
      processingGeneration: 1,
      unresolvedErpCallId: call.erpCallId,
    });

    await expect(
      attemptPersistence.recordDispatchIntent({
        job: seeded.job,
        idempotencyKey: `erp-confirmation:${seeded.orderId}`,
        dispatchedAt: now,
        expectedProcessingGeneration: 1,
      }),
    ).rejects.toThrow(/already has an unresolved ERP dispatch/);
    const unresolvedCalls = await requireConnection()
      .db.select()
      .from(erpDispatchCalls)
      .where(
        and(eq(erpDispatchCalls.orderId, seeded.orderId), isNull(erpDispatchCalls.resolvedAt)),
      );
    expect(unresolvedCalls.map((row) => row.id)).toEqual([call.erpCallId]);

    await expect(
      attemptPersistence.recordDispatchIntent({
        job: seeded.job,
        idempotencyKey: call.idempotencyKey,
        dispatchedAt: now,
        expectedProcessingGeneration: 1,
        supersedesErpCallId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toThrow(/already has an unresolved ERP dispatch/);
    expect(await attemptPersistence.findUnresolvedCall(seeded.orderId)).toEqual(call);
    expect(await controlPersistence.readControlRecord({ orderId: seeded.orderId })).toMatchObject({
      unresolvedErpCallId: call.erpCallId,
    });
    expect(
      await requireConnection()
        .db.select()
        .from(erpDispatchCalls)
        .where(eq(erpDispatchCalls.orderId, seeded.orderId)),
    ).toHaveLength(1);
    const db = requireConnection().db;
    const transaction = db.transaction.bind(db);
    const interrupted = new Error("replacement intent insertion interrupted");
    vi.spyOn(db, "transaction").mockImplementationOnce((callback) =>
      transaction(async (tx) => {
        vi.spyOn(tx, "insert").mockImplementationOnce(() => {
          throw interrupted;
        });
        return callback(tx);
      }),
    );
    await expect(
      attemptPersistence.recordDispatchIntent({
        job: seeded.job,
        idempotencyKey: call.idempotencyKey,
        dispatchedAt: now,
        expectedProcessingGeneration: 1,
        supersedesErpCallId: call.erpCallId,
      }),
    ).rejects.toBe(interrupted);
    expect(await attemptPersistence.findUnresolvedCall(seeded.orderId)).toEqual(call);
    expect(await controlPersistence.readControlRecord({ orderId: seeded.orderId })).toMatchObject({
      unresolvedErpCallId: call.erpCallId,
    });

    const newerCall = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey: `erp-confirmation:${seeded.orderId}`,
      dispatchedAt: now,
      expectedProcessingGeneration: 1,
      supersedesErpCallId: call.erpCallId,
    });
    const [resolvedCall] = await requireConnection()
      .db.select()
      .from(erpDispatchCalls)
      .where(eq(erpDispatchCalls.id, call.erpCallId));
    expect(resolvedCall?.resolvedAt).toEqual(now);
    expect(await controlPersistence.readControlRecord({ orderId: seeded.orderId })).toMatchObject({
      unresolvedErpCallId: newerCall.erpCallId,
    });
    await expect(
      controlPersistence.resolveDispatchedCall({
        orderId: seeded.orderId,
        erpCallId: newerCall.erpCallId,
      }),
    ).resolves.toBe(true);
    expect(await controlPersistence.readControlRecord({ orderId: seeded.orderId })).toMatchObject({
      unresolvedErpCallId: null,
      waitingReason: null,
    });
    await expect(
      controlPersistence.resolveDispatchedCall({
        orderId: seeded.orderId,
        erpCallId: call.erpCallId,
      }),
    ).resolves.toBe(false);
  });

  it("keeps canonical results and per-call accounting idempotent across duplicate writes", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "initial-delivery",
    });

    const successCall = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey: `erp-confirmation:${seeded.orderId}`,
      dispatchedAt: now,
      expectedProcessingGeneration: 0,
    });
    const successRecord = {
      job: seeded.job,
      delivery: { attemptNumber: 1, attemptsMade: 0, maxAttempts: 4, deliveryId: "d1" },
      call: successCall,
      status: "succeeded" as const,
      terminal: true,
      httpStatus: 200,
      latencyMs: 5,
      startedAt: now,
      finishedAt: new Date(now.getTime() + 5),
      response: {
        status: "succeeded" as const,
        confirmationId: "canonical-confirmation",
        httpStatus: 200 as const,
        latencyMs: 5,
        timestamp: "2026-06-22T00:00:00.005Z",
      },
    };
    await expect(attemptPersistence.recordAttempt(successRecord)).resolves.toBe(true);
    await expect(attemptPersistence.recordAttempt(successRecord)).resolves.toBe(false);

    const replayCall = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey: `erp-confirmation:${seeded.orderId}`,
      dispatchedAt: new Date(now.getTime() + 7),
      expectedProcessingGeneration: 0,
    });
    await expect(
      attemptPersistence.recordAttempt({ ...successRecord, call: replayCall }),
    ).resolves.toBe(true);

    const capacityCall = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey: `erp-confirmation:${seeded.orderId}`,
      dispatchedAt: new Date(now.getTime() + 10),
      expectedProcessingGeneration: 0,
    });
    await expect(
      attemptPersistence.recordAttempt({
        job: seeded.job,
        delivery: { attemptNumber: 1, attemptsMade: 1, maxAttempts: 4, deliveryId: "d1" },
        call: capacityCall,
        disposition: "capacity_rejected",
        status: "failed",
        terminal: false,
        httpStatus: 429,
        errorCode: "erp_capacity_exceeded",
        latencyMs: 3,
        startedAt: new Date(now.getTime() + 10),
        finishedAt: new Date(now.getTime() + 13),
      }),
    ).resolves.toBe(true);

    const timeoutCall = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey: `erp-confirmation:${seeded.orderId}`,
      dispatchedAt: new Date(now.getTime() + 20),
      expectedProcessingGeneration: 0,
    });
    await expect(
      attemptPersistence.recordAttempt({
        job: seeded.job,
        delivery: { attemptNumber: 1, attemptsMade: 2, maxAttempts: 4, deliveryId: "d1" },
        call: timeoutCall,
        status: "timed_out",
        terminal: false,
        errorCode: "erp_request_timeout",
        latencyMs: 2_000,
        startedAt: new Date(now.getTime() + 20),
        finishedAt: new Date(now.getTime() + 2_020),
      }),
    ).resolves.toBe(true);

    const attemptRows = await requireConnection()
      .db.select()
      .from(erpAttempts)
      .where(eq(erpAttempts.orderId, seeded.orderId));
    expect(attemptRows).toHaveLength(4);
    expect(new Set(attemptRows.map((row) => row.erpCallId))).toEqual(
      new Set([
        successCall.erpCallId,
        replayCall.erpCallId,
        capacityCall.erpCallId,
        timeoutCall.erpCallId,
      ]),
    );
    expect(attemptRows.filter((row) => row.idempotencyKey !== null)).toHaveLength(1);

    // The canonical success cleared its own unresolved identity; the later
    // timeout call is the unresolved one. Counters accumulate once per call.
    expect(await controlRow(seeded.orderId)).toMatchObject({
      unresolvedErpCallId: timeoutCall.erpCallId,
      attemptCounts: {
        succeeded: 2,
        capacity_rejected: 1,
        uncertain_result: 1,
      },
    });

    // Redelivered duplicate writes never double-count.
    await expect(attemptPersistence.recordAttempt(successRecord)).resolves.toBe(false);
    expect(await controlRow(seeded.orderId)).toMatchObject({
      attemptCounts: { succeeded: 2, capacity_rejected: 1, uncertain_result: 1 },
    });
  });

  it("bounds attempts, call rows, and attempt events without losing cumulative or protected evidence", async () => {
    const seeded = await seedOrder({ createdAt: now });
    const other = await seedOrder({ createdAt: new Date(now.getTime() + 1) });
    await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 1,
      deliveryId: "bounded-history",
    });
    await transitionPersistence.transitionToProcessing(other.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 1,
      deliveryId: "other-order",
    });

    const idempotencyKey = `erp-confirmation:${seeded.orderId}`;
    const supersededStartedAt = new Date(now.getTime() + 10);
    const supersededCall = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey,
      dispatchedAt: supersededStartedAt,
      expectedProcessingGeneration: 0,
    });
    const supersededRecord = {
      job: seeded.job,
      delivery: { attemptNumber: 1, attemptsMade: 0, maxAttempts: 1 },
      call: supersededCall,
      disposition: "uncertain_result" as const,
      status: "timed_out" as const,
      terminal: false,
      errorCode: "erp_request_timeout",
      latencyMs: 1,
      startedAt: supersededStartedAt,
      finishedAt: new Date(supersededStartedAt.getTime() + 1),
    };
    await attemptPersistence.recordAttempt(supersededRecord);

    const canonicalStartedAt = new Date(now.getTime() + 20);
    const canonicalCall = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey,
      dispatchedAt: canonicalStartedAt,
      expectedProcessingGeneration: 0,
      supersedesErpCallId: supersededCall.erpCallId,
    });
    await attemptPersistence.recordAttempt({
      job: seeded.job,
      delivery: { attemptNumber: 1, attemptsMade: 1, maxAttempts: 1 },
      call: canonicalCall,
      disposition: "succeeded",
      status: "succeeded",
      terminal: true,
      httpStatus: 200,
      latencyMs: 1,
      startedAt: canonicalStartedAt,
      finishedAt: new Date(canonicalStartedAt.getTime() + 1),
      response: {
        status: "succeeded",
        confirmationId: "bounded-history-canonical",
        httpStatus: 200,
        latencyMs: 1,
        timestamp: new Date(canonicalStartedAt.getTime() + 1).toISOString(),
      },
    });

    const permanentStartedAt = new Date(now.getTime() + 30);
    const permanentCall = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey,
      dispatchedAt: permanentStartedAt,
      expectedProcessingGeneration: 0,
    });
    await attemptPersistence.recordAttempt({
      job: seeded.job,
      delivery: { attemptNumber: 1, attemptsMade: 2, maxAttempts: 1 },
      call: permanentCall,
      disposition: "permanent_rejection",
      status: "failed",
      terminal: true,
      errorCode: "test_declared_permanent_rejection",
      latencyMs: 1,
      startedAt: permanentStartedAt,
      finishedAt: new Date(permanentStartedAt.getTime() + 1),
    });
    await controlPersistence.resolveDispatchedCall({
      orderId: seeded.orderId,
      erpCallId: permanentCall.erpCallId,
    });

    const timeoutStartedAt = new Date(now.getTime() + 40);
    const timeoutCall = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey,
      dispatchedAt: timeoutStartedAt,
      expectedProcessingGeneration: 0,
    });
    await attemptPersistence.recordAttempt({
      job: seeded.job,
      delivery: { attemptNumber: 1, attemptsMade: 3, maxAttempts: 1 },
      call: timeoutCall,
      disposition: "uncertain_result",
      status: "timed_out",
      terminal: false,
      errorCode: "erp_request_timeout",
      latencyMs: 1,
      startedAt: timeoutStartedAt,
      finishedAt: new Date(timeoutStartedAt.getTime() + 1),
    });

    const orphanCallIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const dispatchedAt = new Date(now.getTime() + 50 + index);
      const id = randomUUID();
      orphanCallIds.push(id);
      await requireConnection().db.insert(erpDispatchCalls).values({
        id,
        orderId: seeded.orderId,
        processingGeneration: 0,
        idempotencyKey,
        publicOrderId: seeded.job.publicOrderId,
        reservationId: seeded.job.reservationId,
        saleOfferId: seeded.job.saleOfferId,
        quantity: seeded.job.quantity,
        correlationId: seeded.job.correlationId,
        dispatchedAt,
        resolvedAt: dispatchedAt,
      });
    }

    for (let index = 0; index < erpAttemptHistoryRetentionLimit + 3; index += 1) {
      const startedAt = new Date(now.getTime() + 100 + index * 10);
      const erpCallId = randomUUID();
      await requireConnection().db.insert(erpDispatchCalls).values({
        id: erpCallId,
        orderId: seeded.orderId,
        processingGeneration: 0,
        idempotencyKey,
        publicOrderId: seeded.job.publicOrderId,
        reservationId: seeded.job.reservationId,
        saleOfferId: seeded.job.saleOfferId,
        quantity: seeded.job.quantity,
        correlationId: seeded.job.correlationId,
        dispatchedAt: startedAt,
      });
      await expect(
        attemptPersistence.recordAttempt({
          job: seeded.job,
          delivery: {
            attemptNumber: 1,
            attemptsMade: index + 4,
            maxAttempts: 1,
            deliveryId: "bounded-history",
          },
          call: {
            erpCallId,
            orderId: seeded.orderId,
            idempotencyKey,
            processingGeneration: 0,
            dispatchedAt: startedAt.toISOString(),
          },
          disposition: "capacity_rejected",
          status: "failed",
          terminal: false,
          httpStatus: 429,
          errorCode: "erp_capacity_exceeded",
          latencyMs: 1,
          startedAt,
          finishedAt: new Date(startedAt.getTime() + 1),
        }),
      ).resolves.toBe(true);
    }

    const otherStartedAt = new Date(now.getTime() + 1_000);
    const otherCall = await attemptPersistence.recordDispatchIntent({
      job: other.job,
      idempotencyKey: `erp-confirmation:${other.orderId}`,
      dispatchedAt: otherStartedAt,
      expectedProcessingGeneration: 0,
    });
    await attemptPersistence.recordAttempt({
      job: other.job,
      delivery: { attemptNumber: 1, attemptsMade: 0, maxAttempts: 1 },
      call: otherCall,
      disposition: "capacity_rejected",
      status: "failed",
      terminal: false,
      httpStatus: 429,
      errorCode: "erp_capacity_exceeded",
      latencyMs: 1,
      startedAt: otherStartedAt,
      finishedAt: new Date(otherStartedAt.getTime() + 1),
    });

    const [attemptRows, callRows, eventRows, otherAttemptRows] = await Promise.all([
      requireConnection()
        .db.select()
        .from(erpAttempts)
        .where(eq(erpAttempts.orderId, seeded.orderId)),
      requireConnection()
        .db.select()
        .from(erpDispatchCalls)
        .where(eq(erpDispatchCalls.orderId, seeded.orderId)),
      requireConnection()
        .db.select()
        .from(orderEvents)
        .where(
          and(
            eq(orderEvents.orderId, seeded.orderId),
            inArray(orderEvents.eventName, ["erp.attempt.failed", "erp.attempt.succeeded"]),
          ),
        ),
      requireConnection()
        .db.select()
        .from(erpAttempts)
        .where(eq(erpAttempts.orderId, other.orderId)),
    ]);
    expect(attemptRows).toHaveLength(erpAttemptHistoryRetentionLimit);
    expect(callRows).toHaveLength(erpAttemptHistoryRetentionLimit);
    expect(eventRows).toHaveLength(erpAttemptHistoryRetentionLimit);
    expect(otherAttemptRows).toHaveLength(1);
    expect(attemptRows.some((attempt) => attempt.idempotencyKey !== null)).toBe(true);
    expect(attemptRows.some((attempt) => attempt.disposition === "permanent_rejection")).toBe(true);
    expect(attemptRows.some((attempt) => attempt.erpCallId === timeoutCall.erpCallId)).toBe(true);
    expect(attemptRows.some((attempt) => attempt.erpCallId === supersededCall.erpCallId)).toBe(
      false,
    );
    expect(eventRows.some((event) => event.payload.canonical === true)).toBe(true);
    expect(eventRows.some((event) => event.payload.disposition === "permanent_rejection")).toBe(
      true,
    );
    expect(eventRows.some((event) => event.payload.erpCallId === timeoutCall.erpCallId)).toBe(true);
    expect(eventRows.some((event) => event.payload.erpCallId === supersededCall.erpCallId)).toBe(
      false,
    );
    expect(callRows.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        canonicalCall.erpCallId,
        permanentCall.erpCallId,
        timeoutCall.erpCallId,
      ]),
    );
    expect(callRows.some((call) => call.id === supersededCall.erpCallId)).toBe(false);
    expect(callRows.some((call) => orphanCallIds.includes(call.id))).toBe(false);
    expect(
      callRows.some((call) => call.id === timeoutCall.erpCallId && call.resolvedAt === null),
    ).toBe(true);
    expect(
      await requireConnection()
        .db.select()
        .from(orderEvents)
        .where(
          and(
            eq(orderEvents.orderId, seeded.orderId),
            eq(orderEvents.eventName, "order.processing"),
          ),
        ),
    ).toHaveLength(1);
    expect(await controlRow(seeded.orderId)).toMatchObject({
      unresolvedErpCallId: timeoutCall.erpCallId,
      attemptCounts: {
        capacity_rejected: erpAttemptHistoryRetentionLimit + 3,
        succeeded: 1,
        permanent_rejection: 1,
        uncertain_result: 2,
      },
    });

    await expect(attemptPersistence.recordAttempt(supersededRecord)).resolves.toBe(false);
    expect(await controlRow(seeded.orderId)).toMatchObject({
      attemptCounts: {
        capacity_rejected: erpAttemptHistoryRetentionLimit + 3,
        succeeded: 1,
        permanent_rejection: 1,
        uncertain_result: 2,
      },
    });
  });

  it("resolves ownership for a terminal technical failure", async () => {
    const seeded = await seedOrder({ createdAt: now });
    const delivery = {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "malformed-response-delivery",
    };
    const processing = await transitionPersistence.transitionToProcessing(seeded.job, delivery);
    const call = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey: `erp-confirmation:${seeded.orderId}`,
      dispatchedAt: now,
      expectedProcessingGeneration: processing.processingGeneration ?? 0,
    });

    await attemptPersistence.recordAttempt({
      job: seeded.job,
      delivery,
      call,
      disposition: "technical_failure",
      status: "failed",
      terminal: true,
      httpStatus: 200,
      errorCode: "erp_response_contract_invalid",
      latencyMs: 5,
      startedAt: now,
      finishedAt: new Date(now.getTime() + 5),
    });

    expect(await controlRow(seeded.orderId)).toMatchObject({
      unresolvedErpCallId: null,
      attemptCounts: { technical_failure: 1 },
    });
    const [storedCall] = await requireConnection()
      .db.select({ resolvedAt: erpDispatchCalls.resolvedAt })
      .from(erpDispatchCalls)
      .where(eq(erpDispatchCalls.id, call.erpCallId));
    expect(storedCall?.resolvedAt).not.toBeNull();
  });

  it.each([
    "connection_loss",
    "body_read_failure",
    "recognized_availability",
  ] as const)("preserves unresolved ownership unless %s supplies authoritative evidence", async (scenario) => {
    const seeded = await seedOrder({ createdAt: now });
    const delivery = {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "transport-failure-delivery",
    };
    const processing = await transitionPersistence.transitionToProcessing(seeded.job, delivery);
    const response = new Response(
      JSON.stringify({
        status: "failed",
        httpStatus: 503,
        errorCode: "erp_forced_outage",
        errorMessage: "offline",
        latencyMs: 5,
        timestamp: now.toISOString(),
      }),
      { status: 503 },
    );
    if (scenario === "body_read_failure") {
      vi.spyOn(response, "json").mockRejectedValue(new TypeError("terminated"));
    }
    const client = new HttpErpOrderConfirmation({
      baseUrl: "http://erp.test",
      lookupTimeoutMs: erpResiliencePolicy.initialRequestDeadlineMs,
      retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
      attemptPersistence,
      now: () => now,
      fetch:
        scenario === "connection_loss"
          ? vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"))
          : vi.fn<typeof fetch>().mockResolvedValue(response),
    });

    const outcome = await client.dispatch(
      seeded.job,
      {
        ...delivery,
        processingGeneration: processing.processingGeneration ?? 0,
      },
      erpResiliencePolicy.initialRequestDeadlineMs,
    );
    expect(outcome.disposition).toBe("temporarily_unavailable");
    const authoritative = scenario === "recognized_availability";
    expect(await controlRow(seeded.orderId)).toMatchObject({
      unresolvedErpCallId: authoritative ? null : outcome.call.erpCallId,
      attemptCounts: { temporarily_unavailable: 1 },
    });
    const [storedCall] = await requireConnection()
      .db.select({ resolvedAt: erpDispatchCalls.resolvedAt })
      .from(erpDispatchCalls)
      .where(eq(erpDispatchCalls.id, outcome.call.erpCallId));
    expect(storedCall?.resolvedAt).toEqual(authoritative ? now : null);
  });

  it.each([
    "success",
    "capacity",
  ] as const)("handles a timeout followed by %s without recounting earlier calls", async (outcome) => {
    const seeded = await seedOrder({ createdAt: now });
    const delivery = {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "replay-delivery",
    };
    await transitionPersistence.transitionToProcessing(seeded.job, delivery);
    const intent = {
      job: seeded.job,
      idempotencyKey: `erp-confirmation:${seeded.orderId}`,
      dispatchedAt: now,
      expectedProcessingGeneration: 0,
    };
    const callA = await attemptPersistence.recordDispatchIntent(intent);
    const base = { job: seeded.job, delivery, latencyMs: 5, startedAt: now, finishedAt: now };
    await attemptPersistence.recordAttempt({
      ...base,
      call: callA,
      status: "timed_out",
      terminal: false,
      errorCode: "erp_request_timeout",
    });
    await controlPersistence.resolveDispatchedCall({
      orderId: seeded.orderId,
      erpCallId: callA.erpCallId,
    });
    const callB = await attemptPersistence.recordDispatchIntent(intent);
    const result =
      outcome === "success"
        ? {
            ...base,
            call: callB,
            status: "succeeded" as const,
            terminal: true,
            httpStatus: 200,
            response: {
              status: "succeeded" as const,
              confirmationId: "replay-success",
              httpStatus: 200 as const,
              latencyMs: 5,
              timestamp: now.toISOString(),
            },
          }
        : {
            ...base,
            call: callB,
            disposition: "capacity_rejected" as const,
            status: "failed" as const,
            terminal: false,
            httpStatus: 429,
            errorCode: "erp_capacity_exceeded",
          };
    await expect(attemptPersistence.recordAttempt(result)).resolves.toBe(true);
    await expect(attemptPersistence.recordAttempt(result)).resolves.toBe(false);

    const calls = await requireConnection()
      .db.select()
      .from(erpDispatchCalls)
      .where(eq(erpDispatchCalls.orderId, seeded.orderId));
    expect(calls.find((call) => call.id === callA.erpCallId)?.resolvedAt).toEqual(now);
    expect(calls.find((call) => call.id === callB.erpCallId)?.resolvedAt).toEqual(now);
    expect(await controlRow(seeded.orderId)).toMatchObject({
      unresolvedErpCallId: null,
      attemptCounts: {
        uncertain_result: 1,
        [outcome === "success" ? "succeeded" : "capacity_rejected"]: 1,
      },
    });
  });

  it("allows only one concurrent dispatch intent for an order", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "concurrent-success-delivery",
    });
    const intents = await Promise.allSettled(
      [0, 1].map((offset) =>
        attemptPersistence.recordDispatchIntent({
          job: seeded.job,
          idempotencyKey: `erp-confirmation:${seeded.orderId}`,
          dispatchedAt: new Date(now.getTime() + offset),
          expectedProcessingGeneration: 0,
        }),
      ),
    );
    expect(intents.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(intents.filter((result) => result.status === "rejected")).toHaveLength(1);
    const fulfilled = intents.find((result) => result.status === "fulfilled");
    if (!fulfilled) throw new Error("Expected one dispatch intent to win.");
    const call = fulfilled.value;
    const response = {
      status: "succeeded" as const,
      confirmationId: "concurrent-canonical-confirmation",
      httpStatus: 200 as const,
      latencyMs: 5,
      timestamp: "2026-06-22T00:00:00.005Z",
    };

    await expect(
      attemptPersistence.recordAttempt({
        job: seeded.job,
        delivery: {
          attemptNumber: 1,
          attemptsMade: 0,
          maxAttempts: 1,
          deliveryId: "concurrent-success-delivery",
        },
        call,
        status: "succeeded",
        terminal: true,
        httpStatus: 200,
        latencyMs: 5,
        startedAt: now,
        finishedAt: new Date(now.getTime() + 5),
        response,
      }),
    ).resolves.toBe(true);

    const attempts = await requireConnection()
      .db.select()
      .from(erpAttempts)
      .where(eq(erpAttempts.orderId, seeded.orderId));
    expect(attempts).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.idempotencyKey !== null)).toHaveLength(1);
    expect(await controlRow(seeded.orderId)).toMatchObject({ attemptCounts: { succeeded: 1 } });
    const dispatchCalls = await requireConnection()
      .db.select()
      .from(erpDispatchCalls)
      .where(eq(erpDispatchCalls.orderId, seeded.orderId));
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]?.resolvedAt).not.toBeNull();
  });

  it("resolves malformed success and retains opaque server uncertainty", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "uncertain-response-delivery",
    });
    const cases = [
      {
        disposition: "technical_failure" as const,
        errorCode: "erp_response_contract_invalid",
        httpStatus: 200,
        terminal: true,
      },
      {
        disposition: "uncertain_result" as const,
        errorCode: "erp_unknown_server_failure",
        httpStatus: 500,
        terminal: false,
      },
    ] as const;
    const calls: ErpCallReference[] = [];
    for (const [index, outcome] of cases.entries()) {
      const previousCall = calls.at(-1);
      if (previousCall) {
        await controlPersistence.resolveDispatchedCall({
          orderId: seeded.orderId,
          erpCallId: previousCall.erpCallId,
        });
      }
      const call = await attemptPersistence.recordDispatchIntent({
        job: seeded.job,
        idempotencyKey: `erp-confirmation:${seeded.orderId}`,
        dispatchedAt: new Date(now.getTime() + index),
        expectedProcessingGeneration: 0,
      });
      calls.push(call);
      await attemptPersistence.recordAttempt({
        job: seeded.job,
        delivery: {
          attemptNumber: index + 1,
          attemptsMade: index,
          maxAttempts: 4,
          deliveryId: "uncertain-response-delivery",
        },
        call,
        disposition: outcome.disposition,
        status: "failed",
        terminal: outcome.terminal,
        httpStatus: outcome.httpStatus,
        errorCode: outcome.errorCode,
        latencyMs: 1,
        startedAt: now,
        finishedAt: new Date(now.getTime() + 1),
      });
    }

    const dispatchCalls = await requireConnection()
      .db.select()
      .from(erpDispatchCalls)
      .where(eq(erpDispatchCalls.orderId, seeded.orderId));
    expect(dispatchCalls).toHaveLength(2);
    expect(dispatchCalls.filter((call) => call.resolvedAt === null)).toHaveLength(1);
    expect(await controlRow(seeded.orderId)).toMatchObject({
      unresolvedErpCallId: calls[1]?.erpCallId,
      attemptCounts: { technical_failure: 1, uncertain_result: 1 },
    });
  });

  it("marks publication failures without overwriting a newer owner", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await requireConnection()
      .db.insert(orderRecoveryJobs)
      .values({
        recoveryKey: `order:${seeded.orderId}`,
        jobId: `job-${seeded.orderId}`,
        orderId: seeded.orderId,
        payload: seeded.job as unknown as Record<string, unknown>,
        reason: "test_setup",
        status: "pending",
        nextAttemptAt: now,
      });

    const claim = await controlPersistence.claimForPublication({
      recoveryKey: `order:${seeded.orderId}`,
      now,
      leaseMs: 30_000,
    });
    expect(claim).toMatchObject({ attempt: 1, processingGeneration: 1 });

    // A stale reporter (generation 0) cannot release the newer owner's lease.
    await controlPersistence.markPublicationFailed({
      recoveryKey: `order:${seeded.orderId}`,
      error: "queue publication failed",
      nextAttemptAt: new Date(now.getTime() + 1_000),
      processingGeneration: 0,
    });
    expect(await controlRow(seeded.orderId)).toMatchObject({
      status: "enqueued",
      processingGeneration: 1,
      publicationOwner: `recovery-${seeded.orderId}-1`,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
    });

    await controlPersistence.markPublicationFailed({
      recoveryKey: `order:${seeded.orderId}`,
      error: "queue publication failed",
      nextAttemptAt: new Date(now.getTime() + 1_000),
      processingGeneration: 1,
    });
    expect(await controlRow(seeded.orderId)).toMatchObject({
      status: "pending",
      processingGeneration: 1,
      publicationOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: new Date(now.getTime() + 1_000),
      lastError: "queue publication failed",
    });

    await requireConnection()
      .db.update(orderRecoveryJobs)
      .set({ status: "resolved" })
      .where(eq(orderRecoveryJobs.orderId, seeded.orderId));
    await controlPersistence.markPublicationFailed({
      recoveryKey: `order:${seeded.orderId}`,
      error: "late queue publication failure",
      nextAttemptAt: new Date(now.getTime() + 2_000),
      processingGeneration: 1,
    });
    expect(await controlRow(seeded.orderId)).toMatchObject({ status: "resolved" });
  });

  it("counts local transport failures as temporarily unavailable", async () => {
    const seeded = await seedOrder({ createdAt: now });
    await transitionPersistence.transitionToProcessing(seeded.job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
      deliveryId: "transport-delivery",
    });
    const call = await attemptPersistence.recordDispatchIntent({
      job: seeded.job,
      idempotencyKey: `erp-confirmation:${seeded.orderId}`,
      dispatchedAt: now,
      expectedProcessingGeneration: 0,
    });

    await attemptPersistence.recordAttempt({
      job: seeded.job,
      delivery: {
        attemptNumber: 1,
        attemptsMade: 0,
        maxAttempts: 4,
        deliveryId: "transport-delivery",
      },
      call,
      status: "failed",
      terminal: false,
      errorCode: "erp_request_failed",
      errorMessage: "connection reset",
      latencyMs: 1,
      startedAt: now,
      finishedAt: new Date(now.getTime() + 1),
    });

    expect(await controlRow(seeded.orderId)).toMatchObject({
      unresolvedErpCallId: call.erpCallId,
      attemptCounts: { temporarily_unavailable: 1 },
    });
  });

  it("reconciles terminal orders out of the recoverable selection", async () => {
    const seeded = await seedOrder({ createdAt: now, status: "processing" });
    await requireConnection()
      .db.insert(orderRecoveryJobs)
      .values({
        recoveryKey: `order:${seeded.orderId}`,
        jobId: `job-${seeded.orderId}`,
        orderId: seeded.orderId,
        payload: seeded.job as unknown as Record<string, unknown>,
        reason: "test_setup",
        status: "pending",
        nextAttemptAt: now,
      });
    await requireConnection()
      .db.update(orders)
      .set({ status: "failed", failedAt: new Date(now.getTime() + 5) })
      .where(eq(orders.id, seeded.orderId));

    await expect(controlPersistence.reconcileTerminal()).resolves.toBe(1);
    expect(await controlRow(seeded.orderId)).toMatchObject({ status: "resolved" });
    await expect(
      requireConnection()
        .db.select()
        .from(orderRecoveryJobs)
        .where(
          and(
            eq(orderRecoveryJobs.orderId, seeded.orderId),
            eq(orderRecoveryJobs.status, "resolved"),
          ),
        ),
    ).resolves.toHaveLength(1);
  });
});
