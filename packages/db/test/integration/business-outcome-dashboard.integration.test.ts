import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readBusinessOutcomeSummary,
  readConsistencyLagSummary,
} from "../../src/business-outcome-dashboard.js";
import { createDatabaseConnection } from "../../src/client.js";
import {
  demoPresets,
  demoRunSaleContexts,
  demoRunSoldOutCounts,
  demoRuns,
  erpAttempts,
  orders,
  products,
  reservationPendingPersistence,
  reservations,
  saleOffers,
  simulatedNotifications,
} from "../../src/schema.js";
import { resetTestDatabase } from "../../src/testing.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("business outcome dashboard projection", () => {
  let connection: ReturnType<typeof createDatabaseConnection>;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for business outcome dashboard tests.");
    }

    await resetTestDatabase({ databaseUrl, migrationsFolder });
    connection = createDatabaseConnection(databaseUrl, { max: 1 });
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("counts secured, waiting, retrying, terminal, pending, sold-out, and notification outcomes", async () => {
    const now = new Date("2026-06-21T00:00:00.000Z");
    const productId = "11111111-1111-4111-8111-111111111111";
    const saleOfferId = "22222222-2222-4222-8222-222222222222";
    const otherSaleOfferId = "22222222-2222-4222-8222-222222222223";
    const presetId = "33333333-3333-4333-8333-333333333333";
    const runId = "44444444-4444-4444-8444-444444444444";
    const otherRunId = "44444444-4444-4444-8444-444444444445";

    await connection.db.insert(products).values({
      id: productId,
      sku: "business-outcome-test",
      slug: "business-outcome-test",
      name: "Business Outcome Test",
    });
    await connection.db.insert(saleOffers).values({
      id: saleOfferId,
      productId,
      name: "Business Outcome Offer",
      allocatedStock: 10,
      saleStartsAt: now,
      saleEndsAt: new Date("2026-06-22T00:00:00.000Z"),
      purpose: "generated_run",
    });
    await connection.db.insert(saleOffers).values({
      id: otherSaleOfferId,
      productId,
      name: "Business Outcome Other Offer",
      allocatedStock: 10,
      saleStartsAt: now,
      saleEndsAt: new Date("2026-06-22T00:00:00.000Z"),
      purpose: "generated_run",
    });
    await connection.db.insert(demoPresets).values({
      id: presetId,
      slug: "business-outcome-preset",
      visibility: "admin",
      isEditable: true,
      display: {
        name: "Business Outcome Preset",
        description: "Projection test",
        sortOrder: 1,
        outcomeFocus: ["business_outcome"],
      },
      ...configSnapshotFixture(),
    });
    await connection.db.insert(demoRuns).values({
      id: runId,
      presetId,
      presetName: "Business Outcome Preset",
      operatorMode: "admin",
      status: "active",
      trafficStatus: "active",
      configSnapshot: configSnapshotFixture(),
      saleOfferId,
      startedAt: now,
    });
    await connection.db.insert(demoRuns).values({
      id: otherRunId,
      presetId,
      presetName: "Business Outcome Preset",
      operatorMode: "admin",
      status: "completed",
      trafficStatus: "succeeded",
      configSnapshot: configSnapshotFixture(),
      saleOfferId: otherSaleOfferId,
      startedAt: now,
      trafficStartedAt: now,
      trafficEndedAt: now,
      finalizedAt: now,
    });
    await connection.db.insert(demoRunSaleContexts).values({
      runId,
      saleOfferId,
    });
    await connection.db.insert(demoRunSaleContexts).values({
      runId: otherRunId,
      saleOfferId: otherSaleOfferId,
    });
    await connection.db.insert(demoRunSoldOutCounts).values({
      runId,
      count: 7,
      capturedAt: now,
      latestObservedAt: now,
    });

    const securedAtByStatus = {
      queued: now,
      processing: new Date(now.getTime() - 3_000),
      confirmed: new Date(now.getTime() - 2_000),
      failed: now,
    } as const;

    await connection.db.insert(reservations).values(
      ["queued", "processing", "confirmed", "failed"].map((status, index) => ({
        id: `55555555-5555-4555-8555-55555555555${index}`,
        saleOfferId,
        runId,
        correlationId: `corr-${status}`,
        quantity: status === "confirmed" ? 2 : 1,
        reservationToken: `res-${status}`,
        securedAt: securedAtByStatus[status as keyof typeof securedAtByStatus],
        expiresAt: new Date("2026-06-21T00:15:00.000Z"),
      })),
    );
    await connection.db.insert(orders).values(
      ["queued", "processing", "confirmed", "failed"].map((status, index) => ({
        id: `66666666-6666-4666-8666-66666666666${index}`,
        publicOrderId: `ord-${status}`,
        saleOfferId,
        reservationId: `55555555-5555-4555-8555-55555555555${index}`,
        runId,
        correlationId: `corr-${status}`,
        quantity: status === "confirmed" ? 2 : 1,
        status: status as "queued" | "processing" | "confirmed" | "failed",
        queuedAt: securedAtByStatus[status as keyof typeof securedAtByStatus],
        ...(status === "processing" ? { processingAt: now } : {}),
        ...(status === "confirmed" ? { processingAt: now, confirmedAt: now } : {}),
        ...(status === "failed"
          ? { processingAt: now, failedAt: now, failureCategory: "technical" as const }
          : {}),
      })),
    );
    await connection.db.insert(reservations).values({
      id: "55555555-5555-4555-8555-555555555554",
      saleOfferId,
      runId,
      correlationId: "corr-delayed",
      quantity: 1,
      reservationToken: "res-delayed",
      securedAt: new Date(now.getTime() - 6_000),
      expiresAt: new Date("2026-06-21T00:15:00.000Z"),
    });
    await connection.db.insert(reservations).values({
      id: "55555555-5555-4555-8555-555555555555",
      saleOfferId: otherSaleOfferId,
      runId: otherRunId,
      correlationId: "corr-other-run",
      quantity: 9,
      reservationToken: "res-other-run",
      securedAt: now,
      expiresAt: new Date("2026-06-21T00:15:00.000Z"),
    });
    await connection.db.insert(orders).values({
      id: "66666666-6666-4666-8666-666666666664",
      publicOrderId: "ord-delayed",
      saleOfferId,
      reservationId: "55555555-5555-4555-8555-555555555554",
      runId,
      correlationId: "corr-delayed",
      quantity: 1,
      status: "processing",
      queuedAt: new Date(now.getTime() - 6_000),
      processingAt: new Date(now.getTime() - 6_000),
    });
    await connection.db.insert(erpAttempts).values({
      orderId: "66666666-6666-4666-8666-666666666661",
      deliveryId: "dashboard-delivery-1",
      runId,
      correlationId: "corr-processing",
      attemptNumber: 1,
      status: "failed",
      terminal: false,
      errorCode: "temporary_erp_failure",
      errorMessage: "ERP temporarily failed.",
      latencyMs: 25,
      startedAt: now,
      finishedAt: now,
    });
    await connection.db.insert(reservationPendingPersistence).values({
      reservationId: "77777777-7777-4777-8777-777777777777",
      saleOfferId,
      runId,
      correlationId: "corr-pending",
    });
    await connection.db.insert(simulatedNotifications).values({
      orderId: "66666666-6666-4666-8666-666666666662",
      saleOfferId,
      runId,
      correlationId: "corr-confirmed",
      recipientPlaceholder: "buyer@example.invalid",
      recordedAt: now,
    });

    await expect(
      readBusinessOutcomeSummary(connection.db, { saleOfferId, runId }),
    ).resolves.toEqual({
      acceptedReservations: 5,
      reservedUnits: 6,
      soldOutRejections: 7,
      queuedOrders: 1,
      processingOrders: 2,
      retryingOrders: 1,
      confirmedOrders: 1,
      failedOrders: 1,
      businessRejectedOrders: 0,
      technicallyFailedOrders: 1,
      administrativelyDisposedOrders: 0,
      pendingPersistenceCount: 1,
      notificationsRecorded: 1,
    });

    await expect(
      readConsistencyLagSummary(
        connection.db,
        {
          saleOfferId,
          runId,
        },
        now,
      ),
    ).resolves.toEqual({
      confirmedOrderCount: 1,
      pendingConfirmationCount: 3,
      averageLagMs: 2000,
      p95LagMs: 2000,
      maxLagMs: 2000,
      oldestPendingAgeSeconds: 6,
      measuredAt: now.toISOString(),
    });
  });
});

function configSnapshotFixture() {
  return {
    trafficConfig: {
      mode: "buyer-spike" as const,
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 10,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 10,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 10,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 1_000,
    },
    backpressureConfig: {
      queueName: "orders:process" as const,
      physicalQueueName: "orders-process" as const,
      orderProcessConcurrency: 1,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}
