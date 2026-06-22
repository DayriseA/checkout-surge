import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readBusinessOutcomeSummary } from "../../src/business-outcome-dashboard.js";
import { createDatabaseConnection } from "../../src/client.js";
import {
  demoPresets,
  demoRunReservationOutcomes,
  demoRunSaleContexts,
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
    const presetId = "33333333-3333-4333-8333-333333333333";
    const runId = "44444444-4444-4444-8444-444444444444";

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
    await connection.db.insert(demoPresets).values({
      id: presetId,
      slug: "business-outcome-preset",
      visibility: "admin",
      isEditable: true,
      display: { name: "Business Outcome Preset", description: "Projection test" },
      trafficConfig: {},
      inventoryConfig: {},
      erpConfig: {},
      backpressureConfig: {},
    });
    await connection.db.insert(demoRuns).values({
      id: runId,
      presetId,
      presetName: "Business Outcome Preset",
      operatorMode: "admin",
      status: "active",
      trafficStatus: "active",
      configSnapshot: {
        trafficConfig: {},
        inventoryConfig: {},
        erpConfig: {},
        backpressureConfig: {},
      },
      saleOfferId,
      startedAt: now,
    });
    await connection.db.insert(demoRunSaleContexts).values({
      runId,
      saleOfferId,
    });
    await connection.db.insert(demoRunReservationOutcomes).values({
      runId,
      outcome: "api_sold_out_decision",
      count: 7,
      source: "redis",
      capturedAt: now,
      latestObservedAt: now,
    });

    await connection.db.insert(reservations).values(
      ["queued", "processing", "confirmed", "failed"].map((status, index) => ({
        id: `55555555-5555-4555-8555-55555555555${index}`,
        saleOfferId,
        runId,
        correlationId: `corr-${status}`,
        quantity: 1,
        status: "secured" as const,
        reservationToken: `res-${status}`,
        securedAt: now,
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
        quantity: 1,
        status: status as "queued" | "processing" | "confirmed" | "failed",
        queuedAt: now,
        ...(status === "processing" ? { processingAt: now } : {}),
        ...(status === "confirmed" ? { processingAt: now, confirmedAt: now } : {}),
        ...(status === "failed" ? { processingAt: now, failedAt: now } : {}),
      })),
    );
    await connection.db.insert(erpAttempts).values({
      orderId: "66666666-6666-4666-8666-666666666661",
      runId,
      correlationId: "corr-processing",
      attemptNumber: 1,
      status: "failed",
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
      idempotencyKey: "pending-key",
      quantity: 1,
      reservationToken: "res-pending",
      securedAt: now,
      expiresAt: new Date("2026-06-21T00:15:00.000Z"),
    });
    await connection.db.insert(simulatedNotifications).values({
      orderId: "66666666-6666-4666-8666-666666666662",
      saleOfferId,
      runId,
      correlationId: "corr-confirmed",
      channel: "email",
      recipientPlaceholder: "buyer@example.invalid",
      status: "recorded",
      recordedAt: now,
    });

    await expect(
      readBusinessOutcomeSummary(connection.db, { saleOfferId, runId }),
    ).resolves.toEqual({
      acceptedReservations: 4,
      soldOutRejections: 7,
      queuedOrders: 1,
      processingOrders: 1,
      retryingOrders: 1,
      confirmedOrders: 1,
      failedOrders: 1,
      pendingPersistenceCount: 1,
      notificationsRecorded: 1,
    });
  });
});
