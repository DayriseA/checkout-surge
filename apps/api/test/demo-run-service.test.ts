import type {
  AcceptedRunConfigSnapshot,
  PublicRuntimePolicy,
  TrafficConfig,
  TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import {
  adaptiveErpAdmissionEnginePolicyIdentity,
  destructiveResetReasonValues,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  trafficDeliverySummarySchema,
} from "@checkout-surge/contracts";
import { signPublicVisitorCredential } from "@checkout-surge/contracts/public-visitor-credential";
import {
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  isRunSaleEligible,
  products,
  publicRuntimePolicies,
  saleOffers,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../src/runtime/errors.js";
import { AdminDemoResetService } from "../src/services/admin-demo-reset-service.js";
import { RedisDashboardTrafficMetricStore } from "../src/services/dashboard-traffic-metric-store.js";
import { ProcessLocalDemoMaintenanceAuthority } from "../src/services/demo-maintenance-authority.js";
import { DemoPresetService } from "../src/services/demo-preset-service.js";
import { emptyBusinessOutcomeSummary } from "../src/services/demo-run-projections.js";
import {
  DemoRunLifecycleService,
  isSingleNonTerminalRunViolation,
  validateAcceptedRunSnapshot,
} from "../src/services/demo-run-service.js";
import { DemoRunValidationError } from "../src/services/demo-run-validation-error.js";
import { PostgresDemoResetWorkflowFence } from "../src/services/postgres-demo-reset-workflow-fence.js";
import { RedisPublicRunBudgetStore } from "../src/services/public-run-budget-store.js";
import { PublicRuntimePolicyService } from "../src/services/public-runtime-policy-service.js";
import { RunHistoryService } from "../src/services/run-history-service.js";
import { PostgresTerminalDemoRunSummaryWriter } from "../src/services/terminal-demo-run-transition.js";

const publicCookieSecret = "test-public-cookie-secret";
const signedVisitor = (visitorId: string) => {
  const credential = signPublicVisitorCredential(publicCookieSecret, visitorId, 1_750_000_000_000);
  if (!credential) throw new Error("Fixture visitor credential could not be signed.");
  return credential;
};

describe("demo-run lifecycle validation", () => {
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
    const service = new DemoRunLifecycleService({
      db: { select } as never,
      redis: {} as never,
      presetReader: {
        readActivePreset: async () => {
          throw new Error("Preset must not be read.");
        },
      },
      runtimePolicyReader: {
        readEffectivePolicy: async () => {
          throw new Error("Policy must not be read.");
        },
      },
      trafficExecutionGateway: {} as never,
      publicRunBudgetStore: { reserve, release: vi.fn() },
      businessOutcomeReader: {} as never,
      terminalRunWriter: {} as never,
      apiBaseUrl: "http://api.test",
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

  it("retains authoritative forced-outage enforcement for public custom snapshots", () => {
    const policy = publicRuntimePolicy();
    const snapshot = {
      ...policy.publicCustomDefaults,
      erpConfig: { ...policy.publicCustomDefaults.erpConfig, forcedOutage: true },
    };

    expect(() =>
      validateAcceptedRunSnapshot(snapshot, policy, {
        operatorMode: "public",
        enforcePublicCustomLimits: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_run_configuration",
        details: expect.objectContaining({
          violationCode: "public_forced_outage_not_allowed",
          path: ["erpConfig", "forcedOutage"],
        }),
      }),
    );

    policy.publicCustomLimits.allowForcedOutage = true;
    expect(() =>
      validateAcceptedRunSnapshot(snapshot, policy, {
        operatorMode: "public",
        enforcePublicCustomLimits: true,
      }),
    ).not.toThrow();
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

    await resetTestDatabase();
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

  it("rejects an archived preset before creating a run", async () => {
    const activeConnection = requireConnection(connection);
    const presetService = new DemoPresetService({
      db: activeConnection.db,
      now: () => new Date("2026-06-20T00:00:10.000Z"),
      generateId: () => "66666666-6666-4666-8666-666666666666",
    });
    await presetService.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "archived-before-start",
    });
    await presetService.archiveAdminPreset({ slug: "archived-before-start" });

    const service = createStartService(activeConnection, requireRedis(redis));
    await expect(
      service.startRun(
        { presetSlug: "archived-before-start", operatorMode: "admin" },
        "corr-archived-start",
      ),
    ).rejects.toMatchObject({ code: "resource_not_found" });
    expect(await activeConnection.db.select().from(demoRuns)).toHaveLength(0);
  });

  it("persists the shared engine-policy identity with each accepted run", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-engine-policy"),
    ).resolves.toMatchObject({ run: { runId: "77777777-7777-4777-8777-777777777777" } });

    const [run] = await requireConnection(connection)
      .db.select({
        enginePolicyName: demoRuns.enginePolicyName,
        enginePolicyVersion: demoRuns.enginePolicyVersion,
      })
      .from(demoRuns);
    expect(run).toEqual({
      enginePolicyName: adaptiveErpAdmissionEnginePolicyIdentity.name,
      enginePolicyVersion: adaptiveErpAdmissionEnginePolicyIdentity.version,
    });
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
      code: "run_conflict",
      details: { conflictReason: "active_run_exists", status },
    });
  });

  it("holds a successor start during abort, rejects it after failure, and admits it after repair", async () => {
    const primary = requireConnection(connection);
    const redisClient = requireRedis(redis);
    const resetConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 2 });
    await seedExistingRun(primary, { runId: existingRunId("active"), status: "active" });
    let releaseAbort!: () => void;
    let abortEntered!: () => void;
    const abortRelease = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const abortStarted = new Promise<void>((resolve) => {
      abortEntered = resolve;
    });
    let abortAttempt = 0;
    const queueCleanup = vi.fn(async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }));
    const resetService = new AdminDemoResetService({
      db: resetConnection.db,
      redis: redisClient,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(resetConnection.db),
      queueMaintenance: {
        cleanRuns: queueCleanup,
      },
      clearErpCircuitBreakerState: async () => undefined,
      trafficAborter: {
        abortCurrent: async () => {
          abortAttempt += 1;
          if (abortAttempt === 1) {
            abortEntered();
            await abortRelease;
            throw new ApiHttpError({
              statusCode: 502,
              code: "load_orchestrator_abort_unconfirmed",
              message: "Traffic termination could not be confirmed.",
            });
          }
          return { outcome: "no_current_run" };
        },
      },
      dashboardLiveStateReset: new RedisDashboardTrafficMetricStore(redisClient),
      resetWorkflowFence: new PostgresDemoResetWorkflowFence(resetConnection.sql),
      maintenanceAuthority: new ProcessLocalDemoMaintenanceAuthority(),
      logger: createSilentLogger("api"),
    });
    const start = vi.fn(async (request: TrafficExecutionStartRequest) => ({
      runId: request.runId,
      status: "active" as const,
      startedAt: "2026-07-13T00:00:01.000Z",
      correlationId: request.correlationId,
    }));
    const startService = createStartService(primary, redisClient, {
      trafficExecutionGateway: { start },
    });

    try {
      const resetPromise = resetService.reset("reset-fence-race");
      await abortStarted;
      const startPromise = startService.startRun(
        { presetSlug: "preview-1k", operatorMode: "admin" },
        "successor-start",
      );
      const waitDeadline = performance.now() + 5_000;
      while (true) {
        const waiting =
          await resetConnection.sql`select 1 from pg_locks where locktype = 'advisory' and not granted limit 1`;
        if (waiting.length > 0) break;
        if (performance.now() >= waitDeadline)
          throw new Error("Successor did not wait on the reset lock");
      }
      expect(start).not.toHaveBeenCalled();

      const rejectedStart = expect(startPromise).rejects.toMatchObject({
        code: "run_conflict",
        message: "The prior demo reset must be repaired before another run can start.",
        details: { conflictReason: "reset_incomplete", runId: existingRunId("active") },
      });
      releaseAbort();
      await expect(resetPromise).rejects.toMatchObject({
        code: "load_orchestrator_abort_unconfirmed",
      });
      await rejectedStart;
      expect(start).not.toHaveBeenCalled();
      expect(queueCleanup).not.toHaveBeenCalled();
      await expect(
        createStartService(primary, redisClient).startRun(
          { presetSlug: "preview-1k", operatorMode: "admin" },
          "recreated-api",
        ),
      ).rejects.toMatchObject({ details: { conflictReason: "reset_incomplete" } });
      await expect(
        primary.db
          .select({ adminResetCompletedAt: demoRuns.adminResetCompletedAt })
          .from(demoRuns)
          .where(eq(demoRuns.id, existingRunId("active"))),
      ).resolves.toEqual([{ adminResetCompletedAt: null }]);

      await expect(resetService.reset("reset-fence-repair")).resolves.toMatchObject({
        failedRunCount: 1,
      });
      await expect(
        primary.db
          .select({ adminResetCompletedAt: demoRuns.adminResetCompletedAt })
          .from(demoRuns)
          .where(eq(demoRuns.id, existingRunId("active"))),
      ).resolves.toEqual([{ adminResetCompletedAt: expect.any(Date) }]);
      await expect(
        startService.startRun(
          { presetSlug: "preview-1k", operatorMode: "admin" },
          "successor-after-repair",
        ),
      ).resolves.toMatchObject({ run: { status: "active" } });
      expect(start).toHaveBeenCalledOnce();
    } finally {
      releaseAbort();
      await resetConnection.close();
    }
  });

  it.each([
    ["selected", { runIds: [existingRunId("active")] }],
    ["delete-all", { deleteAllConfirmation: "DELETE" as const }],
  ])("admits a successor after %s Run History deletion removes a completed reset summary", async (_deletionMode, deletionCommand) => {
    const primary = requireConnection(connection);
    const redisClient = requireRedis(redis);
    const resetConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 2 });
    await seedExistingRun(primary, { runId: existingRunId("active"), status: "active" });
    const resetService = new AdminDemoResetService({
      db: resetConnection.db,
      redis: redisClient,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(resetConnection.db),
      queueMaintenance: {
        cleanRuns: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
      },
      clearErpCircuitBreakerState: async () => undefined,
      trafficAborter: { abortCurrent: async () => ({ outcome: "no_current_run" }) },
      dashboardLiveStateReset: new RedisDashboardTrafficMetricStore(redisClient),
      resetWorkflowFence: new PostgresDemoResetWorkflowFence(resetConnection.sql),
      maintenanceAuthority: new ProcessLocalDemoMaintenanceAuthority(),
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:20.000Z"),
    });

    try {
      await expect(resetService.reset("corr-reset-before-delete")).resolves.toMatchObject({
        failedRunCount: 1,
      });
      const historyService = new RunHistoryService({ db: primary.db });
      await expect(
        historyService.delete(deletionCommand, "corr-delete-reset-summary"),
      ).resolves.toMatchObject({ deletedSummaryCount: 1 });
      await expect(primary.db.select().from(demoRunSummaries)).resolves.toHaveLength(0);
      await expect(
        primary.db
          .select({ adminResetCompletedAt: demoRuns.adminResetCompletedAt })
          .from(demoRuns)
          .where(eq(demoRuns.id, existingRunId("active"))),
      ).resolves.toEqual([{ adminResetCompletedAt: new Date("2026-06-20T00:00:20.000Z") }]);

      await expect(
        createStartService(primary, redisClient).startRun(
          { presetSlug: "preview-1k", operatorMode: "admin" },
          `corr-start-after-${_deletionMode}`,
        ),
      ).resolves.toMatchObject({ run: { status: "active" } });
    } finally {
      await resetConnection.close();
    }
  });

  it.each([
    "metrics",
    "breaker",
  ])("repairs a marker-backed %s failure without aborting an admitted successor or rewriting history", async (failureBoundary) => {
    const primary = requireConnection(connection);
    const redisClient = requireRedis(redis);
    const resetConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 2 });
    const runId = existingRunId("active");
    await seedExistingRun(primary, { runId, status: "active" });
    const saleOfferId = "99999999-9999-4999-8999-999999999999";
    await primary.db.insert(saleOffers).values({
      id: saleOfferId,
      productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Reset retry offer",
      allocatedStock: 1,
      purpose: "generated_run",
      saleStartsAt: new Date("2026-06-20T00:00:00.000Z"),
      saleEndsAt: new Date("2026-06-21T00:00:00.000Z"),
    });
    await primary.db.update(demoRuns).set({ saleOfferId }).where(eq(demoRuns.id, runId));
    const metrics = new RedisDashboardTrafficMetricStore(redisClient);
    await redisClient.sadd(`demo-run:${runId}:traffic-metric-batches`, "pending-projection");
    let clearFailure = true;
    const abortCurrent = vi.fn(async () => ({ outcome: "no_current_run" as const }));
    const cleanRuns = vi.fn(async () => ({ cleanedQueueCount: 2, cleanedJobCount: 0 }));
    const createResetService = () =>
      new AdminDemoResetService({
        db: resetConnection.db,
        redis: redisClient,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(resetConnection.db),
        queueMaintenance: { cleanRuns },
        clearErpCircuitBreakerState: async () => {
          if (clearFailure && failureBoundary === "breaker") throw new Error("breaker unavailable");
        },
        trafficAborter: { abortCurrent },
        dashboardLiveStateReset: {
          fenceRun: (id) => metrics.fenceRun(id),
          hasRunState: (id) => metrics.hasRunState(id),
          clearRun: async (id) => {
            if (clearFailure && failureBoundary === "metrics")
              throw new Error("projection unavailable");
            await metrics.clearRun(id);
          },
        },
        resetWorkflowFence: new PostgresDemoResetWorkflowFence(resetConnection.sql),
        maintenanceAuthority: new ProcessLocalDemoMaintenanceAuthority(),
        logger: createSilentLogger("api"),
      });
    try {
      await expect(createResetService().reset("partial-reset")).rejects.toMatchObject({
        details: { conflictReason: "projection_cleanup_incomplete" },
      });
      const history = await primary.db.select().from(demoRunSummaries);
      const successor = await createStartService(primary, redisClient).startRun(
        { presetSlug: "preview-1k", operatorMode: "admin" },
        "admitted-successor",
      );
      if (failureBoundary === "breaker") expect(await metrics.hasRunState(runId)).toBe(false);
      const publish = vi.spyOn(redisClient, "publish");
      clearFailure = false;
      await expect(createResetService().reset("projection-retry")).resolves.toMatchObject({
        failedRunCount: 0,
      });
      expect(publish).toHaveBeenCalledOnce();
      expect(JSON.parse(String(publish.mock.calls[0]?.[1]))).toEqual({
        type: "dashboard.projection.dirty",
        correlationId: "projection-retry",
      });
      publish.mockRestore();
      expect(abortCurrent).toHaveBeenCalledOnce();
      expect(cleanRuns).toHaveBeenCalledOnce();
      expect(await primary.db.select().from(demoRunSummaries)).toEqual(history);
      expect(
        (await primary.db.select().from(demoRuns).where(eq(demoRuns.id, successor.run.runId)))[0]
          ?.status,
      ).toBe("active");
      expect(await metrics.hasRunState(runId)).toBe(false);
    } finally {
      await resetConnection.close();
    }
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
      reason: { code: "run_conflict" },
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
      ).rejects.toMatchObject({ code: "run_conflict" });

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
    ).rejects.toMatchObject({ code: "preset_operation_not_allowed" });
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
    ).rejects.toMatchObject({ code: "run_conflict" });
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each([
    ["visitor", "public_run_budget_exceeded"],
    ["global", "public_run_budget_exceeded"],
  ] as const)("maps %s budget denial decisions to stable application errors", async (reason, code) => {
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: {
        reserve: async () => ({ outcome: "denied", reason, retryAfterSeconds: 59 }),
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
    ).rejects.toMatchObject({ code, retryAfterSeconds: 59 });
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
    await expect(
      requireConnection(connection)
        .db.select({ correlationId: demoRuns.correlationId })
        .from(demoRuns)
        .where(eq(demoRuns.id, response.run.runId)),
    ).resolves.toEqual([{ correlationId: "corr-start" }]);
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
    const managementService = new PublicRuntimePolicyService({
      db: requireConnection(connection).db,
      deploymentHardCaps: publicRuntimePolicy().deploymentHardCaps,
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
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
      budget: policy.publicRunBudget,
      publicVisitorId: "visitor-budget-1",
      now: new Date("2026-06-20T00:00:00.000Z"),
    });
    if (firstDecision.outcome !== "allowed") throw new Error("Expected allowed fixture decision.");
    const firstReservation = firstDecision.reservation;
    await expect(
      store.reserve({
        budget: policy.publicRunBudget,
        publicVisitorId: "visitor-budget-1",
        now: new Date("2026-06-20T00:00:01.000Z"),
      }),
    ).resolves.toEqual({ outcome: "denied", reason: "visitor", retryAfterSeconds: 59 });
    expect(await requireRedis(redis).get(firstReservation.globalKey)).toBe("1");
    expect(await requireRedis(redis).get(firstReservation.visitorKey)).toBe("1");
    await store.release(firstReservation);
    await store.release(firstReservation);
    expect(await requireRedis(redis).get(firstReservation.globalKey)).toBeNull();
    expect(await requireRedis(redis).get(firstReservation.visitorKey)).toBeNull();
    await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "visitor-budget-1",
      now: new Date("2026-06-20T00:00:59.000Z"),
    });
    await expect(
      store.reserve({
        budget: policy.publicRunBudget,
        publicVisitorId: "visitor-budget-1",
        now: new Date("2026-06-20T00:00:59.500Z"),
      }),
    ).resolves.toEqual({ outcome: "denied", reason: "visitor", retryAfterSeconds: 1 });

    await requireRedis(redis).flushdb();
    policy.publicRunBudget = {
      windowSeconds: 60,
      perVisitorMaxStarts: 10,
      globalMaxStarts: 2,
    };
    await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "visitor-budget-2",
      now: new Date("2026-06-20T00:00:02.000Z"),
    });
    await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "visitor-budget-3",
      now: new Date("2026-06-20T00:00:03.000Z"),
    });
    await expect(
      store.reserve({
        budget: policy.publicRunBudget,
        publicVisitorId: "visitor-budget-4",
        now: new Date("2026-06-20T00:00:04.000Z"),
      }),
    ).resolves.toEqual({ outcome: "denied", reason: "global", retryAfterSeconds: 56 });
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
        store.reserve({ budget: policy.publicRunBudget, publicVisitorId: "concurrent", now }),
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

    const allowedGlobal = await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "other-a",
      now,
    });
    expect(allowedGlobal.outcome).toBe("allowed");
    const globalBefore = await client.get(oldReservation.globalKey);
    const deniedGlobal = await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "denied-visitor",
      now,
    });
    expect(deniedGlobal).toEqual({ outcome: "denied", reason: "global", retryAfterSeconds: 60 });
    const deniedKey = oldReservation.visitorKey.replace("concurrent", "denied-visitor");
    expect(await client.get(deniedKey)).toBeNull();
    expect(await client.get(oldReservation.globalKey)).toBe(globalBefore);
    const globalHashTag = oldReservation.globalKey.match(/\{\d+\}/)?.[0];
    expect(globalHashTag).toBeTruthy();
    expect(oldReservation.visitorKey).toContain(globalHashTag);
    expect(oldReservation.reservationKey).toContain(globalHashTag);

    const nextDecision = await store.reserve({
      budget: policy.publicRunBudget,
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
    expect(summaries[0]?.transportAttemptCounts).toMatchObject({
      plannedRequests: 10_000,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: 10_000,
    });
    expect(summaries[0]?.trafficDeliverySummary).toMatchObject({
      trafficDeliveryStatus: "failed",
      droppedIterations: 0,
      completedIterations: 0,
      trafficMode: "buyer-spike",
      plannedBuyers: 10_000,
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
      failureReason: "load_orchestrator_unavailable",
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
            failureReason: "traffic_failed",
            replayPossible: false,
            startedAt: new Date("2026-06-20T00:00:10.000Z"),
            endedAt: new Date("2026-06-20T00:00:12.000Z"),
            transportAttemptCounts: {
              plannedRequests: 10_000,
              startedRequests: 0,
              completedRequests: 0,
              interruptedRequests: 0,
              unstartedRequests: 10_000,
            },
            httpSummary: {
              failedRequests: 0,
              acceptedResponses: 0,
              soldOutResponses: 0,
              transportFailures: 0,
              unexpectedResponses: 0,
              failureRate: 0,
            },
            trafficDeliverySummary: trafficDeliverySummarySchema.parse({
              trafficMode: null,
              plannedBuyers: null,
              scheduledRatePerSecond: null,
              configuredDurationSeconds: null,
              preAllocatedVUs: null,
              maxVUs: null,
              droppedIterations: 10_000,
              completedIterations: null,
              requestArrivalSummary: emptyRequestArrivalSummary,
              trafficDeliveryStatus: "failed",
              notes: [],
            }),
            httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
            loadRunDiagnosticsSummary: { source: "existing-summary" },
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

  it.each(
    destructiveResetReasonValues,
  )("returns the %s run when delayed activation loses CAS and allows a successor", async (reason) => {
    const startConnection = requireConnection(connection);
    const resetConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 2 });
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
    const resetService = new AdminDemoResetService({
      db: resetConnection.db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(resetConnection.db),
      redis: requireRedis(redis),
      queueMaintenance: {
        cleanRuns: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
      },
      clearErpCircuitBreakerState: async () => undefined,
      trafficAborter: { abortCurrent: async () => ({ outcome: "no_current_run" }) },
      dashboardLiveStateReset: new RedisDashboardTrafficMetricStore(requireRedis(redis)),
      resetWorkflowFence: new PostgresDemoResetWorkflowFence(resetConnection.sql),
      maintenanceAuthority: new ProcessLocalDemoMaintenanceAuthority(),
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:15:11.000Z"),
    });

    try {
      const startPromise = service.startRun(
        { presetSlug: "preview-1k", operatorMode: "admin" },
        "corr-delayed-start",
      );
      await trafficStartEnteredPromise;

      const resetResponse = await resetService.reset("corr-reset-race", reason);
      expect(resetResponse.failedRunCount).toBe(1);

      releaseTrafficStart?.();
      const startResponse = await startPromise;

      expect(startResponse.run).toMatchObject({
        runId: "77777777-7777-4777-8777-777777777777",
        status: "failed",
        trafficStatus: "failed",
        failureCategory: reason === "auto_reset" ? "automatic_reset" : "operator",
        finalizedAt: "2026-06-20T00:15:11.000Z",
      });
      const [run] = await startConnection.db
        .select()
        .from(demoRuns)
        .where(eq(demoRuns.id, "77777777-7777-4777-8777-777777777777"));
      const [summary] = await startConnection.db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, "77777777-7777-4777-8777-777777777777"));
      expect(run).toMatchObject({ status: "failed", failureReason: reason });
      expect(summary).toMatchObject({
        status: "failed",
        failureReason: reason,
        endedAt: new Date("2026-06-20T00:15:11.000Z"),
      });
      const successor = await service.startRun(
        { presetSlug: "preview-1k", operatorMode: "admin" },
        "corr-successor",
      );
      expect(successor.run.status).toBe("active");
      expect(successor.run.runId).not.toBe(startResponse.run.runId);
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
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 10,
      pendingPersistenceRetryAfterSeconds: 30,
    },
  };
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

function createStartService(
  connection: ReturnType<typeof createDatabaseConnection>,
  redis: ReturnType<typeof createRedisClient>,
  overrides: {
    trafficExecutionGateway?: ConstructorParameters<
      typeof DemoRunLifecycleService
    >[0]["trafficExecutionGateway"];
    publicRunBudgetStore?: ConstructorParameters<
      typeof DemoRunLifecycleService
    >[0]["publicRunBudgetStore"];
    terminalRunWriter?: ConstructorParameters<
      typeof DemoRunLifecycleService
    >[0]["terminalRunWriter"];
    businessOutcomeReader?: ConstructorParameters<
      typeof DemoRunLifecycleService
    >[0]["businessOutcomeReader"];
    logger?: ConstructorParameters<typeof DemoRunLifecycleService>[0]["logger"];
  } = {},
): DemoRunLifecycleService {
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
  return new DemoRunLifecycleService({
    db: connection.db,
    presetReader: new DemoPresetService({ db: connection.db }),
    runtimePolicyReader: new PublicRuntimePolicyService({
      db: connection.db,
      deploymentHardCaps: publicRuntimePolicy().deploymentHardCaps,
    }),
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
    businessOutcomeReader,
    apiBaseUrl: "http://api.test",
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
      throw new Error("Redis unavailable during projection dirty publication.");
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
    policy: publicRuntimePolicyMutable(),
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
      },
      backpressureConfig: {
        queueName: "orders:process",
        physicalQueueName: "orders-process",
        orderProcessConcurrency: 5,
        pendingPersistenceRetryAfterSeconds: 30,
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
      allowedTrafficModes: ["buyer-spike", "constant-arrival-rate"],
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
