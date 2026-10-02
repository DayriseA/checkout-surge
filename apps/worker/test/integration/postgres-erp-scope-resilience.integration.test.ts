import { createDatabaseConnection, erpScopeResilienceState } from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { erpResiliencePolicy } from "../../src/application/erp-resilience-policy.js";
import { AdaptiveErpRuntimeAdmission } from "../../src/application/order-process-admission.js";
import { PostgresErpScopeResiliencePersistence } from "../../src/persistence/postgres-erp-scope-resilience-persistence.js";

const databaseUrl = requireTestDatabaseUrl();

describe("PostgreSQL ERP scope resilience state", () => {
  const connection = databaseUrl ? createDatabaseConnection(databaseUrl, { max: 2 }) : null;
  const requireConnection = () => {
    if (!connection) throw new Error("TEST_DATABASE_URL is required for integration tests.");
    return connection;
  };
  let persistence: PostgresErpScopeResiliencePersistence;

  beforeEach(async () => {
    await resetTestDatabase({
      databaseUrl,
      migrationsFolder: "../../packages/db/drizzle",
    });
    persistence = new PostgresErpScopeResiliencePersistence(requireConnection().db);
  });
  afterAll(() => connection?.close());

  it("round-trips the complete adaptive restart-safety boundary", async () => {
    await persistence.save({
      scope: `run:${"44444444-4444-4444-8444-444444444444"}`,
      cooldownUntilMs: Date.parse("2026-06-22T00:01:00.000Z"),
      availabilityRetryAtMs: Date.parse("2026-06-22T00:01:30.000Z"),
      availabilityCircuitOpen: true,
      circuitOpenUntilMs: Date.parse("2026-06-22T00:02:00.000Z"),
      nextProbeAtMs: Date.parse("2026-06-22T00:02:30.000Z"),
    });

    await expect(persistence.listActive(Date.parse("2026-06-22T00:00:00.000Z"))).resolves.toEqual([
      {
        scope: `run:${"44444444-4444-4444-8444-444444444444"}`,
        cooldownUntilMs: Date.parse("2026-06-22T00:01:00.000Z"),
        availabilityRetryAtMs: Date.parse("2026-06-22T00:01:30.000Z"),
        availabilityCircuitOpen: true,
        circuitOpenUntilMs: Date.parse("2026-06-22T00:02:00.000Z"),
        nextProbeAtMs: Date.parse("2026-06-22T00:02:30.000Z"),
      },
    ]);
  });

  it("restores cooldown before a restarted runtime can admit traffic", async () => {
    let now = Date.parse("2026-06-22T00:00:00.000Z");
    await persistence.save({
      scope: `run:${"44444444-4444-4444-8444-444444444444"}`,
      cooldownUntilMs: now + 30_000,
      availabilityRetryAtMs: 0,
      availabilityCircuitOpen: false,
      circuitOpenUntilMs: 0,
      nextProbeAtMs: 0,
    });
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      pauseDelivery: async () => {},
      persistence,
      runConfigReader: { read: async () => null },
      reconciliationConcurrency: 10,
      now: () => now,
      random: () => 0,
    });
    const context = {
      scope: `run:${"44444444-4444-4444-8444-444444444444"}` as const,
      configuredConcurrency: 10,
    };

    await expect(admission.tryAcquire(context, "confirmation")).resolves.toMatchObject({
      admitted: false,
      decision: { reason: "capacity_cooldown", nextEligibleAtMs: now + 30_000 },
    });
    now += 30_000;
    await expect(admission.tryAcquire(context, "confirmation")).resolves.toMatchObject({
      admitted: true,
    });
  });

  it("filters historical rows before bounded restoration", async () => {
    const now = Date.parse("2026-06-22T00:00:00.000Z");
    await requireConnection()
      .db.insert(erpScopeResilienceState)
      .values(
        Array.from({ length: erpResiliencePolicy.maximumScopeStates + 10 }, (_, index) => ({
          scope: `run:expired-${index}`,
          cooldownExpiresAt: new Date(now - 1),
        })),
      );
    await persistence.save({
      scope: `run:${"44444444-4444-4444-8444-444444444444"}`,
      cooldownUntilMs: now + 30_000,
      availabilityRetryAtMs: 0,
      availabilityCircuitOpen: false,
      circuitOpenUntilMs: 0,
      nextProbeAtMs: 0,
    });

    const admission = await AdaptiveErpRuntimeAdmission.restore({
      pauseDelivery: async () => {},
      persistence,
      runConfigReader: { read: async () => null },
      reconciliationConcurrency: 10,
      now: () => now,
    });

    await expect(
      admission.tryAcquire(
        { scope: `run:${"44444444-4444-4444-8444-444444444444"}`, configuredConcurrency: 10 },
        "confirmation",
      ),
    ).resolves.toMatchObject({
      admitted: false,
      decision: { reason: "capacity_cooldown", nextEligibleAtMs: now + 30_000 },
    });
  });

  it("hydrates an active obligation created after startup before first admission", async () => {
    const now = Date.parse("2026-06-22T00:00:00.000Z");
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      pauseDelivery: async () => {},
      persistence,
      runConfigReader: { read: async () => null },
      reconciliationConcurrency: 10,
      now: () => now,
    });
    await persistence.save({
      scope: `run:${"44444444-4444-4444-8444-444444444444"}`,
      cooldownUntilMs: now + 30_000,
      availabilityRetryAtMs: 0,
      availabilityCircuitOpen: false,
      circuitOpenUntilMs: 0,
      nextProbeAtMs: 0,
    });

    await expect(
      admission.tryAcquire(
        { scope: `run:${"44444444-4444-4444-8444-444444444444"}`, configuredConcurrency: 10 },
        "confirmation",
      ),
    ).resolves.toMatchObject({
      admitted: false,
      decision: { reason: "capacity_cooldown" },
    });
  });
});
