import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import {
  createDatabaseConnection,
  demoPresets,
  demoRunSaleContexts,
  demoRuns,
  erpAttempts,
  orderRecoveryJobs,
  orders,
  products,
  readBusinessOutcomeSummary,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresErpAttemptStatusReader } from "../src/services/erp-status-service.js";

const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  saleOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  saleOfferB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc",
  reservation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  order: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  preset: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  runA: "11111111-1111-4111-8111-111111111111",
  runB: "22222222-2222-4222-8222-222222222222",
  reservationB: "33333333-3333-4333-8333-333333333333",
  reservationUnscoped: "44444444-4444-4444-8444-444444444444",
  orderB: "55555555-5555-4555-8555-555555555555",
  orderUnscoped: "66666666-6666-4666-8666-666666666666",
} as const;

describe("PostgresErpAttemptStatusReader", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;
    await resetTestDatabase();
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await seedOrder(connection);
  });

  afterEach(async () => {
    await connection?.close();
    connection = null;
  });

  it("uses exact aggregate counts for recent ERP attempts beyond the read-model sample size", async () => {
    if (!connection) {
      throw new Error("Test database connection was not initialized.");
    }

    const firstAttemptStartedAt = new Date("2026-06-22T00:00:00.000Z");
    await connection.db.insert(orderRecoveryJobs).values({
      recoveryKey: `order:${ids.order}`,
      jobId: "erp-status-reader-control",
      orderId: ids.order,
      payload: {},
      reason: "erp_processing",
      attemptCounts: {
        capacity_rejected: 90,
        temporarily_unavailable: 10,
        uncertain_result: 5,
        permanent_rejection: 1,
      },
    });
    await connection.db.insert(erpAttempts).values(
      Array.from({ length: 125 }, (_, index) => {
        const attemptNumber = index + 1;
        const status: "succeeded" | "failed" | "timed_out" =
          attemptNumber % 5 === 0 ? "timed_out" : attemptNumber % 2 === 0 ? "failed" : "succeeded";
        const startedAt = new Date(firstAttemptStartedAt.getTime() + attemptNumber * 1000);
        const finishedAt = new Date(startedAt.getTime() + 25);

        return {
          orderId: ids.order,
          runId: ids.runA,
          deliveryId: `status-reader-delivery-${attemptNumber}`,
          correlationId: "corr-erp-status-reader",
          attemptNumber,
          status,
          terminal: status === "succeeded",
          httpStatus: status === "succeeded" ? 200 : 503,
          latencyMs: 25,
          startedAt,
          finishedAt,
        };
      }),
    );

    const readModel = await new PostgresErpAttemptStatusReader(connection.db).readStatus(
      { runId: ids.runA },
      new Date("2026-06-22T00:03:00.000Z"),
      300,
    );

    expect(readModel.recentAttemptCount).toBe(125);
    expect(readModel.recentFailureCount).toBe(50);
    expect(readModel.recentTimeoutCount).toBe(25);
    expect(readModel.cumulativeOutcomeCounts).toEqual({
      capacityRejected: 90,
      temporarilyUnavailable: 10,
      uncertainResult: 5,
      permanentRejected: 1,
    });
    expect(readModel.latestAttempt).toEqual({
      runId: ids.runA,
      status: "timed_out",
      finishedAt: expect.any(String),
    });
  });

  it.each([
    {
      ordering: "sequential",
      finishedSeconds: { runAFirst: 1, runASecond: 2, runBFirst: 3, runBSecond: 4, unscoped: 5 },
    },
    {
      ordering: "interleaved",
      finishedSeconds: { runAFirst: 1, runASecond: 3, runBFirst: 2, runBSecond: 5, unscoped: 4 },
    },
  ])("isolates $ordering finishedAt ordering and business outcomes from nullable-unscoped data", async ({
    finishedSeconds,
  }) => {
    if (!connection) throw new Error("Test database connection was not initialized.");
    const startedAt = new Date("2026-06-22T00:00:00.000Z");
    await connection.db
      .insert(erpAttempts)
      .values([
        attempt(ids.order, ids.runA, 1, "failed", finishedSeconds.runAFirst),
        attempt(ids.orderB, ids.runB, 1, "succeeded", finishedSeconds.runBFirst),
        attempt(ids.order, ids.runA, 2, "timed_out", finishedSeconds.runASecond),
        attempt(ids.orderUnscoped, null, 1, "failed", finishedSeconds.unscoped),
        attempt(ids.orderB, ids.runB, 2, "failed", finishedSeconds.runBSecond),
      ]);
    const reader = new PostgresErpAttemptStatusReader(connection.db);
    const expectedBusinessOutcome = {
      acceptedReservations: 1,
      reservedUnits: 1,
      soldOutRejections: 0,
      queuedOrders: 1,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 0,
      failedOrders: 0,
      businessRejectedOrders: 0,
      administrativelyDisposedOrders: 0,
      pendingPersistenceCount: 0,
      notificationsRecorded: 0,
    };

    await expect(
      reader.readStatus({ runId: ids.runA }, new Date(startedAt.getTime() + 10_000), 60),
    ).resolves.toMatchObject({
      latestAttempt: { runId: ids.runA, status: "timed_out" },
      recentAttemptCount: 2,
      recentFailureCount: 1,
      recentTimeoutCount: 1,
    });
    await expect(
      reader.readStatus({ runId: ids.runB }, new Date(startedAt.getTime() + 10_000), 60),
    ).resolves.toMatchObject({
      latestAttempt: { runId: ids.runB, status: "failed" },
      recentAttemptCount: 2,
      recentFailureCount: 1,
      recentTimeoutCount: 0,
    });
    await expect(
      reader.readStatus(
        { runId: "77777777-7777-4777-8777-777777777777" },
        new Date(startedAt.getTime() + 10_000),
        60,
      ),
    ).resolves.toMatchObject({
      latestAttempt: null,
      recentAttemptCount: 0,
      recentFailureCount: 0,
      recentTimeoutCount: 0,
    });
    await expect(
      Promise.all([
        readBusinessOutcomeSummary(connection.db, {
          saleOfferId: ids.saleOffer,
          runId: ids.runA,
        }),
        readBusinessOutcomeSummary(connection.db, {
          saleOfferId: ids.saleOfferB,
          runId: ids.runB,
        }),
      ]),
    ).resolves.toEqual([expectedBusinessOutcome, expectedBusinessOutcome]);
  });
});

async function seedOrder(connection: ReturnType<typeof createDatabaseConnection>): Promise<void> {
  await connection.db.insert(products).values({
    id: ids.product,
    sku: "ERP-STATUS-READER-SKU",
    slug: "erp-status-reader-product",
    name: "ERP Status Reader Product",
    isActive: true,
  });
  await connection.db.insert(saleOffers).values(
    [ids.saleOffer, ids.saleOfferB].map((id, index) => ({
      id,
      productId: ids.product,
      name: `ERP Status Reader Sale Offer ${index}`,
      allocatedStock: 125,
      saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
      saleEndsAt: new Date("2035-01-01T00:00:00.000Z"),
      isActive: true,
      purpose: "catalog" as const,
    })),
  );
  await connection.db.insert(demoPresets).values({
    id: ids.preset,
    slug: "erp-status-reader",
    visibility: "admin",
    isEditable: true,
    display: {
      name: "ERP status reader",
      description: "ERP status reader integration fixture.",
      sortOrder: 1,
      outcomeFocus: [],
    },
    ...previewRunConfigSnapshotFixture(),
  });
  const completedAt = new Date("2026-06-22T00:10:00.000Z");
  await connection.db.insert(demoRuns).values(
    [ids.runA, ids.runB].map((id, index) => ({
      id,
      presetId: ids.preset,
      presetName: "ERP status reader",
      operatorMode: "admin" as const,
      status: "completed" as const,
      trafficStatus: "succeeded" as const,
      saleOfferId: index === 0 ? ids.saleOffer : ids.saleOfferB,
      configSnapshot: previewRunConfigSnapshotFixture(),
      startedAt: new Date(completedAt.getTime() - (index + 1) * 60_000),
      trafficStartedAt: new Date(completedAt.getTime() - (index + 1) * 60_000),
      trafficEndedAt: completedAt,
      finalizedAt: completedAt,
    })),
  );
  await connection.db.insert(demoRunSaleContexts).values([
    { runId: ids.runA, saleOfferId: ids.saleOffer },
    { runId: ids.runB, saleOfferId: ids.saleOfferB },
  ]);
  await connection.db.insert(reservations).values(
    [
      [ids.reservation, ids.runA, ids.saleOffer, "a"],
      [ids.reservationB, ids.runB, ids.saleOfferB, "b"],
      [ids.reservationUnscoped, null, ids.saleOffer, "unscoped"],
    ].map(([id, runId, saleOfferId], index) => ({
      id: id as string,
      saleOfferId: saleOfferId as string,
      runId: runId as string | null,
      correlationId: "corr-erp-status-reader",
      quantity: 1,
      reservationToken: `erp-status-reader-token-${index}`,
      expiresAt: new Date("2026-06-22T00:15:00.000Z"),
      securedAt: new Date("2026-06-22T00:00:00.000Z"),
    })),
  );
  await connection.db
    .insert(orders)
    .values([
      order(ids.order, ids.reservation, ids.runA, ids.saleOffer, "a"),
      order(ids.orderB, ids.reservationB, ids.runB, ids.saleOfferB, "b"),
      order(ids.orderUnscoped, ids.reservationUnscoped, null, ids.saleOffer, "unscoped"),
    ]);
}

function order(
  id: string,
  reservationId: string,
  runId: string | null,
  saleOfferId: string,
  suffix: string,
) {
  return {
    id,
    publicOrderId: `ord_erp_status_reader_${suffix}`,
    saleOfferId,
    reservationId,
    runId,
    correlationId: "corr-erp-status-reader",
    quantity: 1,
    status: "queued" as const,
    queuedAt: new Date("2026-06-22T00:00:00.000Z"),
  };
}

function attempt(
  orderId: string,
  runId: string | null,
  attemptNumber: number,
  status: "succeeded" | "failed" | "timed_out",
  finishedSecond: number,
) {
  const startedAt = new Date(`2026-06-22T00:00:0${finishedSecond}.000Z`);
  return {
    orderId,
    runId,
    deliveryId: `status-reader-${orderId}-${attemptNumber}`,
    correlationId: "corr-erp-status-reader",
    attemptNumber,
    status,
    terminal: status === "succeeded",
    httpStatus: status === "succeeded" ? 200 : 503,
    latencyMs: 25,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 25),
  };
}
