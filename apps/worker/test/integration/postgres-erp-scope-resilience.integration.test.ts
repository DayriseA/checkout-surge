import { createDatabaseConnection } from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresErpScopeResiliencePersistence } from "../../src/persistence/postgres-erp-scope-resilience-persistence.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const requireDatabaseUrl = () => {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for integration tests.");
  return databaseUrl;
};

run("PostgreSQL ERP scope resilience state", () => {
  const connection = databaseUrl ? createDatabaseConnection(databaseUrl, { max: 2 }) : null;
  const requireConnection = () => {
    if (!connection) throw new Error("TEST_DATABASE_URL is required for integration tests.");
    return connection;
  };
  let persistence: PostgresErpScopeResiliencePersistence;

  beforeEach(async () => {
    await resetTestDatabase({
      databaseUrl: requireDatabaseUrl(),
      migrationsFolder: "../../packages/db/drizzle",
    });
    persistence = new PostgresErpScopeResiliencePersistence(requireConnection().db);
  });
  afterAll(() => connection?.close());

  it("persists per-scope cooldown and circuit-open expiries across restarts", async () => {
    await expect(persistence.get("catalog")).resolves.toBeNull();

    const cooldownUntil = new Date("2026-06-22T00:01:00.000Z");
    await persistence.setExpiries({ scope: "catalog", cooldownExpiresAt: cooldownUntil });
    await expect(persistence.get("catalog")).resolves.toMatchObject({
      scope: "catalog",
      cooldownExpiresAt: cooldownUntil,
      circuitOpenExpiresAt: null,
    });

    const circuitUntil = new Date("2026-06-22T00:02:00.000Z");
    const cooldownUpdate = new Date("2026-06-22T00:01:30.000Z");
    await persistence.setExpiries({
      scope: "catalog",
      cooldownExpiresAt: cooldownUpdate,
      circuitOpenExpiresAt: circuitUntil,
    });
    await expect(persistence.get("catalog")).resolves.toMatchObject({
      cooldownExpiresAt: cooldownUpdate,
      circuitOpenExpiresAt: circuitUntil,
    });

    // Scopes are isolated: run-scoped state never bleeds into the catalog.
    const runScopeUntil = new Date("2026-06-22T00:03:00.000Z");
    await persistence.setExpiries({
      scope: "run:55555555-5555-4555-8555-555555555555",
      circuitOpenExpiresAt: runScopeUntil,
    });
    await expect(persistence.get("catalog")).resolves.toMatchObject({
      circuitOpenExpiresAt: circuitUntil,
    });
    await expect(
      persistence.get("run:55555555-5555-4555-8555-555555555555"),
    ).resolves.toMatchObject({ circuitOpenExpiresAt: runScopeUntil, cooldownExpiresAt: null });
  });
});
