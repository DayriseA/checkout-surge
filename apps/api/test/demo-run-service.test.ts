import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AcceptedRunConfigSnapshot,
  BusinessOutcomeSummary,
  PublicRuntimePolicy,
  TrafficCompletionReport,
  TrafficConfig,
  TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import {
  controlServiceTokenHeaderName,
  trafficExecutionStartPath,
} from "@checkout-surge/contracts";
import { signPublicVisitorCredential } from "@checkout-surge/contracts/public-visitor-credential";
import {
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunFinalizations,
  demoRunReservationOutcomes,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  initializeInventory,
  inventoryKeys,
  isRunSaleEligible,
  products,
  publicRuntimePolicies,
  reserveInventoryStock,
  runSaleEligibilityKey,
  saleOffers,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../src/runtime/errors.js";
import { DemoMaintenanceService } from "../src/services/demo-maintenance-service.js";
import { DemoRunFinalizationService } from "../src/services/demo-run-finalization-service.js";
import {
  DemoRunService,
  DemoRunValidationError,
  HttpTrafficExecutionGateway,
  isSingleNonTerminalRunViolation,
  validateAcceptedRunSnapshot,
  validatePublicRuntimePolicyUpdate,
} from "../src/services/demo-run-service.js";
import { RedisPublicRunBudgetStore } from "../src/services/public-run-budget-store.js";
import { PostgresTerminalDemoRunSummaryWriter } from "../src/services/terminal-demo-run-transition.js";
import { TrafficCompletionEnrichmentService } from "../src/services/traffic-completion-enrichment-service.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackageRoot = path.resolve(packageRoot, "../../packages/db");
const migrationsFolder = path.join(dbPackageRoot, "drizzle");
const publicCookieSecret = "test-public-cookie-secret";
const signedVisitor = (visitorId: string) => {
  const credential = signPublicVisitorCredential(publicCookieSecret, visitorId, 1_750_000_000_000);
  if (!credential) throw new Error("Fixture visitor credential could not be signed.");
  return credential;
};

describe("demo-run service validation", () => {
  it.each([
    ["missing", undefined],
    ["raw", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["malformed", "malformed.credential"],
    ["tampered", `${signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")}0`],
    [
      "wrong secret",
      signPublicVisitorCredential(
        "different-cookie-secret",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        1_750_000_000_000,
      ),
    ],
  ])("rejects %s public credentials before persistence or budget mutation", async (_case, credential) => {
    const select = vi.fn(() => {
      throw new Error("Database must not be read.");
    });
    const reserve = vi.fn();
    const service = new DemoRunService({
      db: { select } as never,
      redis: {} as never,
      trafficExecutionGateway: {} as never,
      publicRunBudgetStore: { reserve, release: vi.fn() },
      trafficMetricStore: {} as never,
      businessOutcomeReader: {} as never,
      completionEnrichmentService: {} as never,
      terminalRunWriter: {} as never,
      apiBaseUrl: "http://api.test",
      buyEndpointPath: "/buy",
      logger: createSilentLogger("api"),
      publicClientCookieSecret: publicCookieSecret,
    });
    await expect(
      service.startRun(
        {
          presetSlug: "preview-1k",
          operatorMode: "public",
          ...(credential ? { publicVisitorCredential: credential } : {}),
        },
        "credential-correlation",
      ),
    ).rejects.toMatchObject({ code: "public_visitor_forbidden" });
    expect(select).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("identifies only the exact wrapped single-run unique violation", () => {
    expect(
      isSingleNonTerminalRunViolation({
        cause: {
          code: "23505",
          constraint_name: "demo_runs_single_non_terminal_idx",
        },
      }),
    ).toBe(true);
    expect(
      isSingleNonTerminalRunViolation({
        code: "23505",
        constraint_name: "demo_runs_sale_offer_id_unique",
      }),
    ).toBe(false);
    expect(
      isSingleNonTerminalRunViolation({
        code: "23503",
        constraint_name: "demo_runs_single_non_terminal_idx",
      }),
    ).toBe(false);
  });

  it("allows curated public presets to exceed public-custom caps while enforcing deployment caps", () => {
    expect(() =>
      validateAcceptedRunSnapshot(surge10kSnapshot(), publicRuntimePolicy(), {
        operatorMode: "public",
        enforcePublicCustomLimits: false,
      }),
    ).not.toThrow();
  });

  it("keeps public custom starts inside public-custom caps", () => {
    expect(() =>
      validateAcceptedRunSnapshot(surge10kSnapshot(), publicRuntimePolicy(), {
        operatorMode: "public",
        enforcePublicCustomLimits: true,
      }),
    ).toThrow(DemoRunValidationError);
  });

  it("rejects public runtime policy updates above deployment hard caps", () => {
    const policy = publicRuntimePolicy();
    policy.publicCustomLimits.maxTotalRequests = policy.deploymentHardCaps.maxTotalRequests + 1;

    expect(() => validatePublicRuntimePolicyUpdate(policy)).toThrow(
      "Accepted run configuration exceeds a configured cap.",
    );
    expect(() => validatePublicRuntimePolicyUpdate(policy)).toThrow(DemoRunValidationError);
    expect(() => validatePublicRuntimePolicyUpdate(policy)).toThrowError(
      expect.objectContaining({
        code: "public_limit_total_requests_exceeds_deployment_cap",
        details: { value: 100_001, cap: 100_000 },
      }),
    );
  });

  it("rejects public custom defaults that exceed the updated public limits", () => {
    const policy = publicRuntimePolicy();
    policy.publicCustomLimits.maxBuyers = 100;

    expect(() => validatePublicRuntimePolicyUpdate(policy)).toThrowError(
      expect.objectContaining({
        name: "DemoRunValidationError",
        code: "public_custom_default_public_buyers_exceeded",
        message: "Public custom defaults must fit within the active public runtime policy.",
        details: { value: 500, cap: 100 },
      }),
    );
  });
});

describe("HTTP traffic execution gateway", () => {
  it("sends the validated start correlation ID in the load-orchestrator header", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          runId: "55555555-5555-4555-8555-555555555555",
          status: "active",
          startedAt: "2026-06-20T00:00:11.000Z",
          correlationId: "corr-start-delegation",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "test-token",
    });

    try {
      const response = await gateway.start({
        runId: "55555555-5555-4555-8555-555555555555",
        saleOfferId: "22222222-2222-4222-8222-222222222222",
        apiBaseUrl: "http://api.test",
        buyEndpointPath: "/buy",
        correlationId: "corr-start-delegation",
        configSnapshot: surge10kSnapshot(),
      });

      expect(response.correlationId).toBe("corr-start-delegation");
      expect(fetchMock).toHaveBeenCalledWith(
        `http://load.test${trafficExecutionStartPath}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            [correlationIdHeaderName]: "corr-start-delegation",
            [controlServiceTokenHeaderName]: "test-token",
          }),
        }),
      );
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
        correlationId: "corr-start-delegation",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("demo-run preset management", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await seedPresetFixtures(connection);
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("lists all presets while public listing remains scoped to public presets", async () => {
    const service = createPresetManagementService(requireConnection(connection));

    const publicPresets = await service.listPublicPresets();
    const adminPresets = await service.listAdminPresets();

    expect(publicPresets.presets.map((preset) => preset.slug)).toEqual([
      "preview-1k",
      "public-custom",
    ]);
    expect(adminPresets.presets.map((preset) => preset.slug)).toEqual([
      "preview-1k",
      "public-custom",
      "custom",
    ]);
  });

  it("saves only editable admin presets", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    const snapshot = surge10kSnapshot();

    const updated = await service.saveAdminPreset({
      slug: "custom",
      display: {
        name: "Custom Saved",
        description: "Updated scratch preset.",
        sortOrder: 125,
        outcomeFocus: ["failure_path"],
      },
      ...snapshot,
    });

    await expect(
      service.saveAdminPreset({
        slug: "preview-1k",
        display: {
          name: "Preview Edited",
          description: "Should not persist.",
          sortOrder: 10,
          outcomeFocus: [],
        },
        ...snapshot,
      }),
    ).rejects.toMatchObject({ code: "preset_not_editable" });
    expect(updated.preset.slug).toBe("custom");
    expect(updated.preset.display.name).toBe("Custom Saved");
    expect(expectBuyerSpikeTrafficConfig(updated.preset.trafficConfig)).toMatchObject({
      buyerCount: 10_000,
    });
  });

  it("duplicates presets as editable admin copies and rejects duplicate slugs", async () => {
    const service = createPresetManagementService(requireConnection(connection));

    const created = await service.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "Preview Copy",
      displayName: "Preview Copy",
    });

    await expect(
      service.duplicatePreset({
        sourceSlug: "preview-1k",
        targetSlug: "preview-copy",
      }),
    ).rejects.toMatchObject({ code: "preset_slug_conflict" });
    await expect(
      service.duplicatePreset({
        sourceSlug: "public-custom",
        targetSlug: "public-custom-copy",
      }),
    ).rejects.toMatchObject({ code: "preset_not_duplicable" });
    expect(created.preset.slug).toBe("preview-copy");
    expect(created.preset.visibility).toBe("admin");
    expect(created.preset.isEditable).toBe(true);
    expect(created.preset.isCustom).toBe(false);
    expect(created.preset.display.name).toBe("Preview Copy");
  });

  it("copies any source preset into the editable admin custom preset", async () => {
    const service = createPresetManagementService(requireConnection(connection));

    const copied = await service.copyPresetToCustom({ sourceSlug: "preview-1k" });

    expect(copied.preset.slug).toBe("custom");
    expect(copied.preset.visibility).toBe("admin");
    expect(copied.preset.isCustom).toBe(true);
    expect(copied.preset.display.name).toBe("Custom");
    expect(copied.preset.display.description).toBe("Scratch copy of Preview 1k.");
    expect(expectBuyerSpikeTrafficConfig(copied.preset.trafficConfig)).toMatchObject({
      buyerCount: 10_000,
    });
  });
});

describe("demo-run public runtime policy management", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await seedStartFixtures(connection);
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("persists public budget, default, and limit updates while preserving deployment hard caps", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    const policy = publicRuntimePolicyMutable();
    policy.publicRunBudget = {
      windowSeconds: 60,
      perVisitorMaxStarts: 1,
      globalMaxStarts: 2,
    };
    policy.publicCustomDefaults = {
      ...policy.publicCustomDefaults,
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 250,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 5,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 75,
        quantityPerCheckout: 1,
        reservationHoldMinutes: 15,
      },
    };
    policy.publicCustomLimits = {
      ...policy.publicCustomLimits,
      maxBuyers: 500,
      maxStartingStock: 100,
    };

    const response = await service.updateAdminPublicRuntimePolicy(
      { policy, correlationId: "corr-policy-save" },
      "corr-policy-save",
    );
    const [row] = await requireConnection(connection).db.select().from(publicRuntimePolicies);
    const persistedPolicy = row?.policy as PublicRuntimePolicy | undefined;

    expect(response.correlationId).toBe("corr-policy-save");
    expect(response.policy.publicRunBudget.perVisitorMaxStarts).toBe(1);
    expect(response.policy.publicCustomDefaults.inventoryConfig.startingStock).toBe(75);
    expect(response.policy.publicCustomLimits.maxBuyers).toBe(500);
    expect(response.policy.deploymentHardCaps.maxBuyers).toBe(100_000);
    expect(persistedPolicy?.publicRunBudget.globalMaxStarts).toBe(2);
    expect(persistedPolicy?.deploymentHardCaps.maxTotalRequests).toBe(100_000);
  });

  it("rejects policy updates above deployment hard caps without changing the stored row", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    const policy = publicRuntimePolicyMutable();
    policy.publicCustomLimits.maxTotalRequests = 100_001;

    await expect(
      service.updateAdminPublicRuntimePolicy({ policy }, "corr-policy-reject"),
    ).rejects.toMatchObject({
      code: "public_limit_total_requests_exceeds_deployment_cap",
    });

    const [row] = await requireConnection(connection).db.select().from(publicRuntimePolicies);
    const persistedPolicy = row?.policy as PublicRuntimePolicy | undefined;
    expect(persistedPolicy?.publicCustomLimits.maxTotalRequests).toBe(10_000);
  });
});

describe("demo-run lifecycle start gating", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;
  let redis: ReturnType<typeof createRedisClient> | null = null;

  beforeEach(async () => {
    await connection?.close();
    redis?.disconnect();
    connection = null;
    redis = null;

    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    redis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await redis.flushdb();
    await seedStartFixtures(connection);
  });

  afterAll(async () => {
    await connection?.close();
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
  });

  it.each([
    "starting",
    "active",
    "draining",
  ] as const)("blocks a new start while another run is %s", async (status) => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));
    await seedExistingRun(requireConnection(connection), {
      runId: existingRunId(status),
      status,
    });

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-start"),
    ).rejects.toMatchObject({
      code: "demo_run_already_active",
      details: { status },
    });
  });

  it("replays a durable starting intent with the same run identity and activates it", async () => {
    const start = vi
      .fn(async (request: TrafficExecutionStartRequest) => ({
        runId: request.runId,
        status: "active" as const,
        startedAt: "2026-06-20T00:00:11.000Z",
        correlationId: request.correlationId,
      }))
      .mockRejectedValueOnce(
        new ApiHttpError({
          statusCode: 502,
          code: "load_orchestrator_start_ambiguous",
          message: "ambiguous",
        }),
      );
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      trafficExecutionGateway: { start },
    });
    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "initial-start"),
    ).rejects.toMatchObject({ code: "load_orchestrator_start_ambiguous" });
    const [starting] = await requireConnection(connection)
      .db.select()
      .from(demoRuns)
      .where(eq(demoRuns.status, "starting"));
    const runId = starting?.id;
    expect(runId).toBeTruthy();
    await expect(service.reconcileStartingRuns()).resolves.toBe(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ runId, correlationId: `traffic-reconcile-${runId}` }),
    );
    const [row] = await requireConnection(connection)
      .db.select()
      .from(demoRuns)
      .where(eq(demoRuns.id, runId as string));
    expect(row).toMatchObject({ status: "active", trafficStatus: "active" });
  });

  it("accepts exactly one of two concurrent starts", async () => {
    const trafficStart = vi.fn(async (request) => ({
      runId: request.runId,
      status: "active" as const,
      startedAt: "2026-06-20T00:00:11.000Z",
      correlationId: request.correlationId,
    }));
    const services = [
      createStartService(requireConnection(connection), requireRedis(redis), {
        trafficExecutionGateway: { start: trafficStart },
      }),
      createStartService(requireConnection(connection), requireRedis(redis), {
        trafficExecutionGateway: { start: trafficStart },
      }),
    ];

    const results = await Promise.allSettled(
      services.map((service, index) =>
        service.startRun(
          { presetSlug: "preview-1k", operatorMode: "admin" },
          `corr-concurrent-${index}`,
        ),
      ),
    );
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "demo_run_already_active" },
    });
    expect(await requireConnection(connection).db.select().from(demoRuns)).toHaveLength(1);
    expect(await requireConnection(connection).db.select().from(saleOffers)).toHaveLength(1);
    expect(await requireConnection(connection).db.select().from(demoRunSaleContexts)).toHaveLength(
      1,
    );
    expect(trafficStart).toHaveBeenCalledTimes(1);
  });

  it("maps a direct-writer claim race and rolls back all losing start side effects", async () => {
    const directConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const trafficStart = vi.fn();
    const release = vi.fn(async () => undefined);
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      trafficExecutionGateway: { start: trafficStart },
      publicRunBudgetStore: {
        reserve: async () => {
          await seedExistingRun(directConnection, {
            runId: "88888888-8888-4888-8888-888888888888",
            status: "starting",
          });
          return {
            outcome: "allowed" as const,
            reservation: {
              reservationId: "race",
              globalKey: "g",
              visitorKey: "v",
              reservationKey: "r",
            },
          };
        },
        release,
      },
    });

    try {
      await expect(
        service.startRun(
          {
            presetSlug: "preview-1k",
            operatorMode: "public",
            publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          },
          "corr-direct-writer-race",
        ),
      ).rejects.toMatchObject({ code: "demo_run_already_active" });

      expect(await requireConnection(connection).db.select().from(demoRuns)).toHaveLength(1);
      expect(await requireConnection(connection).db.select().from(saleOffers)).toHaveLength(0);
      expect(
        await requireConnection(connection).db.select().from(demoRunSaleContexts),
      ).toHaveLength(0);
      expect(await requireConnection(connection).db.select().from(demoRunSummaries)).toHaveLength(
        0,
      );
      expect(trafficStart).not.toHaveBeenCalled();
      expect(await requireRedis(redis).dbsize()).toBe(0);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await directConnection.close();
    }
  });

  it("keeps public validation and existing-run overlap rejection ahead of reservation", async () => {
    const reserve = vi.fn();
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: { reserve, release: vi.fn() },
    });
    await expect(
      service.startRun(
        {
          presetSlug: "custom",
          operatorMode: "public",
          publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        },
        "visibility-rejection",
      ),
    ).rejects.toMatchObject({ code: "preset_not_public" });
    expect(reserve).not.toHaveBeenCalled();

    await seedExistingRun(requireConnection(connection), {
      runId: "88888888-8888-4888-8888-888888888889",
      status: "active",
    });
    await expect(
      service.startRun(
        {
          presetSlug: "preview-1k",
          operatorMode: "public",
          publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        },
        "overlap-rejection",
      ),
    ).rejects.toMatchObject({ code: "demo_run_already_active" });
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each([
    ["visitor", "public_visitor_run_budget_exceeded"],
    ["global", "public_run_budget_exceeded"],
  ] as const)("maps %s budget denial decisions to stable application errors", async (reason, code) => {
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: {
        reserve: async () => ({ outcome: "denied", reason }),
        release: vi.fn(),
      },
    });
    await expect(
      service.startRun(
        {
          presetSlug: "preview-1k",
          operatorMode: "public",
          publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        },
        `denied-${reason}`,
      ),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    "completed",
    "failed",
  ] as const)("allows a new start after the existing run is %s", async (status) => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));
    await seedExistingRun(requireConnection(connection), {
      runId: existingRunId(status),
      status,
    });

    const response = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-start",
    );

    expect(response.run.status).toBe("active");
    expect(response.run.trafficStatus).toBe("active");
    expect(response.run.saleOfferId).toBe("77777777-7777-4777-8777-777777777778");
  });

  it("keeps public custom overrides scoped to the accepted run snapshot", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));

    const response = await service.startRun(
      {
        presetSlug: "public-custom",
        operatorMode: "public",
        publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        configOverride: {
          trafficConfig: {
            mode: "buyer-spike",
            buyerCount: 321,
            duplicateEachBuyerAttempt: false,
            startDelaySeconds: 0,
            maxDurationSeconds: 3,
            quantityPerAttempt: 1,
          },
          inventoryConfig: {
            startingStock: 44,
            quantityPerCheckout: 1,
            reservationHoldMinutes: 15,
          },
          erpConfig: {
            latencyMs: 75,
            maxTps: 50,
            errorRate: 0,
            forcedOutage: false,
            requestTimeoutMs: 2000,
          },
        },
      },
      "corr-public-custom",
    );
    const publicCustomPreset = await readPresetRow(requireConnection(connection), "public-custom");

    expect(expectBuyerSpikeTrafficConfig(response.run.configSnapshot.trafficConfig)).toMatchObject({
      buyerCount: 321,
      maxDurationSeconds: 3,
    });
    expect(response.run.configSnapshot.inventoryConfig.startingStock).toBe(44);
    expect(publicCustomPreset.trafficConfig).toMatchObject({
      mode: "buyer-spike",
      buyerCount: 10_000,
    });
    expect(publicCustomPreset.inventoryConfig.startingStock).toBe(1000);
  });

  it("uses updated persisted public custom defaults for the next public custom start", async () => {
    const managementService = createPresetManagementService(requireConnection(connection));
    const policy = publicRuntimePolicyMutable();
    policy.publicCustomDefaults = {
      ...policy.publicCustomDefaults,
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 222,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 4,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 55,
        quantityPerCheckout: 1,
        reservationHoldMinutes: 15,
      },
    };
    await managementService.updateAdminPublicRuntimePolicy({ policy }, "corr-policy-update");

    const startService = createStartService(requireConnection(connection), requireRedis(redis));
    const response = await startService.startRun(
      {
        presetSlug: "public-custom",
        operatorMode: "public",
        publicVisitorCredential: signedVisitor("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      },
      "corr-public-defaults",
    );

    expect(expectBuyerSpikeTrafficConfig(response.run.configSnapshot.trafficConfig)).toMatchObject({
      buyerCount: 222,
      maxDurationSeconds: 4,
    });
    expect(response.run.configSnapshot.inventoryConfig.startingStock).toBe(55);
  });

  it("allows admin run-scoped overrides for read-only public presets", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));

    const response = await service.startRun(
      {
        presetSlug: "preview-1k",
        operatorMode: "admin",
        configOverride: {
          trafficConfig: {
            mode: "buyer-spike",
            buyerCount: 123,
            duplicateEachBuyerAttempt: true,
            startDelaySeconds: 0,
            maxDurationSeconds: 5,
            quantityPerAttempt: 1,
          },
          inventoryConfig: {
            startingStock: 33,
            quantityPerCheckout: 1,
            reservationHoldMinutes: 15,
          },
        },
      },
      "corr-admin-public-override",
    );
    const previewPreset = await readPresetRow(requireConnection(connection), "preview-1k");

    expect(response.run.operatorMode).toBe("admin");
    expect(expectBuyerSpikeTrafficConfig(response.run.configSnapshot.trafficConfig)).toMatchObject({
      buyerCount: 123,
      duplicateEachBuyerAttempt: true,
    });
    expect(response.run.configSnapshot.inventoryConfig.startingStock).toBe(33);
    expect(previewPreset.trafficConfig).toMatchObject({
      mode: "buyer-spike",
      buyerCount: 10_000,
      duplicateEachBuyerAttempt: false,
    });
    expect(previewPreset.inventoryConfig.startingStock).toBe(1000);
  });

  it("does not consume public run budget for admin starts", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: {
        reserve: async () => {
          throw new Error("Admin starts should not consume public budget.");
        },
        release: async () => {
          throw new Error("Admin starts should not release public budget.");
        },
      },
    });

    const response = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-admin-budget-bypass",
    );

    expect(response.run.operatorMode).toBe("admin");
  });

  it("releases exactly once after a reserved acceptance failure and retains successful reservations", async () => {
    const reservation = {
      reservationId: "reservation-1",
      globalKey: "g",
      visitorKey: "v",
      reservationKey: "r",
    };
    const reserve = vi.fn(async () => ({ outcome: "allowed" as const, reservation }));
    const release = vi.fn(async () => undefined);
    const failing = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: { reserve, release },
      trafficExecutionGateway: {
        start: async () => {
          throw new Error("orchestrator unavailable");
        },
      },
    });
    await expect(
      failing.startRun(
        {
          presetSlug: "preview-1k",
          operatorMode: "public",
          publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        },
        "compensation-correlation",
      ),
    ).rejects.toThrow("orchestrator unavailable");
    expect(reserve).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledExactlyOnceWith(reservation);
  });

  it("preserves the primary failure and logs safe metadata when compensation fails", async () => {
    const reservation = {
      reservationId: "safe-reservation-id",
      globalKey: "secret-key",
      visitorKey: "secret-visitor",
      reservationKey: "secret-marker",
    };
    const logger = createSilentLogger("api");
    const errorLog = vi.spyOn(logger, "error");
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      logger,
      publicRunBudgetStore: {
        reserve: async () => ({ outcome: "allowed", reservation }),
        release: async () => {
          throw new Error("release failed");
        },
      },
      trafficExecutionGateway: {
        start: async () => {
          throw new Error("primary failure");
        },
      },
    });
    await expect(
      service.startRun(
        {
          presetSlug: "preview-1k",
          operatorMode: "public",
          publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        },
        "safe-correlation",
      ),
    ).rejects.toThrow("primary failure");
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "safe-correlation",
        reservationId: "safe-reservation-id",
      }),
      expect.any(String),
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("secret-key");
  });

  it("retains the public budget reservation after a successful accepted response", async () => {
    const release = vi.fn();
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: {
        reserve: async () => ({
          outcome: "allowed",
          reservation: {
            reservationId: "accepted",
            globalKey: "g",
            visitorKey: "v",
            reservationKey: "r",
          },
        }),
        release,
      },
    });
    const response = await service.startRun(
      {
        presetSlug: "preview-1k",
        operatorMode: "public",
        publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      },
      "accepted-correlation",
    );
    expect(response.run.status).toBe("active");
    expect(release).not.toHaveBeenCalled();
  });

  it("enforces updated public run-budget windows through Redis", async () => {
    const store = new RedisPublicRunBudgetStore(requireRedis(redis));
    const policy = publicRuntimePolicy();
    policy.publicRunBudget = {
      windowSeconds: 60,
      perVisitorMaxStarts: 1,
      globalMaxStarts: 2,
    };

    const firstDecision = await store.reserve({
      policy,
      publicVisitorId: "visitor-budget-1",
      now: new Date("2026-06-20T00:00:00.000Z"),
    });
    if (firstDecision.outcome !== "allowed") throw new Error("Expected allowed fixture decision.");
    const firstReservation = firstDecision.reservation;
    await expect(
      store.reserve({
        policy,
        publicVisitorId: "visitor-budget-1",
        now: new Date("2026-06-20T00:00:01.000Z"),
      }),
    ).resolves.toEqual({ outcome: "denied", reason: "visitor" });
    expect(await requireRedis(redis).get(firstReservation.globalKey)).toBe("1");
    expect(await requireRedis(redis).get(firstReservation.visitorKey)).toBe("1");
    await store.release(firstReservation);
    await store.release(firstReservation);
    expect(await requireRedis(redis).get(firstReservation.globalKey)).toBeNull();
    expect(await requireRedis(redis).get(firstReservation.visitorKey)).toBeNull();
    await store.reserve({
      policy,
      publicVisitorId: "visitor-budget-1",
      now: new Date("2026-06-20T00:00:59.000Z"),
    });

    await requireRedis(redis).flushdb();
    policy.publicRunBudget = {
      windowSeconds: 60,
      perVisitorMaxStarts: 10,
      globalMaxStarts: 2,
    };
    await store.reserve({
      policy,
      publicVisitorId: "visitor-budget-2",
      now: new Date("2026-06-20T00:00:02.000Z"),
    });
    await store.reserve({
      policy,
      publicVisitorId: "visitor-budget-3",
      now: new Date("2026-06-20T00:00:03.000Z"),
    });
    await expect(
      store.reserve({
        policy,
        publicVisitorId: "visitor-budget-4",
        now: new Date("2026-06-20T00:00:04.000Z"),
      }),
    ).resolves.toEqual({ outcome: "denied", reason: "global" });
  });

  it("atomically enforces concurrent budgets and exact-window idempotent release", async () => {
    const client = requireRedis(redis);
    await client.flushdb();
    const store = new RedisPublicRunBudgetStore(client);
    const policy = publicRuntimePolicy();
    policy.publicRunBudget = { windowSeconds: 60, perVisitorMaxStarts: 2, globalMaxStarts: 3 };
    const now = new Date("2026-06-20T00:00:00.000Z");

    const visitorDecisions = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.reserve({ policy, publicVisitorId: "concurrent", now }),
      ),
    );
    const visitorReservations = visitorDecisions.flatMap((decision) =>
      decision.outcome === "allowed" ? [decision.reservation] : [],
    );
    expect(visitorReservations).toHaveLength(2);
    const oldReservation = visitorReservations[0];
    if (!oldReservation) throw new Error("Expected a visitor reservation fixture.");
    expect(await client.get(oldReservation.globalKey)).toBe("2");
    expect(await client.get(oldReservation.visitorKey)).toBe("2");

    const allowedGlobal = await store.reserve({ policy, publicVisitorId: "other-a", now });
    expect(allowedGlobal.outcome).toBe("allowed");
    const globalBefore = await client.get(oldReservation.globalKey);
    const deniedGlobal = await store.reserve({ policy, publicVisitorId: "denied-visitor", now });
    expect(deniedGlobal).toEqual({ outcome: "denied", reason: "global" });
    const deniedKey = oldReservation.visitorKey.replace("concurrent", "denied-visitor");
    expect(await client.get(deniedKey)).toBeNull();
    expect(await client.get(oldReservation.globalKey)).toBe(globalBefore);
    const globalHashTag = oldReservation.globalKey.match(/\{\d+\}/)?.[0];
    expect(globalHashTag).toBeTruthy();
    expect(oldReservation.visitorKey).toContain(globalHashTag);
    expect(oldReservation.reservationKey).toContain(globalHashTag);

    const nextDecision = await store.reserve({
      policy,
      publicVisitorId: "concurrent",
      now: new Date("2026-06-20T00:01:00.000Z"),
    });
    if (nextDecision.outcome !== "allowed") throw new Error("Expected next-window reservation.");
    const nextWindow = nextDecision.reservation;
    expect(await client.ttl(nextWindow.globalKey)).toBeGreaterThanOrEqual(118);
    expect(await client.ttl(nextWindow.globalKey)).toBeLessThanOrEqual(120);
    await store.release(oldReservation);
    await store.release(oldReservation);
    expect(await client.get(nextWindow.globalKey)).toBe("1");
    expect(await client.get(nextWindow.visitorKey)).toBe("1");
  });

  it("writes a terminal summary when inventory initialization fails", async () => {
    const db = requireConnection(connection).db;
    const postgresTerminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(db);
    const writeTerminalRun = vi.fn(postgresTerminalRunWriter.write.bind(postgresTerminalRunWriter));
    const service = createStartService(requireConnection(connection), redisUnavailable(), {
      terminalRunWriter: { write: writeTerminalRun },
    });

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-start"),
    ).rejects.toThrow("Redis unavailable during initialization.");

    const summaries = await requireConnection(connection).db.select().from(demoRunSummaries);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      runId: "77777777-7777-4777-8777-777777777777",
      status: "failed",
      failureReason: "inventory_initialization_failed",
      terminalInventorySnapshot: null,
    });
    expect(summaries[0]?.httpSummary).toMatchObject({
      plannedRequests: 10_000,
      emittedRequests: 0,
    });
    expect(summaries[0]?.trafficDeliverySummary).toMatchObject({
      trafficDeliveryStatus: "failed",
      droppedIterations: 10_000,
    });
    expect(writeTerminalRun).toHaveBeenCalledOnce();
    expect(writeTerminalRun).toHaveBeenCalledWith(
      expect.objectContaining({
        failureReason: "inventory_initialization_failed",
        allowedCurrentStatuses: ["starting", "active"],
        terminalTrafficStatus: "failed",
      }),
    );
  });

  it("writes a terminal summary when load-orchestrator traffic start fails", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      trafficExecutionGateway: {
        start: async () => {
          throw new Error("load orchestrator unavailable");
        },
      },
    });

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-start"),
    ).rejects.toThrow("load orchestrator unavailable");

    const summaries = await requireConnection(connection).db.select().from(demoRunSummaries);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      runId: "77777777-7777-4777-8777-777777777777",
      status: "failed",
      failureReason: "load_orchestrator_start_failed",
    });
    expect(summaries[0]?.terminalInventorySnapshot).toMatchObject({
      saleOfferId: "77777777-7777-4777-8777-777777777778",
      startingStock: 1000,
      remainingStock: 1000,
      acceptedReservations: 0,
      source: "redis",
    });
  });

  it("repairs stale Redis acceptance when an existing summary terminalizes a failed start", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createStartService(requireConnection(connection), redisClient, {
      trafficExecutionGateway: {
        start: async (request) => {
          await db.insert(demoRunSummaries).values({
            runId: request.runId,
            presetName: "Preview 1k",
            status: "failed",
            failureReason: "existing_terminal_summary",
            startedAt: new Date("2026-06-20T00:00:10.000Z"),
            endedAt: new Date("2026-06-20T00:00:12.000Z"),
            httpSummary: {
              plannedRequests: 10_000,
              emittedRequests: 0,
              completedRequests: 0,
              failedRequests: 0,
              acceptedResponses: 0,
              soldOutResponses: 0,
              unexpectedResponses: 0,
              failureRate: 0,
            },
            trafficDeliverySummary: {
              plannedRequests: 10_000,
              emittedRequests: 0,
              droppedIterations: 10_000,
              trafficDeliveryStatus: "failed",
              notes: [],
            },
            httpTimingBreakdownSummary: {},
            loadRunDiagnosticsSummary: { source: "existing-summary" },
            apiRequestLifecycleSummary: { source: "existing-summary" },
            businessOutcomeSummary: emptyBusinessOutcomeSummary(),
            terminalInventorySnapshot: null,
            capturedAt: new Date("2026-06-20T00:00:12.000Z"),
          });
          throw new Error("load orchestrator unavailable");
        },
      },
    });

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-start"),
    ).rejects.toThrow("load orchestrator unavailable");

    const [run] = await db
      .select()
      .from(demoRuns)
      .where(eq(demoRuns.id, "77777777-7777-4777-8777-777777777777"));
    expect(run?.status).toBe("failed");
    await expect(
      isRunSaleEligible(redisClient, {
        runId: "77777777-7777-4777-8777-777777777777",
        saleOfferId: "77777777-7777-4777-8777-777777777778",
      }),
    ).resolves.toBe(false);
  });

  it("returns the draining run when fast traffic completion wins activation CAS", async () => {
    let releaseTrafficStart: (() => void) | undefined;
    let trafficStartEntered: (() => void) | undefined;
    const trafficStartEnteredPromise = new Promise<void>((resolve) => {
      trafficStartEntered = resolve;
    });
    const trafficStartReleasePromise = new Promise<void>((resolve) => {
      releaseTrafficStart = resolve;
    });
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      trafficExecutionGateway: {
        start: async (request) => {
          trafficStartEntered?.();
          await trafficStartReleasePromise;
          return {
            runId: request.runId,
            status: "active",
            startedAt: "2026-06-20T00:00:11.000Z",
            correlationId: request.correlationId,
          };
        },
      },
    });

    try {
      const startPromise = service.startRun(
        { presetSlug: "preview-1k", operatorMode: "admin" },
        "corr-fast-completion-start",
      );
      await trafficStartEnteredPromise;

      const completionRun = await service.recordTrafficCompletion({
        runId: "77777777-7777-4777-8777-777777777777",
        status: "succeeded",
        httpSummary: {
          plannedRequests: 10_000,
          emittedRequests: 0,
          completedRequests: 0,
          failedRequests: 0,
          acceptedResponses: 0,
          soldOutResponses: 0,
          unexpectedResponses: 0,
          failureRate: 0,
        },
        trafficOutcomeSummary: {},
        trafficDeliverySummary: {
          plannedRequests: 10_000,
          emittedRequests: 0,
          droppedIterations: 10_000,
          trafficDeliveryStatus: "complete",
          notes: [],
        },
        httpTimingBreakdownSummary: {},
        loadRunDiagnosticsSummary: {},
        apiRequestLifecycleSummary: {},
        completedAt: "2026-06-20T00:00:12.000Z",
        correlationId: "corr-fast-completion",
      });
      expect(completionRun).toMatchObject({
        runId: "77777777-7777-4777-8777-777777777777",
        status: "draining",
        trafficStatus: "succeeded",
        trafficEndedAt: "2026-06-20T00:00:12.000Z",
      });

      releaseTrafficStart?.();
      const startResponse = await startPromise;

      expect(startResponse.run).toMatchObject({
        runId: "77777777-7777-4777-8777-777777777777",
        status: "draining",
        trafficStatus: "succeeded",
        trafficEndedAt: "2026-06-20T00:00:12.000Z",
      });
      const [run] = await requireConnection(connection)
        .db.select()
        .from(demoRuns)
        .where(eq(demoRuns.id, "77777777-7777-4777-8777-777777777777"));
      const [finalization] = await requireConnection(connection)
        .db.select()
        .from(demoRunFinalizations)
        .where(eq(demoRunFinalizations.runId, "77777777-7777-4777-8777-777777777777"));
      expect(run).toMatchObject({
        status: "draining",
        trafficStatus: "succeeded",
        trafficEndedAt: new Date("2026-06-20T00:00:12.000Z"),
      });
      expect(finalization).toMatchObject({
        runId: "77777777-7777-4777-8777-777777777777",
        trafficSummaryReceivedAt: expect.any(Date),
      });
      await expect(
        isRunSaleEligible(requireRedis(redis), {
          runId: "77777777-7777-4777-8777-777777777777",
          saleOfferId: "77777777-7777-4777-8777-777777777778",
        }),
      ).resolves.toBe(false);
    } finally {
      releaseTrafficStart?.();
    }
  });

  it("keeps the first conflicting completion authoritative while concurrent redelivery repairs finalization", async () => {
    let releaseFirstEnrichment: () => void = () => undefined;
    let firstEnrichmentEntered: () => void = () => undefined;
    const firstEnrichmentGate = new Promise<void>((resolve) => {
      releaseFirstEnrichment = resolve;
    });
    const firstEnrichmentEnteredPromise = new Promise<void>((resolve) => {
      firstEnrichmentEntered = resolve;
    });
    let businessReads = 0;
    const finalizeRun = vi.fn().mockRejectedValueOnce(new Error("finalization temporarily failed"));
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      businessOutcomeReader: {
        read: async () => {
          businessReads += 1;
          if (businessReads === 1) {
            firstEnrichmentEntered();
            await firstEnrichmentGate;
          }
          return emptyBusinessOutcomeSummary();
        },
      },
      finalizationService: { finalizeRun, finalizeReadyRuns: async () => 0 },
    });
    const started = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-completion-concurrency-start",
    );
    const firstReport = trafficCompletionFixture({
      runId: started.run.runId,
      status: "succeeded",
      exitCode: 0,
      completedAt: "2026-06-20T00:00:12.000Z",
      plannedRequests: 111,
      correlationId: "corr-completion-first",
    });
    const conflictingReport = trafficCompletionFixture({
      runId: started.run.runId,
      status: "failed",
      exitCode: 9,
      errorMessage: "conflicting duplicate",
      completedAt: "2026-06-20T00:00:13.000Z",
      plannedRequests: 999,
      correlationId: "corr-completion-conflict",
    });
    const saleOfferId = started.run.saleOfferId;
    if (!saleOfferId) {
      throw new Error("Started run did not expose its sale offer.");
    }

    const first = service.recordTrafficCompletion(firstReport);
    await firstEnrichmentEnteredPromise;
    await expect(
      isRunSaleEligible(requireRedis(redis), {
        runId: started.run.runId,
        saleOfferId,
      }),
    ).resolves.toBe(false);
    await expect(
      reserveInventoryStock(requireRedis(redis), {
        idempotencyKey: "completion-race-buy",
        idempotencyTtlSeconds: 1800,
        reservation: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000093",
          saleOfferId,
          runId: started.run.runId,
          correlationId: "completion-race-buy-correlation",
          quantity: 1,
          status: "secured",
          reservationToken: "completion-race-buy-token",
          securedAt: "2026-06-20T00:00:12.000Z",
          expiresAt: "2026-06-20T00:15:12.000Z",
        },
      }),
    ).resolves.toEqual({ outcome: "run_not_accepting_traffic", reservation: null });
    const inventory = inventoryKeys(saleOfferId);
    await requireRedis(redis).hset(inventory.state, {
      remainingStock: "900",
      reservedStock: "100",
    });
    await requireRedis(redis).hset(inventory.reservationOutcomes, "api_sold_out_decision", "17");
    const duplicate = service.recordTrafficCompletion(conflictingReport);
    await expect(duplicate).rejects.toThrow("finalization temporarily failed");
    releaseFirstEnrichment();
    await expect(first).resolves.toMatchObject({ status: "draining" });

    const [run] = await requireConnection(connection)
      .db.select()
      .from(demoRuns)
      .where(eq(demoRuns.id, started.run.runId));
    const [finalization] = await requireConnection(connection)
      .db.select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    const [soldOutOutcome] = await requireConnection(connection)
      .db.select()
      .from(demoRunReservationOutcomes)
      .where(eq(demoRunReservationOutcomes.runId, started.run.runId));
    expect(finalizeRun).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({
      status: "draining",
      trafficStatus: "succeeded",
      trafficEndedAt: new Date(firstReport.completedAt),
    });
    expect(finalization).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      httpSummary: expect.objectContaining({ plannedRequests: 111 }),
      trafficDeliverySummary: expect.objectContaining({ plannedRequests: 111 }),
      completionEnrichmentStatus: "completed",
    });
    expect(finalization?.trafficOutcomeSummary).toMatchObject({
      terminalInventorySnapshot: expect.objectContaining({
        remainingStock: 900,
        reservedStock: 100,
        soldOutRejections: 17,
      }),
      businessOutcomeAtTrafficCompletion: emptyBusinessOutcomeSummary(),
    });
    expect(soldOutOutcome).toMatchObject({ count: 17, source: "redis" });

    const authoritativeOutcome = structuredClone(finalization?.trafficOutcomeSummary);
    await requireRedis(redis).hset(inventory.state, {
      remainingStock: "1",
      reservedStock: "999",
    });
    await requireRedis(redis).hset(inventory.reservationOutcomes, "api_sold_out_decision", "99");
    await expect(service.recordTrafficCompletion(conflictingReport)).resolves.toMatchObject({
      status: "draining",
    });
    const [afterRedelivery] = await requireConnection(connection)
      .db.select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    const [soldOutAfterRedelivery] = await requireConnection(connection)
      .db.select()
      .from(demoRunReservationOutcomes)
      .where(eq(demoRunReservationOutcomes.runId, started.run.runId));
    expect(afterRedelivery?.trafficOutcomeSummary).toEqual(authoritativeOutcome);
    expect(soldOutAfterRedelivery?.count).toBe(17);
    expect(businessReads).toBe(2);
  });

  it("re-drives real finalization after enrichment commits and Redis inventory is removed", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const enrichmentBusinessOutcome: BusinessOutcomeSummary = {
      ...emptyBusinessOutcomeSummary(),
      acceptedReservations: 149,
      soldOutRejections: 23,
    };
    const readBusinessOutcome = vi.fn(async () => enrichmentBusinessOutcome);
    let captureReadCount = 0;
    const captureRedis = new Proxy(redisClient, {
      get(target, property) {
        if (property === "hgetall") {
          return async (...args: Parameters<typeof target.hgetall>) => {
            captureReadCount += 1;
            return target.hgetall(...args);
          };
        }
        const value = target[property as keyof typeof target];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof redisClient;
    const completionEnrichmentService = new TrafficCompletionEnrichmentService({
      db,
      redis: captureRedis,
      businessOutcomeReader: { read: readBusinessOutcome },
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const postgresWriter = new PostgresTerminalDemoRunSummaryWriter(db);
    let writeAttemptCount = 0;
    const write = vi.fn(async (input: Parameters<typeof postgresWriter.write>[0]) => {
      writeAttemptCount += 1;
      if (writeAttemptCount === 1) {
        throw new Error("injected failure before terminal summary persistence");
      }
      return postgresWriter.write(input);
    });
    let reconciliationCount = 0;
    const reconcileSaleOffer = vi.fn(async (saleOfferId: string) => {
      reconciliationCount += 1;
      if (reconciliationCount > 1) {
        await initializeInventory(redisClient, {
          saleOfferId,
          allocatedStock: 7,
          initializedAt: new Date("2026-06-20T00:00:20.000Z"),
          run: { runId: startedRunId, status: "closed" },
        });
      }
      return { found: 0, materialized: 0, reconciled: 0, reversed: 0, failed: 0 };
    });
    let startedRunId = "";
    const finalizationService = new DemoRunFinalizationService({
      db,
      redis: redisClient,
      logger: createSilentLogger("api"),
      pendingPersistenceReconciler: { reconcileSaleOffer },
      terminalRunWriter: { write },
      now: () => new Date("2026-06-20T00:00:15.000Z"),
    });
    const service = createStartService(requireConnection(connection), redisClient, {
      businessOutcomeReader: { read: readBusinessOutcome },
      completionEnrichmentService,
      finalizationService,
    });
    const started = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-post-enrichment-start",
    );
    startedRunId = started.run.runId;
    const saleOfferId = started.run.saleOfferId;
    if (!saleOfferId) {
      throw new Error("Started run did not expose its sale offer.");
    }
    const inventory = inventoryKeys(saleOfferId);
    await redisClient.hset(inventory.state, { remainingStock: "850", reservedStock: "150" });
    await redisClient.hset(inventory.reservationOutcomes, "api_sold_out_decision", "23");
    const report: TrafficCompletionReport = {
      ...trafficCompletionFixture({
        runId: started.run.runId,
        status: "succeeded",
        exitCode: 0,
        completedAt: "2026-06-20T00:00:12.000Z",
        plannedRequests: 10,
        correlationId: "corr-post-enrichment",
      }),
      trafficDeliverySummary: {
        plannedRequests: 10,
        emittedRequests: 10,
        droppedIterations: 0,
        trafficDeliveryStatus: "complete",
        notes: [],
      },
    };

    await expect(service.recordTrafficCompletion(report)).rejects.toThrow(
      "injected failure before terminal summary persistence",
    );
    const [committedFinalization] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    const [committedSoldOut] = await db
      .select()
      .from(demoRunReservationOutcomes)
      .where(eq(demoRunReservationOutcomes.runId, started.run.runId));
    const authoritativeOutcome = structuredClone(committedFinalization?.trafficOutcomeSummary);
    const authoritativeSnapshot = (
      authoritativeOutcome as { terminalInventorySnapshot?: unknown }
    ).terminalInventorySnapshot;

    expect(committedFinalization?.completionEnrichmentStatus).toBe("completed");
    expect(authoritativeOutcome).toMatchObject({
      businessOutcomeAtTrafficCompletion: enrichmentBusinessOutcome,
      terminalInventorySnapshot: {
        saleOfferId,
        remainingStock: 850,
        reservedStock: 150,
        acceptedReservations: 149,
        soldOutRejections: 23,
        capturedAt: "2026-06-20T00:00:10.000Z",
      },
    });
    expect(committedSoldOut?.count).toBe(23);
    expect(await db.select().from(demoRunSummaries)).toHaveLength(0);

    await redisClient.unlink(
      inventory.state,
      inventory.reservations,
      inventory.reservationExpirations,
      inventory.pendingPersistence,
      inventory.pendingPersistenceRecords,
      inventory.events,
      inventory.reservationOutcomes,
      inventory.reservationThroughput,
      runSaleEligibilityKey(started.run.runId),
    );

    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "completed",
    });
    const [afterRedelivery] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    const [soldOutAfterRedelivery] = await db
      .select()
      .from(demoRunReservationOutcomes)
      .where(eq(demoRunReservationOutcomes.runId, started.run.runId));
    const summaries = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, started.run.runId));

    expect(afterRedelivery?.trafficOutcomeSummary).toEqual(authoritativeOutcome);
    expect(soldOutAfterRedelivery?.count).toBe(23);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.terminalInventorySnapshot).toEqual(authoritativeSnapshot);
    expect(captureReadCount).toBe(1);
    expect(readBusinessOutcome).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("keeps a claimed completion non-terminal until enrichment durably concludes", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    let releaseEnrichment: () => void = () => undefined;
    let enrichmentEntered: () => void = () => undefined;
    const enrichmentGate = new Promise<void>((resolve) => {
      releaseEnrichment = resolve;
    });
    const enrichmentEnteredPromise = new Promise<void>((resolve) => {
      enrichmentEntered = resolve;
    });
    const businessOutcomeReader = {
      read: async () => {
        enrichmentEntered();
        await enrichmentGate;
        return emptyBusinessOutcomeSummary();
      },
    };
    const finalizationService = new DemoRunFinalizationService({
      db,
      redis: redisClient,
      logger: createSilentLogger("api"),
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const service = createStartService(requireConnection(connection), redisClient, {
      businessOutcomeReader,
      finalizationService,
    });
    const started = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-pending-enrichment-start",
    );
    const report: TrafficCompletionReport = {
      ...trafficCompletionFixture({
        runId: started.run.runId,
        status: "succeeded",
        exitCode: 0,
        completedAt: "2026-06-20T00:00:12.000Z",
        plannedRequests: 10,
        correlationId: "corr-pending-enrichment",
      }),
      trafficDeliverySummary: {
        plannedRequests: 10,
        emittedRequests: 10,
        droppedIterations: 0,
        trafficDeliveryStatus: "complete",
        notes: [],
      },
    };

    try {
      const completion = service.recordTrafficCompletion(report);
      await enrichmentEnteredPromise;
      const [pending] = await db
        .select()
        .from(demoRunFinalizations)
        .where(eq(demoRunFinalizations.runId, started.run.runId));

      expect(pending?.completionEnrichmentStatus).toBe("pending");
      await expect(
        finalizationService.finalizeRun(started.run.runId, report.correlationId),
      ).resolves.toMatchObject({ status: "draining" });
      expect(
        await db
          .select()
          .from(demoRunSummaries)
          .where(eq(demoRunSummaries.runId, started.run.runId)),
      ).toHaveLength(0);

      releaseEnrichment();
      await expect(completion).resolves.toMatchObject({ status: "completed" });
      const [concluded] = await db
        .select()
        .from(demoRunFinalizations)
        .where(eq(demoRunFinalizations.runId, started.run.runId));
      const [summary] = await db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, started.run.runId));

      expect(concluded?.completionEnrichmentStatus).toBe("completed");
      expect(summary?.terminalInventorySnapshot).toEqual(
        (concluded?.trafficOutcomeSummary as Record<string, unknown>)?.terminalInventorySnapshot,
      );
    } finally {
      releaseEnrichment();
    }
  });

  it("repairs enrichment that failed after the durable claim on redelivery", async () => {
    const db = requireConnection(connection).db;
    let businessReadCount = 0;
    const finalizeRun = vi.fn(async () => null);
    const businessOutcomeReader = {
      read: async () => {
        businessReadCount += 1;
        if (businessReadCount === 1) {
          throw new Error("injected failure before enrichment persistence");
        }
        return emptyBusinessOutcomeSummary();
      },
    };
    const completionEnrichmentService = new TrafficCompletionEnrichmentService({
      db,
      redis: requireRedis(redis),
      businessOutcomeReader,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      businessOutcomeReader,
      completionEnrichmentService,
      finalizationService: { finalizeRun, finalizeReadyRuns: async () => 0 },
    });
    const started = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-enrichment-repair-start",
    );
    const report = trafficCompletionFixture({
      runId: started.run.runId,
      status: "succeeded",
      exitCode: 0,
      completedAt: "2026-06-20T00:00:12.000Z",
      plannedRequests: 10,
      correlationId: "corr-enrichment-repair",
    });

    await expect(service.recordTrafficCompletion(report)).rejects.toThrow(
      "injected failure before enrichment persistence",
    );
    let [finalization] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    expect(finalization?.completionEnrichmentStatus).toBe("pending");
    expect(finalizeRun).not.toHaveBeenCalled();

    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "draining",
    });
    [finalization] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    expect(finalization?.completionEnrichmentStatus).toBe("completed");
    expect(finalizeRun).toHaveBeenCalledOnce();
    expect(businessReadCount).toBe(2);
  });

  it("repairs abandoned pending enrichment through periodic reconciliation", async () => {
    const db = requireConnection(connection).db;
    let businessReadCount = 0;
    const businessOutcomeReader = {
      read: async () => {
        businessReadCount += 1;
        if (businessReadCount === 1) {
          throw new Error("injected abandoned enrichment");
        }
        return emptyBusinessOutcomeSummary();
      },
    };
    const completionEnrichmentService = new TrafficCompletionEnrichmentService({
      db,
      redis: requireRedis(redis),
      businessOutcomeReader,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      businessOutcomeReader,
      completionEnrichmentService,
      finalizationService: { finalizeRun: async () => null, finalizeReadyRuns: async () => 0 },
    });
    const started = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-periodic-enrichment-start",
    );
    const report = trafficCompletionFixture({
      runId: started.run.runId,
      status: "succeeded",
      exitCode: 0,
      completedAt: "2026-06-20T00:00:12.000Z",
      plannedRequests: 10,
      correlationId: "corr-periodic-enrichment",
    });

    await expect(service.recordTrafficCompletion(report)).rejects.toThrow(
      "injected abandoned enrichment",
    );
    await expect(completionEnrichmentService.reconcilePendingEnrichments()).resolves.toBe(1);
    const [finalization] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));

    expect(finalization?.completionEnrichmentStatus).toBe("completed");
    expect(businessReadCount).toBe(2);
  });

  it("keeps a completed Redis capture failure as an immutable no-snapshot result", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    let failCapture = true;
    let captureReadCount = 0;
    const captureRedis = new Proxy(redisClient, {
      get(target, property) {
        if (property === "hgetall") {
          return async (...args: Parameters<typeof target.hgetall>) => {
            captureReadCount += 1;
            if (failCapture) {
              throw new Error("injected Redis capture failure");
            }
            return target.hgetall(...args);
          };
        }
        const value = target[property as keyof typeof target];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof redisClient;
    const businessOutcomeReader = { read: async () => emptyBusinessOutcomeSummary() };
    const completionEnrichmentService = new TrafficCompletionEnrichmentService({
      db,
      redis: captureRedis,
      businessOutcomeReader,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const finalizationService = new DemoRunFinalizationService({
      db,
      redis: redisClient,
      logger: createSilentLogger("api"),
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const service = createStartService(requireConnection(connection), redisClient, {
      businessOutcomeReader,
      completionEnrichmentService,
      finalizationService,
    });
    const started = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-no-snapshot-start",
    );
    const report: TrafficCompletionReport = {
      ...trafficCompletionFixture({
        runId: started.run.runId,
        status: "succeeded",
        exitCode: 0,
        completedAt: "2026-06-20T00:00:12.000Z",
        plannedRequests: 10,
        correlationId: "corr-no-snapshot",
      }),
      trafficDeliverySummary: {
        plannedRequests: 10,
        emittedRequests: 10,
        droppedIterations: 0,
        trafficDeliveryStatus: "complete",
        notes: [],
      },
    };

    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "completed",
    });
    failCapture = false;
    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "completed",
    });
    const [finalization] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, started.run.runId));

    expect(finalization?.completionEnrichmentStatus).toBe("completed");
    expect(finalization?.trafficOutcomeSummary).not.toHaveProperty("terminalInventorySnapshot");
    expect(summary?.terminalInventorySnapshot).toBeNull();
    expect(captureReadCount).toBe(1);
  });

  it("returns the reset run when a delayed orchestrator acknowledgement loses activation CAS", async () => {
    const startConnection = requireConnection(connection);
    const resetConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    let releaseTrafficStart: (() => void) | undefined;
    let trafficStartEntered: (() => void) | undefined;
    const trafficStartEnteredPromise = new Promise<void>((resolve) => {
      trafficStartEntered = resolve;
    });
    const trafficStartReleasePromise = new Promise<void>((resolve) => {
      releaseTrafficStart = resolve;
    });

    const service = createStartService(startConnection, requireRedis(redis), {
      trafficExecutionGateway: {
        start: async (request) => {
          trafficStartEntered?.();
          await trafficStartReleasePromise;
          return {
            runId: request.runId,
            status: "active",
            startedAt: "2026-06-20T00:00:11.000Z",
            correlationId: request.correlationId,
          };
        },
      },
    });
    const resetService = new DemoMaintenanceService({
      db: resetConnection.db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(resetConnection.db),
      redis: requireRedis(redis),
      queueMaintenance: {
        cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
      },
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:20.000Z"),
    });

    try {
      const startPromise = service.startRun(
        { presetSlug: "preview-1k", operatorMode: "admin" },
        "corr-delayed-start",
      );
      await trafficStartEnteredPromise;

      const resetResponse = await resetService.reset("corr-reset-race");
      expect(resetResponse.failedRunCount).toBe(1);

      releaseTrafficStart?.();
      const startResponse = await startPromise;

      expect(startResponse.run).toMatchObject({
        runId: "77777777-7777-4777-8777-777777777777",
        status: "failed",
        trafficStatus: "failed",
        failureReason: "admin_reset",
        finalizedAt: "2026-06-20T00:00:20.000Z",
      });
      const [run] = await startConnection.db
        .select()
        .from(demoRuns)
        .where(eq(demoRuns.id, "77777777-7777-4777-8777-777777777777"));
      const [summary] = await startConnection.db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, "77777777-7777-4777-8777-777777777777"));
      expect(run).toMatchObject({ status: "failed", failureReason: "admin_reset" });
      expect(summary).toMatchObject({
        status: "failed",
        failureReason: "admin_reset",
        endedAt: new Date("2026-06-20T00:00:20.000Z"),
      });
    } finally {
      releaseTrafficStart?.();
      await resetConnection.close();
    }
  });
});

function surge10kSnapshot(): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10_000,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 2,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 1000,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 150,
      maxTps: 250,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 10,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for API tests.");
  }

  return databaseUrl;
}

function requireConnection(
  connection: ReturnType<typeof createDatabaseConnection> | null,
): ReturnType<typeof createDatabaseConnection> {
  if (!connection) {
    throw new Error("Test database connection was not initialized.");
  }

  return connection;
}

function requireTestRedisUrl(): string {
  const redisUrl = process.env.TEST_REDIS_URL;

  if (!redisUrl) {
    throw new Error("TEST_REDIS_URL is required for API demo-run tests.");
  }

  return redisUrl;
}

function requireRedis(
  redis: ReturnType<typeof createRedisClient> | null,
): ReturnType<typeof createRedisClient> {
  if (!redis) {
    throw new Error("Test Redis client was not initialized.");
  }

  return redis;
}

function createPresetManagementService(
  connection: ReturnType<typeof createDatabaseConnection>,
): DemoRunService {
  return new DemoRunService({
    db: connection.db,
    terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(connection.db),
    redis: {} as never,
    trafficExecutionGateway: {
      start: async () => ({
        runId: "unused",
        status: "active",
        startedAt: "unused",
        correlationId: "unused",
      }),
    },
    publicRunBudgetStore: {
      reserve: async () => ({
        outcome: "allowed",
        reservation: {
          reservationId: "unused",
          globalKey: "g",
          visitorKey: "v",
          reservationKey: "r",
        },
      }),
      release: async () => undefined,
    },
    trafficMetricStore: {} as never,
    businessOutcomeReader: { read: async () => emptyBusinessOutcomeSummary() },
    completionEnrichmentService: { completePendingEnrichment: async () => "not_found" },
    apiBaseUrl: "http://api.test",
    buyEndpointPath: "/buy",
    logger: createSilentLogger("api"),
    publicClientCookieSecret: publicCookieSecret,
    now: () => new Date("2026-06-20T00:00:10.000Z"),
    generateId: () => "66666666-6666-4666-8666-666666666666",
  });
}

function createStartService(
  connection: ReturnType<typeof createDatabaseConnection>,
  redis: ReturnType<typeof createRedisClient>,
  overrides: {
    trafficExecutionGateway?: ConstructorParameters<
      typeof DemoRunService
    >[0]["trafficExecutionGateway"];
    publicRunBudgetStore?: ConstructorParameters<typeof DemoRunService>[0]["publicRunBudgetStore"];
    terminalRunWriter?: ConstructorParameters<typeof DemoRunService>[0]["terminalRunWriter"];
    businessOutcomeReader?: ConstructorParameters<
      typeof DemoRunService
    >[0]["businessOutcomeReader"];
    finalizationService?: ConstructorParameters<typeof DemoRunService>[0]["finalizationService"];
    completionEnrichmentService?: ConstructorParameters<
      typeof DemoRunService
    >[0]["completionEnrichmentService"];
    logger?: ConstructorParameters<typeof DemoRunService>[0]["logger"];
  } = {},
): DemoRunService {
  const ids = [
    "77777777-7777-4777-8777-777777777777",
    "77777777-7777-4777-8777-777777777778",
    "77777777-7777-4777-8777-777777777779",
    "77777777-7777-4777-8777-777777777780",
  ];

  const businessOutcomeReader = overrides.businessOutcomeReader ?? {
    read: async () => emptyBusinessOutcomeSummary(),
  };
  const logger = overrides.logger ?? createSilentLogger("api");
  const completionEnrichmentService =
    overrides.completionEnrichmentService ??
    new TrafficCompletionEnrichmentService({
      db: connection.db,
      redis,
      businessOutcomeReader,
      logger,
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });

  return new DemoRunService({
    db: connection.db,
    terminalRunWriter:
      overrides.terminalRunWriter ?? new PostgresTerminalDemoRunSummaryWriter(connection.db),
    redis,
    trafficExecutionGateway: overrides.trafficExecutionGateway ?? {
      start: async (request) => ({
        runId: request.runId,
        status: "active",
        startedAt: "2026-06-20T00:00:11.000Z",
        correlationId: request.correlationId,
      }),
    },
    publicRunBudgetStore: overrides.publicRunBudgetStore ?? {
      reserve: async () => ({
        outcome: "allowed",
        reservation: {
          reservationId: "unused",
          globalKey: "g",
          visitorKey: "v",
          reservationKey: "r",
        },
      }),
      release: async () => undefined,
    },
    trafficMetricStore: {} as never,
    businessOutcomeReader,
    completionEnrichmentService,
    ...(overrides.finalizationService
      ? { finalizationService: overrides.finalizationService }
      : {}),
    apiBaseUrl: "http://api.test",
    buyEndpointPath: "/buy",
    logger,
    publicClientCookieSecret: publicCookieSecret,
    now: () => new Date("2026-06-20T00:00:10.000Z"),
    generateId: () => {
      const id = ids.shift();
      if (!id) {
        throw new Error("Start-service ID sequence exhausted.");
      }
      return id;
    },
  });
}

function redisUnavailable(): ReturnType<typeof createRedisClient> {
  return {
    hget: async () => {
      throw new Error("Redis unavailable during initialization.");
    },
    eval: async () => {
      throw new Error("Redis unavailable during cleanup.");
    },
    hgetall: async () => {
      throw new Error("Redis unavailable during snapshot capture.");
    },
    publish: async () => {
      throw new Error("Redis unavailable during event publication.");
    },
  } as unknown as ReturnType<typeof createRedisClient>;
}

function expectBuyerSpikeTrafficConfig(
  trafficConfig: TrafficConfig,
): Extract<TrafficConfig, { mode: "buyer-spike" }> {
  if (trafficConfig.mode !== "buyer-spike") {
    throw new Error(`Expected buyer-spike traffic config, received ${trafficConfig.mode}.`);
  }

  return trafficConfig;
}

async function readPresetRow(
  connection: ReturnType<typeof createDatabaseConnection>,
  slug: string,
): Promise<typeof demoPresets.$inferSelect> {
  const presets = await connection.db.select().from(demoPresets);
  const preset = presets.find((candidate) => candidate.slug === slug);

  if (!preset) {
    throw new Error(`Expected seeded preset ${slug}.`);
  }

  return preset;
}

function emptyBusinessOutcomeSummary(): BusinessOutcomeSummary {
  return {
    acceptedReservations: 0,
    soldOutRejections: 0,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: 0,
    failedOrders: 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: 0,
  };
}

function trafficCompletionFixture(input: {
  runId: string;
  status: "succeeded" | "failed";
  exitCode: number;
  errorMessage?: string;
  completedAt: string;
  plannedRequests: number;
  correlationId: string;
}): TrafficCompletionReport {
  return {
    runId: input.runId,
    status: input.status,
    exitCode: input.exitCode,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    httpSummary: {
      plannedRequests: input.plannedRequests,
      emittedRequests: 0,
      completedRequests: 0,
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficOutcomeSummary: {},
    trafficDeliverySummary: {
      plannedRequests: input.plannedRequests,
      emittedRequests: 0,
      droppedIterations: input.plannedRequests,
      trafficDeliveryStatus: "failed",
      notes: [],
    },
    httpTimingBreakdownSummary: {},
    loadRunDiagnosticsSummary: {},
    apiRequestLifecycleSummary: {},
    completedAt: input.completedAt,
    correlationId: input.correlationId,
  };
}

async function seedStartFixtures(
  connection: ReturnType<typeof createDatabaseConnection>,
): Promise<void> {
  await connection.db.insert(products).values({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sku: "START-GATING-001",
    slug: "start-gating-product",
    name: "Start Gating Product",
    isActive: true,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await seedPresetFixtures(connection);
  await connection.db.insert(publicRuntimePolicies).values({
    id: "active",
    policy: publicRuntimePolicy(),
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
}

async function seedExistingRun(
  connection: ReturnType<typeof createDatabaseConnection>,
  input: {
    runId: string;
    status: "starting" | "active" | "draining" | "completed" | "failed";
  },
): Promise<void> {
  await connection.db.insert(demoRuns).values({
    id: input.runId,
    presetId: "33333333-3333-4333-8333-333333333331",
    presetName: "Preview 1k",
    operatorMode: "admin",
    status: input.status,
    trafficStatus: trafficStatusForRunStatus(input.status),
    configSnapshot: surge10kSnapshot(),
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
    ...(input.status === "draining" || input.status === "completed" || input.status === "failed"
      ? { trafficEndedAt: new Date("2026-06-20T00:00:05.000Z") }
      : {}),
    ...(input.status === "completed" || input.status === "failed"
      ? { finalizedAt: new Date("2026-06-20T00:00:06.000Z") }
      : {}),
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:06.000Z"),
  });
}

function trafficStatusForRunStatus(
  status: "starting" | "active" | "draining" | "completed" | "failed",
): "starting" | "active" | "succeeded" | "failed" {
  if (status === "starting" || status === "active") {
    return status;
  }
  if (status === "failed") {
    return "failed";
  }

  return "succeeded";
}

function existingRunId(status: "starting" | "active" | "draining" | "completed" | "failed") {
  const suffix = {
    starting: "1",
    active: "2",
    draining: "3",
    completed: "4",
    failed: "5",
  }[status];

  return `55555555-5555-4555-8555-55555555555${suffix}`;
}

async function seedPresetFixtures(
  connection: ReturnType<typeof createDatabaseConnection>,
): Promise<void> {
  const now = new Date("2026-06-20T00:00:00.000Z");
  const snapshot = surge10kSnapshot();

  await connection.db.insert(demoPresets).values([
    {
      id: "33333333-3333-4333-8333-333333333331",
      slug: "preview-1k",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      display: {
        name: "Preview 1k",
        description: "Preview run.",
        sortOrder: 10,
        outcomeFocus: ["happy_path"],
      },
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "33333333-3333-4333-8333-333333333335",
      slug: "public-custom",
      visibility: "public",
      isEditable: false,
      isCustom: true,
      display: {
        name: "Public Custom",
        description: "Public custom base.",
        sortOrder: 20,
        outcomeFocus: [],
      },
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "44444444-4444-4444-8444-444444444443",
      slug: "custom",
      visibility: "admin",
      isEditable: true,
      isCustom: true,
      display: {
        name: "Custom",
        description: "Editable scratch preset.",
        sortOrder: 120,
        outcomeFocus: [],
      },
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

function publicRuntimePolicy(): PublicRuntimePolicy {
  return {
    isPublicRunBudgetEnforced: true,
    publicRunBudget: {
      windowSeconds: 300,
      perVisitorMaxStarts: 2,
      globalMaxStarts: 6,
    },
    publicCustomDefaults: {
      ...surge10kSnapshot(),
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 500,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 10,
        quantityPerAttempt: 1,
      },
      erpConfig: {
        latencyMs: 100,
        maxTps: 100,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 2000,
      },
      backpressureConfig: {
        queueName: "orders:process",
        physicalQueueName: "orders-process",
        orderProcessConcurrency: 5,
        retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
        drainTimeoutSeconds: 300,
        pendingPersistenceRetryAfterSeconds: 30,
        circuitBreakerFailureThreshold: 5,
        circuitBreakerResetTimeoutMs: 10_000,
      },
    },
    publicCustomLimits: {
      maxTotalRequests: 10_000,
      maxBuyers: 10_000,
      maxRequestsPerSecond: 1000,
      maxTrafficDurationSeconds: 120,
      maxTrafficStartDelaySeconds: 10,
      maxPreAllocatedVus: 1000,
      maxVus: 1000,
      maxStartingStock: 1000,
      maxErpLatencyMs: 2000,
      minErpMaxTps: 1,
      maxErpMaxTps: 100,
      maxErpErrorRate: 0.25,
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike", "steady-arrival-rate"],
    },
    deploymentHardCaps: {
      maxBuyers: 100_000,
      maxTotalRequests: 100_000,
      maxRequestsPerSecond: 10_000,
      maxTrafficDurationSeconds: 300,
      maxTrafficStartDelaySeconds: 30,
      maxPreAllocatedVus: 10_000,
      maxVus: 10_000,
    },
  };
}

function publicRuntimePolicyMutable() {
  const policy = publicRuntimePolicy();

  return {
    isPublicRunBudgetEnforced: policy.isPublicRunBudgetEnforced,
    publicRunBudget: policy.publicRunBudget,
    publicCustomDefaults: policy.publicCustomDefaults,
    publicCustomLimits: policy.publicCustomLimits,
  };
}
