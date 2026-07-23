import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseConnection, publicRuntimePolicies } from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  PublicRuntimePolicyService,
  resolveEffectivePublicRuntimePolicy,
} from "../src/services/public-runtime-policy-service.js";
import {
  deploymentHardCapsFixture,
  publicRuntimePolicyMutableFixture,
} from "./demo-administration-test-fixtures.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFolder = path.resolve(packageRoot, "../../packages/db/drizzle");
const now = new Date("2026-06-20T00:00:10.000Z");

describe("public runtime policy service", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await requireConnection(connection).db.insert(publicRuntimePolicies).values({
      id: "active",
      policy: publicRuntimePolicyMutableFixture(),
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("hydrates strict mutable persistence with current environment hard caps", async () => {
    const persisted = publicRuntimePolicyMutableFixture();
    const caps = { ...deploymentHardCapsFixture, maxBuyers: 20_000 };
    const service = createService(requireConnection(connection), caps);

    const effective = resolveEffectivePublicRuntimePolicy(persisted, caps);
    const publicResponse = await service.getPublicRuntimePolicy();
    const adminResponse = await service.getAdminPublicRuntimePolicy("corr-policy-read");

    expect(effective.deploymentHardCaps.maxBuyers).toBe(20_000);
    expect(publicResponse.policy.deploymentHardCaps.maxBuyers).toBe(20_000);
    expect(adminResponse).toMatchObject({
      id: "active",
      correlationId: "corr-policy-read",
      timestamp: now.toISOString(),
    });
    expect(() =>
      resolveEffectivePublicRuntimePolicy(
        { ...persisted, deploymentHardCaps: deploymentHardCapsFixture },
        caps,
      ),
    ).toThrow(/Unrecognized key.*deploymentHardCaps/i);
  });

  it("persists mutable updates while returning effective hard caps", async () => {
    const activeConnection = requireConnection(connection);
    const service = createService(activeConnection);
    const policy = publicRuntimePolicyMutableFixture();
    policy.publicRunBudget = { windowSeconds: 60, perVisitorMaxStarts: 1, globalMaxStarts: 2 };
    policy.publicCustomLimits.maxBuyers = 500;
    policy.publicCustomDefaults.inventoryConfig.startingStock = 75;

    const response = await service.updateAdminPublicRuntimePolicy(
      { policy, correlationId: "body-correlation" },
      "corr-policy-save",
    );
    const [row] = await activeConnection.db.select().from(publicRuntimePolicies);

    expect(response).toMatchObject({
      correlationId: "corr-policy-save",
      policy: {
        publicRunBudget: { globalMaxStarts: 2 },
        publicCustomLimits: { maxBuyers: 500 },
        deploymentHardCaps: deploymentHardCapsFixture,
      },
    });
    expect(row?.policy).not.toHaveProperty("deploymentHardCaps");
    expect(row?.policy.publicCustomDefaults.inventoryConfig.startingStock).toBe(75);
  });

  it("rejects policy values above environment caps without changing persistence", async () => {
    const activeConnection = requireConnection(connection);
    const service = createService(activeConnection, {
      ...deploymentHardCapsFixture,
      maxTotalRequests: 50_000,
    });
    const policy = publicRuntimePolicyMutableFixture();
    policy.publicCustomLimits.maxTotalRequests = 50_001;

    await expect(
      service.updateAdminPublicRuntimePolicy({ policy }, "corr-policy-reject"),
    ).rejects.toMatchObject({
      code: "invalid_runtime_policy",
      details: {
        value: 50_001,
        cap: 50_000,
        violationCode: "public_limit_total_requests_exceeds_deployment_cap",
      },
    });
    const [row] = await activeConnection.db.select().from(publicRuntimePolicies);
    expect(row?.policy.publicCustomLimits.maxTotalRequests).toBe(10_000);
  });

  it("rejects an automatic default whose derived max VUs exceed deployment caps", async () => {
    const activeConnection = requireConnection(connection);
    const service = createService(activeConnection, {
      ...deploymentHardCapsFixture,
      maxPreAllocatedVus: 10,
      maxVus: 10,
    });
    const policy = publicRuntimePolicyMutableFixture();
    policy.publicCustomLimits.maxPreAllocatedVus = 10;
    policy.publicCustomLimits.maxVus = 10;
    policy.publicCustomDefaults.trafficConfig = {
      mode: "steady-arrival-rate",
      ratePerSecond: 6,
      startDelaySeconds: 0,
      durationSeconds: 1,
      quantityPerAttempt: 1,
    };

    await expect(
      service.updateAdminPublicRuntimePolicy({ policy }, "corr-policy-default-vus-reject"),
    ).rejects.toMatchObject({
      code: "invalid_runtime_policy",
      details: {
        value: 12,
        cap: 10,
        violationCode: "public_custom_default_deployment_max_vus_exceeded",
      },
    });
    const [row] = await activeConnection.db.select().from(publicRuntimePolicies);
    expect(row?.policy.publicCustomDefaults.trafficConfig.mode).toBe("buyer-spike");
  });

  it("validates the active policy against current deployment caps before startup", async () => {
    const service = createService(requireConnection(connection), {
      ...deploymentHardCapsFixture,
      maxBuyers: 9_999,
    });
    await expect(service.validateActivePolicyAtStartup()).rejects.toThrow(
      /publicCustomLimits\.maxBuyers.*public_limit_buyers_exceeds_deployment_cap/,
    );
  });

  it("reports missing and obsolete active policy persistence at startup", async () => {
    const activeConnection = requireConnection(connection);
    await activeConnection.db.delete(publicRuntimePolicies);
    await expect(createService(activeConnection).validateActivePolicyAtStartup()).rejects.toThrow(
      /policy "active" is missing/,
    );

    await activeConnection.db.execute(sql`
      INSERT INTO ${publicRuntimePolicies} (id, policy)
      VALUES ('active', ${JSON.stringify({
        ...publicRuntimePolicyMutableFixture(),
        deploymentHardCaps: deploymentHardCapsFixture,
      })}::jsonb)
    `);
    await expect(createService(activeConnection).validateActivePolicyAtStartup()).rejects.toThrow(
      /Unrecognized key.*deploymentHardCaps/i,
    );
  });

  it("uses new hard caps on the next service boot without reseeding", async () => {
    const activeConnection = requireConnection(connection);
    const first = createService(activeConnection, {
      ...deploymentHardCapsFixture,
      maxBuyers: 20_000,
    });
    const second = createService(activeConnection, {
      ...deploymentHardCapsFixture,
      maxBuyers: 30_000,
    });

    expect((await first.readEffectivePolicy()).deploymentHardCaps.maxBuyers).toBe(20_000);
    expect((await second.readEffectivePolicy()).deploymentHardCaps.maxBuyers).toBe(30_000);
  });

  it("returns resource_not_found when an update races with active-row removal", async () => {
    const activeConnection = requireConnection(connection);
    await activeConnection.db
      .delete(publicRuntimePolicies)
      .where(eq(publicRuntimePolicies.id, "active"));
    await expect(
      createService(activeConnection).updateAdminPublicRuntimePolicy(
        { policy: publicRuntimePolicyMutableFixture() },
        "corr-missing",
      ),
    ).rejects.toMatchObject({ code: "resource_not_found" });
  });
});

function createService(
  connection: ReturnType<typeof createDatabaseConnection>,
  deploymentHardCaps = deploymentHardCapsFixture,
): PublicRuntimePolicyService {
  return new PublicRuntimePolicyService({
    db: connection.db,
    deploymentHardCaps,
    now: () => now,
  });
}

function requireConnection(connection: ReturnType<typeof createDatabaseConnection> | null) {
  if (!connection) throw new Error("Test database connection was not initialized.");
  return connection;
}

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for API tests.");
  return databaseUrl;
}
