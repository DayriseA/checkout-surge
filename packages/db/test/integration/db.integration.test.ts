import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  acceptedRunConfigSnapshotSchema,
  backpressureConfigSchema,
  type DashboardEvent,
  dashboardEventsRedisChannel,
  publicRuntimePolicySchema,
} from "@checkout-surge/contracts";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearErpCircuitBreakerSnapshots,
  createDatabaseConnection,
  createRedisDashboardEventSubscriber,
  erpCircuitBreakerSnapshotKey,
  getErpCircuitBreakerSnapshot,
  getErpCircuitBreakerSnapshotKey,
  getInventoryStatus,
  InventoryNotInitializedError,
  initializeInventory,
  inventoryKeys,
  isRunSaleEligible,
  markReservationPendingPersistence,
  promoteReservationIdempotencyToAccepted,
  publishDashboardEvent,
  reserveInventoryStock,
  reverseReservation,
  setErpCircuitBreakerSnapshot,
  setRunSaleEligibility,
} from "../../src/index.js";
import { runDatabaseMigrations } from "../../src/migrations.js";
import { resetTestDatabase } from "../../src/testing.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const seededSaleOfferId = "22222222-2222-4222-8222-222222222222";
const reservationSecuredAt = "2026-06-20T12:00:00.000Z";
const reservationExpiresAt = "2026-06-20T12:15:00.000Z";
const orderQueuedAt = "2026-06-20T12:00:01.000Z";
const saleStartsAt = "2026-06-20T00:00:00.000Z";
const saleEndsAt = "2026-06-21T00:00:00.000Z";
const dashboardEvent: DashboardEvent = {
  type: "traffic.metric",
  eventId: "77777777-7777-4777-8777-777777777777",
  runId: "55555555-5555-4555-8555-555555555555",
  metricName: "traffic.latency",
  value: 42,
  unit: "ms",
  occurredAt: "2026-06-20T12:00:00.000Z",
};

type TestSql = ReturnType<typeof createDatabaseConnection>["sql"];
type ReservationStatusForTest = "secured" | "rejected" | "released" | "expired";
type OrderStatusForTest = "queued" | "processing" | "confirmed" | "failed";
type SaleOfferPurposeForTest = "catalog" | "generated_run";

function buildReservationInput(options: {
  saleOfferId: string;
  sequence: number;
  quantity?: number;
  idempotencyKey?: string;
  runId?: string;
}) {
  const suffix = options.sequence.toString(16).padStart(12, "0");

  return {
    idempotencyKey: options.idempotencyKey ?? `reservation-attempt-${options.sequence}`,
    idempotencyTtlSeconds: 1800,
    reservation: {
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
      saleOfferId: options.saleOfferId,
      correlationId: `corr-reservation-${options.sequence}`,
      ...(options.runId ? { runId: options.runId } : {}),
      quantity: options.quantity ?? 1,
      status: "secured" as const,
      reservationToken: `reservation-token-${options.sequence}`,
      securedAt: reservationSecuredAt,
      expiresAt: reservationExpiresAt,
    },
  };
}

function buildOrderReservationIds(sequence: number) {
  const suffix = sequence.toString(16).padStart(12, "0");

  return {
    productId: `31000000-0000-4000-8000-${suffix}`,
    saleOfferId: `31000001-0000-4000-8000-${suffix}`,
    alternateProductId: `31000002-0000-4000-8000-${suffix}`,
    alternateSaleOfferId: `31000003-0000-4000-8000-${suffix}`,
    reservationId: `31000004-0000-4000-8000-${suffix}`,
    orderId: `31000005-0000-4000-8000-${suffix}`,
    alternateOrderId: `31000006-0000-4000-8000-${suffix}`,
    thirdOrderId: `31000007-0000-4000-8000-${suffix}`,
    runId: `31000008-0000-4000-8000-${suffix}`,
    presetId: `31000009-0000-4000-8000-${suffix}`,
  };
}

function requireTestEnv(name: "TEST_DATABASE_URL" | "TEST_REDIS_URL"): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for database integration tests.`);
  }

  return value;
}

async function withDatabase<T>(
  fn: (sql: ReturnType<typeof createDatabaseConnection>["sql"]) => Promise<T>,
) {
  const connection = createDatabaseConnection(requireTestEnv("TEST_DATABASE_URL"), { max: 1 });

  try {
    return await fn(connection.sql);
  } finally {
    await connection.close();
  }
}

async function removeRunSaleContextOwnershipConstraint(sql: TestSql): Promise<void> {
  await sql`
    ALTER TABLE "demo_run_sale_contexts"
    DROP CONSTRAINT IF EXISTS "demo_run_sale_contexts_run_sale_offer_demo_runs_fk"
  `;
  await sql`DROP INDEX IF EXISTS "demo_runs_id_sale_offer_id_unique"`;
}

async function removeLifecycleAndChildAttributionGuards(sql: TestSql): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS "erp_attempts_enforce_order_attribution" ON "erp_attempts"`;
  await sql`DROP TRIGGER IF EXISTS "order_events_enforce_parent_attribution" ON "order_events"`;
  await sql`DROP TRIGGER IF EXISTS "orders_preserve_child_attribution" ON "orders"`;
  await sql`DROP TRIGGER IF EXISTS "reservations_preserve_event_attribution" ON "reservations"`;
  await sql`DROP FUNCTION IF EXISTS "enforce_erp_attempt_order_attribution"()`;
  await sql`DROP FUNCTION IF EXISTS "enforce_order_event_parent_attribution"()`;
  await sql`DROP FUNCTION IF EXISTS "preserve_order_child_attribution"()`;
  await sql`DROP FUNCTION IF EXISTS "preserve_reservation_only_event_attribution"()`;
  await sql`
    ALTER TABLE "reservations"
      DROP CONSTRAINT IF EXISTS "reservations_released_requires_released_at",
      DROP CONSTRAINT IF EXISTS "reservations_expired_requires_expired_at"
  `;
  await sql`
    ALTER TABLE "orders"
      DROP CONSTRAINT IF EXISTS "orders_confirmed_requires_confirmed_at",
      DROP CONSTRAINT IF EXISTS "orders_failed_requires_failed_at",
      DROP CONSTRAINT IF EXISTS "orders_in_progress_requires_processing_at",
      DROP CONSTRAINT IF EXISTS "orders_terminal_timestamps_after_queued_at"
  `;
  await sql`
    ALTER TABLE "erp_attempts"
      DROP CONSTRAINT IF EXISTS "erp_attempts_finished_after_started"
  `;
}

async function insertCatalogSaleOffer(
  sql: TestSql,
  input: { productId: string; saleOfferId: string; purpose?: SaleOfferPurposeForTest },
): Promise<void> {
  const slug = input.saleOfferId.replaceAll("-", "");

  await sql`
    INSERT INTO "products" ("id", "sku", "slug", "name")
    VALUES (${input.productId}, ${`sku-${slug}`}, ${`slug-${slug}`}, ${`Product ${slug}`})
  `;
  await sql`
    INSERT INTO "sale_offers" (
      "id",
      "product_id",
      "name",
      "allocated_stock",
      "sale_starts_at",
      "sale_ends_at",
      "purpose"
    )
    VALUES (
      ${input.saleOfferId},
      ${input.productId},
      ${`Offer ${slug}`},
      ${10},
      ${saleStartsAt}::timestamptz,
      ${saleEndsAt}::timestamptz,
      ${input.purpose ?? "catalog"}::"sale_offer_purpose"
    )
  `;
}

async function insertGeneratedRunContext(
  sql: TestSql,
  input: { presetId: string; runId: string; saleOfferId: string },
): Promise<void> {
  await sql`
    INSERT INTO "demo_presets" (
      "id",
      "slug",
      "visibility",
      "is_editable",
      "display",
      "traffic_config",
      "inventory_config",
      "erp_config",
      "backpressure_config"
    )
    VALUES (
      ${input.presetId},
      ${`preset-${input.presetId.replaceAll("-", "")}`},
      'admin'::"demo_preset_visibility",
      true,
      ${JSON.stringify({ name: "Order Reservation Guard" })}::jsonb,
      '{}'::jsonb,
      '{}'::jsonb,
      '{}'::jsonb,
      '{}'::jsonb
    )
  `;
  await sql`
    INSERT INTO "demo_runs" (
      "id",
      "preset_id",
      "preset_name",
      "operator_mode",
      "status",
      "traffic_status",
      "config_snapshot",
      "sale_offer_id",
      "started_at"
    )
    VALUES (
      ${input.runId},
      ${input.presetId},
      'Order Reservation Guard',
      'admin'::"demo_run_operator_mode",
      'completed'::"demo_run_status",
      'succeeded'::"demo_run_traffic_status",
      '{}'::jsonb,
      ${input.saleOfferId},
      ${saleStartsAt}::timestamptz
    )
  `;
  await sql`
    INSERT INTO "demo_run_sale_contexts" ("run_id", "sale_offer_id")
    VALUES (${input.runId}, ${input.saleOfferId})
  `;
}

async function insertReservation(
  sql: TestSql,
  input: {
    reservationId: string;
    saleOfferId: string;
    correlationId: string;
    runId?: string | null;
    quantity?: number;
    status?: ReservationStatusForTest;
  },
): Promise<void> {
  await sql`
    INSERT INTO "reservations" (
      "id",
      "sale_offer_id",
      "correlation_id",
      "run_id",
      "quantity",
      "status",
      "reservation_token",
      "secured_at",
      "expires_at",
      "released_at",
      "expired_at"
    )
    VALUES (
      ${input.reservationId},
      ${input.saleOfferId},
      ${input.correlationId},
      ${input.runId ?? null},
      ${input.quantity ?? 1},
      ${input.status ?? "secured"}::"reservation_status",
      ${`token-${input.reservationId}`},
      ${reservationSecuredAt}::timestamptz,
      ${reservationExpiresAt}::timestamptz,
      ${input.status === "released" ? reservationSecuredAt : null}::timestamptz,
      ${input.status === "expired" ? reservationSecuredAt : null}::timestamptz
    )
  `;
}

async function insertOrder(
  sql: TestSql,
  input: {
    orderId: string;
    saleOfferId: string;
    reservationId: string;
    correlationId: string;
    runId?: string | null;
    quantity?: number;
    status?: OrderStatusForTest;
    processingAt?: string | null;
    confirmedAt?: string | null;
    failedAt?: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO "orders" (
      "id",
      "public_order_id",
      "sale_offer_id",
      "reservation_id",
      "correlation_id",
      "run_id",
      "quantity",
      "status",
      "queued_at",
      "processing_at",
      "confirmed_at",
      "failed_at"
    )
    VALUES (
      ${input.orderId},
      ${`ord-${input.orderId}`},
      ${input.saleOfferId},
      ${input.reservationId},
      ${input.correlationId},
      ${input.runId ?? null},
      ${input.quantity ?? 1},
      ${input.status ?? "queued"}::"order_status",
      ${orderQueuedAt}::timestamptz,
      ${input.processingAt ?? null}::timestamptz,
      ${input.confirmedAt ?? null}::timestamptz,
      ${input.failedAt ?? null}::timestamptz
    )
  `;
}

async function runSeedScript(overrides: Partial<Record<string, string>> = {}): Promise<void> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

  await execFileAsync(command, ["exec", "tsx", "src/scripts/seed.ts"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: requireTestEnv("TEST_DATABASE_URL"),
      REDIS_URL: requireTestEnv("TEST_REDIS_URL"),
      ...overrides,
    },
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function expectConstraintViolation(promise: Promise<unknown>, constraintName: string) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "23514", constraint_name: constraintName });
}

async function removeRunHistoryChronologicalIndexes(sql: TestSql): Promise<void> {
  await sql`DROP INDEX IF EXISTS "orders_run_id_queued_at_created_at_idx"`;
  await sql`DROP INDEX IF EXISTS "erp_attempts_run_id_finished_at_created_at_idx"`;
  await sql`DROP INDEX IF EXISTS "simulated_notifications_run_id_recorded_at_created_at_idx"`;
  await sql`DROP INDEX IF EXISTS "order_events_run_id_occurred_at_created_at_idx"`;
}

describe("database migrations, seed data, and reset behavior", () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(requireTestEnv("TEST_REDIS_URL"), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await redis.connect();
    await redis.flushdb();
    await resetTestDatabase({ migrationsFolder });
  });

  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it("applies the schema and run sale ownership guards", async () => {
    const tableRows = await withDatabase(
      (sql) =>
        sql<{ table_name: string }[]>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('products', 'sale_offers', 'reservations', 'orders', 'demo_runs')
      `,
    );
    const triggerRows = await withDatabase(
      (sql) =>
        sql<{ tgname: string }[]>`
        SELECT tgname
        FROM pg_trigger
        WHERE tgname IN (
          'demo_run_sale_contexts_enforce_offer_purpose',
          'erp_attempts_enforce_order_attribution',
          'order_events_enforce_parent_attribution',
          'orders_enforce_backing_secured_reservation',
          'orders_preserve_child_attribution',
          'reservations_preserve_event_attribution',
          'reservations_preserve_order_backing_secured_reservation',
          'reservations_enforce_run_owned_sale_offer_attribution'
        )
      `,
    );
    const ownershipConstraintRows = await withDatabase(
      (sql) =>
        sql<{ conname: string; confdeltype: string }[]>`
        SELECT conname, confdeltype
        FROM pg_constraint
        WHERE conname = 'demo_run_sale_contexts_run_sale_offer_demo_runs_fk'
      `,
    );

    expect(tableRows.map((row) => row.table_name).sort()).toEqual([
      "demo_runs",
      "orders",
      "products",
      "reservations",
      "sale_offers",
    ]);
    expect(triggerRows.map((row) => row.tgname).sort()).toEqual([
      "demo_run_sale_contexts_enforce_offer_purpose",
      "erp_attempts_enforce_order_attribution",
      "order_events_enforce_parent_attribution",
      "orders_enforce_backing_secured_reservation",
      "orders_preserve_child_attribution",
      "reservations_enforce_run_owned_sale_offer_attribution",
      "reservations_preserve_event_attribution",
      "reservations_preserve_order_backing_secured_reservation",
    ]);
    expect(ownershipConstraintRows).toEqual([
      {
        conname: "demo_run_sale_contexts_run_sale_offer_demo_runs_fk",
        confdeltype: "c",
      },
    ]);
  });

  it("installs run-history indexes with the filter and chronological keys in query order", async () => {
    const indexColumns = await withDatabase(
      (sql) =>
        sql<
          {
            index_name: string;
            table_name: string;
            column_name: string;
            key_position: number;
            direction: "ASC" | "DESC";
          }[]
        >`
        SELECT
          index_relation.relname AS index_name,
          table_relation.relname AS table_name,
          attribute.attname AS column_name,
          key.ordinality::int AS key_position,
          CASE WHEN (index_metadata.indoption[key.ordinality - 1] & 1) = 1
            THEN 'DESC'
            ELSE 'ASC'
          END AS direction
        FROM pg_index index_metadata
        JOIN pg_class index_relation ON index_relation.oid = index_metadata.indexrelid
        JOIN pg_class table_relation ON table_relation.oid = index_metadata.indrelid
        CROSS JOIN LATERAL unnest(index_metadata.indkey)
          WITH ORDINALITY AS key(attribute_number, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = table_relation.oid
          AND attribute.attnum = key.attribute_number
        WHERE index_relation.relname IN (
          'orders_run_id_queued_at_created_at_idx',
          'erp_attempts_run_id_finished_at_created_at_idx',
          'simulated_notifications_run_id_recorded_at_created_at_idx',
          'order_events_run_id_occurred_at_created_at_idx'
        )
        ORDER BY index_relation.relname, key.ordinality
      `,
    );

    expect(indexColumns).toEqual([
      {
        index_name: "erp_attempts_run_id_finished_at_created_at_idx",
        table_name: "erp_attempts",
        column_name: "run_id",
        key_position: 1,
        direction: "ASC",
      },
      {
        index_name: "erp_attempts_run_id_finished_at_created_at_idx",
        table_name: "erp_attempts",
        column_name: "finished_at",
        key_position: 2,
        direction: "DESC",
      },
      {
        index_name: "erp_attempts_run_id_finished_at_created_at_idx",
        table_name: "erp_attempts",
        column_name: "created_at",
        key_position: 3,
        direction: "DESC",
      },
      {
        index_name: "order_events_run_id_occurred_at_created_at_idx",
        table_name: "order_events",
        column_name: "run_id",
        key_position: 1,
        direction: "ASC",
      },
      {
        index_name: "order_events_run_id_occurred_at_created_at_idx",
        table_name: "order_events",
        column_name: "occurred_at",
        key_position: 2,
        direction: "DESC",
      },
      {
        index_name: "order_events_run_id_occurred_at_created_at_idx",
        table_name: "order_events",
        column_name: "created_at",
        key_position: 3,
        direction: "DESC",
      },
      {
        index_name: "orders_run_id_queued_at_created_at_idx",
        table_name: "orders",
        column_name: "run_id",
        key_position: 1,
        direction: "ASC",
      },
      {
        index_name: "orders_run_id_queued_at_created_at_idx",
        table_name: "orders",
        column_name: "queued_at",
        key_position: 2,
        direction: "DESC",
      },
      {
        index_name: "orders_run_id_queued_at_created_at_idx",
        table_name: "orders",
        column_name: "created_at",
        key_position: 3,
        direction: "DESC",
      },
      {
        index_name: "simulated_notifications_run_id_recorded_at_created_at_idx",
        table_name: "simulated_notifications",
        column_name: "run_id",
        key_position: 1,
        direction: "ASC",
      },
      {
        index_name: "simulated_notifications_run_id_recorded_at_created_at_idx",
        table_name: "simulated_notifications",
        column_name: "recorded_at",
        key_position: 2,
        direction: "DESC",
      },
      {
        index_name: "simulated_notifications_run_id_recorded_at_created_at_idx",
        table_name: "simulated_notifications",
        column_name: "created_at",
        key_position: 3,
        direction: "DESC",
      },
    ]);
  });

  it("aborts ownership migration when legacy run and context offers contradict", async () => {
    const presetId = "38000000-0000-4000-8000-000000000001";
    const runId = "38000000-0000-4000-8000-000000000002";
    const runSaleOfferId = "38000000-0000-4000-8000-000000000003";
    const contextSaleOfferId = "38000000-0000-4000-8000-000000000004";

    await withDatabase(async (sql) => {
      await removeRunHistoryChronologicalIndexes(sql);
      await removeLifecycleAndChildAttributionGuards(sql);
      await removeRunSaleContextOwnershipConstraint(sql);
      await sql`DROP TABLE demo_run_teardown_receipts`;
      await sql`
        DELETE FROM drizzle.__drizzle_migrations
        WHERE id IN (
          SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 6
        )
      `;
      await insertCatalogSaleOffer(sql, {
        productId: "38000000-0000-4000-8000-000000000005",
        saleOfferId: runSaleOfferId,
        purpose: "generated_run",
      });
      await insertCatalogSaleOffer(sql, {
        productId: "38000000-0000-4000-8000-000000000006",
        saleOfferId: contextSaleOfferId,
        purpose: "generated_run",
      });
      await sql`
        INSERT INTO demo_presets (
          id, slug, visibility, is_editable, display,
          traffic_config, inventory_config, erp_config, backpressure_config
        ) VALUES (
          ${presetId}, 'legacy-run-sale-ownership', 'admin', true,
          '{"name":"Legacy ownership"}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
        )
      `;
      await sql`
        INSERT INTO demo_runs (
          id, preset_id, preset_name, operator_mode, status, config_snapshot, sale_offer_id
        ) VALUES (
          ${runId}, ${presetId}, 'Legacy ownership', 'admin', 'completed', '{}'::jsonb,
          ${runSaleOfferId}
        )
      `;
      await sql`
        INSERT INTO demo_run_sale_contexts (run_id, sale_offer_id)
        VALUES (${runId}, ${contextSaleOfferId})
      `;
    });

    const migrationError = await runDatabaseMigrations({
      databaseUrl: requireTestEnv("TEST_DATABASE_URL"),
      migrationsFolder,
    }).catch((error: unknown) => error);
    expect(migrationError).toMatchObject({
      cause: {
        code: "23514",
        constraint_name: "demo_run_sale_contexts_existing_ownership_consistency",
      },
    });
    await expect(
      withDatabase(
        (sql) => sql`
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'demo_run_sale_contexts_run_sale_offer_demo_runs_fk'
        `,
      ),
    ).resolves.toEqual([]);

    await withDatabase(
      (sql) => sql`
        UPDATE demo_run_sale_contexts
        SET sale_offer_id = ${runSaleOfferId}
        WHERE run_id = ${runId}
      `,
    );
    await runDatabaseMigrations({
      databaseUrl: requireTestEnv("TEST_DATABASE_URL"),
      migrationsFolder,
    });
    await withDatabase(async (sql) => {
      await sql`DELETE FROM demo_runs WHERE id = ${runId}`;
      await sql`DELETE FROM demo_presets WHERE id = ${presetId}`;
      await sql`
        DELETE FROM sale_offers WHERE id IN (${runSaleOfferId}, ${contextSaleOfferId})
      `;
      await sql`
        DELETE FROM products
        WHERE id IN (
          '38000000-0000-4000-8000-000000000005',
          '38000000-0000-4000-8000-000000000006'
        )
      `;
    });
  });

  it("keeps matching run context creation valid and rejects contradictory mutations", async () => {
    const presetId = "38000000-0000-4000-8000-000000000011";
    const runAId = "38000000-0000-4000-8000-000000000012";
    const runBId = "38000000-0000-4000-8000-000000000013";
    const saleOfferAId = "38000000-0000-4000-8000-000000000014";
    const saleOfferBId = "38000000-0000-4000-8000-000000000015";
    const unownedSaleOfferId = "38000000-0000-4000-8000-000000000016";

    await withDatabase(async (sql) => {
      for (const [productId, saleOfferId] of [
        ["38000000-0000-4000-8000-000000000017", saleOfferAId],
        ["38000000-0000-4000-8000-000000000018", saleOfferBId],
        ["38000000-0000-4000-8000-000000000019", unownedSaleOfferId],
      ] as const) {
        await insertCatalogSaleOffer(sql, { productId, saleOfferId, purpose: "generated_run" });
      }
      await sql`
        INSERT INTO demo_presets (
          id, slug, visibility, is_editable, display,
          traffic_config, inventory_config, erp_config, backpressure_config
        ) VALUES (
          ${presetId}, 'run-sale-ownership', 'admin', true,
          '{"name":"Run sale ownership"}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
        )
      `;
      await sql`
        INSERT INTO demo_runs (
          id, preset_id, preset_name, operator_mode, status, config_snapshot, sale_offer_id
        ) VALUES
          (${runAId}, ${presetId}, 'Run A', 'admin', 'completed', '{}'::jsonb, ${saleOfferAId}),
          (${runBId}, ${presetId}, 'Run B', 'admin', 'completed', '{}'::jsonb, ${saleOfferBId})
      `;
      await sql`
        INSERT INTO demo_run_sale_contexts (run_id, sale_offer_id)
        VALUES (${runAId}, ${saleOfferAId})
      `;

      const [matchingContext] = await sql<{ run_id: string; sale_offer_id: string }[]>`
        SELECT run_id, sale_offer_id
        FROM demo_run_sale_contexts
        WHERE run_id = ${runAId}
      `;
      expect(matchingContext).toEqual({ run_id: runAId, sale_offer_id: saleOfferAId });

      for (const contradictoryWrite of [
        sql`
          INSERT INTO demo_run_sale_contexts (run_id, sale_offer_id)
          VALUES (${runBId}, ${unownedSaleOfferId})
        `,
        sql`
          UPDATE demo_run_sale_contexts
          SET sale_offer_id = ${saleOfferBId}
          WHERE run_id = ${runAId}
        `,
        sql`
          UPDATE demo_run_sale_contexts
          SET run_id = ${runBId}
          WHERE run_id = ${runAId}
        `,
        sql`
          UPDATE demo_runs
          SET sale_offer_id = ${unownedSaleOfferId}
          WHERE id = ${runAId}
        `,
      ]) {
        const violation = await contradictoryWrite.catch((error: unknown) => error);
        expect(violation).toMatchObject({
          code: "23503",
          constraint_name: "demo_run_sale_contexts_run_sale_offer_demo_runs_fk",
        });
      }

      await sql`DELETE FROM demo_runs WHERE id IN (${runAId}, ${runBId})`;
      await sql`DELETE FROM demo_presets WHERE id = ${presetId}`;
      await sql`
        DELETE FROM sale_offers
        WHERE id IN (${saleOfferAId}, ${saleOfferBId}, ${unownedSaleOfferId})
      `;
      await sql`
        DELETE FROM products
        WHERE id IN (
          '38000000-0000-4000-8000-000000000017',
          '38000000-0000-4000-8000-000000000018',
          '38000000-0000-4000-8000-000000000019'
        )
      `;
    });
  });

  it("backfills legacy traffic completions as enrichment-completed during migration", async () => {
    const legacyRunId = "55555555-5555-4555-8555-555555555559";
    await runSeedScript();
    await withDatabase(async (sql) => {
      await removeRunHistoryChronologicalIndexes(sql);
      await removeLifecycleAndChildAttributionGuards(sql);
      await removeRunSaleContextOwnershipConstraint(sql);
      await sql`DROP TABLE demo_run_teardown_receipts`;
      await sql`ALTER TABLE demo_run_finalizations DROP COLUMN completion_enrichment_status`;
      await sql`DROP TYPE traffic_completion_enrichment_status`;
      await sql`
        DELETE FROM drizzle.__drizzle_migrations
        WHERE id IN (
          SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 7
        )
      `;
      await sql`
        INSERT INTO demo_runs (
          id, preset_id, preset_name, operator_mode, status, traffic_status, config_snapshot
        )
        SELECT
          ${legacyRunId},
          id,
          display ->> 'name',
          'admin',
          'completed',
          'succeeded',
          jsonb_build_object(
            'trafficConfig', traffic_config,
            'inventoryConfig', inventory_config,
            'erpConfig', erp_config,
            'backpressureConfig', backpressure_config
          )
        FROM demo_presets
        WHERE slug = 'admin-smoke-steady'
      `;
      await sql`
        INSERT INTO demo_run_finalizations (
          run_id,
          http_summary,
          traffic_outcome_summary,
          traffic_delivery_summary,
          http_timing_breakdown_summary,
          load_run_diagnostics_summary,
          api_request_lifecycle_summary
        ) VALUES (${legacyRunId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
      `;
    });

    await runDatabaseMigrations({
      databaseUrl: requireTestEnv("TEST_DATABASE_URL"),
      migrationsFolder,
    });

    const [legacyFinalization] = await withDatabase(
      (sql) => sql<{ completion_enrichment_status: string }[]>`
        SELECT completion_enrichment_status
        FROM demo_run_finalizations
        WHERE run_id = ${legacyRunId}
      `,
    );
    expect(legacyFinalization?.completion_enrichment_status).toBe("completed");
  });

  it("backfills legacy breaker and retry configuration during a migrate-only upgrade", async () => {
    await runSeedScript();
    await withDatabase(async (sql) => {
      await removeRunHistoryChronologicalIndexes(sql);
      await removeRunSaleContextOwnershipConstraint(sql);
      await sql`DROP TABLE demo_run_teardown_receipts`;
      await sql`
        UPDATE demo_presets
        SET backpressure_config = (backpressure_config
          - 'circuitBreakerFailureThreshold'
          - 'circuitBreakerResetTimeoutMs'
          - 'retryPolicy')
        WHERE slug = 'admin-smoke-steady'
      `;
      await sql`
        UPDATE public_runtime_policies
        SET policy = jsonb_set(
          jsonb_set(policy, '{publicRunBudget,windowSeconds}', '999'::jsonb),
          '{publicCustomDefaults,backpressureConfig}',
          (policy #> '{publicCustomDefaults,backpressureConfig}')
            - 'circuitBreakerFailureThreshold'
            - 'circuitBreakerResetTimeoutMs'
            - 'retryPolicy',
          true
        )
        WHERE id = 'active'
      `;
      await sql`
        INSERT INTO demo_runs (
          id, preset_id, preset_name, operator_mode, status, traffic_status, config_snapshot
        )
        SELECT
          '55555555-5555-4555-8555-555555555558',
          id,
          display ->> 'name',
          'admin',
          'completed',
          'succeeded',
          jsonb_build_object(
            'trafficConfig', traffic_config,
            'inventoryConfig', inventory_config,
            'erpConfig', erp_config,
            'backpressureConfig',
              (backpressure_config || jsonb_build_object(
                'circuitBreakerFailureThreshold', 5,
                'circuitBreakerResetTimeoutMs', 10000
              )) - 'retryPolicy'
          )
        FROM demo_presets
        WHERE slug = 'admin-smoke-steady'
      `;
      await sql`
        ALTER TABLE demo_run_finalizations DROP COLUMN completion_enrichment_status
      `;
      await sql`
        DROP TYPE traffic_completion_enrichment_status
      `;
      await removeLifecycleAndChildAttributionGuards(sql);
      await sql`
        DELETE FROM drizzle.__drizzle_migrations
        WHERE id IN (
          SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 9
        )
      `;
    });

    await runDatabaseMigrations({
      databaseUrl: requireTestEnv("TEST_DATABASE_URL"),
      migrationsFolder,
    });

    const [preset] = await withDatabase(
      (sql) => sql<{ backpressure_config: Record<string, unknown> }[]>`
        SELECT backpressure_config
        FROM demo_presets
        WHERE slug = 'admin-smoke-steady'
      `,
    );
    const [policy] = await withDatabase(
      (sql) => sql<{ policy: unknown }[]>`
        SELECT policy
        FROM public_runtime_policies
        WHERE id = 'active'
      `,
    );
    const [legacyRun] = await withDatabase(
      (sql) => sql<{ config_snapshot: unknown }[]>`
        SELECT config_snapshot
        FROM demo_runs
        WHERE id = '55555555-5555-4555-8555-555555555558'
      `,
    );
    expect(preset?.backpressure_config).toMatchObject({
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
      queueName: "orders:process",
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
    });
    expect(policy?.policy).toMatchObject({
      publicCustomDefaults: {
        backpressureConfig: {
          circuitBreakerFailureThreshold: 5,
          circuitBreakerResetTimeoutMs: 10_000,
          retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
        },
      },
      publicRunBudget: { windowSeconds: 999 },
    });
    expect(() => publicRuntimePolicySchema.parse(policy?.policy)).not.toThrow();
    const migratedSnapshot = acceptedRunConfigSnapshotSchema.parse(legacyRun?.config_snapshot);
    expect(migratedSnapshot.backpressureConfig.retryPolicy).toEqual({
      maxAttempts: 4,
      initialBackoffMs: 500,
    });
  });

  it("backfills preset archive lifecycle columns during a migrate-only upgrade", async () => {
    const canonicalPresetId = "44444444-4444-4444-8444-444444444460";
    const operatorDuplicateId = "44444444-4444-4444-8444-444444444461";

    // Rewind to before migration 0009: drop the new columns and index, remove
    // the 0009 and later journal entries, then insert representative legacy rows before
    // re-migrating so the backfill semantics are exercised, not just a fresh
    // schema build.
    await withDatabase(async (sql) => {
      await removeRunHistoryChronologicalIndexes(sql);
      await removeLifecycleAndChildAttributionGuards(sql);
      await sql`DROP INDEX IF EXISTS "demo_presets_archived_at_idx"`;
      await sql`ALTER TABLE "demo_presets" DROP COLUMN IF EXISTS "archived_at"`;
      await sql`ALTER TABLE "demo_presets" DROP COLUMN IF EXISTS "is_system"`;
      await sql`
        DELETE FROM drizzle.__drizzle_migrations
        WHERE id IN (
          SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 4
        )
      `;
      await sql`
        INSERT INTO "demo_presets" (
          "id", "slug", "visibility", "is_editable", "is_custom", "display",
          "traffic_config", "inventory_config", "erp_config", "backpressure_config"
        ) VALUES
          (
            ${canonicalPresetId},
            'admin-smoke-steady',
            'admin'::"demo_preset_visibility",
            true,
            false,
            '{"name":"Admin Smoke Steady","description":"Legacy canonical","sortOrder":100,"outcomeFocus":[]}'::jsonb,
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
          ),
          (
            ${operatorDuplicateId},
            'operator-smoke-copy',
            'admin'::"demo_preset_visibility",
            true,
            false,
            '{"name":"Operator Smoke Copy","description":"Noncanonical duplicate","sortOrder":101,"outcomeFocus":[]}'::jsonb,
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
          )
        ON CONFLICT ("slug") DO NOTHING
      `;
    });

    await runDatabaseMigrations({
      databaseUrl: requireTestEnv("TEST_DATABASE_URL"),
      migrationsFolder,
    });

    const [isSystemColumn] = await withDatabase(
      (sql) =>
        sql<{ is_nullable: string; column_default: string | null }[]>`
          SELECT is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'demo_presets'
            AND column_name = 'is_system'
        `,
    );
    const [archivedAtColumn] = await withDatabase(
      (sql) =>
        sql<{ is_nullable: string; column_default: string | null }[]>`
          SELECT is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'demo_presets'
            AND column_name = 'archived_at'
        `,
    );
    const [archiveIndex] = await withDatabase(
      (sql) => sql<{ exists: boolean }[]>`
        SELECT to_regclass('public.demo_presets_archived_at_idx') IS NOT NULL AS "exists"
      `,
    );
    const presetRows = await withDatabase(
      (sql) =>
        sql<{ slug: string; is_system: boolean; archived_at: string | null }[]>`
          SELECT slug, is_system, archived_at::text
          FROM demo_presets
          WHERE slug IN ('admin-smoke-steady', 'operator-smoke-copy')
          ORDER BY slug
        `,
    );

    expect(isSystemColumn?.is_nullable).toBe("NO");
    expect(isSystemColumn?.column_default).toBe("false");
    expect(archivedAtColumn?.is_nullable).toBe("YES");
    expect(archivedAtColumn?.column_default).toBeNull();
    expect(archiveIndex?.exists).toBe(true);
    expect(presetRows).toEqual([
      { slug: "admin-smoke-steady", is_system: true, archived_at: null },
      { slug: "operator-smoke-copy", is_system: false, archived_at: null },
    ]);

    // Leave the database usable for subsequent tests.
    await withDatabase(
      (sql) =>
        sql`DELETE FROM demo_presets WHERE id IN (${canonicalPresetId}, ${operatorDuplicateId})`,
    );
  });

  it("backfills conservative ERP attempt terminal markers and enforces the final column contract", async () => {
    const confirmedIds = buildOrderReservationIds(901);
    const failedIds = buildOrderReservationIds(902);
    const processingIds = buildOrderReservationIds(903);
    const correlationId = "corr-erp-terminal-migration";

    await withDatabase(async (sql) => {
      await removeRunHistoryChronologicalIndexes(sql);
      await removeLifecycleAndChildAttributionGuards(sql);
      await sql`ALTER TABLE "erp_attempts" DROP COLUMN IF EXISTS "terminal"`;
      await sql`
        DELETE FROM drizzle.__drizzle_migrations
        WHERE id IN (
          SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 3
        )
      `;
      await insertCatalogSaleOffer(sql, confirmedIds);
      for (const { ids, status } of [
        { ids: confirmedIds, status: "confirmed" as const },
        { ids: failedIds, status: "failed" as const },
        { ids: processingIds, status: "processing" as const },
      ]) {
        await insertReservation(sql, {
          reservationId: ids.reservationId,
          saleOfferId: confirmedIds.saleOfferId,
          correlationId,
        });
        await insertOrder(sql, {
          orderId: ids.orderId,
          saleOfferId: confirmedIds.saleOfferId,
          reservationId: ids.reservationId,
          correlationId,
          status,
          processingAt: orderQueuedAt,
          confirmedAt: status === "confirmed" ? orderQueuedAt : null,
          failedAt: status === "failed" ? orderQueuedAt : null,
        });
      }
      await sql`
        INSERT INTO "erp_attempts" (
          "order_id", "delivery_id", "correlation_id", "attempt_number", "status",
          "latency_ms", "started_at", "finished_at", "created_at"
        ) VALUES
          (${confirmedIds.orderId}, 'confirmed-failure', ${correlationId}, 1, 'failed', 10, '2026-06-20T12:00:01Z', '2026-06-20T12:00:01Z', '2026-06-20T12:00:01Z'),
          (${confirmedIds.orderId}, 'confirmed-success', ${correlationId}, 2, 'succeeded', 10, '2026-06-20T12:00:02Z', '2026-06-20T12:00:02Z', '2026-06-20T12:00:02Z'),
          (${failedIds.orderId}, 'failed-earlier', ${correlationId}, 1, 'failed', 10, '2026-06-20T12:00:01Z', '2026-06-20T12:00:01Z', '2026-06-20T12:00:01Z'),
          (${failedIds.orderId}, 'failed-latest', ${correlationId}, 2, 'timed_out', 10, '2026-06-20T12:00:02Z', '2026-06-20T12:00:02Z', '2026-06-20T12:00:02Z'),
          (${processingIds.orderId}, 'processing-ambiguous', ${correlationId}, 1, 'failed', 10, '2026-06-20T12:00:01Z', '2026-06-20T12:00:01Z', '2026-06-20T12:00:01Z')
      `;
    });

    await runDatabaseMigrations({
      databaseUrl: requireTestEnv("TEST_DATABASE_URL"),
      migrationsFolder,
    });

    await withDatabase(async (sql) => {
      const rows = await sql<{ delivery_id: string; terminal: boolean }[]>`
        SELECT "delivery_id", "terminal"
        FROM "erp_attempts"
        WHERE "correlation_id" = ${correlationId}
        ORDER BY "delivery_id"
      `;
      expect(rows).toEqual([
        { delivery_id: "confirmed-failure", terminal: false },
        { delivery_id: "confirmed-success", terminal: true },
        { delivery_id: "failed-earlier", terminal: false },
        { delivery_id: "failed-latest", terminal: true },
        { delivery_id: "processing-ambiguous", terminal: false },
      ]);

      const [column] = await sql<{ is_nullable: string; column_default: string | null }[]>`
        SELECT is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'erp_attempts'
          AND column_name = 'terminal'
      `;
      expect(column).toEqual({ is_nullable: "NO", column_default: "false" });

      await sql`
        INSERT INTO "erp_attempts" (
          "order_id", "delivery_id", "correlation_id", "attempt_number", "status",
          "latency_ms", "started_at", "finished_at"
        ) VALUES (
          ${processingIds.orderId}, 'default-terminal', ${correlationId}, 2, 'failed',
          10, '2026-06-20T12:00:03Z', '2026-06-20T12:00:03Z'
        )
      `;
      const [defaulted] = await sql<{ terminal: boolean }[]>`
        SELECT terminal FROM erp_attempts WHERE delivery_id = 'default-terminal'
      `;
      expect(defaulted?.terminal).toBe(false);
      await expect(sql`
        INSERT INTO "erp_attempts" (
          "order_id", "delivery_id", "correlation_id", "attempt_number", "status", "terminal",
          "latency_ms", "started_at", "finished_at"
        ) VALUES (
          ${processingIds.orderId}, 'null-terminal', ${correlationId}, 3, 'failed', NULL,
          10, '2026-06-20T12:00:04Z', '2026-06-20T12:00:04Z'
        )
      `).rejects.toThrow();

      await sql`DELETE FROM orders WHERE id IN (${confirmedIds.orderId}, ${failedIds.orderId}, ${processingIds.orderId})`;
      await sql`DELETE FROM reservations WHERE id IN (${confirmedIds.reservationId}, ${failedIds.reservationId}, ${processingIds.reservationId})`;
      await sql`DELETE FROM sale_offers WHERE id = ${confirmedIds.saleOfferId}`;
      await sql`DELETE FROM products WHERE id = ${confirmedIds.productId}`;
    });
  });

  it("isolates scoped ERP circuit snapshots, applies TTL, and clears scoped and legacy state", async () => {
    const base = {
      state: "closed" as const,
      consecutiveFailureCount: 0,
      failureThreshold: 5,
      resetTimeoutMs: 10_000,
      openedAt: null,
      nextAttemptAt: null,
      halfOpenProbeInFlight: false,
      updatedAt: "2026-06-20T12:00:00.000Z",
    };
    const runA = { type: "run" as const, runId: "55555555-5555-4555-8555-555555555555" };
    const runB = { type: "run" as const, runId: "66666666-6666-4666-8666-666666666666" };
    await redis.set(erpCircuitBreakerSnapshotKey, JSON.stringify({ ...base, state: "open" }));
    await setErpCircuitBreakerSnapshot(redis, { ...base, failureThreshold: 2 }, runA);
    await setErpCircuitBreakerSnapshot(
      redis,
      { ...base, failureThreshold: 3, resetTimeoutMs: 172_800_001 },
      runB,
    );
    await setErpCircuitBreakerSnapshot(redis, base, { type: "catalog" });

    await expect(getErpCircuitBreakerSnapshot(redis, runA)).resolves.toMatchObject({
      failureThreshold: 2,
    });
    await expect(getErpCircuitBreakerSnapshot(redis, runB)).resolves.toMatchObject({
      failureThreshold: 3,
    });
    await expect(getErpCircuitBreakerSnapshot(redis, { type: "catalog" })).resolves.toMatchObject({
      failureThreshold: 5,
    });
    expect(await redis.ttl(getErpCircuitBreakerSnapshotKey(runA))).toBeGreaterThan(86_300);
    expect(await redis.ttl(getErpCircuitBreakerSnapshotKey(runB))).toBeGreaterThan(345_500);
    expect(await redis.get(erpCircuitBreakerSnapshotKey)).toBeNull();

    await redis.set(erpCircuitBreakerSnapshotKey, JSON.stringify(base));
    await clearErpCircuitBreakerSnapshots(redis);
    await expect(getErpCircuitBreakerSnapshot(redis, runA)).resolves.toBeNull();
    await expect(getErpCircuitBreakerSnapshot(redis, runB)).resolves.toBeNull();
    await expect(getErpCircuitBreakerSnapshot(redis, { type: "catalog" })).resolves.toBeNull();
    expect(await redis.get(erpCircuitBreakerSnapshotKey)).toBeNull();
  });

  it("enforces one non-terminal demo run across direct and concurrent writers", async () => {
    const presetId = "39000000-0000-4000-8000-000000000001";
    await withDatabase(async (sql) => {
      await sql`
        INSERT INTO demo_presets (
          id, slug, visibility, is_editable, display,
          traffic_config, inventory_config, erp_config, backpressure_config
        ) VALUES (
          ${presetId}, 'single-run-invariant', 'admin', true,
          ${JSON.stringify({ name: "Single Run Invariant" })}::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
        )
      `;

      for (const [index, status] of ["starting", "active", "draining"].entries()) {
        const blockerId = `39000000-0000-4000-8000-${(index * 2 + 2).toString().padStart(12, "0")}`;
        const rejectedId = `39000000-0000-4000-8000-${(index * 2 + 3).toString().padStart(12, "0")}`;
        await sql`
          INSERT INTO demo_runs (id, preset_id, preset_name, operator_mode, status, config_snapshot)
          VALUES (${blockerId}, ${presetId}, 'Single Run Invariant', 'admin', ${status}, '{}'::jsonb)
        `;

        const violation = await sql`
          INSERT INTO demo_runs (id, preset_id, preset_name, operator_mode, status, config_snapshot)
          VALUES (${rejectedId}, ${presetId}, 'Single Run Invariant', 'admin', 'starting', '{}'::jsonb)
        `.catch((error: unknown) => error);

        expect(violation).toMatchObject({
          code: "23505",
          constraint_name: "demo_runs_single_non_terminal_idx",
        });
        await sql`UPDATE demo_runs SET status = 'failed' WHERE id = ${blockerId}`;
      }

      await sql`
        INSERT INTO demo_runs (id, preset_id, preset_name, operator_mode, status, config_snapshot)
        VALUES
          ('39000000-0000-4000-8000-000000000008', ${presetId}, 'Completed History', 'admin', 'completed', '{}'::jsonb),
          ('39000000-0000-4000-8000-000000000009', ${presetId}, 'Failed History', 'admin', 'failed', '{}'::jsonb)
      `;
    });

    const claimConnections = [
      createDatabaseConnection(requireTestEnv("TEST_DATABASE_URL"), { max: 1 }),
      createDatabaseConnection(requireTestEnv("TEST_DATABASE_URL"), { max: 1 }),
    ];
    try {
      const claims = await Promise.allSettled(
        claimConnections.map(
          (connection, index) =>
            connection.sql`
            INSERT INTO demo_runs (id, preset_id, preset_name, operator_mode, status, config_snapshot)
            VALUES (
              ${`39000000-0000-4000-8000-${(index + 10).toString().padStart(12, "0")}`},
              ${presetId}, 'Concurrent Claim', 'admin', 'starting', '{}'::jsonb
            )
          `,
        ),
      );

      expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
      const rejectedClaim = claims.find((claim) => claim.status === "rejected");
      expect(rejectedClaim).toMatchObject({
        reason: { code: "23505", constraint_name: "demo_runs_single_non_terminal_idx" },
      });
      const cleanupConnection = claimConnections[0];
      if (!cleanupConnection) {
        throw new Error("Expected a database connection for cleanup.");
      }
      await cleanupConnection.sql`
        UPDATE demo_runs SET status = 'failed'
        WHERE status IN ('starting', 'active', 'draining')
      `;
      await cleanupConnection.sql`DELETE FROM demo_runs WHERE preset_id = ${presetId}`;
      await cleanupConnection.sql`DELETE FROM demo_presets WHERE id = ${presetId}`;
    } finally {
      await Promise.all(claimConnections.map((connection) => connection.close()));
    }
  });

  it("seeds idempotently without overwriting an admin-edited active runtime policy", async () => {
    await runSeedScript();
    const [initialPolicyRow] = await withDatabase(
      (sql) => sql<{ created_at: string; updated_at: string }[]>`
        SELECT created_at, updated_at
        FROM public_runtime_policies
        WHERE id = 'active'
      `,
    );
    await withDatabase(
      (sql) => sql`
        UPDATE public_runtime_policies
        SET policy = jsonb_set(policy, '{publicRunBudget,windowSeconds}', '999'::jsonb),
            updated_at = updated_at + interval '1 second'
        WHERE id = 'active'
      `,
    );
    await runSeedScript({ PUBLIC_RUN_BUDGET_WINDOW_SECONDS: " 301 " });

    const [counts] = await withDatabase(
      (sql) =>
        sql<
          {
            products: number;
            sale_offers: number;
            demo_presets: number;
            public_runtime_policies: number;
          }[]
        >`
        SELECT
          (SELECT count(*)::int FROM products) AS products,
          (SELECT count(*)::int FROM sale_offers) AS sale_offers,
          (SELECT count(*)::int FROM demo_presets) AS demo_presets,
          (SELECT count(*)::int FROM public_runtime_policies) AS public_runtime_policies
      `,
    );
    const [policyRow] = await withDatabase(
      (sql) =>
        sql<{ policy: unknown; created_at: string; updated_at: string }[]>`
        SELECT policy, created_at, updated_at
        FROM public_runtime_policies
        WHERE id = 'active'
      `,
    );
    const inventoryState = await redis.hgetall(`inventory:${seededSaleOfferId}:state`);

    expect(counts).toEqual({
      products: 1,
      sale_offers: 1,
      demo_presets: 8,
      public_runtime_policies: 1,
    });
    expect(publicRuntimePolicySchema.parse(policyRow?.policy).publicRunBudget.windowSeconds).toBe(
      999,
    );
    expect(policyRow?.created_at).toEqual(initialPolicyRow?.created_at);
    expect(new Date(policyRow?.updated_at ?? 0).getTime()).toBeGreaterThan(
      new Date(initialPolicyRow?.updated_at ?? 0).getTime(),
    );
    expect(inventoryState).toMatchObject({
      saleOfferId: seededSaleOfferId,
      inventoryScope: "catalog",
      allocatedStock: "1000",
      remainingStock: "1000",
      reservedStock: "0",
    });
  });

  it("reseeds an already-system mutable admin preset as a true no-op", async () => {
    await runSeedScript();
    // Operator edits the mutable admin preset and bumps updated_at. Uses the
    // `custom` scratch preset so later breaker-backfill assertions on
    // `admin-smoke-steady` are not affected by the preserved operator edit.
    await withDatabase(
      (sql) => sql`
        UPDATE demo_presets
        SET backpressure_config = jsonb_set(
              backpressure_config, '{orderProcessConcurrency}', '2'::jsonb
            ),
            updated_at = updated_at + interval '1 second'
        WHERE slug = 'custom'
      `,
    );
    const [edited] = await withDatabase(
      (sql) =>
        sql<
          { is_system: boolean; updated_at: string; backpressure_config: Record<string, unknown> }[]
        >`
          SELECT is_system, updated_at::text, backpressure_config
          FROM demo_presets WHERE slug = 'custom'
        `,
    );
    expect(edited?.is_system).toBe(true);
    expect(edited?.backpressure_config).toMatchObject({ orderProcessConcurrency: 2 });

    // Reseed — the already-system row must be a no-op: no config overwrite and
    // no updated_at bump.
    await runSeedScript();

    const [afterReseed] = await withDatabase(
      (sql) =>
        sql<
          { is_system: boolean; updated_at: string; backpressure_config: Record<string, unknown> }[]
        >`
          SELECT is_system, updated_at::text, backpressure_config
          FROM demo_presets WHERE slug = 'custom'
        `,
    );
    expect(afterReseed?.is_system).toBe(true);
    expect(afterReseed?.updated_at).toEqual(edited?.updated_at);
    expect(afterReseed?.backpressure_config).toEqual(edited?.backpressure_config);
  });

  it("repairs a falsely non-system mutable admin preset on reseed without overwriting configuration", async () => {
    await runSeedScript();
    // Deliberately corrupt is_system to false and operator-edit the config.
    // Uses a value within the backpressure schema max so later breaker-backfill
    // schema validation on admin-failure-path still passes.
    await withDatabase(
      (sql) => sql`
        UPDATE demo_presets
        SET is_system = false,
            backpressure_config = jsonb_set(
              backpressure_config, '{orderProcessConcurrency}', '3'::jsonb
            )
        WHERE slug = 'admin-failure-path'
      `,
    );
    const [corrupted] = await withDatabase(
      (sql) =>
        sql<{ is_system: boolean; backpressure_config: Record<string, unknown> }[]>`
          SELECT is_system, backpressure_config
          FROM demo_presets WHERE slug = 'admin-failure-path'
        `,
    );
    expect(corrupted?.is_system).toBe(false);
    expect(corrupted?.backpressure_config).toMatchObject({ orderProcessConcurrency: 3 });

    // Reseed — the marker is repaired to true, but the operator config is kept.
    await runSeedScript();

    const [afterReseed] = await withDatabase(
      (sql) =>
        sql<{ is_system: boolean; backpressure_config: Record<string, unknown> }[]>`
          SELECT is_system, backpressure_config
          FROM demo_presets WHERE slug = 'admin-failure-path'
        `,
    );
    expect(afterReseed?.is_system).toBe(true);
    expect(afterReseed?.backpressure_config).toMatchObject({ orderProcessConcurrency: 3 });
  });

  it("rejects invalid seed environment without changing the active runtime policy", async () => {
    await runSeedScript();
    const readPolicy = () =>
      withDatabase(
        (sql) => sql<{ policy: unknown; created_at: string; updated_at: string }[]>`
          SELECT policy, created_at, updated_at
          FROM public_runtime_policies
          WHERE id = 'active'
        `,
      );
    const [before] = await readPolicy();

    const partialIntegerFailure = await runSeedScript({
      PUBLIC_CUSTOM_MAX_TOTAL_REQUESTS: "10oops",
    }).catch((error: unknown) => error);
    expect(partialIntegerFailure).toMatchObject({
      stderr: expect.stringContaining("PUBLIC_CUSTOM_MAX_TOTAL_REQUESTS must be an integer"),
    });
    expect((await readPolicy())[0]).toEqual(before);

    const emptyIntegerFailure = await runSeedScript({
      PUBLIC_CUSTOM_MAX_TOTAL_REQUESTS: "",
    }).catch((error: unknown) => error);
    expect(emptyIntegerFailure).toMatchObject({
      stderr: expect.stringContaining("PUBLIC_CUSTOM_MAX_TOTAL_REQUESTS must be an integer"),
    });
    expect((await readPolicy())[0]).toEqual(before);

    const whitespaceNumberFailure = await runSeedScript({
      PUBLIC_CUSTOM_MAX_ERP_ERROR_RATE: "   ",
    }).catch((error: unknown) => error);
    expect(whitespaceNumberFailure).toMatchObject({
      stderr: expect.stringContaining("PUBLIC_CUSTOM_MAX_ERP_ERROR_RATE must be a number"),
    });
    expect((await readPolicy())[0]).toEqual(before);

    const semanticFailure = await runSeedScript({
      PUBLIC_CUSTOM_MAX_BUYERS: "100",
    }).catch((error: unknown) => error);
    expect(semanticFailure).toMatchObject({
      stderr: expect.stringContaining("public_custom_default_public_buyers_exceeded"),
    });
    expect((await readPolicy())[0]).toEqual(before);
  });

  it("maps every runtime-setup public policy bootstrap override", async () => {
    await withDatabase((sql) => sql`DELETE FROM public_runtime_policies WHERE id = 'active'`);
    await runSeedScript({
      PUBLIC_RUN_BUDGET_WINDOW_SECONDS: "301",
      PUBLIC_RUN_BUDGET_PER_VISITOR_MAX_STARTS: "3",
      PUBLIC_RUN_BUDGET_GLOBAL_MAX_STARTS: "7",
      DEMO_MAX_BUYERS: "300000",
      PUBLIC_CUSTOM_MAX_TOTAL_REQUESTS: "20000",
      PUBLIC_CUSTOM_MAX_BUYERS: "200000",
      PUBLIC_CUSTOM_MAX_REQUESTS_PER_SECOND: "2000",
      PUBLIC_CUSTOM_MAX_TRAFFIC_DURATION_SECONDS: "121",
      PUBLIC_CUSTOM_MAX_TRAFFIC_START_DELAY_SECONDS: "11",
      PUBLIC_CUSTOM_MAX_PRE_ALLOCATED_VUS: "1001",
      PUBLIC_CUSTOM_MAX_VUS: "1002",
      PUBLIC_CUSTOM_MAX_STARTING_STOCK: "1001",
      PUBLIC_CUSTOM_MAX_ERP_LATENCY_MS: "2001",
      PUBLIC_CUSTOM_MIN_ERP_MAX_TPS: "2",
      PUBLIC_CUSTOM_MAX_ERP_MAX_TPS: "300",
      PUBLIC_CUSTOM_MAX_ERP_ERROR_RATE: "0.3",
    });
    const [row] = await withDatabase(
      (sql) => sql<{ policy: unknown }[]>`
        SELECT policy FROM public_runtime_policies WHERE id = 'active'
      `,
    );
    const policy = publicRuntimePolicySchema.parse(row?.policy);

    expect(policy.publicRunBudget).toEqual({
      windowSeconds: 301,
      perVisitorMaxStarts: 3,
      globalMaxStarts: 7,
    });
    expect(policy.publicCustomLimits).toMatchObject({
      maxTotalRequests: 20_000,
      maxBuyers: 200_000,
      maxRequestsPerSecond: 2000,
      maxTrafficDurationSeconds: 121,
      maxTrafficStartDelaySeconds: 11,
      maxPreAllocatedVus: 1001,
      maxVus: 1002,
      maxStartingStock: 1001,
      maxErpLatencyMs: 2001,
      minErpMaxTps: 2,
      maxErpMaxTps: 300,
      maxErpErrorRate: 0.3,
    });
    expect(policy.deploymentHardCaps.maxBuyers).toBe(300_000);
  });

  it("backfills legacy preset breaker defaults while preserving runtime policy JSON", async () => {
    await runSeedScript();
    await withDatabase(async (sql) => {
      await sql`
        UPDATE demo_presets
        SET backpressure_config = backpressure_config - 'circuitBreakerFailureThreshold' - 'circuitBreakerResetTimeoutMs'
        WHERE slug = 'admin-smoke-steady'
      `;
      await sql`
        UPDATE demo_presets
        SET backpressure_config = (backpressure_config - 'circuitBreakerResetTimeoutMs')
          || '{"circuitBreakerFailureThreshold":77}'::jsonb
        WHERE slug = 'admin-failure-path'
      `;
      await sql`
        UPDATE public_runtime_policies
        SET policy = jsonb_set(jsonb_set(
          policy, '{publicRunBudget,windowSeconds}', '999'::jsonb),
          '{publicCustomDefaults,backpressureConfig}',
          (policy #> '{publicCustomDefaults,backpressureConfig}')
            - 'circuitBreakerFailureThreshold' - 'circuitBreakerResetTimeoutMs',
          true
        )
        WHERE id = 'active'
      `;
    });

    const overrides = {
      ERP_CIRCUIT_FAILURE_THRESHOLD: "7",
      ERP_CIRCUIT_RESET_TIMEOUT_MS: "12345",
    };
    await runSeedScript(overrides);
    const readBackfilledState = () =>
      withDatabase(
        (sql) => sql<{ slug: string; backpressure_config: Record<string, unknown> }[]>`
        SELECT slug, backpressure_config
        FROM demo_presets
        WHERE slug IN ('admin-smoke-steady', 'admin-failure-path')
        ORDER BY slug
      `,
      );
    const firstPresetState = await readBackfilledState();
    const [policyRow] = await withDatabase(
      (sql) => sql<{ policy: unknown }[]>`
      SELECT policy FROM public_runtime_policies WHERE id = 'active'
    `,
    );
    expect(firstPresetState).toEqual([
      {
        slug: "admin-failure-path",
        backpressure_config: expect.objectContaining({
          circuitBreakerFailureThreshold: 77,
          circuitBreakerResetTimeoutMs: 12_345,
          queueName: "orders:process",
        }),
      },
      {
        slug: "admin-smoke-steady",
        backpressure_config: expect.objectContaining({
          circuitBreakerFailureThreshold: 7,
          circuitBreakerResetTimeoutMs: 12_345,
          orderProcessConcurrency: 5,
          retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
        }),
      },
    ]);
    for (const preset of firstPresetState) {
      expect(() => backpressureConfigSchema.parse(preset.backpressure_config)).not.toThrow();
    }
    expect(() => publicRuntimePolicySchema.parse(policyRow?.policy)).toThrow();
    expect(policyRow?.policy).toMatchObject({
      publicCustomDefaults: { backpressureConfig: { orderProcessConcurrency: 5 } },
      publicRunBudget: { windowSeconds: 999 },
    });

    await runSeedScript({
      ERP_CIRCUIT_FAILURE_THRESHOLD: "9",
      ERP_CIRCUIT_RESET_TIMEOUT_MS: "54321",
    });
    expect(await readBackfilledState()).toEqual(firstPresetState);
    const [policyAfterRerun] = await withDatabase(
      (sql) => sql<{ policy: unknown }[]>`
      SELECT policy FROM public_runtime_policies WHERE id = 'active'
    `,
    );
    expect(policyAfterRerun?.policy).toMatchObject({
      publicCustomDefaults: { backpressureConfig: { orderProcessConcurrency: 5 } },
      publicRunBudget: { windowSeconds: 999 },
    });
  });

  it("fails closed on legacy lifecycle contradictions and succeeds after explicit remediation", async () => {
    const ids = buildOrderReservationIds(920);

    await withDatabase(async (sql) => {
      await removeRunHistoryChronologicalIndexes(sql);
      await removeLifecycleAndChildAttributionGuards(sql);
      await sql`
        DELETE FROM drizzle.__drizzle_migrations
        WHERE id IN (
          SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 2
        )
      `;
      await insertCatalogSaleOffer(sql, ids);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId: "corr-lifecycle-preflight",
        status: "released",
      });
      await sql`
        UPDATE "reservations" SET "released_at" = NULL WHERE "id" = ${ids.reservationId}
      `;
    });

    const migrationError = await runDatabaseMigrations({
      databaseUrl: requireTestEnv("TEST_DATABASE_URL"),
      migrationsFolder,
    }).catch((error: unknown) => error);
    expect(migrationError).toMatchObject({
      cause: {
        code: "23514",
        constraint_name: "reservations_released_requires_released_at",
      },
    });

    await withDatabase(
      (sql) => sql`
        UPDATE "reservations" SET "released_at" = "secured_at"
        WHERE "id" = ${ids.reservationId}
      `,
    );
    await runDatabaseMigrations({
      databaseUrl: requireTestEnv("TEST_DATABASE_URL"),
      migrationsFolder,
    });
  });

  it("fails closed on legacy attribution contradictions and succeeds after explicit remediation", async () => {
    const ids = buildOrderReservationIds(930);

    await withDatabase(async (sql) => {
      await removeRunHistoryChronologicalIndexes(sql);
      await removeLifecycleAndChildAttributionGuards(sql);
      await sql`
        DELETE FROM drizzle.__drizzle_migrations
        WHERE id IN (
          SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 2
        )
      `;
      await insertCatalogSaleOffer(sql, ids);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId: "corr-attribution-preflight",
      });
      await insertOrder(sql, {
        orderId: ids.orderId,
        saleOfferId: ids.saleOfferId,
        reservationId: ids.reservationId,
        correlationId: "corr-attribution-preflight",
      });
      await sql`
        INSERT INTO "order_events" (
          "order_id", "reservation_id", "sale_offer_id", "correlation_id",
          "event_name", "source", "occurred_at"
        ) VALUES (
          ${ids.orderId}, ${ids.reservationId}, ${ids.saleOfferId}, 'corr-legacy-mismatch',
          'order.queued', 'legacy-test', ${orderQueuedAt}::timestamptz
        )
      `;
    });

    const migrationError = await runDatabaseMigrations({
      databaseUrl: requireTestEnv("TEST_DATABASE_URL"),
      migrationsFolder,
    }).catch((error: unknown) => error);
    expect(migrationError).toMatchObject({
      cause: {
        code: "23514",
        constraint_name: "order_events_order_attribution_agreement",
      },
    });

    await withDatabase(
      (sql) => sql`
        UPDATE "order_events" SET "correlation_id" = 'corr-attribution-preflight'
        WHERE "order_id" = ${ids.orderId}
      `,
    );
    await runDatabaseMigrations({
      databaseUrl: requireTestEnv("TEST_DATABASE_URL"),
      migrationsFolder,
    });
  });

  it("enforces lifecycle timestamp constraints while preserving one-way and equality semantics", async () => {
    await withDatabase(async (sql) => {
      const ids = buildOrderReservationIds(921);
      await insertCatalogSaleOffer(sql, ids);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId: "corr-lifecycle-checks",
      });

      await expectConstraintViolation(
        sql`UPDATE "reservations" SET "status" = 'released' WHERE "id" = ${ids.reservationId}`,
        "reservations_released_requires_released_at",
      );
      await expectConstraintViolation(
        sql`UPDATE "reservations" SET "status" = 'expired' WHERE "id" = ${ids.reservationId}`,
        "reservations_expired_requires_expired_at",
      );
      await sql`
        UPDATE "reservations"
        SET "status" = 'released', "released_at" = "secured_at", "expired_at" = "secured_at"
        WHERE "id" = ${ids.reservationId}
      `;
      await sql`
        UPDATE "reservations" SET "status" = 'secured' WHERE "id" = ${ids.reservationId}
      `;
      await insertOrder(sql, {
        orderId: ids.orderId,
        saleOfferId: ids.saleOfferId,
        reservationId: ids.reservationId,
        correlationId: "corr-lifecycle-checks",
      });

      await expectConstraintViolation(
        sql`UPDATE "orders" SET "status" = 'processing' WHERE "id" = ${ids.orderId}`,
        "orders_in_progress_requires_processing_at",
      );
      await sql`
        UPDATE "orders" SET "status" = 'processing', "processing_at" = "queued_at"
        WHERE "id" = ${ids.orderId}
      `;
      await expectConstraintViolation(
        sql`UPDATE "orders" SET "status" = 'confirmed' WHERE "id" = ${ids.orderId}`,
        "orders_confirmed_requires_confirmed_at",
      );
      await expectConstraintViolation(
        sql`UPDATE "orders" SET "status" = 'failed' WHERE "id" = ${ids.orderId}`,
        "orders_failed_requires_failed_at",
      );
      await expectConstraintViolation(
        sql`
          UPDATE "orders" SET "status" = 'queued', "confirmed_at" = "queued_at" - interval '1 millisecond'
          WHERE "id" = ${ids.orderId}
        `,
        "orders_terminal_timestamps_after_queued_at",
      );
      await sql`
        UPDATE "orders"
        SET "status" = 'confirmed', "confirmed_at" = "queued_at", "failed_at" = "queued_at"
        WHERE "id" = ${ids.orderId}
      `;

      await expectConstraintViolation(
        sql`
          INSERT INTO "erp_attempts" (
            "order_id", "delivery_id", "correlation_id", "attempt_number", "status",
            "latency_ms", "started_at", "finished_at"
          ) VALUES (
            ${ids.orderId}, 'lifecycle-invalid', 'corr-lifecycle-checks', 1, 'failed',
            1, ${orderQueuedAt}::timestamptz, ${orderQueuedAt}::timestamptz - interval '1 millisecond'
          )
        `,
        "erp_attempts_finished_after_started",
      );
      await sql`
        INSERT INTO "erp_attempts" (
          "order_id", "delivery_id", "correlation_id", "attempt_number", "status",
          "latency_ms", "started_at", "finished_at"
        ) VALUES (
          ${ids.orderId}, 'lifecycle-equal', 'corr-lifecycle-checks', 1, 'succeeded',
          0, ${orderQueuedAt}::timestamptz, ${orderQueuedAt}::timestamptz
        )
      `;
    });
  });

  it("enforces ERP attempt attribution on inserts and updates, including nullable runs", async () => {
    await withDatabase(async (sql) => {
      const generatedIds = buildOrderReservationIds(922);
      const alternateIds = buildOrderReservationIds(923);
      const catalogIds = buildOrderReservationIds(924);
      await insertCatalogSaleOffer(sql, { ...generatedIds, purpose: "generated_run" });
      await insertCatalogSaleOffer(sql, { ...alternateIds, purpose: "generated_run" });
      await insertCatalogSaleOffer(sql, catalogIds);
      await insertGeneratedRunContext(sql, generatedIds);
      await insertGeneratedRunContext(sql, alternateIds);
      await insertReservation(sql, {
        reservationId: generatedIds.reservationId,
        saleOfferId: generatedIds.saleOfferId,
        correlationId: "corr-erp-attribution",
        runId: generatedIds.runId,
      });
      await insertOrder(sql, {
        orderId: generatedIds.orderId,
        saleOfferId: generatedIds.saleOfferId,
        reservationId: generatedIds.reservationId,
        correlationId: "corr-erp-attribution",
        runId: generatedIds.runId,
      });

      const insertAttempt = (
        deliveryId: string,
        runId: string | null,
        correlationId: string,
      ) => sql`
        INSERT INTO "erp_attempts" (
          "order_id", "delivery_id", "correlation_id", "run_id", "attempt_number", "status",
          "latency_ms", "started_at", "finished_at"
        ) VALUES (
          ${generatedIds.orderId}, ${deliveryId}, ${correlationId}, ${runId}, 1, 'failed',
          1, ${orderQueuedAt}::timestamptz, ${orderQueuedAt}::timestamptz
        )
      `;
      await insertAttempt("erp-attribution-valid", generatedIds.runId, "corr-erp-attribution");
      await expectConstraintViolation(
        insertAttempt("erp-attribution-null", null, "corr-erp-attribution"),
        "erp_attempts_order_attribution_agreement",
      );
      await expectConstraintViolation(
        insertAttempt("erp-attribution-run", alternateIds.runId, "corr-erp-attribution"),
        "erp_attempts_order_attribution_agreement",
      );
      await expectConstraintViolation(
        insertAttempt("erp-attribution-correlation", generatedIds.runId, "corr-other"),
        "erp_attempts_order_attribution_agreement",
      );
      await expectConstraintViolation(
        sql`
          UPDATE "erp_attempts" SET "correlation_id" = 'corr-other'
          WHERE "delivery_id" = 'erp-attribution-valid'
        `,
        "erp_attempts_order_attribution_agreement",
      );

      await insertReservation(sql, {
        reservationId: catalogIds.reservationId,
        saleOfferId: catalogIds.saleOfferId,
        correlationId: "corr-erp-null-run",
      });
      await insertOrder(sql, {
        orderId: catalogIds.orderId,
        saleOfferId: catalogIds.saleOfferId,
        reservationId: catalogIds.reservationId,
        correlationId: "corr-erp-null-run",
      });
      await sql`
        INSERT INTO "erp_attempts" (
          "order_id", "delivery_id", "correlation_id", "run_id", "attempt_number", "status",
          "latency_ms", "started_at", "finished_at"
        ) VALUES (
          ${catalogIds.orderId}, 'erp-null-run-valid', 'corr-erp-null-run', NULL, 1, 'succeeded',
          0, ${orderQueuedAt}::timestamptz, ${orderQueuedAt}::timestamptz
        )
      `;
    });
  });

  it("enforces linked, reservation-only, and unlinked order-event attribution policies", async () => {
    await withDatabase(async (sql) => {
      const ids = buildOrderReservationIds(925);
      const alternateIds = buildOrderReservationIds(926);
      const generatedIds = buildOrderReservationIds(929);
      await insertCatalogSaleOffer(sql, ids);
      await insertCatalogSaleOffer(sql, alternateIds);
      await insertCatalogSaleOffer(sql, { ...generatedIds, purpose: "generated_run" });
      await insertGeneratedRunContext(sql, generatedIds);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId: "corr-event-attribution",
      });
      await insertReservation(sql, {
        reservationId: alternateIds.reservationId,
        saleOfferId: alternateIds.saleOfferId,
        correlationId: "corr-event-alternate",
      });
      await insertOrder(sql, {
        orderId: ids.orderId,
        saleOfferId: ids.saleOfferId,
        reservationId: ids.reservationId,
        correlationId: "corr-event-attribution",
      });

      const insertEvent = (input: {
        id: string;
        orderId: string | null;
        reservationId: string | null;
        saleOfferId: string;
        correlationId: string;
        runId?: string | null;
      }) => sql`
        INSERT INTO "order_events" (
          "id", "order_id", "reservation_id", "sale_offer_id", "correlation_id", "run_id",
          "event_name", "source", "occurred_at"
        ) VALUES (
          ${input.id}, ${input.orderId}, ${input.reservationId}, ${input.saleOfferId},
          ${input.correlationId}, ${input.runId ?? null}, 'order.queued', 'test', ${orderQueuedAt}::timestamptz
        )
      `;
      const baseEvent = {
        orderId: ids.orderId,
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId: "corr-event-attribution",
      };
      await insertEvent({ ...baseEvent, id: "93000000-0000-4000-8000-000000000001" });
      for (const [id, override] of [
        ["93000000-0000-4000-8000-000000000002", { reservationId: alternateIds.reservationId }],
        ["93000000-0000-4000-8000-000000000003", { saleOfferId: alternateIds.saleOfferId }],
        ["93000000-0000-4000-8000-000000000004", { correlationId: "corr-other" }],
        ["93000000-0000-4000-8000-000000000009", { runId: generatedIds.runId }],
      ] as const) {
        await expectConstraintViolation(
          insertEvent({ ...baseEvent, ...override, id }),
          "order_events_order_attribution_agreement",
        );
      }
      await expectConstraintViolation(
        sql`
          UPDATE "order_events" SET "correlation_id" = 'corr-other'
          WHERE "id" = '93000000-0000-4000-8000-000000000001'
        `,
        "order_events_order_attribution_agreement",
      );

      await insertEvent({
        ...baseEvent,
        id: "93000000-0000-4000-8000-000000000005",
        orderId: null,
      });
      await expectConstraintViolation(
        insertEvent({
          id: "93000000-0000-4000-8000-000000000006",
          orderId: null,
          reservationId: ids.reservationId,
          saleOfferId: alternateIds.saleOfferId,
          correlationId: "corr-event-attribution",
        }),
        "order_events_reservation_attribution_agreement",
      );
      await expectConstraintViolation(
        insertEvent({
          id: "93000000-0000-4000-8000-000000000010",
          orderId: null,
          reservationId: ids.reservationId,
          saleOfferId: ids.saleOfferId,
          correlationId: "corr-event-attribution",
          runId: generatedIds.runId,
        }),
        "order_events_reservation_attribution_agreement",
      );
      await expectConstraintViolation(
        insertEvent({
          id: "93000000-0000-4000-8000-000000000007",
          orderId: null,
          reservationId: ids.reservationId,
          saleOfferId: ids.saleOfferId,
          correlationId: "corr-other",
        }),
        "order_events_reservation_attribution_agreement",
      );
      await insertEvent({
        id: "93000000-0000-4000-8000-000000000008",
        orderId: null,
        reservationId: null,
        saleOfferId: alternateIds.saleOfferId,
        correlationId: "corr-unlinked",
      });
    });
  });

  it("preserves nullable event links and cascading ERP cleanup when parents are deleted", async () => {
    await withDatabase(async (sql) => {
      const ids = buildOrderReservationIds(931);
      const eventId = "93000000-0000-4000-8000-000000000011";
      await insertCatalogSaleOffer(sql, ids);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId: "corr-event-delete-actions",
      });
      await insertOrder(sql, {
        orderId: ids.orderId,
        saleOfferId: ids.saleOfferId,
        reservationId: ids.reservationId,
        correlationId: "corr-event-delete-actions",
      });
      await sql`
        INSERT INTO "order_events" (
          "id", "order_id", "reservation_id", "sale_offer_id", "correlation_id",
          "event_name", "source", "occurred_at"
        ) VALUES (
          ${eventId}, ${ids.orderId}, ${ids.reservationId}, ${ids.saleOfferId},
          'corr-event-delete-actions', 'order.queued', 'test', ${orderQueuedAt}::timestamptz
        )
      `;
      await sql`
        INSERT INTO "erp_attempts" (
          "order_id", "delivery_id", "correlation_id", "attempt_number", "status",
          "latency_ms", "started_at", "finished_at"
        ) VALUES (
          ${ids.orderId}, 'event-delete-actions', 'corr-event-delete-actions', 1, 'succeeded',
          0, ${orderQueuedAt}::timestamptz, ${orderQueuedAt}::timestamptz
        )
      `;

      await sql`DELETE FROM "orders" WHERE "id" = ${ids.orderId}`;
      const [afterOrderDelete] = await sql<
        { order_id: string | null; reservation_id: string | null }[]
      >`
        SELECT "order_id", "reservation_id" FROM "order_events" WHERE "id" = ${eventId}
      `;
      expect(afterOrderDelete).toEqual({
        order_id: null,
        reservation_id: ids.reservationId,
      });
      const [attemptCount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM "erp_attempts" WHERE "order_id" = ${ids.orderId}
      `;
      expect(attemptCount?.count).toBe(0);

      await sql`DELETE FROM "reservations" WHERE "id" = ${ids.reservationId}`;
      const [afterReservationDelete] = await sql<
        { order_id: string | null; reservation_id: string | null }[]
      >`
        SELECT "order_id", "reservation_id" FROM "order_events" WHERE "id" = ${eventId}
      `;
      expect(afterReservationDelete).toEqual({ order_id: null, reservation_id: null });
    });
  });

  it("prevents parent attribution changes from invalidating existing children", async () => {
    await withDatabase(async (sql) => {
      const ids = buildOrderReservationIds(927);
      const alternateIds = buildOrderReservationIds(928);
      await insertCatalogSaleOffer(sql, ids);
      await insertCatalogSaleOffer(sql, alternateIds);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId: "corr-parent-preservation",
      });
      await insertReservation(sql, {
        reservationId: alternateIds.reservationId,
        saleOfferId: alternateIds.saleOfferId,
        correlationId: "corr-parent-alternate",
      });
      await insertOrder(sql, {
        orderId: ids.orderId,
        saleOfferId: ids.saleOfferId,
        reservationId: ids.reservationId,
        correlationId: "corr-parent-preservation",
      });
      await sql`
        INSERT INTO "erp_attempts" (
          "order_id", "delivery_id", "correlation_id", "attempt_number", "status",
          "latency_ms", "started_at", "finished_at"
        ) VALUES (
          ${ids.orderId}, 'parent-preservation', 'corr-parent-preservation', 1, 'failed',
          0, ${orderQueuedAt}::timestamptz, ${orderQueuedAt}::timestamptz
        )
      `;
      await sql`
        INSERT INTO "order_events" (
          "order_id", "reservation_id", "sale_offer_id", "correlation_id",
          "event_name", "source", "occurred_at"
        ) VALUES (
          ${ids.orderId}, ${ids.reservationId}, ${ids.saleOfferId}, 'corr-parent-preservation',
          'order.queued', 'test', ${orderQueuedAt}::timestamptz
        )
      `;
      await expectConstraintViolation(
        sql`
          UPDATE "orders"
          SET "reservation_id" = ${alternateIds.reservationId},
              "sale_offer_id" = ${alternateIds.saleOfferId},
              "correlation_id" = 'corr-parent-alternate'
          WHERE "id" = ${ids.orderId}
        `,
        "orders_child_attribution_preservation",
      );

      await sql`
        INSERT INTO "order_events" (
          "order_id", "reservation_id", "sale_offer_id", "correlation_id",
          "event_name", "source", "occurred_at"
        ) VALUES (
          NULL, ${alternateIds.reservationId}, ${alternateIds.saleOfferId}, 'corr-parent-alternate',
          'reservation.secured', 'test', ${orderQueuedAt}::timestamptz
        )
      `;
      await expectConstraintViolation(
        sql`
          UPDATE "reservations" SET "correlation_id" = 'corr-parent-mutated'
          WHERE "id" = ${alternateIds.reservationId}
        `,
        "reservations_event_attribution_preservation",
      );
    });
  });

  it("accepts orders backed by matching secured reservations", async () => {
    await withDatabase(async (sql) => {
      const ids = buildOrderReservationIds(1);
      const correlationId = "corr-order-reservation-valid";

      await insertCatalogSaleOffer(sql, ids);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId,
        quantity: 2,
      });
      await insertOrder(sql, {
        orderId: ids.orderId,
        saleOfferId: ids.saleOfferId,
        reservationId: ids.reservationId,
        correlationId,
        quantity: 2,
      });
      await sql`
        UPDATE "orders"
        SET "status" = 'confirmed'::"order_status",
            "processing_at" = ${orderQueuedAt}::timestamptz,
            "confirmed_at" = ${orderQueuedAt}::timestamptz
        WHERE "id" = ${ids.orderId}
      `;

      const [orderRow] = await sql<{ status: string }[]>`
        SELECT "status"
        FROM "orders"
        WHERE "id" = ${ids.orderId}
      `;

      expect(orderRow?.status).toBe("confirmed");
    });
  });

  it.each([
    "rejected",
    "released",
    "expired",
  ] as const)("rejects orders backed by %s reservations", async (status) => {
    await withDatabase(async (sql) => {
      const sequenceByStatus = { rejected: 10, released: 11, expired: 12 } as const;
      const ids = buildOrderReservationIds(sequenceByStatus[status]);
      const correlationId = `corr-order-reservation-${status}`;

      await insertCatalogSaleOffer(sql, ids);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId,
        status,
      });

      await expect(
        insertOrder(sql, {
          orderId: ids.orderId,
          saleOfferId: ids.saleOfferId,
          reservationId: ids.reservationId,
          correlationId,
        }),
      ).rejects.toThrow("must match secured reservation");
    });
  });

  it("rejects orders whose offer, correlation ID, or quantity differs from the reservation", async () => {
    await withDatabase(async (sql) => {
      const ids = buildOrderReservationIds(20);
      const correlationId = "corr-order-reservation-mismatch";

      await insertCatalogSaleOffer(sql, ids);
      await insertCatalogSaleOffer(sql, {
        productId: ids.alternateProductId,
        saleOfferId: ids.alternateSaleOfferId,
      });
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId,
        quantity: 2,
      });

      await expect(
        insertOrder(sql, {
          orderId: ids.orderId,
          saleOfferId: ids.alternateSaleOfferId,
          reservationId: ids.reservationId,
          correlationId,
          quantity: 2,
        }),
      ).rejects.toThrow("must match secured reservation");
      await expect(
        insertOrder(sql, {
          orderId: ids.alternateOrderId,
          saleOfferId: ids.saleOfferId,
          reservationId: ids.reservationId,
          correlationId: "corr-order-reservation-other",
          quantity: 2,
        }),
      ).rejects.toThrow("must match secured reservation");
      await expect(
        insertOrder(sql, {
          orderId: ids.thirdOrderId,
          saleOfferId: ids.saleOfferId,
          reservationId: ids.reservationId,
          correlationId,
          quantity: 1,
        }),
      ).rejects.toThrow("must match secured reservation");
    });
  });

  it("rejects orders whose nullable run ID differs from the reservation", async () => {
    await withDatabase(async (sql) => {
      const ids = buildOrderReservationIds(30);
      const correlationId = "corr-order-reservation-run";

      await insertCatalogSaleOffer(sql, {
        productId: ids.productId,
        saleOfferId: ids.saleOfferId,
        purpose: "generated_run",
      });
      await insertGeneratedRunContext(sql, ids);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        runId: ids.runId,
        correlationId,
      });

      await expect(
        insertOrder(sql, {
          orderId: ids.orderId,
          saleOfferId: ids.saleOfferId,
          reservationId: ids.reservationId,
          runId: null,
          correlationId,
        }),
      ).rejects.toThrow("must match secured reservation");
    });
  });

  it("rejects reservation updates that would invalidate an existing order", async () => {
    await withDatabase(async (sql) => {
      const ids = buildOrderReservationIds(40);
      const correlationId = "corr-order-reservation-preserve";

      await insertCatalogSaleOffer(sql, ids);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId,
      });
      await insertOrder(sql, {
        orderId: ids.orderId,
        saleOfferId: ids.saleOfferId,
        reservationId: ids.reservationId,
        correlationId,
      });

      await expect(
        sql`
          UPDATE "reservations"
          SET "status" = 'released'::"reservation_status", "released_at" = "secured_at"
          WHERE "id" = ${ids.reservationId}
        `,
      ).rejects.toThrow("cannot be changed because an order depends");
    });
  });

  it("rejects worker-style order confirmation when the backing reservation is invalid", async () => {
    await withDatabase(async (sql) => {
      const ids = buildOrderReservationIds(50);
      const correlationId = "corr-order-reservation-worker-transition";

      await insertCatalogSaleOffer(sql, ids);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        correlationId,
      });
      await insertOrder(sql, {
        orderId: ids.orderId,
        saleOfferId: ids.saleOfferId,
        reservationId: ids.reservationId,
        correlationId,
        status: "processing",
        processingAt: orderQueuedAt,
      });
      await sql`
        ALTER TABLE "reservations"
        DISABLE TRIGGER "reservations_preserve_order_backing_secured_reservation"
      `;
      try {
        await sql`
          UPDATE "reservations"
          SET "status" = 'released'::"reservation_status", "released_at" = "secured_at"
          WHERE "id" = ${ids.reservationId}
        `;
      } finally {
        await sql`
          ALTER TABLE "reservations"
          ENABLE TRIGGER "reservations_preserve_order_backing_secured_reservation"
        `;
      }

      try {
        await expect(
          sql`
            UPDATE "orders"
            SET "status" = 'confirmed'::"order_status", "confirmed_at" = ${orderQueuedAt}::timestamptz
            WHERE "id" = ${ids.orderId}
          `,
        ).rejects.toThrow("must match secured reservation");
      } finally {
        await sql`
          UPDATE "reservations"
          SET "status" = 'secured'::"reservation_status"
          WHERE "id" = ${ids.reservationId}
        `;
      }
    });
  });

  it("publishes validated dashboard events through the shared Redis Pub/Sub channel", async () => {
    const subscriberRedis = new Redis(requireTestEnv("TEST_REDIS_URL"), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await subscriberRedis.connect();
    let resolveReceived: (event: DashboardEvent) => void = () => undefined;
    let rejectReceived: (error: unknown) => void = () => undefined;
    const receivedEvent = new Promise<DashboardEvent>((resolve, reject) => {
      resolveReceived = resolve;
      rejectReceived = reject;
    });
    const subscriber = createRedisDashboardEventSubscriber(subscriberRedis, {
      onEvent: resolveReceived,
      onInvalidMessage: rejectReceived,
    });

    try {
      await subscriber.start();
      await publishDashboardEvent(redis, dashboardEvent);
      await expect(
        withTimeout(receivedEvent, 1_000, "Timed out waiting for dashboard event."),
      ).resolves.toEqual(dashboardEvent);
    } finally {
      await subscriber.close();
      subscriberRedis.disconnect();
    }
  });

  it("rejects invalid dashboard events before publishing", async () => {
    await expect(
      publishDashboardEvent(redis, {
        ...dashboardEvent,
        eventId: "not-a-uuid",
      } as DashboardEvent),
    ).rejects.toThrow();
  });

  it("reports malformed dashboard Pub/Sub messages without delivering them", async () => {
    const subscriberRedis = new Redis(requireTestEnv("TEST_REDIS_URL"), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await subscriberRedis.connect();
    const delivered: DashboardEvent[] = [];
    let resolveInvalidMessage: (message: { error: unknown; message: string }) => void = () =>
      undefined;
    const invalidMessage = new Promise<{ error: unknown; message: string }>((resolve) => {
      resolveInvalidMessage = resolve;
    });
    const subscriber = createRedisDashboardEventSubscriber(subscriberRedis, {
      onEvent: (event) => {
        delivered.push(event);
      },
      onInvalidMessage: (error, message) => {
        resolveInvalidMessage({ error, message });
      },
    });

    try {
      await subscriber.start();
      await redis.publish(
        dashboardEventsRedisChannel,
        JSON.stringify({ ...dashboardEvent, eventId: "not-a-uuid" }),
      );
      const result = await withTimeout(
        invalidMessage,
        1_000,
        "Timed out waiting for invalid dashboard event.",
      );

      expect(result.error).toBeTruthy();
      expect(result.message).toContain("not-a-uuid");
      expect(delivered).toEqual([]);
    } finally {
      await subscriber.close();
      subscriberRedis.disconnect();
    }
  });

  it("initializes and resets only the targeted inventory namespace", async () => {
    const targetOfferId = "55555555-5555-4555-8555-555555555555";
    const otherOfferId = "66666666-6666-4666-8666-666666666666";
    const targetKeys = inventoryKeys(targetOfferId);
    const otherKeys = inventoryKeys(otherOfferId);
    const staleTargetIdempotencyKeys = Array.from({ length: 250 }, (_, index) =>
      targetKeys.idempotency(`old-key-${index}`),
    );
    const preservedOtherOfferKeys = Array.from({ length: 3 }, (_, index) =>
      otherKeys.idempotency(`keep-key-${index}`),
    );

    await initializeInventory(redis, {
      saleOfferId: targetOfferId,
      allocatedStock: 12,
      source: "integration-test",
      initializedAt: new Date("2026-06-20T10:00:00.000Z"),
    });
    const staleKeySetup = redis.pipeline();
    for (const key of staleTargetIdempotencyKeys) {
      staleKeySetup.set(key, "stale");
    }
    for (const key of preservedOtherOfferKeys) {
      staleKeySetup.set(key, "preserved");
    }
    await staleKeySetup.exec();
    await redis.hset(targetKeys.reservations, "old-reservation", "stale");

    const status = await initializeInventory(redis, {
      saleOfferId: targetOfferId,
      allocatedStock: 8,
      source: "generated-run",
      initializedAt: new Date("2026-06-20T11:00:00.000Z"),
    });

    expect(status).toMatchObject({
      saleOfferId: targetOfferId,
      allocatedStock: 8,
      remainingStock: 8,
      reservedStock: 0,
    });
    expect(await redis.exists(...staleTargetIdempotencyKeys)).toBe(0);
    expect(await redis.exists(targetKeys.reservations)).toBe(0);
    expect(await redis.mget(...preservedOtherOfferKeys)).toEqual([
      "preserved",
      "preserved",
      "preserved",
    ]);
    expect(await redis.llen(targetKeys.events)).toBe(1);
  });

  it("derives pending and expired status fields from Redis source collections", async () => {
    const saleOfferId = "77777777-7777-4777-8777-777777777777";
    const keys = inventoryKeys(saleOfferId);
    const now = new Date("2026-06-20T12:00:00.000Z");

    await initializeInventory(redis, {
      saleOfferId,
      allocatedStock: 20,
      initializedAt: new Date("2026-06-20T11:59:00.000Z"),
    });
    await redis.hset(keys.state, {
      remainingStock: "13",
      reservedStock: "7",
      pendingPersistenceCount: "99",
      expiredReservationCount: "99",
      oldestPendingPersistenceAgeSeconds: "99",
    });
    await redis.zadd(
      keys.pendingPersistence,
      now.getTime() - 4_500,
      "pending-oldest",
      now.getTime() - 1_000,
      "pending-newest",
    );
    await redis.zadd(
      keys.reservationExpirations,
      now.getTime() - 1,
      "expired",
      now.getTime() + 1,
      "active",
    );

    const status = await getInventoryStatus(redis, saleOfferId, now);

    expect(status).toMatchObject({
      allocatedStock: 20,
      remainingStock: 13,
      reservedStock: 7,
      pendingPersistenceCount: 2,
      expiredReservationCount: 1,
      oldestPendingPersistenceAgeSeconds: 4.5,
    });
  });

  it("rejects missing inventory state instead of fabricating zero stock", async () => {
    const missingSaleOfferId = "88888888-8888-4888-8888-888888888888";
    await redis.set(inventoryKeys(missingSaleOfferId).pendingPersistence, "orphaned-state");

    await expect(getInventoryStatus(redis, missingSaleOfferId)).rejects.toEqual(
      new InventoryNotInitializedError(missingSaleOfferId),
    );
  });

  it("atomically secures stock and writes the complete replayable hold", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000001";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 1, quantity: 2 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 5 });

    const result = await reserveInventoryStock(redis, input);

    expect(result).toEqual({ outcome: "reservation_secured", reservation: input.reservation });
    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "3",
      reservedStock: "2",
      lastUpdatedAt: reservationSecuredAt,
    });
    expect(
      JSON.parse((await redis.hget(keys.reservations, input.reservation.id)) ?? "null"),
    ).toEqual(input.reservation);
    expect(await redis.zscore(keys.reservationExpirations, input.reservation.id)).toBe(
      new Date(reservationExpiresAt).getTime().toString(),
    );
    expect(await redis.zscore(keys.pendingPersistence, input.reservation.id)).toBe(
      new Date(reservationSecuredAt).getTime().toString(),
    );
    expect(
      JSON.parse(
        (await redis.hget(keys.pendingPersistenceRecords, input.reservation.id)) ?? "null",
      ),
    ).toMatchObject({
      id: input.reservation.id,
      saleOfferId,
      idempotencyKey: input.idempotencyKey,
      quantity: input.reservation.quantity,
      reservationToken: input.reservation.reservationToken,
    });
    expect(
      await redis.zscore(
        "inventory:pending-persistence-index",
        `${saleOfferId}:${input.reservation.id}`,
      ),
    ).toBe(new Date(reservationSecuredAt).getTime().toString());
    expect(await getInventoryStatus(redis, saleOfferId)).toMatchObject({
      pendingPersistenceCount: 1,
    });
    const idempotencyTtl = await redis.ttl(keys.idempotency(input.idempotencyKey));
    expect(idempotencyTtl).toBeGreaterThan(1790);
    expect(idempotencyTtl).toBeLessThanOrEqual(1800);
    expect(JSON.parse((await redis.get(keys.idempotency(input.idempotencyKey))) ?? "null")).toEqual(
      {
        status: "pending_persistence",
        quantity: input.reservation.quantity,
        reservation: input.reservation,
      },
    );
    expect(await redis.llen(keys.events)).toBe(2);
    expect(JSON.parse((await redis.lindex(keys.events, -1)) ?? "null")).toMatchObject({
      eventName: "inventory.updated",
      remainingStock: 3,
      reservedStock: 2,
      reservationCount: 1,
      reservedQuantity: 2,
      occurredAt: reservationSecuredAt,
    });
  });

  it("recovers the connection-scoped reservation command after SCRIPT FLUSH", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000091";
    await initializeInventory(redis, { saleOfferId, allocatedStock: 2 });

    await expect(
      reserveInventoryStock(redis, buildReservationInput({ saleOfferId, sequence: 91 })),
    ).resolves.toMatchObject({ outcome: "reservation_secured" });
    await redis.script("FLUSH");
    await expect(
      reserveInventoryStock(redis, buildReservationInput({ saleOfferId, sequence: 92 })),
    ).resolves.toMatchObject({ outcome: "reservation_secured" });

    await expect(getInventoryStatus(redis, saleOfferId)).resolves.toMatchObject({
      remainingStock: 0,
      reservedStock: 2,
    });
  });

  it("keeps pre-scope seeded inventory compatible as catalog inventory", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000017";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 17 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 1 });
    await redis.hdel(keys.state, "inventoryScope");

    expect(await reserveInventoryStock(redis, input)).toEqual({
      outcome: "reservation_secured",
      reservation: input.reservation,
    });
    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "0",
      reservedStock: "1",
    });
  });

  it("projects exact rolling successful-reservation throughput and aggregate sold-out pressure", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000009";
    const keys = inventoryKeys(saleOfferId);
    const first = buildReservationInput({ saleOfferId, sequence: 91, quantity: 2 });
    const second = buildReservationInput({ saleOfferId, sequence: 92, quantity: 1 });
    await initializeInventory(redis, {
      saleOfferId,
      allocatedStock: 3,
      initializedAt: new Date("2026-06-20T11:59:00.000Z"),
    });

    await reserveInventoryStock(redis, first);
    await reserveInventoryStock(redis, second);
    await reserveInventoryStock(redis, first);
    await reserveInventoryStock(
      redis,
      buildReservationInput({ saleOfferId, sequence: 93, quantity: 1 }),
    );

    const activeWindow = await getInventoryStatus(
      redis,
      saleOfferId,
      new Date("2026-06-20T12:00:30.000Z"),
    );
    const expiredWindow = await getInventoryStatus(
      redis,
      saleOfferId,
      new Date("2026-06-20T12:01:00.000Z"),
    );

    expect(activeWindow).toMatchObject({
      remainingStock: 0,
      reservedStock: 3,
      reservationThroughput: {
        windowSeconds: 60,
        successfulReservationCount: 2,
        rate: 2 / 60,
        unit: "reservations_per_second",
        measuredAt: "2026-06-20T12:00:30.000Z",
      },
      soldOutPressure: {
        rejectionCount: 1,
        latestObservedAt: reservationSecuredAt,
      },
    });
    expect(expiredWindow.reservationThroughput.successfulReservationCount).toBe(0);
    expect(await redis.hlen(keys.reservationThroughput)).toBe(2);
  });

  it("rejects half-populated reservation-throughput slots as malformed state", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000010";
    const keys = inventoryKeys(saleOfferId);
    await initializeInventory(redis, { saleOfferId, allocatedStock: 3 });

    await redis.hset(keys.reservationThroughput, "0:second", "1781956800");
    await expect(getInventoryStatus(redis, saleOfferId)).rejects.toThrow(
      "Malformed reservation throughput state at slot 0: second and count must both be present.",
    );

    await redis.del(keys.reservationThroughput);
    await redis.hset(keys.reservationThroughput, "0:count", "1");
    await expect(getInventoryStatus(redis, saleOfferId)).rejects.toThrow(
      "Malformed reservation throughput state at slot 0: second and count must both be present.",
    );

    await redis.hset(keys.reservationThroughput, "0:second", "0", "0:count", "not-an-integer");
    await expect(getInventoryStatus(redis, saleOfferId)).rejects.toThrow(
      "Malformed reservation throughput state at slot 0: count must be a nonnegative safe integer.",
    );
  });

  it("rejects contradictory stock counters from inventory status", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000016";
    const keys = inventoryKeys(saleOfferId);
    await initializeInventory(redis, { saleOfferId, allocatedStock: 5 });
    await redis.hset(keys.state, { remainingStock: "3", reservedStock: "1" });

    await expect(getInventoryStatus(redis, saleOfferId)).rejects.toThrow(
      "Inventory stock counters must sum to allocatedStock.",
    );
  });

  it("returns sold out without per-loser records or events", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000002";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 2, quantity: 3 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 2 });

    const result = await reserveInventoryStock(redis, input);

    expect(result).toEqual({ outcome: "sold_out", reservation: null });
    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "2",
      reservedStock: "0",
    });
    expect(await redis.exists(keys.idempotency(input.idempotencyKey))).toBe(0);
    expect(await redis.exists(keys.reservations, keys.reservationExpirations)).toBe(0);
    expect(await redis.llen(keys.events)).toBe(1);
    expect(await redis.hgetall(keys.reservationOutcomes)).toEqual({
      api_sold_out_decision: "1",
      api_sold_out_decision_latest_observed_at: reservationSecuredAt,
    });
  });

  it("returns inventory not initialized without creating side keys", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000003";
    const keys = inventoryKeys(saleOfferId);

    const result = await reserveInventoryStock(
      redis,
      buildReservationInput({ saleOfferId, sequence: 3 }),
    );

    expect(result).toEqual({ outcome: "inventory_not_initialized", reservation: null });
    expect(await redis.keys(`${keys.prefix}:*`)).toEqual([]);
  });

  it("returns pending for a pre-durable retry and replays after accepted promotion", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000004";
    const keys = inventoryKeys(saleOfferId);
    const firstInput = buildReservationInput({
      saleOfferId,
      sequence: 4,
      idempotencyKey: "replay-key",
    });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 1 });
    const firstDecision = await reserveInventoryStock(redis, firstInput);
    expect(firstDecision).toEqual({
      outcome: "reservation_secured",
      reservation: firstInput.reservation,
    });

    const immediateRetry = await reserveInventoryStock(redis, {
      ...buildReservationInput({ saleOfferId, sequence: 40, idempotencyKey: "replay-key" }),
      reservation: {
        ...buildReservationInput({ saleOfferId, sequence: 40 }).reservation,
        quantity: 1,
      },
    });

    expect(immediateRetry).toEqual({
      outcome: "reservation_pending_persistence",
      reservation: firstInput.reservation,
    });
    expect(await redis.hget(keys.state, "reservedStock")).toBe("1");
    expect(await redis.hlen(keys.reservations)).toBe(1);
    expect(await redis.llen(keys.events)).toBe(2);

    const idempotencyKey = keys.idempotency(firstInput.idempotencyKey);
    const ttlBeforePromotion = await redis.ttl(idempotencyKey);
    await markReservationPendingPersistence(redis, firstInput);
    await markReservationPendingPersistence(redis, firstInput);
    expect(await redis.zscore(keys.pendingPersistence, firstInput.reservation.id)).toBe(
      new Date(firstInput.reservation.securedAt).getTime().toString(),
    );
    await promoteReservationIdempotencyToAccepted(redis, firstInput);
    const ttlAfterPromotion = await redis.ttl(idempotencyKey);
    expect(ttlAfterPromotion).toBeGreaterThan(ttlBeforePromotion - 5);
    expect(ttlAfterPromotion).toBeLessThanOrEqual(ttlBeforePromotion);

    const acceptedReplay = await reserveInventoryStock(redis, firstInput);
    expect(acceptedReplay).toEqual({
      outcome: "idempotent_replay",
      reservation: firstInput.reservation,
    });
    expect(await redis.hget(keys.state, "reservedStock")).toBe("1");
    expect(await redis.hlen(keys.reservations)).toBe(1);
    expect(await redis.llen(keys.events)).toBe(2);
    expect(await redis.zcard(keys.pendingPersistence)).toBe(0);
  });

  it("reverses a pending hold atomically and is idempotent on repetition", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000009";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 9, quantity: 2 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 5 });
    await reserveInventoryStock(redis, input);
    await markReservationPendingPersistence(redis, input);

    await expect(
      reverseReservation(redis, {
        idempotencyKey: input.idempotencyKey,
        reservation: input.reservation,
      }),
    ).resolves.toBe("reversed");
    expect(await redis.hget(keys.state, "remainingStock")).toBe("5");
    expect(await redis.hget(keys.state, "reservedStock")).toBe("0");
    expect(await redis.hget(keys.reservations, input.reservation.id)).toBeNull();
    expect(await redis.zscore(keys.pendingPersistence, input.reservation.id)).toBeNull();
    expect(await redis.hget(keys.pendingPersistenceRecords, input.reservation.id)).toBeNull();
    expect(
      await redis.zscore(
        "inventory:pending-persistence-index",
        `${saleOfferId}:${input.reservation.id}`,
      ),
    ).toBeNull();
    expect(await redis.get(keys.idempotency(input.idempotencyKey))).toBeNull();
    await expect(
      reverseReservation(redis, {
        idempotencyKey: input.idempotencyKey,
        reservation: input.reservation,
      }),
    ).resolves.toBe("not_held");
  });

  it("rejects a mismatched reversal without mutation and handles an expired idempotency key", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000010";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 10 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 2 });
    await reserveInventoryStock(redis, input);
    await markReservationPendingPersistence(redis, input);

    await expect(
      reverseReservation(redis, {
        idempotencyKey: "wrong-reversal-key",
        reservation: input.reservation,
      }),
    ).rejects.toThrow("mismatch");
    expect(await redis.hget(keys.state, "reservedStock")).toBe("1");
    expect(await redis.hget(keys.reservations, input.reservation.id)).not.toBeNull();
    expect(await redis.get(keys.idempotency(input.idempotencyKey))).not.toBeNull();

    await redis.pexpire(keys.idempotency(input.idempotencyKey), 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      reverseReservation(redis, {
        idempotencyKey: input.idempotencyKey,
        reservation: input.reservation,
      }),
    ).resolves.toBe("reversed");
    expect(await redis.hget(keys.state, "reservedStock")).toBe("0");
    expect(await redis.hget(keys.pendingPersistenceRecords, input.reservation.id)).toBeNull();
  });

  it("verifies pending and accepted transitions against the original hold", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000008";
    const input = buildReservationInput({
      saleOfferId,
      sequence: 8,
      idempotencyKey: "verified-transition",
    });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 2 });
    await reserveInventoryStock(redis, input);
    const mismatched = {
      ...input,
      reservation: { ...input.reservation, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    };

    await expect(markReservationPendingPersistence(redis, mismatched)).rejects.toThrow("mismatch");
    await expect(promoteReservationIdempotencyToAccepted(redis, mismatched)).rejects.toThrow(
      "mismatch",
    );
    expect(
      JSON.parse(
        (await redis.get(inventoryKeys(saleOfferId).idempotency(input.idempotencyKey))) ?? "null",
      ),
    ).toMatchObject({ status: "pending_persistence", quantity: 1 });
  });

  it("keeps the lifecycle cache synchronized with authoritative generated-run state", async () => {
    const runId = "20000000-0000-4000-8000-000000000001";
    const saleOfferId = "20000000-0000-4000-8000-000000000002";

    await expect(isRunSaleEligible(redis, { runId, saleOfferId })).resolves.toBe(false);
    await initializeInventory(redis, {
      saleOfferId,
      allocatedStock: 5,
      run: { runId, status: "closed" },
    });
    await expect(isRunSaleEligible(redis, { runId, saleOfferId })).resolves.toBe(false);
    await setRunSaleEligibility(redis, { runId, saleOfferId, status: "accepting" });
    await expect(isRunSaleEligible(redis, { runId, saleOfferId })).resolves.toBe(true);
    await expect(
      isRunSaleEligible(redis, {
        runId,
        saleOfferId: "20000000-0000-4000-8000-000000000003",
      }),
    ).resolves.toBe(false);
    await setRunSaleEligibility(redis, { runId, saleOfferId, status: "closed" });
    await expect(isRunSaleEligible(redis, { runId, saleOfferId })).resolves.toBe(false);
    expect(await redis.hget(inventoryKeys(saleOfferId).state, "runSaleStatus")).toBe("closed");
  });

  it("rejects omitted and mismatched run IDs and catalog requests with a run ID", async () => {
    const runId = "20000000-0000-4000-8000-000000000011";
    const generatedOfferId = "20000000-0000-4000-8000-000000000012";
    const catalogOfferId = "20000000-0000-4000-8000-000000000013";
    const mismatchedRunId = "20000000-0000-4000-8000-000000000014";
    await initializeInventory(redis, {
      saleOfferId: generatedOfferId,
      allocatedStock: 3,
      run: { runId, status: "accepting" },
    });
    await initializeInventory(redis, { saleOfferId: catalogOfferId, allocatedStock: 3 });

    const omitted = await reserveInventoryStock(
      redis,
      buildReservationInput({ saleOfferId: generatedOfferId, sequence: 21 }),
    );
    const mismatched = await reserveInventoryStock(
      redis,
      buildReservationInput({
        saleOfferId: generatedOfferId,
        sequence: 22,
        runId: mismatchedRunId,
      }),
    );
    const catalogWithRun = await reserveInventoryStock(
      redis,
      buildReservationInput({ saleOfferId: catalogOfferId, sequence: 23, runId }),
    );

    expect(omitted).toEqual({ outcome: "run_not_accepting_traffic", reservation: null });
    expect(mismatched).toEqual({ outcome: "run_not_accepting_traffic", reservation: null });
    expect(catalogWithRun).toEqual({ outcome: "run_not_accepting_traffic", reservation: null });
    expect(await getInventoryStatus(redis, generatedOfferId)).toMatchObject({
      remainingStock: 3,
      reservedStock: 0,
      pendingPersistenceCount: 0,
    });
    expect(await getInventoryStatus(redis, catalogOfferId)).toMatchObject({
      remainingStock: 3,
      reservedStock: 0,
      pendingPersistenceCount: 0,
    });
  });

  it("serializes closure with reservation and checks eligibility before replay", async () => {
    const runId = "20000000-0000-4000-8000-000000000021";
    const saleOfferId = "20000000-0000-4000-8000-000000000022";
    const keys = inventoryKeys(saleOfferId);
    const beforeClose = buildReservationInput({
      saleOfferId,
      sequence: 24,
      idempotencyKey: "ordered-before-close",
      runId,
    });
    const afterClose = buildReservationInput({
      saleOfferId,
      sequence: 25,
      idempotencyKey: "ordered-after-close",
      runId,
    });
    await initializeInventory(redis, {
      saleOfferId,
      allocatedStock: 2,
      run: { runId, status: "accepting" },
    });

    expect(await reserveInventoryStock(redis, beforeClose)).toMatchObject({
      outcome: "reservation_secured",
    });
    await setRunSaleEligibility(redis, { runId, saleOfferId, status: "closed" });
    expect(await reserveInventoryStock(redis, afterClose)).toEqual({
      outcome: "run_not_accepting_traffic",
      reservation: null,
    });
    expect(await reserveInventoryStock(redis, beforeClose)).toEqual({
      outcome: "run_not_accepting_traffic",
      reservation: null,
    });
    expect(await redis.hgetall(keys.state)).toMatchObject({
      runSaleStatus: "closed",
      remainingStock: "1",
      reservedStock: "1",
    });
    expect(await redis.hlen(keys.reservations)).toBe(1);
    expect(await redis.zcard(keys.pendingPersistence)).toBe(1);
    expect(await redis.exists(keys.idempotency(afterClose.idempotencyKey))).toBe(0);
    expect(await redis.llen(keys.events)).toBe(2);
  });

  it("rejects an idempotency quantity conflict without changing stock", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000005";
    const keys = inventoryKeys(saleOfferId);
    await initializeInventory(redis, { saleOfferId, allocatedStock: 5 });
    await reserveInventoryStock(
      redis,
      buildReservationInput({ saleOfferId, sequence: 5, idempotencyKey: "conflict-key" }),
    );

    const conflict = await reserveInventoryStock(
      redis,
      buildReservationInput({
        saleOfferId,
        sequence: 50,
        quantity: 2,
        idempotencyKey: "conflict-key",
      }),
    );

    expect(conflict).toEqual({ outcome: "idempotency_conflict", reservation: null });
    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "4",
      reservedStock: "1",
    });
    expect(await redis.hlen(keys.reservations)).toBe(1);
    expect(await redis.llen(keys.events)).toBe(2);
  });

  it("treats a retry after idempotency expiry as a new reservation attempt", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000011";
    const keys = inventoryKeys(saleOfferId);
    const first = buildReservationInput({
      saleOfferId,
      sequence: 11,
      idempotencyKey: "late-retry-key",
    });
    const lateRetry = buildReservationInput({
      saleOfferId,
      sequence: 111,
      idempotencyKey: "late-retry-key",
    });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 2 });

    await reserveInventoryStock(redis, first);
    await redis.del(keys.idempotency(first.idempotencyKey));
    const retryDecision = await reserveInventoryStock(redis, lateRetry);

    expect(retryDecision).toEqual({
      outcome: "reservation_secured",
      reservation: lateRetry.reservation,
    });
    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "0",
      reservedStock: "2",
    });
    expect(await redis.hlen(keys.reservations)).toBe(2);
    expect(await redis.zcard(keys.pendingPersistence)).toBe(2);
    expect(await redis.llen(keys.events)).toBe(3);
  });

  it("keeps stale accepted and pending holds reserved with inclusive expiry visibility", async () => {
    const acceptedOfferId = "10000000-0000-4000-8000-000000000012";
    const pendingOfferId = "10000000-0000-4000-8000-000000000013";
    const accepted = buildReservationInput({ saleOfferId: acceptedOfferId, sequence: 12 });
    const pending = buildReservationInput({ saleOfferId: pendingOfferId, sequence: 13 });
    const immediatelyBeforeExpiry = new Date(new Date(reservationExpiresAt).getTime() - 1);
    const atExpiry = new Date(reservationExpiresAt);
    await initializeInventory(redis, { saleOfferId: acceptedOfferId, allocatedStock: 1 });
    await initializeInventory(redis, { saleOfferId: pendingOfferId, allocatedStock: 1 });
    await reserveInventoryStock(redis, accepted);
    await promoteReservationIdempotencyToAccepted(redis, accepted);
    await reserveInventoryStock(redis, pending);

    expect(
      (await getInventoryStatus(redis, acceptedOfferId, immediatelyBeforeExpiry))
        .expiredReservationCount,
    ).toBe(0);
    expect(await getInventoryStatus(redis, acceptedOfferId, atExpiry)).toMatchObject({
      remainingStock: 0,
      reservedStock: 1,
      expiredReservationCount: 1,
      pendingPersistenceCount: 0,
    });
    expect(await getInventoryStatus(redis, pendingOfferId, atExpiry)).toMatchObject({
      remainingStock: 0,
      reservedStock: 1,
      expiredReservationCount: 1,
      pendingPersistenceCount: 1,
      oldestPendingPersistenceAgeSeconds: 900,
    });
    expect(await reserveInventoryStock(redis, accepted)).toMatchObject({
      outcome: "idempotent_replay",
      reservation: accepted.reservation,
    });
    expect(await reserveInventoryStock(redis, pending)).toMatchObject({
      outcome: "reservation_pending_persistence",
      reservation: pending.reservation,
    });
  });

  it("rejects malformed counters and collection types before mutating stock", async () => {
    const malformedCounterOfferId = "10000000-0000-4000-8000-000000000014";
    const malformedCollectionOfferId = "10000000-0000-4000-8000-000000000015";
    const counterKeys = inventoryKeys(malformedCounterOfferId);
    const collectionKeys = inventoryKeys(malformedCollectionOfferId);
    const counterInput = buildReservationInput({
      saleOfferId: malformedCounterOfferId,
      sequence: 14,
    });
    const collectionInput = buildReservationInput({
      saleOfferId: malformedCollectionOfferId,
      sequence: 15,
    });
    await initializeInventory(redis, { saleOfferId: malformedCounterOfferId, allocatedStock: 2 });
    await initializeInventory(redis, {
      saleOfferId: malformedCollectionOfferId,
      allocatedStock: 2,
    });
    await redis.hset(counterKeys.state, "reservedStock", "malformed");
    await redis.del(collectionKeys.events);
    await redis.set(collectionKeys.events, "not-a-list");

    await expect(reserveInventoryStock(redis, counterInput)).rejects.toThrow(
      "Inventory reservedStock must be a nonnegative safe integer",
    );
    await expect(reserveInventoryStock(redis, collectionInput)).rejects.toThrow(
      "Inventory events key must be a list",
    );
    expect(await redis.hget(counterKeys.state, "remainingStock")).toBe("2");
    expect(await redis.hget(collectionKeys.state, "remainingStock")).toBe("2");
    expect(await redis.hlen(counterKeys.reservations)).toBe(0);
    expect(await redis.hlen(collectionKeys.reservations)).toBe(0);
    expect(await redis.exists(counterKeys.idempotency(counterInput.idempotencyKey))).toBe(0);
    expect(await redis.exists(collectionKeys.idempotency(collectionInput.idempotencyKey))).toBe(0);
  });

  it("rejects invalid quantities before Redis without mutating inventory", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000006";
    const keys = inventoryKeys(saleOfferId);
    await initializeInventory(redis, { saleOfferId, allocatedStock: 5 });

    for (const [index, quantity] of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].entries()) {
      const input = buildReservationInput({ saleOfferId, sequence: 60 + index });
      const result = await reserveInventoryStock(redis, {
        ...input,
        reservation: { ...input.reservation, quantity },
      });
      expect(result).toEqual({ outcome: "quantity_invalid", reservation: null });
    }

    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "5",
      reservedStock: "0",
    });
    expect(await redis.exists(keys.reservations, keys.reservationExpirations)).toBe(0);
    expect(await redis.llen(keys.events)).toBe(1);
    expect(await redis.hget(keys.reservationOutcomes, "api_sold_out_decision")).toBe("0");
  });

  it("does not oversell under concurrent reservations and bounds event history", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000007";
    const keys = inventoryKeys(saleOfferId);
    const clients = Array.from(
      { length: 8 },
      () => new Redis(requireTestEnv("TEST_REDIS_URL"), { maxRetriesPerRequest: 3 }),
    );
    await initializeInventory(redis, { saleOfferId, allocatedStock: 100 });

    try {
      const decisions = await Promise.all(
        Array.from({ length: 250 }, (_, index) =>
          reserveInventoryStock(
            clients[index % clients.length] ?? redis,
            buildReservationInput({ saleOfferId, sequence: 1000 + index }),
          ),
        ),
      );
      const securedCount = decisions.filter(
        (decision) => decision.outcome === "reservation_secured",
      ).length;
      const soldOutCount = decisions.filter((decision) => decision.outcome === "sold_out").length;

      expect({ securedCount, soldOutCount }).toEqual({ securedCount: 100, soldOutCount: 150 });
      expect(await redis.hgetall(keys.state)).toMatchObject({
        remainingStock: "0",
        reservedStock: "100",
      });
      expect(await redis.hlen(keys.reservations)).toBe(100);
      expect(await redis.zcard(keys.reservationExpirations)).toBe(100);
      expect(await redis.hget(keys.reservationOutcomes, "api_sold_out_decision")).toBe("150");
      expect(await redis.llen(keys.events)).toBe(100);
      expect(await redis.hlen(keys.reservationThroughput)).toBeLessThanOrEqual(120);
      expect(
        (await getInventoryStatus(redis, saleOfferId, new Date("2026-06-20T12:00:30.000Z")))
          .reservationThroughput.successfulReservationCount,
      ).toBe(100);
    } finally {
      for (const client of clients) {
        client.disconnect();
      }
    }
  });

  it("resets only business tables in the isolated test database", async () => {
    await resetTestDatabase({ migrationsFolder });

    const [counts] = await withDatabase(
      (sql) =>
        sql<{ products: number; demo_presets: number }[]>`
        SELECT
          (SELECT count(*)::int FROM products) AS products,
          (SELECT count(*)::int FROM demo_presets) AS demo_presets
      `,
    );

    expect(counts).toEqual({ products: 0, demo_presets: 0 });
  });
});
