import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readBusinessOutcomeSummary,
  readConsistencyLagSummary,
  readDownstreamErpStatus,
  readRunRuntimeProgress,
} from "../../src/business-outcome-dashboard.js";
import { createDatabaseConnection } from "../../src/client.js";
import {
  demoPresets,
  demoRunSaleContexts,
  demoRunSoldOutCounts,
  demoRuns,
  erpAttempts,
  erpScopeResilienceState,
  orders,
  products,
  reservationPendingPersistence,
  reservations,
  saleOffers,
  simulatedNotifications,
} from "../../src/schema.js";
import { requireTestDatabaseUrl, resetTestDatabase } from "../../src/testing.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const databaseUrl = requireTestDatabaseUrl();

describe("business outcome dashboard projection", () => {
  let connection: ReturnType<typeof createDatabaseConnection>;

  beforeAll(async () => {
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
    });
    await connection.db.insert(saleOffers).values({
      id: otherSaleOfferId,
      productId,
      name: "Business Outcome Other Offer",
      allocatedStock: 10,
      saleStartsAt: now,
      saleEndsAt: new Date("2026-06-22T00:00:00.000Z"),
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
      correlationId: "corr-test-run",
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
      correlationId: "corr-test-run",
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
        ...(status === "failed" ? { processingAt: now, failedAt: now } : {}),
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
    await connection.db.insert(reservations).values({
      id: "55555555-5555-4555-8555-555555555556",
      saleOfferId: otherSaleOfferId,
      runId: otherRunId,
      correlationId: "corr-other-attributed",
      quantity: 1,
      reservationToken: "res-other-attributed",
      securedAt: now,
      expiresAt: new Date("2026-06-21T00:15:00.000Z"),
    });
    await connection.db.insert(orders).values({
      id: "66666666-6666-4666-8666-666666666666",
      publicOrderId: "ord-other-attributed",
      saleOfferId: otherSaleOfferId,
      reservationId: "55555555-5555-4555-8555-555555555556",
      runId: otherRunId,
      correlationId: "corr-other-attributed",
      quantity: 1,
      status: "queued",
      queuedAt: now,
    });
    await connection.db.insert(erpAttempts).values({
      disposition: "technical_failure",
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

    // Runtime progress reads the same durable order records: three outstanding orders, the
    // oldest secured 6 s ago, and one confirmation inside the last 10 s divided by the 6 s of
    // elapsed processing time rather than the full window.
    await expect(
      readRunRuntimeProgress(connection.db, { runId }, new Date(now.getTime() - 10_000), now),
    ).resolves.toEqual({
      outstandingOrders: 3,
      oldestOutstandingAgeSeconds: 6,
      confirmedOrdersInWindow: 1,
      processingStartedAt: new Date(now.getTime() - 6_000),
    });

    // A confirmation committed after the measurement instant belongs to the next window.
    await connection.db
      .update(orders)
      .set({ confirmedAt: new Date(now.getTime() + 1) })
      .where(eq(orders.publicOrderId, "ord-confirmed"));
    await expect(
      readRunRuntimeProgress(connection.db, { runId }, new Date(now.getTime() - 10_000), now),
    ).resolves.toMatchObject({ confirmedOrdersInWindow: 0 });
  });

  it("derives one downstream status from the run's durable protection state only", async () => {
    const now = new Date("2026-06-21T00:00:00.000Z");
    const runId = "44444444-4444-4444-8444-444444444444";

    await expect(readDownstreamErpStatus(connection.db, runId, now)).resolves.toBe("nominal");

    const cooldownFuture = new Date(now.getTime() + 30_000);
    await connection.db.insert(erpScopeResilienceState).values({
      scope: `run:${runId}`,
      cooldownExpiresAt: cooldownFuture,
    });
    await expect(readDownstreamErpStatus(connection.db, runId, now)).resolves.toBe("erp_limiting");

    await connection.db
      .update(erpScopeResilienceState)
      .set({
        availabilityCircuitOpen: true,
        circuitOpenExpiresAt: new Date(now.getTime() + 60_000),
      })
      .where(eq(erpScopeResilienceState.scope, `run:${runId}`));
    await expect(readDownstreamErpStatus(connection.db, runId, now)).resolves.toBe(
      "erp_unavailable",
    );

    // Circuit expiry permits a probe; its future deadline still protects an ongoing outage.
    await connection.db
      .update(erpScopeResilienceState)
      .set({
        circuitOpenExpiresAt: new Date(now.getTime() - 1_000),
        nextProbeAt: new Date(now.getTime() + 10_000),
      })
      .where(eq(erpScopeResilienceState.scope, `run:${runId}`));
    await expect(readDownstreamErpStatus(connection.db, runId, now)).resolves.toBe(
      "erp_unavailable",
    );

    // The retry deadline independently keeps the circuit open too.
    await connection.db
      .update(erpScopeResilienceState)
      .set({
        nextProbeAt: new Date(now.getTime() - 1_000),
        availabilityRetryAt: new Date(now.getTime() + 10_000),
      })
      .where(eq(erpScopeResilienceState.scope, `run:${runId}`));
    await expect(readDownstreamErpStatus(connection.db, runId, now)).resolves.toBe(
      "erp_unavailable",
    );

    // An open flag with every availability deadline expired falls through to capacity state.
    await connection.db
      .update(erpScopeResilienceState)
      .set({
        availabilityRetryAt: new Date(now.getTime() - 1_000),
      })
      .where(eq(erpScopeResilienceState.scope, `run:${runId}`));
    await expect(readDownstreamErpStatus(connection.db, runId, now)).resolves.toBe("erp_limiting");
    await connection.db
      .update(erpScopeResilienceState)
      .set({
        cooldownExpiresAt: new Date(now.getTime() - 1_000),
      })
      .where(eq(erpScopeResilienceState.scope, `run:${runId}`));
    await expect(readDownstreamErpStatus(connection.db, runId, now)).resolves.toBe("nominal");

    // Successful recovery closes the circuit even if a previous probe deadline is still future.
    await connection.db
      .update(erpScopeResilienceState)
      .set({
        availabilityCircuitOpen: false,
        nextProbeAt: new Date(now.getTime() + 10_000),
      })
      .where(eq(erpScopeResilienceState.scope, `run:${runId}`));
    await expect(readDownstreamErpStatus(connection.db, runId, now)).resolves.toBe("nominal");

    await connection.db
      .delete(erpScopeResilienceState)
      .where(eq(erpScopeResilienceState.scope, `run:${runId}`));
    await expect(readDownstreamErpStatus(connection.db, runId, now)).resolves.toBe("nominal");
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
    },
    erpConfig: {
      latencyMs: 10,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
    },
    backpressureConfig: {
      queueName: "orders:process" as const,
      physicalQueueName: "orders-process" as const,
      orderProcessConcurrency: 1,
    },
  };
}
