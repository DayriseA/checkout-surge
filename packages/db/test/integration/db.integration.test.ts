import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  backpressureConfigSchema,
  type DashboardProjectionDirtySignal,
  publicRuntimePolicyPersistedSchema,
} from "@checkout-surge/contracts";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabaseConnection,
  createRedisDashboardProjectionDirtySubscriber,
  dashboardProjectionDirtyRedisChannel,
  deferPendingPersistenceRecord,
  getInventoryStatus,
  InventoryNotInitializedError,
  initializeInventory,
  inventoryKeys,
  isRunSaleEligible,
  markReservationPendingPersistence,
  promoteReservationIdempotencyToAccepted,
  publishDashboardProjectionDirtySignal,
  readPendingPersistencePage,
  readPendingPersistenceRecord,
  reserveInventoryStock,
  reverseReservation,
  runSaleEligibilityKey,
  runSaleEligibilityTtlSeconds,
  setRunSaleEligibility,
} from "../../src/index.js";
import { runDatabaseMigrations } from "../../src/migrations.js";
import { validateDedicatedTestDatabaseUrl } from "../../src/test-environment-safety.js";
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
const expectedDeclarativeAttributionConstraints = [
  "demo_run_sale_contexts_run_sale_offer_demo_runs_fk",
  "erp_attempts_order_correlation_fk",
  "order_events_run_sale_context_fk",
  "orders_backing_reservation_fk",
  "orders_run_sale_context_fk",
  "reservation_pending_persistence_run_sale_context_fk",
  "reservations_run_sale_context_fk",
  "simulated_notifications_order_attribution_fk",
  "simulated_notifications_run_sale_context_fk",
].sort();
const dashboardDirtySignal: DashboardProjectionDirtySignal = {
  type: "dashboard.projection.dirty",
  correlationId: "corr-dashboard-dirty",
};

type TestSql = ReturnType<typeof createDatabaseConnection>["sql"];
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

async function rebuildAsEmptyPublicSchema(): Promise<void> {
  await withDatabase(async (sql) => {
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await sql.unsafe("CREATE SCHEMA public");
  });
}

async function readMigrationCount(folder: string): Promise<number> {
  const journal = JSON.parse(
    await readFile(path.join(folder, "meta", "_journal.json"), "utf8"),
  ) as { entries: unknown[] };

  return journal.entries.length;
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
  },
): Promise<void> {
  await sql`
    INSERT INTO "reservations" (
      "id",
      "sale_offer_id",
      "correlation_id",
      "run_id",
      "quantity",
      "reservation_token",
      "secured_at",
      "expires_at"
    )
    VALUES (
      ${input.reservationId},
      ${input.saleOfferId},
      ${input.correlationId},
      ${input.runId ?? null},
      ${input.quantity ?? 1},
      ${`token-${input.reservationId}`},
      ${reservationSecuredAt}::timestamptz,
      ${reservationExpiresAt}::timestamptz
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
  await execFileAsync(process.execPath, ["--import", "tsx", "src/scripts/seed.ts"], {
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

async function expectConstraintViolation(
  promise: Promise<unknown>,
  constraintName: string,
  code = "23514",
) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code, constraint_name: constraintName });
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

  it("applies the schema with only declarative attribution guards", async () => {
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
        WHERE NOT tgisinternal
      `,
    );
    const functionRows = await withDatabase(
      (sql) =>
        sql<{ proname: string }[]>`
        SELECT proname
        FROM pg_proc
        INNER JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
        WHERE pg_namespace.nspname = 'public'
          AND prokind = 'f'
          AND pg_get_function_result(pg_proc.oid) = 'trigger'
      `,
    );
    const ownershipConstraintRows = await withDatabase(
      (sql) =>
        sql<{ conname: string }[]>`
        SELECT conname
        FROM pg_constraint
        WHERE conname = ANY(${expectedDeclarativeAttributionConstraints}::text[])
        ORDER BY conname
      `,
    );

    expect(tableRows.map((row) => row.table_name).sort()).toEqual([
      "demo_runs",
      "orders",
      "products",
      "reservations",
      "sale_offers",
    ]);
    expect(triggerRows).toEqual([]);
    expect(functionRows).toEqual([]);
    expect(ownershipConstraintRows.map((row) => row.conname)).toEqual(
      expectedDeclarativeAttributionConstraints,
    );
  });

  it("applies the baseline to an empty dedicated test database and reruns as a no-op", async () => {
    const databaseUrl = requireTestEnv("TEST_DATABASE_URL");
    const { databaseName } = validateDedicatedTestDatabaseUrl(databaseUrl);
    const expectedMigrationCount = await readMigrationCount(migrationsFolder);

    try {
      await rebuildAsEmptyPublicSchema();
      await runDatabaseMigrations({ databaseUrl, expectedDatabaseName: databaseName });
      const [firstCount] = await withDatabase(
        (sql) =>
          sql<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
      );
      await runDatabaseMigrations({ databaseUrl, expectedDatabaseName: databaseName });
      const [secondCount] = await withDatabase(
        (sql) =>
          sql<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
      );

      expect(firstCount?.count).toBe(expectedMigrationCount);
      expect(secondCount).toEqual(firstCount);
    } finally {
      await resetTestDatabase();
    }
  });

  it("preserves valid current policy data and rejects invalid current policy data", async () => {
    const databaseUrl = requireTestEnv("TEST_DATABASE_URL");
    const { databaseName } = validateDedicatedTestDatabaseUrl(databaseUrl);

    try {
      await runSeedScript();
      await withDatabase(
        (sql) => sql`
          UPDATE public_runtime_policies
          SET policy = jsonb_set(policy, '{publicRunBudget,windowSeconds}', '777'::jsonb)
          WHERE id = 'active'
        `,
      );
      const [customized] = await withDatabase(
        (sql) => sql<{ policy: unknown; updated_at: string }[]>`
          SELECT policy, updated_at::text
          FROM public_runtime_policies
          WHERE id = 'active'
        `,
      );

      await runDatabaseMigrations({ databaseUrl, expectedDatabaseName: databaseName });
      const [afterMigration] = await withDatabase(
        (sql) => sql<{ policy: unknown; updated_at: string }[]>`
          SELECT policy, updated_at::text
          FROM public_runtime_policies
          WHERE id = 'active'
        `,
      );
      expect(afterMigration).toEqual(customized);

      await withDatabase(
        (sql) => sql`
          UPDATE public_runtime_policies
          SET policy = jsonb_set(
            policy,
            '{publicCustomLimits,maxPreAllocatedVus}',
            '1001'::jsonb
          )
          WHERE id = 'active'
        `,
      );
      await expect(
        runDatabaseMigrations({ databaseUrl, expectedDatabaseName: databaseName }),
      ).rejects.toThrow(/publicCustomLimits\.maxPreAllocatedVus \(public_vus_limit_invalid\)/);

      await withDatabase(
        (sql) => sql`
          UPDATE public_runtime_policies
          SET policy = jsonb_set(
            policy,
            '{publicCustomLimits,maxPreAllocatedVus}',
            '1000'::jsonb
          ) || '{"deploymentHardCaps":{"maxBuyers":100000}}'::jsonb
          WHERE id = 'active'
        `,
      );
      await expect(
        runDatabaseMigrations({ databaseUrl, expectedDatabaseName: databaseName }),
      ).rejects.toThrow(/Unrecognized key.*deploymentHardCaps/i);
    } finally {
      await resetTestDatabase();
    }
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
    const [duplicatePreset] = await withDatabase(
      (sql) =>
        sql<
          {
            slug: string;
            visibility: string;
            display: { name: string; description: string };
          }[]
        >`
        SELECT slug, visibility, display
        FROM demo_presets
        WHERE slug = 'idempotency-check-200'
      `,
    );
    const inventoryState = await redis.hgetall(`inventory:${seededSaleOfferId}:state`);

    expect(counts).toEqual({
      products: 1,
      sale_offers: 1,
      demo_presets: 8,
      public_runtime_policies: 1,
    });
    expect(
      publicRuntimePolicyPersistedSchema.parse(policyRow?.policy).publicRunBudget.windowSeconds,
    ).toBe(999);
    expect(policyRow?.policy).not.toHaveProperty("deploymentHardCaps");
    expect(policyRow?.created_at).toEqual(initialPolicyRow?.created_at);
    expect(new Date(policyRow?.updated_at ?? 0).getTime()).toBeGreaterThan(
      new Date(initialPolicyRow?.updated_at ?? 0).getTime(),
    );
    expect(duplicatePreset).toMatchObject({
      slug: "idempotency-check-200",
      visibility: "public",
      display: {
        name: "Duplicate-click storm",
        description: "200 buyers, every buyer clicks Buy twice.",
      },
    });
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
    // `custom` scratch preset so its preserved operator edit does not affect
    // other seeded preset assertions.
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
    // Uses a value within the backpressure schema max so later seeded preset
    // schema validation still passes.
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

    const erpLatencySemanticFailure = await runSeedScript({
      PUBLIC_CUSTOM_MAX_ERP_LATENCY_MS: "50",
    }).catch((error: unknown) => error);
    expect(erpLatencySemanticFailure).toMatchObject({
      stderr: expect.stringContaining("public_erp_latency_exceeded"),
    });
    expect((await readPolicy())[0]).toEqual(before);
  });

  it("maps every runtime-setup public policy bootstrap override", async () => {
    await withDatabase((sql) => sql`DELETE FROM public_runtime_policies WHERE id = 'active'`);
    await runSeedScript({
      PUBLIC_RUN_BUDGET_WINDOW_SECONDS: "301",
      PUBLIC_RUN_BUDGET_PER_VISITOR_MAX_STARTS: "3",
      PUBLIC_RUN_BUDGET_GLOBAL_MAX_STARTS: "7",
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
    const policy = publicRuntimePolicyPersistedSchema.parse(row?.policy);

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
    expect(policy).not.toHaveProperty("deploymentHardCaps");
  });

  it("seeds presets without retired engine knobs", async () => {
    await runSeedScript();
    const seededPresets = await withDatabase(
      (sql) => sql<
        {
          slug: string;
          erp_config: Record<string, unknown>;
          backpressure_config: Record<string, unknown>;
        }[]
      >`
        SELECT slug, erp_config, backpressure_config
        FROM demo_presets
        ORDER BY slug
      `,
    );
    expect(seededPresets.length).toBeGreaterThan(0);
    for (const preset of seededPresets) {
      expect(Object.keys(preset.backpressure_config)).toEqual(
        expect.arrayContaining(["orderProcessConcurrency", "pendingPersistenceRetryAfterSeconds"]),
      );
      expect(preset.backpressure_config).not.toHaveProperty("retryPolicy");
      expect(preset.backpressure_config).not.toHaveProperty("drainTimeoutSeconds");
      expect(preset.backpressure_config).not.toHaveProperty("circuitBreakerFailureThreshold");
      expect(preset.backpressure_config).not.toHaveProperty("circuitBreakerResetTimeoutMs");
      expect(preset.erp_config).not.toHaveProperty("requestTimeoutMs");
      expect(() => backpressureConfigSchema.parse(preset.backpressure_config)).not.toThrow();
    }

    // Reseeding keeps the retired-field-free shape and does not re-add retired knobs.
    await runSeedScript();
    expect(
      await withDatabase(
        (sql) => sql<
          {
            slug: string;
            erp_config: Record<string, unknown>;
            backpressure_config: Record<string, unknown>;
          }[]
        >`
          SELECT slug, erp_config, backpressure_config
          FROM demo_presets
          ORDER BY slug
        `,
      ),
    ).toEqual(seededPresets);
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

  it("enforces ERP attempt correlation attribution declaratively", async () => {
    await withDatabase(async (sql) => {
      const generatedIds = buildOrderReservationIds(922);
      const catalogIds = buildOrderReservationIds(924);
      await insertCatalogSaleOffer(sql, { ...generatedIds, purpose: "generated_run" });
      await insertCatalogSaleOffer(sql, catalogIds);
      await insertGeneratedRunContext(sql, generatedIds);
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
        insertAttempt("erp-attribution-correlation", generatedIds.runId, "corr-other"),
        "erp_attempts_order_correlation_fk",
        "23503",
      );
      await expectConstraintViolation(
        sql`
          UPDATE "erp_attempts" SET "correlation_id" = 'corr-other'
          WHERE "delivery_id" = 'erp-attribution-valid'
        `,
        "erp_attempts_order_correlation_fk",
        "23503",
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

  it("accepts orders backed by matching reservations", async () => {
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

      await expectConstraintViolation(
        insertOrder(sql, {
          orderId: ids.orderId,
          saleOfferId: ids.alternateSaleOfferId,
          reservationId: ids.reservationId,
          correlationId,
          quantity: 2,
        }),
        "orders_backing_reservation_fk",
        "23503",
      );
      await expectConstraintViolation(
        insertOrder(sql, {
          orderId: ids.alternateOrderId,
          saleOfferId: ids.saleOfferId,
          reservationId: ids.reservationId,
          correlationId: "corr-order-reservation-other",
          quantity: 2,
        }),
        "orders_backing_reservation_fk",
        "23503",
      );
      await expectConstraintViolation(
        insertOrder(sql, {
          orderId: ids.thirdOrderId,
          saleOfferId: ids.saleOfferId,
          reservationId: ids.reservationId,
          correlationId,
          quantity: 1,
        }),
        "orders_backing_reservation_fk",
        "23503",
      );
    });
  });

  it("rejects orders attributed to a different run sale context", async () => {
    await withDatabase(async (sql) => {
      const ids = buildOrderReservationIds(30);
      const alternateIds = buildOrderReservationIds(31);
      const correlationId = "corr-order-reservation-run";

      await insertCatalogSaleOffer(sql, {
        productId: ids.productId,
        saleOfferId: ids.saleOfferId,
        purpose: "generated_run",
      });
      await insertGeneratedRunContext(sql, ids);
      await insertCatalogSaleOffer(sql, {
        productId: alternateIds.productId,
        saleOfferId: alternateIds.saleOfferId,
        purpose: "generated_run",
      });
      await insertGeneratedRunContext(sql, alternateIds);
      await insertReservation(sql, {
        reservationId: ids.reservationId,
        saleOfferId: ids.saleOfferId,
        runId: ids.runId,
        correlationId,
      });

      await expectConstraintViolation(
        insertOrder(sql, {
          orderId: ids.orderId,
          saleOfferId: ids.saleOfferId,
          reservationId: ids.reservationId,
          runId: alternateIds.runId,
          correlationId,
        }),
        "orders_run_sale_context_fk",
        "23503",
      );
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

      await expectConstraintViolation(
        sql`
          UPDATE "reservations"
          SET "quantity" = 2
          WHERE "id" = ${ids.reservationId}
        `,
        "orders_backing_reservation_fk",
        "23503",
      );
    });
  });

  it("publishes validated projection dirty signals through the shared Redis Pub/Sub channel", async () => {
    const subscriberRedis = new Redis(requireTestEnv("TEST_REDIS_URL"), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await subscriberRedis.connect();
    let resolveReceived: (signal: DashboardProjectionDirtySignal) => void = () => undefined;
    let rejectReceived: (error: unknown) => void = () => undefined;
    const receivedSignal = new Promise<DashboardProjectionDirtySignal>((resolve, reject) => {
      resolveReceived = resolve;
      rejectReceived = reject;
    });
    const subscriber = createRedisDashboardProjectionDirtySubscriber(subscriberRedis, {
      onDirty: resolveReceived,
      onInvalidMessage: rejectReceived,
    });

    try {
      await subscriber.start();
      await publishDashboardProjectionDirtySignal(redis, dashboardDirtySignal);
      await expect(
        withTimeout(receivedSignal, 1_000, "Timed out waiting for dashboard dirty signal."),
      ).resolves.toEqual(dashboardDirtySignal);
    } finally {
      await subscriber.close();
      subscriberRedis.disconnect();
    }
  });

  it("rejects invalid projection dirty signals before publishing", async () => {
    await expect(
      publishDashboardProjectionDirtySignal(redis, {
        ...dashboardDirtySignal,
        scope: { runId: "not-a-uuid", saleOfferId: seededSaleOfferId },
      }),
    ).rejects.toThrow();
  });

  it("reports malformed dashboard Pub/Sub messages without delivering them", async () => {
    const subscriberRedis = new Redis(requireTestEnv("TEST_REDIS_URL"), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await subscriberRedis.connect();
    const delivered: DashboardProjectionDirtySignal[] = [];
    let resolveInvalidMessage: (message: { error: unknown; message: string }) => void = () =>
      undefined;
    const invalidMessage = new Promise<{ error: unknown; message: string }>((resolve) => {
      resolveInvalidMessage = resolve;
    });
    const subscriber = createRedisDashboardProjectionDirtySubscriber(subscriberRedis, {
      onDirty: (signal) => {
        delivered.push(signal);
      },
      onInvalidMessage: (error, message) => {
        resolveInvalidMessage({ error, message });
      },
    });

    try {
      await subscriber.start();
      await redis.publish(
        dashboardProjectionDirtyRedisChannel,
        JSON.stringify({
          ...dashboardDirtySignal,
          scope: { runId: "not-a-uuid", saleOfferId: seededSaleOfferId },
        }),
      );
      const result = await withTimeout(
        invalidMessage,
        1_000,
        "Timed out waiting for invalid dashboard dirty signal.",
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
      observedAt: now.toISOString(),
      lastUpdatedAt: "2026-06-20T11:59:00.000Z",
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

  it("rejects inventory state without the current scope field", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000017";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 17 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 1 });
    await redis.hdel(keys.state, "inventoryScope");

    await expect(reserveInventoryStock(redis, input)).rejects.toThrow(
      "Inventory scope must be catalog or generated_run",
    );
    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "1",
      reservedStock: "0",
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
        peakRatePerSecond: 2,
        peakWindowSeconds: 1,
        unit: "reservations_per_second",
        measuredAt: "2026-06-20T12:00:30.000Z",
      },
      soldOutPressure: {
        rejectionCount: 1,
        latestObservedAt: reservationSecuredAt,
      },
    });
    expect(expiredWindow.reservationThroughput.successfulReservationCount).toBe(0);
    expect(expiredWindow.reservationThroughput.peakRatePerSecond).toBe(0);
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
    expect(await redis.hgetall(keys.soldOut)).toEqual({
      count: "1",
      latest_observed_at: reservationSecuredAt,
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
    await markReservationPendingPersistence(redis, firstInput);
    await markReservationPendingPersistence(redis, firstInput);
    expect(await redis.zscore(keys.pendingPersistence, firstInput.reservation.id)).toBe(
      new Date(firstInput.reservation.securedAt).getTime().toString(),
    );
    await redis.expire(idempotencyKey, 15);
    await expect(
      promoteReservationIdempotencyToAccepted(redis, {
        ...firstInput,
        idempotencyTtlSeconds: 120,
      }),
    ).resolves.toBe("promoted");
    const ttlAfterPromotion = await redis.ttl(idempotencyKey);
    expect(ttlAfterPromotion).toBeGreaterThanOrEqual(119);
    expect(ttlAfterPromotion).toBeLessThanOrEqual(120);

    await redis.expire(idempotencyKey, 10);
    await expect(
      promoteReservationIdempotencyToAccepted(redis, {
        ...firstInput,
        idempotencyTtlSeconds: 120,
      }),
    ).resolves.toBe("already_accepted");
    const ttlAfterRepeatedPromotion = await redis.ttl(idempotencyKey);
    expect(ttlAfterRepeatedPromotion).toBeGreaterThanOrEqual(119);
    expect(ttlAfterRepeatedPromotion).toBeLessThanOrEqual(120);

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

  it("recreates an accepted replay after idempotency expiry without changing inventory", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000017";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({
      saleOfferId,
      sequence: 17,
      idempotencyKey: "expired-before-promotion",
    });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 2 });
    await reserveInventoryStock(redis, input);
    await markReservationPendingPersistence(redis, input);
    const stateBefore = await redis.hgetall(keys.state);
    const reservationCountBefore = await redis.hlen(keys.reservations);
    const eventCountBefore = await redis.llen(keys.events);
    await redis.del(keys.idempotency(input.idempotencyKey));

    await expect(
      promoteReservationIdempotencyToAccepted(redis, {
        ...input,
        idempotencyTtlSeconds: 240,
      }),
    ).resolves.toBe("promoted");

    const acceptedRecord = JSON.parse(
      (await redis.get(keys.idempotency(input.idempotencyKey))) ?? "null",
    );
    expect(acceptedRecord).toEqual({
      status: "accepted",
      quantity: input.reservation.quantity,
      reservation: input.reservation,
    });
    expect(await redis.ttl(keys.idempotency(input.idempotencyKey))).toBeGreaterThanOrEqual(239);
    expect(await redis.zscore(keys.pendingPersistence, input.reservation.id)).toBeNull();
    expect(await redis.hget(keys.pendingPersistenceRecords, input.reservation.id)).toBeNull();
    await expect(reserveInventoryStock(redis, input)).resolves.toEqual({
      outcome: "idempotent_replay",
      reservation: input.reservation,
    });
    expect(await redis.hgetall(keys.state)).toEqual(stateBefore);
    expect(await redis.hlen(keys.reservations)).toBe(reservationCountBefore);
    expect(await redis.llen(keys.events)).toBe(eventCountBefore);
  });

  it("repairs matching persistent idempotency records and preserves persistent mismatches", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000020";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({
      saleOfferId,
      sequence: 20,
      idempotencyKey: "persistent-before-promotion",
    });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 1 });
    await reserveInventoryStock(redis, input);
    const idempotencyKey = keys.idempotency(input.idempotencyKey);
    await redis.persist(idempotencyKey);
    expect(await redis.ttl(idempotencyKey)).toBe(-1);

    await expect(
      promoteReservationIdempotencyToAccepted(redis, {
        ...input,
        idempotencyTtlSeconds: 90,
      }),
    ).resolves.toBe("promoted");
    expect(await redis.ttl(idempotencyKey)).toBeGreaterThanOrEqual(89);

    await redis.persist(idempotencyKey);
    const acceptedJson = await redis.get(idempotencyKey);
    const mismatched = {
      ...input,
      reservation: {
        ...input.reservation,
        reservationToken: "conflicting-persistent-token",
      },
      idempotencyTtlSeconds: 180,
    };
    await expect(promoteReservationIdempotencyToAccepted(redis, mismatched)).rejects.toThrow(
      "mismatch",
    );
    expect(await redis.get(idempotencyKey)).toBe(acceptedJson);
    expect(await redis.ttl(idempotencyKey)).toBe(-1);

    await expect(
      promoteReservationIdempotencyToAccepted(redis, {
        ...input,
        idempotencyTtlSeconds: 180,
      }),
    ).resolves.toBe("already_accepted");
    expect(await redis.ttl(idempotencyKey)).toBeGreaterThanOrEqual(179);
  });

  it("rejects a conflicting replacement record without mutation or pending cleanup", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000018";
    const keys = inventoryKeys(saleOfferId);
    const original = buildReservationInput({
      saleOfferId,
      sequence: 18,
      idempotencyKey: "replacement-before-promotion",
    });
    const replacement = buildReservationInput({
      saleOfferId,
      sequence: 118,
      idempotencyKey: original.idempotencyKey,
    });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 2 });
    await reserveInventoryStock(redis, original);
    await markReservationPendingPersistence(redis, original);
    await redis.del(keys.idempotency(original.idempotencyKey));
    await reserveInventoryStock(redis, replacement);
    const replacementJson = await redis.get(keys.idempotency(original.idempotencyKey));
    const replacementTtl = await redis.ttl(keys.idempotency(original.idempotencyKey));

    await expect(
      promoteReservationIdempotencyToAccepted(redis, {
        ...original,
        idempotencyTtlSeconds: 3600,
      }),
    ).rejects.toThrow("mismatch");

    expect(await redis.get(keys.idempotency(original.idempotencyKey))).toBe(replacementJson);
    const ttlAfterRejectedPromotion = await redis.ttl(keys.idempotency(original.idempotencyKey));
    expect(ttlAfterRejectedPromotion).toBeGreaterThanOrEqual(replacementTtl - 2);
    expect(ttlAfterRejectedPromotion).toBeLessThanOrEqual(replacementTtl);
    expect(await redis.zcard(keys.pendingPersistence)).toBe(2);
    expect(await redis.hlen(keys.pendingPersistenceRecords)).toBe(2);
    expect(await redis.zscore(keys.pendingPersistence, original.reservation.id)).not.toBeNull();
    expect(
      await redis.hget(keys.pendingPersistenceRecords, original.reservation.id),
    ).not.toBeNull();
    expect(await redis.zscore(keys.pendingPersistence, replacement.reservation.id)).not.toBeNull();
    expect(
      await redis.hget(keys.pendingPersistenceRecords, replacement.reservation.id),
    ).not.toBeNull();
  });

  it("validates promotion TTL and hold window before Redis execution", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000019";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 19 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 1 });
    await reserveInventoryStock(redis, input);
    const recordBefore = await redis.get(keys.idempotency(input.idempotencyKey));
    const evalSpy = vi.spyOn(redis, "eval");
    try {
      for (const idempotencyTtlSeconds of [0, -1, 1.5]) {
        await expect(
          promoteReservationIdempotencyToAccepted(redis, { ...input, idempotencyTtlSeconds }),
        ).rejects.toThrow();
      }
      await expect(
        promoteReservationIdempotencyToAccepted(redis, {
          ...input,
          reservation: {
            ...input.reservation,
            expiresAt: input.reservation.securedAt,
          },
        }),
      ).rejects.toThrow("Reservation expiresAt must be later than securedAt.");
      expect(evalSpy).not.toHaveBeenCalled();
    } finally {
      evalSpy.mockRestore();
    }
    expect(await redis.get(keys.idempotency(input.idempotencyKey))).toBe(recordBefore);
    expect(await redis.zscore(keys.pendingPersistence, input.reservation.id)).not.toBeNull();
  });

  it("atomically defers a retryable record in both pending indexes", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000029";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 29 });
    const deferredAt = new Date("2026-06-20T13:00:00.000Z");
    await initializeInventory(redis, { saleOfferId, allocatedStock: 1 });
    await reserveInventoryStock(redis, input);

    await expect(
      deferPendingPersistenceRecord(redis, {
        saleOfferId,
        reservationId: input.reservation.id,
        attemptCount: 1,
        status: "pending",
        nextRecoveryAt: deferredAt,
        recoveryDeadlineAt: new Date("2026-06-20T13:05:00.000Z"),
        lastError: "database unavailable",
      }),
    ).resolves.toBe("deferred");
    expect(await redis.zscore(keys.pendingPersistence, input.reservation.id)).toBe(
      deferredAt.getTime().toString(),
    );
    expect(await redis.hget(keys.pendingPersistenceRecords, input.reservation.id)).not.toBeNull();
  });

  it("reports authoritative removal when promotion wins before retry scheduling", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000034";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 34 });
    const deadline = new Date("2026-06-20T13:05:00.000Z");
    await initializeInventory(redis, { saleOfferId, allocatedStock: 1 });
    await reserveInventoryStock(redis, input);
    await promoteReservationIdempotencyToAccepted(redis, input);

    await expect(
      deferPendingPersistenceRecord(redis, {
        saleOfferId,
        reservationId: input.reservation.id,
        attemptCount: 1,
        status: "exhausted",
        nextRecoveryAt: deadline,
        recoveryDeadlineAt: deadline,
        lastError: "late failure response",
      }),
    ).resolves.toBe("removed");
    expect(await redis.zscore(keys.pendingPersistence, input.reservation.id)).toBeNull();
    expect(await redis.hget(keys.pendingPersistenceRecords, input.reservation.id)).toBeNull();
  });

  it.each([
    { status: "pending" as const, nextRecoveryAt: new Date("2026-06-20T13:00:00.000Z") },
    { status: "exhausted" as const, nextRecoveryAt: new Date("2026-06-20T13:05:00.000Z") },
  ])("preserves $status recovery state and scheduling score when ensuring the marker", async (state) => {
    const saleOfferId =
      state.status === "pending"
        ? "10000000-0000-4000-8000-000000000030"
        : "10000000-0000-4000-8000-000000000031";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({
      saleOfferId,
      sequence: state.status === "pending" ? 30 : 31,
    });
    const deadline = new Date("2026-06-20T13:10:00.000Z");
    await initializeInventory(redis, { saleOfferId, allocatedStock: 1 });
    await reserveInventoryStock(redis, input);
    await deferPendingPersistenceRecord(redis, {
      saleOfferId,
      reservationId: input.reservation.id,
      attemptCount: 4,
      status: state.status,
      nextRecoveryAt: state.nextRecoveryAt,
      recoveryDeadlineAt: deadline,
      lastError: "preserve this error",
    });
    const recordBefore = JSON.parse(
      (await redis.hget(keys.pendingPersistenceRecords, input.reservation.id)) ?? "null",
    );
    const scoreBefore = await redis.zscore(keys.pendingPersistence, input.reservation.id);

    await markReservationPendingPersistence(redis, input);

    expect(
      JSON.parse(
        (await redis.hget(keys.pendingPersistenceRecords, input.reservation.id)) ?? "null",
      ),
    ).toEqual(recordBefore);
    expect(await redis.zscore(keys.pendingPersistence, input.reservation.id)).toBe(scoreBefore);
  });

  it("quarantines a malformed due cursor so it cannot starve later valid work", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000032";
    const keys = inventoryKeys(saleOfferId);
    const first = buildReservationInput({ saleOfferId, sequence: 32 });
    const second = buildReservationInput({ saleOfferId, sequence: 33 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 2 });
    await reserveInventoryStock(redis, first);
    await reserveInventoryStock(redis, second);
    const malformedMetadata = JSON.parse(
      (await redis.hget(keys.pendingPersistenceRecords, first.reservation.id)) ?? "null",
    );
    malformedMetadata.idempotencyKey = "";
    await redis.hset(
      keys.pendingPersistenceRecords,
      first.reservation.id,
      JSON.stringify(malformedMetadata),
    );

    await expect(
      readPendingPersistencePage(redis, {
        saleOfferId,
        dueAt: new Date(reservationSecuredAt),
        limit: 1,
      }),
    ).resolves.toEqual({
      records: [],
      issues: [{ reservationId: first.reservation.id, reason: "malformed_pending_record" }],
    });
    await expect(
      readPendingPersistencePage(redis, {
        saleOfferId,
        dueAt: new Date(reservationSecuredAt),
        limit: 1,
      }),
    ).resolves.toMatchObject({
      records: [expect.objectContaining({ id: second.reservation.id })],
      issues: [],
    });
    expect(await redis.zscore(keys.pendingPersistence, first.reservation.id)).toBe(
      Number.MAX_SAFE_INTEGER.toString(),
    );
  });

  it("does not recreate a pending cursor removed after page discovery", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000035";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 35 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 1 });
    await reserveInventoryStock(redis, input);
    const originalHget = redis.hget.bind(redis);
    const hgetSpy = vi.spyOn(redis, "hget").mockImplementation(async (key, field) => {
      if (key === keys.pendingPersistenceRecords && field === input.reservation.id) {
        await redis
          .multi()
          .zrem(keys.pendingPersistence, input.reservation.id)
          .hdel(keys.pendingPersistenceRecords, input.reservation.id)
          .exec();
        return null;
      }
      return originalHget(key, field);
    });

    try {
      await expect(
        readPendingPersistencePage(redis, {
          saleOfferId,
          dueAt: new Date(reservationSecuredAt),
          limit: 1,
        }),
      ).resolves.toEqual({
        records: [],
        issues: [{ reservationId: input.reservation.id, reason: "missing_pending_record" }],
      });
    } finally {
      hgetSpy.mockRestore();
    }

    expect(await redis.zscore(keys.pendingPersistence, input.reservation.id)).toBeNull();
    expect(await redis.hget(keys.pendingPersistenceRecords, input.reservation.id)).toBeNull();
  });

  it("does not recreate a pending cursor removed after an exact membership read", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000036";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 36 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 1 });
    await reserveInventoryStock(redis, input);
    const originalZscore = redis.zscore.bind(redis);
    const originalHget = redis.hget.bind(redis);
    let signalRemovalComplete: () => void = () => undefined;
    const removalComplete = new Promise<void>((resolve) => {
      signalRemovalComplete = resolve;
    });
    const zscoreSpy = vi.spyOn(redis, "zscore").mockImplementationOnce(async (key, member) => {
      const score = await originalZscore(key, member);
      await redis
        .multi()
        .zrem(keys.pendingPersistence, input.reservation.id)
        .hdel(keys.pendingPersistenceRecords, input.reservation.id)
        .exec();
      signalRemovalComplete();
      return score;
    });
    const hgetSpy = vi.spyOn(redis, "hget").mockImplementation(async (key, field) => {
      if (key === keys.pendingPersistenceRecords && field === input.reservation.id) {
        await removalComplete;
      }
      return originalHget(key, field);
    });

    try {
      await expect(
        readPendingPersistenceRecord(redis, {
          saleOfferId,
          reservationId: input.reservation.id,
        }),
      ).resolves.toEqual({
        record: null,
        issue: { reservationId: input.reservation.id, reason: "missing_pending_record" },
      });
    } finally {
      zscoreSpy.mockRestore();
      hgetSpy.mockRestore();
    }

    expect(await redis.zscore(keys.pendingPersistence, input.reservation.id)).toBeNull();
    expect(await redis.hget(keys.pendingPersistenceRecords, input.reservation.id)).toBeNull();
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
    const eligibilityKey = runSaleEligibilityKey(runId);
    expect(await redis.ttl(eligibilityKey)).toBeGreaterThan(0);
    expect(await redis.ttl(eligibilityKey)).toBeLessThanOrEqual(runSaleEligibilityTtlSeconds);
    await expect(isRunSaleEligible(redis, { runId, saleOfferId })).resolves.toBe(false);
    await setRunSaleEligibility(redis, { runId, saleOfferId, status: "accepting" });
    expect(await redis.ttl(eligibilityKey)).toBe(runSaleEligibilityTtlSeconds);
    await expect(isRunSaleEligible(redis, { runId, saleOfferId })).resolves.toBe(true);
    await expect(
      isRunSaleEligible(redis, {
        runId,
        saleOfferId: "20000000-0000-4000-8000-000000000003",
      }),
    ).resolves.toBe(false);
    await redis.expire(eligibilityKey, 60);
    await setRunSaleEligibility(redis, { runId, saleOfferId, status: "accepting" });
    expect(await redis.ttl(eligibilityKey)).toBe(runSaleEligibilityTtlSeconds);
    await redis.expire(eligibilityKey, 60);
    await setRunSaleEligibility(redis, { runId, saleOfferId, status: "closed" });
    await expect(isRunSaleEligible(redis, { runId, saleOfferId })).resolves.toBe(false);
    expect(await redis.ttl(eligibilityKey)).toBeGreaterThan(0);
    expect(await redis.ttl(eligibilityKey)).toBeLessThanOrEqual(60);
    expect(await redis.hget(inventoryKeys(saleOfferId).state, "runSaleStatus")).toBe("closed");

    await redis.del(eligibilityKey);
    await setRunSaleEligibility(redis, { runId, saleOfferId, status: "closed" });
    expect(await redis.exists(eligibilityKey)).toBe(0);
  });

  it("fails closed in the atomic reservation path when generated-run eligibility expires", async () => {
    const runId = "20000000-0000-4000-8000-000000000006";
    const saleOfferId = "20000000-0000-4000-8000-000000000007";
    await initializeInventory(redis, {
      saleOfferId,
      allocatedStock: 2,
      run: { runId, status: "accepting" },
    });
    const eligibilityKey = runSaleEligibilityKey(runId);
    expect(await redis.ttl(eligibilityKey)).toBeGreaterThan(0);

    await redis.expire(eligibilityKey, 0);
    expect(await redis.exists(eligibilityKey)).toBe(0);
    expect(await redis.hget(inventoryKeys(saleOfferId).state, "runSaleStatus")).toBe("accepting");
    await expect(
      reserveInventoryStock(redis, buildReservationInput({ saleOfferId, sequence: 20, runId })),
    ).resolves.toEqual({ outcome: "run_not_accepting_traffic", reservation: null });
    await expect(getInventoryStatus(redis, saleOfferId)).resolves.toMatchObject({
      remainingStock: 2,
      reservedStock: 0,
      pendingPersistenceCount: 0,
    });
  });

  it.each([
    ["malformed", "{not-json"],
    ["primitive", "false"],
    [
      "mismatched",
      JSON.stringify({
        runId: "20000000-0000-4000-8000-000000000099",
        saleOfferId: "20000000-0000-4000-8000-000000000032",
        status: "accepting",
      }),
    ],
    [
      "closed",
      JSON.stringify({
        runId: "20000000-0000-4000-8000-000000000031",
        saleOfferId: "20000000-0000-4000-8000-000000000032",
        status: "closed",
      }),
    ],
  ])("fails closed without mutation for %s generated-run eligibility before idempotency replay", async (_label, corruptedEligibility) => {
    const runId = "20000000-0000-4000-8000-000000000031";
    const saleOfferId = "20000000-0000-4000-8000-000000000032";
    const keys = inventoryKeys(saleOfferId);
    const eligibilityKey = runSaleEligibilityKey(runId);
    const replay = buildReservationInput({
      saleOfferId,
      sequence: 31,
      idempotencyKey: "corrupt-eligibility-replay",
      runId,
    });
    const fresh = buildReservationInput({
      saleOfferId,
      sequence: 32,
      idempotencyKey: "corrupt-eligibility-fresh",
      runId,
    });
    await initializeInventory(redis, {
      saleOfferId,
      allocatedStock: 3,
      run: { runId, status: "accepting" },
    });
    await expect(reserveInventoryStock(redis, replay)).resolves.toMatchObject({
      outcome: "reservation_secured",
    });
    const before = {
      state: await redis.hgetall(keys.state),
      reservations: await redis.hgetall(keys.reservations),
      expirations: await redis.zrange(keys.reservationExpirations, 0, -1, "WITHSCORES"),
      pending: await redis.zrange(keys.pendingPersistence, 0, -1, "WITHSCORES"),
      pendingRecords: await redis.hgetall(keys.pendingPersistenceRecords),
      events: await redis.lrange(keys.events, 0, -1),
      replayIdempotency: await redis.get(keys.idempotency(replay.idempotencyKey)),
    };
    await redis.set(eligibilityKey, corruptedEligibility, "KEEPTTL");

    await expect(reserveInventoryStock(redis, replay)).resolves.toEqual({
      outcome: "run_not_accepting_traffic",
      reservation: null,
    });
    await expect(reserveInventoryStock(redis, fresh)).resolves.toEqual({
      outcome: "run_not_accepting_traffic",
      reservation: null,
    });
    expect(await redis.get(eligibilityKey)).toBe(corruptedEligibility);
    expect(await redis.ttl(eligibilityKey)).toBeGreaterThan(0);
    expect(await redis.ttl(keys.state)).toBe(-1);
    expect(await redis.hgetall(keys.state)).toEqual(before.state);
    expect(await redis.hgetall(keys.reservations)).toEqual(before.reservations);
    expect(await redis.zrange(keys.reservationExpirations, 0, -1, "WITHSCORES")).toEqual(
      before.expirations,
    );
    expect(await redis.zrange(keys.pendingPersistence, 0, -1, "WITHSCORES")).toEqual(
      before.pending,
    );
    expect(await redis.hgetall(keys.pendingPersistenceRecords)).toEqual(before.pendingRecords);
    expect(await redis.lrange(keys.events, 0, -1)).toEqual(before.events);
    expect(await redis.get(keys.idempotency(replay.idempotencyKey))).toBe(before.replayIdempotency);
    expect(await redis.exists(keys.idempotency(fresh.idempotencyKey))).toBe(0);
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

  it("collapses a concurrent shared-idempotency burst to one pending hold", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000074";
    const idempotencyKey = "concurrent-shared-idempotency-key";
    const keys = inventoryKeys(saleOfferId);
    const candidates = Array.from({ length: 20 }, (_, index) =>
      buildReservationInput({
        saleOfferId,
        sequence: 7400 + index,
        idempotencyKey,
      }),
    );
    await initializeInventory(redis, { saleOfferId, allocatedStock: 10 });

    const decisions = await Promise.all(
      candidates.map((candidate) => reserveInventoryStock(redis, candidate)),
    );
    const secured = decisions.filter((decision) => decision.outcome === "reservation_secured");
    const pending = decisions.filter(
      (decision) => decision.outcome === "reservation_pending_persistence",
    );
    const winner = secured[0]?.reservation;

    expect(secured).toHaveLength(1);
    if (!winner) {
      throw new Error("Expected the shared-idempotency burst to select one winning hold.");
    }
    expect(pending).toHaveLength(candidates.length - 1);
    expect(pending.every((decision) => decision.reservation?.id === winner.id)).toBe(true);
    expect(pending.map((decision) => decision.reservation)).toEqual(
      Array.from({ length: candidates.length - 1 }, () => winner),
    );
    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "9",
      reservedStock: "1",
    });
    expect(
      (await getInventoryStatus(redis, saleOfferId, new Date("2026-06-20T12:00:30.000Z")))
        .reservationThroughput.successfulReservationCount,
    ).toBe(1);
    expect(await redis.hlen(keys.reservations)).toBe(1);
    expect(await redis.zcard(keys.reservationExpirations)).toBe(1);
    expect(await redis.zcard(keys.pendingPersistence)).toBe(1);
    expect(await redis.hlen(keys.pendingPersistenceRecords)).toBe(1);
    expect(await redis.keys(`${keys.prefix}:idempotency:*`)).toEqual([
      keys.idempotency(idempotencyKey),
    ]);
    expect(JSON.parse((await redis.get(keys.idempotency(idempotencyKey))) ?? "null")).toEqual({
      status: "pending_persistence",
      quantity: winner.quantity,
      reservation: winner,
    });
    expect(
      JSON.parse((await redis.hget(keys.pendingPersistenceRecords, winner.id)) ?? "null"),
    ).toMatchObject({
      id: winner.id,
      idempotencyKey,
      quantity: winner.quantity,
      reservationToken: winner.reservationToken,
    });
    expect(await redis.zscore(keys.reservationExpirations, winner.id)).toBe(
      new Date(winner.expiresAt).getTime().toString(),
    );
    expect(await redis.zscore(keys.pendingPersistence, winner.id)).toBe(
      new Date(winner.securedAt).getTime().toString(),
    );
    expect(await redis.llen(keys.events)).toBe(2);
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
    expect(await redis.hget(keys.soldOut, "count")).toBe("0");
  });

  it("does not oversell under concurrent reservations", async () => {
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
      expect(await redis.hget(keys.soldOut, "count")).toBe("150");
      expect(await redis.llen(keys.events)).toBe(101);
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

  it("retains exactly the newest 500 inventory updates across reservations and reversal", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000059";
    const keys = inventoryKeys(saleOfferId);
    const allocatedStock = 501;
    let latestInput = buildReservationInput({ saleOfferId, sequence: 2000 });
    await initializeInventory(redis, {
      saleOfferId,
      allocatedStock,
      source: "retention-test",
      initializedAt: new Date("2026-06-20T11:59:00.000Z"),
    });

    for (let index = 0; index < allocatedStock; index += 1) {
      latestInput = buildReservationInput({ saleOfferId, sequence: 2000 + index });
      await expect(reserveInventoryStock(redis, latestInput)).resolves.toMatchObject({
        outcome: "reservation_secured",
      });
    }

    expect(await redis.llen(keys.events)).toBe(500);
    expect(JSON.parse((await redis.lindex(keys.events, 0)) ?? "null")).toEqual({
      eventName: "inventory.updated",
      saleOfferId,
      allocatedStock,
      remainingStock: 499,
      reservedStock: 2,
      reservationCount: 1,
      reservedQuantity: 1,
      source: "reservation",
      occurredAt: reservationSecuredAt,
    });
    expect(JSON.parse((await redis.lindex(keys.events, -1)) ?? "null")).toEqual({
      eventName: "inventory.updated",
      saleOfferId,
      allocatedStock,
      remainingStock: 0,
      reservedStock: 501,
      reservationCount: 1,
      reservedQuantity: 1,
      source: "reservation",
      occurredAt: reservationSecuredAt,
    });

    const reversalOccurredAt = new Date("2026-06-20T12:05:00.000Z");
    await expect(
      reverseReservation(redis, {
        idempotencyKey: latestInput.idempotencyKey,
        reservation: latestInput.reservation,
        occurredAt: reversalOccurredAt,
      }),
    ).resolves.toBe("reversed");

    expect(await redis.llen(keys.events)).toBe(500);
    expect(JSON.parse((await redis.lindex(keys.events, 0)) ?? "null")).toMatchObject({
      remainingStock: 498,
      reservedStock: 3,
      source: "reservation",
    });
    expect(JSON.parse((await redis.lindex(keys.events, -1)) ?? "null")).toEqual({
      eventName: "inventory.updated",
      saleOfferId,
      allocatedStock,
      remainingStock: 1,
      reservedStock: 500,
      source: "reservation-reversal",
      occurredAt: reversalOccurredAt.toISOString(),
    });
  }, 30_000);

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
