import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection } from "../../src/client.js";
import { readRunSignalTimeline } from "../../src/run-signal-timeline.js";
import {
  demoPresets,
  demoRunSaleContexts,
  demoRuns,
  erpAttempts,
  orders,
  products,
  reservations,
  saleOffers,
} from "../../src/schema.js";
import { resetTestDatabase } from "../../src/testing.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const databaseUrl = process.env.TEST_DATABASE_URL;
const anchoredAt = new Date("2026-07-20T12:00:00.000Z");
const capturedAt = new Date("2026-07-20T12:03:00.000Z");
const ids = {
  product: "a3000000-0000-4000-8000-000000000001",
  offer: "a3000000-0000-4000-8000-000000000002",
  preset: "a3000000-0000-4000-8000-000000000003",
  run: "a3000000-0000-4000-8000-000000000004",
} as const;

describe.skipIf(!databaseUrl)("durable run signal timeline", () => {
  let connection: ReturnType<typeof createDatabaseConnection>;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required.");
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    connection = createDatabaseConnection(databaseUrl, { max: 1 });
    await seedRun(connection.db);
  });

  beforeEach(async () => {
    await connection.db.delete(erpAttempts);
    await connection.db.delete(orders);
    await connection.db.delete(reservations);
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("returns no timeline without a first checkout attempt and derives empty evidence", async () => {
    await expect(
      readRunSignalTimeline(
        connection.db,
        { runId: ids.run, saleOfferId: ids.offer },
        {
          firstAttemptStartedAt: null,
          dispatchDurationSeconds: 0,
          peakArrivalWindowSeconds: 1,
          capturedAt,
        },
      ),
    ).resolves.toBeNull();

    const empty = await readRunSignalTimeline(
      connection.db,
      { runId: ids.run, saleOfferId: ids.offer },
      {
        firstAttemptStartedAt: anchoredAt.toISOString(),
        dispatchDurationSeconds: 120,
        peakArrivalWindowSeconds: 1,
        capturedAt,
      },
    );
    expect(empty).toMatchObject({
      inventoryDrain: { startingStock: 5, remainingStock: 5, depletedAt: null },
      queueBacklog: { peakBacklog: 0, drainDurationSeconds: null },
      confirmationConvergence: {
        confirmedOrderCount: 0,
        failedOrderCount: 0,
        pendingAtCaptureCount: 0,
      },
      convergenceDurationSeconds: null,
    });
    expect(empty?.inventoryDrain.remainingStockSeries).toHaveLength(120);
  });

  it("uses the producer arrival window for a one-attempt run with no durable rows", async () => {
    const peakArrivalWindowSeconds = 0.36;
    const timeline = await readRunSignalTimeline(
      connection.db,
      { runId: ids.run, saleOfferId: ids.offer },
      {
        firstAttemptStartedAt: anchoredAt.toISOString(),
        dispatchDurationSeconds: 0,
        peakArrivalWindowSeconds,
        capturedAt,
      },
    );

    expect(timeline).not.toBeNull();
    expect(
      (Date.parse(timeline?.window.endedAt ?? "") - Date.parse(timeline?.window.anchoredAt ?? "")) /
        1_000,
    ).toBe(peakArrivalWindowSeconds);
    expect(timeline?.window.bucketCount).toBe(120);
    expect(timeline?.window.bucketWidthSeconds).toBe(peakArrivalWindowSeconds / 120);
  });

  it("counts a reservation secured exactly at the anchor in the producer-sized window", async () => {
    await seedReservations(connection.db, 1, anchoredAt);
    const peakArrivalWindowSeconds = 0.36;
    const timeline = await readRunSignalTimeline(
      connection.db,
      { runId: ids.run, saleOfferId: ids.offer },
      {
        firstAttemptStartedAt: anchoredAt.toISOString(),
        dispatchDurationSeconds: 0,
        peakArrivalWindowSeconds,
        capturedAt,
      },
    );

    expect(timeline?.inventoryDrain.remainingStock).toBe(4);
    expect(timeline?.inventoryDrain.remainingStockSeries[0]?.remainingStock).toBe(4);
    expect(
      (Date.parse(timeline?.window.endedAt ?? "") - Date.parse(timeline?.window.anchoredAt ?? "")) /
        1_000,
    ).toBe(peakArrivalWindowSeconds);
    expect(timeline?.window.bucketCount).toBe(120);
    expect(timeline?.window.bucketWidthSeconds).toBe(peakArrivalWindowSeconds / 120);
  });

  it("retains remaining stock when accepted reservations do not deplete the offer", async () => {
    await seedReservations(connection.db, 2);

    const partialInventory = await readRunSignalTimeline(
      connection.db,
      { runId: ids.run, saleOfferId: ids.offer },
      {
        firstAttemptStartedAt: anchoredAt.toISOString(),
        dispatchDurationSeconds: 10,
        peakArrivalWindowSeconds: 1,
        capturedAt,
      },
    );

    expect(partialInventory?.inventoryDrain).toMatchObject({
      startingStock: 5,
      remainingStock: 3,
      depletedAt: null,
      timeToDepletionSeconds: null,
    });
    expect(partialInventory?.inventoryDrain.remainingStockSeries.at(-1)?.remainingStock).toBe(3);
  });

  it("retains an exact inside-bucket peak and partial failure/retry evidence", async () => {
    await seedOrders(connection.db);
    const partial = await readRunSignalTimeline(
      connection.db,
      { runId: ids.run, saleOfferId: ids.offer },
      {
        firstAttemptStartedAt: anchoredAt.toISOString(),
        dispatchDurationSeconds: 120,
        peakArrivalWindowSeconds: 1,
        capturedAt,
      },
    );

    expect(partial).not.toBeNull();
    expect(partial?.inventoryDrain).toMatchObject({
      remainingStock: 0,
      timeToDepletionSeconds: 0.1,
    });
    expect(partial?.queueBacklog.peakBacklog).toBe(5);
    expect(
      Math.max(...(partial?.queueBacklog.backlogSeries.map((sample) => sample.backlog) ?? [])),
    ).toBe(0);
    expect(partial?.queueBacklog.drainDurationSeconds).toBeCloseTo(0.1);
    await expect(connection.db.select().from(erpAttempts)).resolves.toHaveLength(1);
    expect(partial?.confirmationConvergence).toMatchObject({
      confirmedOrderCount: 3,
      failedOrderCount: 1,
      pendingAtCaptureCount: 1,
      boundary: "reservation_secured_to_order_confirmed",
    });
    expect(partial?.convergenceDurationSeconds).toBeNull();
  });

  it("keeps terminal durations anchored after a long configured preparation gap", async () => {
    await seedOrders(
      connection.db,
      ["confirmed", "confirmed", "confirmed", "confirmed", "confirmed"],
      false,
    );

    const withPreparationGap = await readRunSignalTimeline(
      connection.db,
      { runId: ids.run, saleOfferId: ids.offer },
      {
        firstAttemptStartedAt: anchoredAt.toISOString(),
        dispatchDurationSeconds: 40,
        peakArrivalWindowSeconds: 1,
        capturedAt,
      },
    );
    await connection.db
      .update(demoRuns)
      .set({
        configSnapshot: {
          ...previewRunConfigSnapshotFixture(),
          trafficConfig: {
            ...previewRunConfigSnapshotFixture().trafficConfig,
            startDelaySeconds: 0,
          },
        },
        trafficStartedAt: anchoredAt,
      })
      .where(eq(demoRuns.id, ids.run));
    const withoutPreparationGap = await readRunSignalTimeline(
      connection.db,
      { runId: ids.run, saleOfferId: ids.offer },
      {
        firstAttemptStartedAt: anchoredAt.toISOString(),
        dispatchDurationSeconds: 40,
        peakArrivalWindowSeconds: 1,
        capturedAt,
      },
    );

    expect(withPreparationGap?.inventoryDrain).toMatchObject({
      remainingStock: 0,
      timeToDepletionSeconds: 0.1,
    });
    expect(withoutPreparationGap?.inventoryDrain.timeToDepletionSeconds).toBe(
      withPreparationGap?.inventoryDrain.timeToDepletionSeconds,
    );
    expect(withPreparationGap?.queueBacklog).toMatchObject({
      peakBacklog: 5,
      drainDurationSeconds: 0.1,
      drainDurationBoundary: "first_order_queued_to_final_backlog_zero",
    });
    expect(withPreparationGap?.confirmationConvergence).toMatchObject({
      confirmedOrderCount: 5,
      failedOrderCount: 0,
      pendingAtCaptureCount: 0,
    });
    expect(withPreparationGap?.convergenceDurationSeconds).toBe(10);
  });
});

async function seedRun(db: ReturnType<typeof createDatabaseConnection>["db"]) {
  await db.insert(products).values({
    id: ids.product,
    sku: "run-signals",
    slug: "run-signals",
    name: "Run signals",
  });
  await db.insert(saleOffers).values({
    id: ids.offer,
    productId: ids.product,
    name: "Run signals offer",
    allocatedStock: 5,
    saleStartsAt: anchoredAt,
    saleEndsAt: capturedAt,
    purpose: "generated_run",
  });
  await db.insert(demoPresets).values({
    id: ids.preset,
    slug: "run-signals",
    visibility: "admin",
    isEditable: true,
    display: {
      name: "Run signals",
      description: "Run signal derivation",
      sortOrder: 1,
      outcomeFocus: [],
    },
    ...previewRunConfigSnapshotFixture(),
  });
  await db.insert(demoRuns).values({
    id: ids.run,
    presetId: ids.preset,
    presetName: "Run signals",
    operatorMode: "admin",
    status: "active",
    trafficStatus: "active",
    configSnapshot: {
      ...previewRunConfigSnapshotFixture(),
      trafficConfig: {
        ...previewRunConfigSnapshotFixture().trafficConfig,
        startDelaySeconds: 15,
      },
    },
    saleOfferId: ids.offer,
    startedAt: new Date(anchoredAt.getTime() - 60_000),
    trafficStartedAt: new Date(anchoredAt.getTime() - 60_000),
  });
  await db.insert(demoRunSaleContexts).values({ runId: ids.run, saleOfferId: ids.offer });
}

type SeedOrderStatus = "confirmed" | "failed" | "processing";

async function seedReservations(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  count: number,
  securedAt = new Date(anchoredAt.getTime() + 100),
) {
  const reservationRows = Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      id: `a3000001-0000-4000-8000-${number.toString().padStart(12, "0")}`,
      saleOfferId: ids.offer,
      runId: ids.run,
      correlationId: `signal-correlation-${number}`,
      quantity: 1,
      reservationToken: `signal-reservation-${number}`,
      securedAt,
      expiresAt: capturedAt,
    };
  });
  await db.insert(reservations).values(reservationRows);
  return reservationRows;
}

async function seedOrders(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  statuses: readonly SeedOrderStatus[] = [
    "confirmed",
    "confirmed",
    "confirmed",
    "failed",
    "processing",
  ],
  includeRetryAttempt = true,
) {
  const reservationRows = await seedReservations(db, statuses.length);
  await db.insert(orders).values(
    reservationRows.map((reservation, index) => {
      const number = index + 1;
      const terminalAt = new Date(anchoredAt.getTime() + (index + 1) * 10_000);
      const status = statuses[index] ?? "processing";
      return {
        id: `a3000002-0000-4000-8000-${number.toString().padStart(12, "0")}`,
        publicOrderId: `signal-order-${number}`,
        saleOfferId: ids.offer,
        reservationId: reservation.id,
        runId: ids.run,
        correlationId: reservation.correlationId,
        quantity: 1,
        status,
        queuedAt: new Date(anchoredAt.getTime() + 100),
        processingAt: new Date(anchoredAt.getTime() + 200),
        ...(status === "confirmed" ? { confirmedAt: terminalAt } : {}),
        ...(status === "failed" ? { failedAt: terminalAt } : {}),
      };
    }),
  );
  if (!includeRetryAttempt) return;
  await db.insert(erpAttempts).values({
    orderId: "a3000002-0000-4000-8000-000000000005",
    deliveryId: "retry-does-not-reenter-durable-backlog",
    correlationId: "signal-correlation-5",
    runId: ids.run,
    attemptNumber: 1,
    status: "failed",
    terminal: false,
    latencyMs: 10,
    startedAt: new Date(anchoredAt.getTime() + 1_000),
    finishedAt: new Date(anchoredAt.getTime() + 1_010),
  });
}
