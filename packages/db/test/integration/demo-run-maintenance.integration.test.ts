import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  deleteGeneratedRunDurable,
  demoRuns,
  erpAttempts,
  erpConfirmationLedger,
  erpDispatchCalls,
  erpScopeResilienceState,
  inspectGeneratedRunTeardown,
  orderRecoveryJobs,
  simulatedNotifications,
} from "../../src/index.js";
import { requireTestDatabaseUrl, resetTestDatabase } from "../../src/testing.js";

const databaseUrl = requireTestDatabaseUrl();
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

const ids = {
  preset: "71000000-0000-4000-8000-000000000001",
  run: "71000000-0000-4000-8000-000000000002",
  saleOffer: "71000000-0000-4000-8000-000000000003",
  product: "71000000-0000-4000-8000-000000000004",
  reservation: "71000000-0000-4000-8000-000000000005",
  order: "71000000-0000-4000-8000-000000000006",
};
const runScopedCorrelationId = "corr-maintenance-run";

type TestSql = ReturnType<typeof createDatabaseConnection>["sql"];

async function seedGeneratedRunWithTerminalOrder(sql: TestSql): Promise<void> {
  await sql`
    INSERT INTO "products" ("id", "sku", "slug", "name")
    VALUES (${ids.product}, 'MAINTENANCE-GUARD', 'maintenance-guard', 'Maintenance Guard')
  `;
  await sql`
    INSERT INTO "sale_offers" (
      "id", "product_id", "name", "allocated_stock", "sale_starts_at", "sale_ends_at"
    ) VALUES (
      ${ids.saleOffer}, ${ids.product}, 'Maintenance Offer', 10,
      '2026-01-01'::timestamptz, '2030-01-01'::timestamptz
    )
  `;
  await sql`
    INSERT INTO "demo_presets" (
      "id", "slug", "visibility", "is_editable", "display",
      "traffic_config", "inventory_config", "erp_config", "backpressure_config"
    ) VALUES (
      ${ids.preset}, 'maintenance-guard', 'admin', true, '{"name":"Maintenance Guard"}'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
    )
  `;
  await sql`
    INSERT INTO "demo_runs" (
      "id", "preset_id", "preset_name", "operator_mode", "status", "traffic_status",
      "config_snapshot", "sale_offer_id", "started_at",
      "correlation_id"
    ) VALUES (
      ${ids.run}, ${ids.preset}, 'Maintenance Guard', 'admin', 'completed', 'succeeded',
      '{}'::jsonb, ${ids.saleOffer}, '2026-06-20T00:00:00Z'::timestamptz,
      ${runScopedCorrelationId}
    )
  `;
  await sql`
    INSERT INTO "demo_run_sale_contexts" ("run_id", "sale_offer_id")
    VALUES (${ids.run}, ${ids.saleOffer})
  `;
  await sql`
    INSERT INTO "reservations" (
      "id", "sale_offer_id", "correlation_id", "run_id", "quantity",
      "reservation_token", "secured_at", "expires_at"
    ) VALUES (
      ${ids.reservation}, ${ids.saleOffer}, ${runScopedCorrelationId}, ${ids.run}, 1,
      'maintenance-guard-token', '2026-06-20T00:00:00Z'::timestamptz, '2026-06-20T00:15:00Z'::timestamptz
    )
  `;
  await sql`
    INSERT INTO "orders" (
      "id", "public_order_id", "sale_offer_id", "reservation_id", "correlation_id",
      "run_id", "quantity", "status", "queued_at", "processing_at", "confirmed_at"
    ) VALUES (
      ${ids.order}, 'ord-maintenance-guard', ${ids.saleOffer}, ${ids.reservation},
      ${runScopedCorrelationId}, ${ids.run}, 1, 'confirmed',
      '2026-06-20T00:00:01Z'::timestamptz, '2026-06-20T00:00:02Z'::timestamptz,
      '2026-06-20T00:00:03Z'::timestamptz
    )
  `;
  await sql`
    INSERT INTO "simulated_notifications" (
      "order_id", "sale_offer_id", "run_id", "correlation_id", "recipient_placeholder", "recorded_at"
    ) VALUES (
      ${ids.order}, ${ids.saleOffer}, ${ids.run}, ${runScopedCorrelationId},
      'buyer@example.invalid', '2026-06-20T00:00:04Z'::timestamptz
    )
  `;
}

describe("generated-run durable maintenance with processing-control data", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;
  const requireConnection = () => {
    if (!connection) throw new Error("TEST_DATABASE_URL is required for integration tests.");
    return connection;
  };

  beforeAll(async () => {
    await resetTestDatabase({ migrationsFolder });
    connection = createDatabaseConnection(databaseUrl, { max: 2 });
  });
  beforeEach(async () => {
    await resetTestDatabase({ migrationsFolder });
    await seedGeneratedRunWithTerminalOrder(requireConnection().sql);
  });
  afterAll(async () => {
    await connection?.close();
  });

  it("refuses teardown while a confirmed order still needs notification", async () => {
    await requireConnection().db.delete(simulatedNotifications);

    await expect(inspectGeneratedRunTeardown(requireConnection().db, ids.run)).resolves.toEqual({
      outcome: "outstanding_work",
    });
  });

  it("deletes dispatch-call and attempt evidence after control records are settled", async () => {
    const erpCallId = randomUUID();
    await requireConnection()
      .db.insert(erpDispatchCalls)
      .values({
        id: erpCallId,
        orderId: ids.order,
        processingGeneration: 0,
        idempotencyKey: `erp-confirmation:${ids.order}`,
        publicOrderId: "ord-maintenance-guard",
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        runId: ids.run,
        quantity: 1,
        correlationId: runScopedCorrelationId,
        dispatchedAt: new Date("2026-06-20T00:00:02Z"),
        resolvedAt: new Date("2026-06-20T00:00:03Z"),
      });
    await requireConnection()
      .db.insert(erpScopeResilienceState)
      .values([
        { scope: `run:${ids.run}` },
        { scope: "run:71000000-0000-4000-8000-000000000098" },
        { scope: "run:71000000-0000-4000-8000-000000000099" },
      ]);
    await requireConnection()
      .db.insert(erpAttempts)
      .values({
        disposition: "succeeded",
        orderId: ids.order,
        deliveryId: "maintenance-delivery",
        correlationId: runScopedCorrelationId,
        runId: ids.run,
        erpCallId,
        attemptNumber: 1,
        status: "succeeded",
        terminal: true,
        httpStatus: 200,
        latencyMs: 5,
        startedAt: new Date("2026-06-20T00:00:02Z"),
        finishedAt: new Date("2026-06-20T00:00:03Z"),
        confirmationId: "maintenance-confirmation",
        idempotencyKey: `erp-confirmation:${ids.order}`,
      });
    await requireConnection()
      .db.insert(erpConfirmationLedger)
      .values([
        {
          idempotencyKey: `erp-confirmation:${ids.order}`,
          orderId: ids.order,
          publicOrderId: "ord-maintenance-guard",
          reservationId: ids.reservation,
          saleOfferId: ids.saleOffer,
          runId: ids.run,
          quantity: 1,
          terminalResult: {
            status: "succeeded",
            confirmationId: "maintenance-confirmation",
            httpStatus: 200,
            latencyMs: 5,
            timestamp: "2026-06-20T00:00:03.000Z",
          },
        },
        {
          runId: "71000000-0000-4000-8000-000000000099",
          idempotencyKey: "erp-confirmation:other-run-order",
          orderId: "71000000-0000-4000-8000-000000000099",
          publicOrderId: "ord-catalog",
          reservationId: "71000000-0000-4000-8000-000000000098",
          saleOfferId: "71000000-0000-4000-8000-000000000097",
          quantity: 1,
          terminalResult: {
            status: "succeeded",
            confirmationId: "catalog-confirmation",
            httpStatus: 200,
            latencyMs: 5,
            timestamp: "2026-06-20T00:00:03.000Z",
          },
        },
      ]);

    await expect(
      deleteGeneratedRunDurable(requireConnection().db, {
        runId: ids.run,
        saleOfferId: ids.saleOffer,
      }),
    ).resolves.toEqual({ outcome: "deleted" });

    const db = requireConnection().db;
    await expect(db.select().from(erpDispatchCalls)).resolves.toHaveLength(0);
    await expect(db.select().from(erpAttempts)).resolves.toHaveLength(0);
    await expect(db.select().from(erpConfirmationLedger)).resolves.toMatchObject([
      {
        idempotencyKey: "erp-confirmation:other-run-order",
        runId: "71000000-0000-4000-8000-000000000099",
      },
    ]);
    await expect(db.select().from(orderRecoveryJobs)).resolves.toHaveLength(0);
    const remainingScopes = await db.select().from(erpScopeResilienceState);
    expect(remainingScopes.map((row) => row.scope).sort()).toEqual([
      "run:71000000-0000-4000-8000-000000000098",
      "run:71000000-0000-4000-8000-000000000099",
    ]);
    await expect(db.select().from(demoRuns).where(eq(demoRuns.id, ids.run))).resolves.toHaveLength(
      0,
    );
  });

  it("refuses teardown while a dispatched call remains unresolved", async () => {
    await requireConnection()
      .db.insert(erpDispatchCalls)
      .values({
        orderId: ids.order,
        processingGeneration: 0,
        idempotencyKey: `erp-confirmation:${ids.order}`,
        publicOrderId: "ord-maintenance-guard",
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        runId: ids.run,
        quantity: 1,
        correlationId: runScopedCorrelationId,
        dispatchedAt: new Date("2026-06-20T00:00:02Z"),
      });
    await requireConnection()
      .db.insert(erpConfirmationLedger)
      .values({
        idempotencyKey: `erp-confirmation:${ids.order}`,
        orderId: ids.order,
        publicOrderId: "ord-maintenance-guard",
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        runId: ids.run,
        quantity: 1,
        terminalResult: {
          status: "succeeded",
          confirmationId: "maintenance-confirmation",
          httpStatus: 200,
          latencyMs: 5,
          timestamp: "2026-06-20T00:00:03.000Z",
        },
      });

    await expect(inspectGeneratedRunTeardown(requireConnection().db, ids.run)).resolves.toEqual({
      outcome: "outstanding_work",
    });
    await expect(
      deleteGeneratedRunDurable(requireConnection().db, {
        runId: ids.run,
        saleOfferId: ids.saleOffer,
      }),
    ).resolves.toEqual({ outcome: "outstanding_work" });
    await expect(requireConnection().db.select().from(erpConfirmationLedger)).resolves.toHaveLength(
      1,
    );
  });

  it("keeps non-terminal runs ineligible for teardown", async () => {
    await requireConnection()
      .db.update(demoRuns)
      .set({ status: "draining" })
      .where(eq(demoRuns.id, ids.run));

    await expect(
      deleteGeneratedRunDurable(requireConnection().db, {
        runId: ids.run,
        saleOfferId: ids.saleOffer,
      }),
    ).resolves.toEqual({ outcome: "non_terminal" });
  });
});
