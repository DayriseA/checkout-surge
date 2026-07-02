import { randomUUID } from "node:crypto";
import {
  type AcceptedRunConfigSnapshot,
  type AdminPresetListResponse,
  type AdminPresetMutationResponse,
  type AdminPublicRuntimePolicyResponse,
  type AdminPublicRuntimePolicyUpdateRequest,
  acceptedRunConfigSnapshotSchema,
  adminPresetListResponseSchema,
  adminPresetMutationResponseSchema,
  adminPublicRuntimePolicyResponseSchema,
  type BusinessOutcomeSummary,
  type CopyDemoPresetToCustomRequest,
  controlServiceTokenHeaderName,
  type DemoPresetContract,
  type DemoRunConfigOverride,
  type DemoRunSnapshot,
  type DuplicateDemoPresetRequest,
  demoPresetContractSchema,
  demoRunSnapshotSchema,
  type LoadMetricIngestRequest,
  loadMetricIngestRequestSchema,
  type MetricSample,
  type OperatorMode,
  type PublicPresetListResponse,
  type PublicRuntimePolicy,
  type PublicRuntimePolicyResponse,
  publicPresetListResponseSchema,
  publicRuntimePolicyMutableSchema,
  publicRuntimePolicyResponseSchema,
  publicRuntimePolicySchema,
  type SaveDemoPresetRequest,
  type StartDemoRunRequest,
  type StartDemoRunResponse,
  startDemoRunResponseSchema,
  type TerminalInventorySnapshot,
  type TrafficCompletionReport,
  type TrafficConfig,
  type TrafficDeliverySummary,
  type TrafficExecutionStartRequest,
  type TrafficExecutionStartResponse,
  type TrafficHttpSummary,
  trafficCompletionReportSchema,
  trafficExecutionStartPath,
  trafficExecutionStartResponseSchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoPresets,
  demoRunFinalizations,
  demoRunReservationOutcomes,
  demoRunSaleContexts,
  demoRuns,
  getInventoryStatus,
  initializeInventory,
  products,
  publicRuntimePolicies,
  publishDashboardEvent,
  saleOffers,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ApiHttpError } from "../runtime/errors.js";
import type { DashboardBusinessOutcomeReader } from "./dashboard-recovery-service.js";
import type { DemoRunFinalizationController } from "./demo-run-finalization-service.js";
import { PostgresTerminalDemoRunSummaryWriter } from "./terminal-demo-run-transition.js";

const demoRunStartLockKey = "checkout_surge_demo_run_start";
const generatedRunSaleDurationMs = 24 * 60 * 60 * 1000;
const recentMetricLimit = 50;

export interface TrafficExecutionGateway {
  start(request: TrafficExecutionStartRequest): Promise<TrafficExecutionStartResponse>;
}

export interface PublicRunBudgetStore {
  consume(input: {
    policy: PublicRuntimePolicy;
    publicVisitorId: string;
    now: Date;
  }): Promise<void>;
}

export interface DashboardTrafficMetricReader {
  readRecent(runId: string | null): Promise<MetricSample[]>;
}

export interface DemoRunController {
  listPublicPresets(): Promise<PublicPresetListResponse>;
  listAdminPresets(): Promise<AdminPresetListResponse>;
  saveAdminPreset(request: SaveDemoPresetRequest): Promise<AdminPresetMutationResponse>;
  duplicatePreset(request: DuplicateDemoPresetRequest): Promise<AdminPresetMutationResponse>;
  copyPresetToCustom(request: CopyDemoPresetToCustomRequest): Promise<AdminPresetMutationResponse>;
  getPublicRuntimePolicy(): Promise<PublicRuntimePolicyResponse>;
  getAdminPublicRuntimePolicy(correlationId: string): Promise<AdminPublicRuntimePolicyResponse>;
  updateAdminPublicRuntimePolicy(
    request: AdminPublicRuntimePolicyUpdateRequest,
    correlationId: string,
  ): Promise<AdminPublicRuntimePolicyResponse>;
  startRun(request: StartDemoRunCommand, correlationId: string): Promise<StartDemoRunResponse>;
  ingestMetrics(input: LoadMetricIngestRequest): Promise<void>;
  recordTrafficCompletion(input: TrafficCompletionReport): Promise<DemoRunSnapshot>;
}

export type StartDemoRunCommand = StartDemoRunRequest & {
  operatorMode: OperatorMode;
  publicVisitorId?: string;
};

export class RedisPublicRunBudgetStore implements PublicRunBudgetStore {
  constructor(private readonly redis: CheckoutSurgeRedis) {}

  async consume(input: {
    policy: PublicRuntimePolicy;
    publicVisitorId: string;
    now: Date;
  }): Promise<void> {
    if (!input.policy.isPublicRunBudgetEnforced) {
      return;
    }

    const windowStart = Math.floor(
      input.now.getTime() / (input.policy.publicRunBudget.windowSeconds * 1000),
    );
    const globalKey = `demo-run:public-budget:${windowStart}:global`;
    const visitorKey = `demo-run:public-budget:${windowStart}:visitor:${input.publicVisitorId}`;
    const ttlSeconds = input.policy.publicRunBudget.windowSeconds * 2;
    const [globalCount, visitorCount] = await this.redis
      .multi()
      .incr(globalKey)
      .expire(globalKey, ttlSeconds, "NX")
      .incr(visitorKey)
      .expire(visitorKey, ttlSeconds, "NX")
      .exec()
      .then((results) => {
        if (!results) {
          throw new Error("Redis public run budget update did not return results.");
        }
        const globalResult = results[0];
        const visitorResult = results[2];
        if (!globalResult || globalResult[0] || !visitorResult || visitorResult[0]) {
          throw new Error("Redis public run budget update failed.");
        }
        return [Number(globalResult[1]), Number(visitorResult[1])] as const;
      });

    if (globalCount > input.policy.publicRunBudget.globalMaxStarts) {
      throw new DemoRunValidationError(
        "public_run_budget_exceeded",
        "Public run budget is exhausted.",
      );
    }
    if (visitorCount > input.policy.publicRunBudget.perVisitorMaxStarts) {
      throw new DemoRunValidationError(
        "public_visitor_run_budget_exceeded",
        "Public visitor run budget is exhausted.",
      );
    }
  }
}

export class RedisDashboardTrafficMetricStore implements DashboardTrafficMetricReader {
  constructor(private readonly redis: CheckoutSurgeRedis) {}

  async append(input: LoadMetricIngestRequest): Promise<void> {
    const key = trafficMetricKey(input.runId);
    const payloads = input.samples.map((sample) => JSON.stringify(sample));
    await this.redis.rpush(key, ...payloads);
    await this.redis.ltrim(key, -recentMetricLimit, -1);
    await this.redis.expire(key, 24 * 60 * 60);
  }

  async readRecent(runId: string | null): Promise<MetricSample[]> {
    if (!runId) {
      return [];
    }

    const rawSamples = await this.redis.lrange(trafficMetricKey(runId), -20, -1);
    return rawSamples.map((raw) =>
      loadMetricIngestRequestSchema.shape.samples.element.parse(JSON.parse(raw)),
    );
  }
}

export class HttpTrafficExecutionGateway implements TrafficExecutionGateway {
  constructor(
    private readonly options: {
      loadOrchestratorBaseUrl: string;
      controlServiceToken: string;
    },
  ) {}

  async start(request: TrafficExecutionStartRequest): Promise<TrafficExecutionStartResponse> {
    const response = await fetch(
      `${this.options.loadOrchestratorBaseUrl}${trafficExecutionStartPath}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          [controlServiceTokenHeaderName]: this.options.controlServiceToken,
        },
        body: JSON.stringify(request),
      },
    );

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiHttpError({
        statusCode: 502,
        code: "load_orchestrator_start_failed",
        message: "The load orchestrator rejected the run start.",
        details: {
          statusCode: response.status,
          payload: payload && typeof payload === "object" ? payload : {},
        },
      });
    }

    return trafficExecutionStartResponseSchema.parse(payload);
  }
}

export class DemoRunValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DemoRunValidationError";
  }
}

export class DemoRunService implements DemoRunController {
  private readonly summaryWriter: PostgresTerminalDemoRunSummaryWriter;

  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      trafficExecutionGateway: TrafficExecutionGateway;
      publicRunBudgetStore: PublicRunBudgetStore;
      trafficMetricStore: RedisDashboardTrafficMetricStore;
      businessOutcomeReader: DashboardBusinessOutcomeReader;
      finalizationService?: DemoRunFinalizationController;
      apiBaseUrl: string;
      buyEndpointPath: string;
      logger: CheckoutSurgeLogger;
      now?: () => Date;
      generateId?: () => string;
    },
  ) {
    this.summaryWriter = new PostgresTerminalDemoRunSummaryWriter(options.db);
  }

  async listPublicPresets(): Promise<PublicPresetListResponse> {
    const rows = await this.options.db
      .select()
      .from(demoPresets)
      .where(eq(demoPresets.visibility, "public"))
      .orderBy(sql`(${demoPresets.display}->>'sortOrder')::int`);

    return publicPresetListResponseSchema.parse({
      presets: rows.map(toDemoPresetContract),
      timestamp: this.now().toISOString(),
    });
  }

  async listAdminPresets(): Promise<AdminPresetListResponse> {
    const rows = await this.options.db
      .select()
      .from(demoPresets)
      .orderBy(sql`(${demoPresets.display}->>'sortOrder')::int`, demoPresets.slug);

    return adminPresetListResponseSchema.parse({
      presets: rows.map(toDemoPresetContract),
      timestamp: this.now().toISOString(),
    });
  }

  async saveAdminPreset(request: SaveDemoPresetRequest): Promise<AdminPresetMutationResponse> {
    const now = this.now();
    const preset = await this.readPreset(request.slug);
    ensureEditableAdminPreset(preset);

    const [updated] = await this.options.db
      .update(demoPresets)
      .set({
        display: request.display,
        trafficConfig: request.trafficConfig,
        inventoryConfig: request.inventoryConfig,
        erpConfig: request.erpConfig,
        backpressureConfig: request.backpressureConfig,
        updatedAt: now,
      })
      .where(eq(demoPresets.slug, request.slug))
      .returning();

    return adminPresetMutationResponseSchema.parse({
      preset: toDemoPresetContract(requirePresetRow(updated, request.slug)),
      timestamp: now.toISOString(),
    });
  }

  async duplicatePreset(request: DuplicateDemoPresetRequest): Promise<AdminPresetMutationResponse> {
    const now = this.now();
    const source = await this.readPreset(request.sourceSlug);
    const targetSlug = normalizeSlug(request.targetSlug);
    const [existingTarget] = await this.options.db
      .select({ id: demoPresets.id })
      .from(demoPresets)
      .where(eq(demoPresets.slug, targetSlug))
      .limit(1);

    if (existingTarget) {
      throw new DemoRunValidationError("preset_slug_conflict", "A preset already uses that slug.", {
        slug: targetSlug,
      });
    }

    if (source.slug === "public-custom") {
      throw new DemoRunValidationError(
        "preset_not_duplicable",
        "The public custom base preset cannot be duplicated.",
      );
    }

    const [inserted] = await this.options.db
      .insert(demoPresets)
      .values({
        id: this.generateId(),
        slug: targetSlug,
        visibility: "admin",
        isEditable: true,
        isCustom: false,
        display: {
          ...source.display,
          name: request.displayName ?? `${source.display.name} Copy`,
        },
        trafficConfig: source.trafficConfig,
        inventoryConfig: source.inventoryConfig,
        erpConfig: source.erpConfig,
        backpressureConfig: source.backpressureConfig,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return adminPresetMutationResponseSchema.parse({
      preset: toDemoPresetContract(requirePresetRow(inserted, targetSlug)),
      timestamp: now.toISOString(),
    });
  }

  async copyPresetToCustom(
    request: CopyDemoPresetToCustomRequest,
  ): Promise<AdminPresetMutationResponse> {
    const now = this.now();
    const source = await this.readPreset(request.sourceSlug);
    const custom = await this.readPreset("custom");
    ensureEditableAdminPreset(custom);

    const [updated] = await this.options.db
      .update(demoPresets)
      .set({
        display: {
          ...custom.display,
          description: `Scratch copy of ${source.display.name}.`,
        },
        trafficConfig: source.trafficConfig,
        inventoryConfig: source.inventoryConfig,
        erpConfig: source.erpConfig,
        backpressureConfig: source.backpressureConfig,
        updatedAt: now,
      })
      .where(eq(demoPresets.slug, "custom"))
      .returning();

    return adminPresetMutationResponseSchema.parse({
      preset: toDemoPresetContract(requirePresetRow(updated, "custom")),
      timestamp: now.toISOString(),
    });
  }

  async getPublicRuntimePolicy(): Promise<PublicRuntimePolicyResponse> {
    const row = await this.readPublicRuntimePolicyRow();
    return publicRuntimePolicyResponseSchema.parse({
      id: row.id,
      policy: row.policy,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async getAdminPublicRuntimePolicy(
    correlationId: string,
  ): Promise<AdminPublicRuntimePolicyResponse> {
    return toAdminPublicRuntimePolicyResponse(
      await this.readPublicRuntimePolicyRow(),
      correlationId,
      this.now(),
    );
  }

  async updateAdminPublicRuntimePolicy(
    request: AdminPublicRuntimePolicyUpdateRequest,
    correlationId: string,
  ): Promise<AdminPublicRuntimePolicyResponse> {
    const now = this.now();
    const currentRow = await this.readPublicRuntimePolicyRow();
    const currentPolicy = publicRuntimePolicySchema.parse(currentRow.policy);
    const mutablePolicy = publicRuntimePolicyMutableSchema.parse(request.policy);
    const nextPolicy = publicRuntimePolicySchema.parse({
      ...mutablePolicy,
      deploymentHardCaps: currentPolicy.deploymentHardCaps,
    });

    validatePublicRuntimePolicyUpdate(nextPolicy);

    const [updated] = await this.options.db
      .update(publicRuntimePolicies)
      .set({
        policy: nextPolicy,
        updatedAt: now,
      })
      .where(eq(publicRuntimePolicies.id, "active"))
      .returning();

    if (!updated) {
      throw new DemoRunValidationError(
        "public_runtime_policy_not_found",
        "Public runtime policy is not configured.",
      );
    }

    return toAdminPublicRuntimePolicyResponse(updated, correlationId, now);
  }

  async startRun(
    request: StartDemoRunCommand,
    correlationId: string,
  ): Promise<StartDemoRunResponse> {
    const now = this.now();
    const policyRow = await this.readPublicRuntimePolicyRow();
    const policy = publicRuntimePolicySchema.parse(policyRow.policy);
    const acceptedConfig = await this.resolveAcceptedConfig(request, policy);
    validateAcceptedRunSnapshot(acceptedConfig.snapshot, policy, {
      operatorMode: request.operatorMode,
      enforcePublicCustomLimits:
        request.operatorMode === "public" && acceptedConfig.preset.isCustom,
    });

    let consumePublicBudget: (() => Promise<void>) | undefined;
    if (request.operatorMode === "public" && policy.isPublicRunBudgetEnforced) {
      if (!request.publicVisitorId) {
        throw new DemoRunValidationError(
          "public_visitor_required",
          "A public visitor ID is required to enforce public run budgets.",
        );
      }
      consumePublicBudget = () =>
        this.options.publicRunBudgetStore.consume({
          policy,
          publicVisitorId: request.publicVisitorId as string,
          now,
        });
    }

    const accepted = await this.createAcceptedRun(
      request,
      acceptedConfig.preset,
      acceptedConfig.snapshot,
      now,
      consumePublicBudget,
    );
    const saleOfferId = requireRunSaleOfferId(accepted.run);

    try {
      await initializeInventory(this.options.redis, {
        saleOfferId,
        allocatedStock: acceptedConfig.snapshot.inventoryConfig.startingStock,
        source: "demo_run_start",
        initializedAt: now,
        run: { runId: accepted.run.runId, status: "accepting" },
      });
    } catch (error) {
      await this.failRun(accepted.run.runId, "inventory_initialization_failed", correlationId);
      throw error;
    }

    await this.publishRunEvent("run.started", accepted.run, correlationId, now);

    let trafficResponse: TrafficExecutionStartResponse;
    try {
      trafficResponse = await this.options.trafficExecutionGateway.start({
        runId: accepted.run.runId,
        saleOfferId,
        apiBaseUrl: this.options.apiBaseUrl,
        buyEndpointPath: this.options.buyEndpointPath,
        correlationId,
        configSnapshot: acceptedConfig.snapshot,
      });
    } catch (error) {
      await this.failRun(accepted.run.runId, "load_orchestrator_start_failed", correlationId);
      throw error;
    }

    const activeRun = await this.updateRunAfterTrafficStart(
      accepted.run.runId,
      trafficResponse,
      now,
    );
    await this.publishRunEvent("run.updated", activeRun, correlationId, now);

    return startDemoRunResponseSchema.parse({
      run: activeRun,
      recovery: { establishedAt: now.toISOString() },
      correlationId,
      timestamp: now.toISOString(),
    });
  }

  async ingestMetrics(input: LoadMetricIngestRequest): Promise<void> {
    const request = loadMetricIngestRequestSchema.parse(input);
    await this.options.trafficMetricStore.append(request);

    for (const sample of request.samples) {
      await publishDashboardEvent(this.options.redis, {
        type: "traffic.metric",
        eventId: this.generateId(),
        runId: request.runId,
        correlationId: request.correlationId,
        metricName: sample.metricName,
        value: sample.value,
        unit: sample.unit,
        occurredAt: sample.timestamp,
      });
    }
  }

  async recordTrafficCompletion(input: TrafficCompletionReport): Promise<DemoRunSnapshot> {
    const report = trafficCompletionReportSchema.parse(input);
    const now = this.now();
    const [run] = await this.options.db
      .select()
      .from(demoRuns)
      .where(eq(demoRuns.id, report.runId))
      .limit(1);

    if (!run) {
      throw new DemoRunValidationError("run_not_found", "Demo run was not found.", {
        runId: report.runId,
      });
    }
    if (!run.saleOfferId) {
      throw new DemoRunValidationError("run_sale_offer_missing", "Demo run has no sale offer.", {
        runId: report.runId,
      });
    }

    const initialBusinessOutcome = await this.options.businessOutcomeReader.read({
      saleOfferId: run.saleOfferId,
      runId: run.id,
    });
    const terminalInventorySnapshot = await this.captureTerminalInventorySnapshot(
      run.saleOfferId,
      initialBusinessOutcome,
      now,
    );
    const businessOutcome = await this.options.businessOutcomeReader.read({
      saleOfferId: run.saleOfferId,
      runId: run.id,
    });

    await this.options.db.transaction(async (tx) => {
      if (terminalInventorySnapshot) {
        await tx
          .insert(demoRunReservationOutcomes)
          .values({
            runId: report.runId,
            outcome: "api_sold_out_decision",
            count: terminalInventorySnapshot.soldOutRejections,
            latestObservedAt: terminalInventorySnapshot.soldOutRejections > 0 ? now : null,
            source: "redis",
            capturedAt: now,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [demoRunReservationOutcomes.runId, demoRunReservationOutcomes.outcome],
            set: {
              count: terminalInventorySnapshot.soldOutRejections,
              latestObservedAt: terminalInventorySnapshot.soldOutRejections > 0 ? now : null,
              source: "redis",
              capturedAt: now,
            },
          });
      }

      await tx
        .insert(demoRunFinalizations)
        .values({
          runId: report.runId,
          exitCode: report.exitCode ?? null,
          errorMessage: report.errorMessage ?? null,
          httpSummary: report.httpSummary,
          trafficOutcomeSummary: {
            ...report.trafficOutcomeSummary,
            businessOutcomeAtTrafficCompletion: businessOutcome,
            ...(terminalInventorySnapshot ? { terminalInventorySnapshot } : {}),
          },
          trafficDeliverySummary: report.trafficDeliverySummary,
          httpTimingBreakdownSummary: report.httpTimingBreakdownSummary,
          loadRunDiagnosticsSummary: report.loadRunDiagnosticsSummary,
          apiRequestLifecycleSummary: report.apiRequestLifecycleSummary,
          trafficSummaryReceivedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: demoRunFinalizations.runId,
        });

      await tx
        .update(demoRuns)
        .set({
          status: "draining",
          trafficStatus: report.status,
          trafficEndedAt: new Date(report.completedAt),
          updatedAt: now,
        })
        .where(
          and(eq(demoRuns.id, report.runId), inArray(demoRuns.status, ["starting", "active"])),
        );
    });

    if (run.saleOfferId) {
      await setRunSaleEligibility(this.options.redis, {
        runId: report.runId,
        saleOfferId: run.saleOfferId,
        status: "closed",
      }).catch((error: unknown) => {
        this.options.logger.warn(
          { err: error, runId: report.runId, saleOfferId: run.saleOfferId },
          "Could not close run sale eligibility after traffic completion.",
        );
      });
    }

    const updatedRun = await this.readRunSnapshot(report.runId);
    await this.publishRunEvent("run.updated", updatedRun, report.correlationId, now);
    return (
      (await this.options.finalizationService?.finalizeRun(report.runId, report.correlationId)) ??
      updatedRun
    );
  }

  private async createAcceptedRun(
    request: StartDemoRunCommand,
    preset: DemoPresetContract,
    snapshot: AcceptedRunConfigSnapshot,
    now: Date,
    beforeInsert?: () => Promise<void>,
  ): Promise<{ run: DemoRunSnapshot }> {
    const runId = this.generateId();
    const saleOfferId = this.generateId();

    return this.options.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${demoRunStartLockKey}))`);

      const [existingRun] = await tx
        .select({ id: demoRuns.id, status: demoRuns.status })
        .from(demoRuns)
        .where(inArray(demoRuns.status, ["starting", "active", "draining"]))
        .limit(1);

      if (existingRun) {
        throw new DemoRunValidationError(
          "demo_run_already_active",
          "A demo run is already starting, active, or draining.",
          {
            runId: existingRun.id,
            status: existingRun.status,
          },
        );
      }

      await beforeInsert?.();

      const [product] = await tx
        .select({ id: products.id })
        .from(products)
        .where(eq(products.isActive, true))
        .orderBy(desc(products.updatedAt))
        .limit(1);

      if (!product) {
        throw new DemoRunValidationError(
          "active_product_not_found",
          "No active product is available for demo runs.",
        );
      }

      await tx.insert(saleOffers).values({
        id: saleOfferId,
        productId: product.id,
        name: `${preset.display.name} Generated Run Offer`,
        allocatedStock: snapshot.inventoryConfig.startingStock,
        saleStartsAt: now,
        saleEndsAt: new Date(now.getTime() + generatedRunSaleDurationMs),
        isActive: true,
        purpose: "generated_run",
        createdAt: now,
        updatedAt: now,
      });

      const [run] = await tx
        .insert(demoRuns)
        .values({
          id: runId,
          presetId: preset.id,
          presetName: preset.display.name,
          operatorMode: request.operatorMode,
          status: "starting",
          trafficStatus: "starting",
          configSnapshot: snapshot,
          saleOfferId,
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!run) {
        throw new Error("Failed to create demo run.");
      }

      await tx.insert(demoRunSaleContexts).values({
        runId,
        saleOfferId,
        createdAt: now,
        updatedAt: now,
      });

      return { run: toDemoRunSnapshot(run) };
    });
  }

  private async resolveAcceptedConfig(
    request: StartDemoRunCommand,
    policy: PublicRuntimePolicy,
  ): Promise<{ preset: DemoPresetContract; snapshot: AcceptedRunConfigSnapshot }> {
    const preset = await this.readPreset(request.presetSlug);

    if (request.operatorMode === "public" && preset.visibility !== "public") {
      throw new DemoRunValidationError(
        "preset_not_public",
        "Public runs can only use public presets.",
      );
    }

    if (request.operatorMode === "public" && request.configOverride && !preset.isCustom) {
      throw new DemoRunValidationError(
        "public_override_not_allowed",
        "Public overrides are allowed only for the public custom preset.",
      );
    }

    const base =
      request.operatorMode === "public" && preset.isCustom
        ? policy.publicCustomDefaults
        : {
            trafficConfig: preset.trafficConfig,
            inventoryConfig: preset.inventoryConfig,
            erpConfig: preset.erpConfig,
            backpressureConfig: preset.backpressureConfig,
          };

    return {
      preset,
      snapshot: acceptedRunConfigSnapshotSchema.parse(
        mergeConfigSnapshot(base, request.configOverride),
      ),
    };
  }

  private async readPreset(slug: string): Promise<DemoPresetContract> {
    const [preset] = await this.options.db
      .select()
      .from(demoPresets)
      .where(eq(demoPresets.slug, slug))
      .limit(1);

    if (!preset) {
      throw new DemoRunValidationError("preset_not_found", "Demo preset was not found.", { slug });
    }

    return toDemoPresetContract(preset);
  }

  private async readPublicRuntimePolicyRow(): Promise<typeof publicRuntimePolicies.$inferSelect> {
    const [row] = await this.options.db
      .select()
      .from(publicRuntimePolicies)
      .where(eq(publicRuntimePolicies.id, "active"))
      .limit(1);

    if (!row) {
      throw new DemoRunValidationError(
        "public_runtime_policy_not_found",
        "Public runtime policy is not configured.",
      );
    }

    return row;
  }

  private async updateRunAfterTrafficStart(
    runId: string,
    trafficResponse: TrafficExecutionStartResponse,
    now: Date,
  ): Promise<DemoRunSnapshot> {
    const [run] = await this.options.db
      .update(demoRuns)
      .set({
        status: "active",
        trafficStatus: trafficResponse.status,
        trafficStartedAt: new Date(trafficResponse.startedAt),
        updatedAt: now,
      })
      .where(eq(demoRuns.id, runId))
      .returning();

    if (!run) {
      throw new DemoRunValidationError("run_not_found", "Demo run was not found.", { runId });
    }

    return toDemoRunSnapshot(run);
  }

  private async failRun(
    runId: string,
    failureReason: string,
    correlationId: string,
  ): Promise<void> {
    const now = this.now();
    const [run] = await this.options.db.select().from(demoRuns).where(eq(demoRuns.id, runId));

    if (run) {
      const businessOutcome = await this.readBusinessOutcomeForRun(run);
      const terminalInventorySnapshot = run.saleOfferId
        ? await this.captureTerminalInventorySnapshot(run.saleOfferId, businessOutcome, now)
        : null;
      const trafficSummary = failedBeforeTrafficStartSummary(
        acceptedRunConfigSnapshotSchema.parse(run.configSnapshot),
        failureReason,
      );

      await this.summaryWriter.write({
        run,
        terminalStatus: "failed",
        failureReason,
        finalizedAt: now,
        httpSummary: trafficSummary.httpSummary,
        trafficDeliverySummary: trafficSummary.trafficDeliverySummary,
        httpTimingBreakdownSummary: {},
        loadRunDiagnosticsSummary: {
          failureReason,
          previousTrafficStatus: run.trafficStatus,
        },
        apiRequestLifecycleSummary: {
          failureReason,
          previousStatus: run.status,
          previousTrafficStatus: run.trafficStatus,
          finalizedAt: now.toISOString(),
        },
        businessOutcome,
        terminalInventorySnapshot,
        allowedCurrentStatuses: ["starting", "active"],
        terminalTrafficStatus: "failed",
      });
      const updatedRun = await this.readRunSnapshot(runId);

      if (run.saleOfferId) {
        await setRunSaleEligibility(this.options.redis, {
          runId,
          saleOfferId: run.saleOfferId,
          status: "closed",
        }).catch((error: unknown) => {
          this.options.logger.warn(
            { err: error, runId, saleOfferId: run.saleOfferId },
            "Could not close run sale eligibility after run failure.",
          );
        });
      }
      await this.publishRunEvent("run.failed", updatedRun, correlationId, now);
    }
  }

  private async readBusinessOutcomeForRun(
    run: typeof demoRuns.$inferSelect,
  ): Promise<BusinessOutcomeSummary> {
    if (!run.saleOfferId) {
      return emptyBusinessOutcomeSummary();
    }

    return this.options.businessOutcomeReader.read({
      saleOfferId: run.saleOfferId,
      runId: run.id,
    });
  }

  private async captureTerminalInventorySnapshot(
    saleOfferId: string,
    businessOutcome: { acceptedReservations: number },
    capturedAt: Date,
  ): Promise<TerminalInventorySnapshot | null> {
    try {
      const inventory = await getInventoryStatus(this.options.redis, saleOfferId, capturedAt);
      return {
        saleOfferId,
        startingStock: inventory.allocatedStock,
        remainingStock: inventory.remainingStock,
        reservedStock: inventory.reservedStock,
        acceptedReservations: businessOutcome.acceptedReservations,
        soldOutRejections: inventory.soldOutPressure.rejectionCount,
        pendingPersistenceCount: inventory.pendingPersistenceCount,
        capturedAt: capturedAt.toISOString(),
        source: "redis",
      };
    } catch (error) {
      this.options.logger.warn(
        { err: error, saleOfferId },
        "Could not capture terminal inventory snapshot at traffic completion.",
      );
      return null;
    }
  }

  private async readRunSnapshot(runId: string): Promise<DemoRunSnapshot> {
    const [run] = await this.options.db
      .select()
      .from(demoRuns)
      .where(eq(demoRuns.id, runId))
      .limit(1);
    if (!run) {
      throw new DemoRunValidationError("run_not_found", "Demo run was not found.", { runId });
    }
    return toDemoRunSnapshot(run);
  }

  private async publishRunEvent(
    type: "run.started" | "run.updated" | "run.failed",
    run: DemoRunSnapshot,
    correlationId: string,
    occurredAt: Date,
  ): Promise<void> {
    try {
      await publishDashboardEvent(this.options.redis, {
        type,
        eventId: this.generateId(),
        runId: run.runId,
        correlationId,
        run,
        occurredAt: occurredAt.toISOString(),
      });
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId: run.runId },
        "Could not publish run dashboard event.",
      );
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private generateId(): string {
    return this.options.generateId?.() ?? randomUUID();
  }
}

export function toDemoRunSnapshot(run: typeof demoRuns.$inferSelect): DemoRunSnapshot {
  return demoRunSnapshotSchema.parse({
    runId: run.id,
    presetId: run.presetId,
    presetName: run.presetName,
    operatorMode: run.operatorMode,
    status: run.status,
    trafficStatus: run.trafficStatus,
    ...(run.saleOfferId ? { saleOfferId: run.saleOfferId } : {}),
    configSnapshot: run.configSnapshot,
    ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
    ...(run.trafficStartedAt ? { trafficStartedAt: run.trafficStartedAt.toISOString() } : {}),
    ...(run.trafficEndedAt ? { trafficEndedAt: run.trafficEndedAt.toISOString() } : {}),
    ...(run.finalizedAt ? { finalizedAt: run.finalizedAt.toISOString() } : {}),
    ...(run.failureReason ? { failureReason: run.failureReason } : {}),
  });
}

function toDemoPresetContract(preset: typeof demoPresets.$inferSelect): DemoPresetContract {
  return demoPresetContractSchema.parse({
    id: preset.id,
    slug: preset.slug,
    visibility: preset.visibility,
    isEditable: preset.isEditable,
    isCustom: preset.isCustom,
    display: preset.display,
    trafficConfig: preset.trafficConfig,
    inventoryConfig: preset.inventoryConfig,
    erpConfig: preset.erpConfig,
    backpressureConfig: preset.backpressureConfig,
    createdAt: preset.createdAt.toISOString(),
    updatedAt: preset.updatedAt.toISOString(),
  });
}

function ensureEditableAdminPreset(preset: DemoPresetContract): void {
  if (preset.visibility !== "admin" || !preset.isEditable) {
    throw new DemoRunValidationError(
      "preset_not_editable",
      "Only editable admin presets can be changed.",
      { slug: preset.slug },
    );
  }
}

function normalizeSlug(slug: string): string {
  const normalized = slug
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

  if (!normalized) {
    throw new DemoRunValidationError(
      "invalid_preset_slug",
      "Preset slug must contain a letter or number.",
    );
  }

  return normalized;
}

function requirePresetRow(
  preset: typeof demoPresets.$inferSelect | undefined,
  slug: string,
): typeof demoPresets.$inferSelect {
  if (!preset) {
    throw new DemoRunValidationError("preset_not_found", "Demo preset was not found.", { slug });
  }

  return preset;
}

function mergeConfigSnapshot(
  base: AcceptedRunConfigSnapshot,
  override: DemoRunConfigOverride | undefined,
): AcceptedRunConfigSnapshot {
  if (!override) {
    return base;
  }

  return acceptedRunConfigSnapshotSchema.parse({
    trafficConfig: override.trafficConfig ?? base.trafficConfig,
    inventoryConfig: override.inventoryConfig ?? base.inventoryConfig,
    erpConfig: override.erpConfig ?? base.erpConfig,
    backpressureConfig: override.backpressureConfig ?? base.backpressureConfig,
  });
}

export function validateAcceptedRunSnapshot(
  snapshot: AcceptedRunConfigSnapshot,
  policy: PublicRuntimePolicy,
  options: { operatorMode: OperatorMode; enforcePublicCustomLimits: boolean },
): void {
  const totalRequests = calculatePlannedRequests(snapshot.trafficConfig);
  const requestRate =
    snapshot.trafficConfig.mode === "steady-arrival-rate"
      ? snapshot.trafficConfig.ratePerSecond
      : Math.ceil(
          snapshot.trafficConfig.buyerCount /
            Math.max(snapshot.trafficConfig.maxDurationSeconds, 1),
        );
  const durationSeconds =
    snapshot.trafficConfig.mode === "steady-arrival-rate"
      ? snapshot.trafficConfig.durationSeconds
      : snapshot.trafficConfig.maxDurationSeconds;
  const startDelaySeconds = snapshot.trafficConfig.startDelaySeconds;
  const k6Vus =
    snapshot.trafficConfig.mode === "steady-arrival-rate"
      ? snapshot.trafficConfig.k6Vus
      : undefined;

  assertCap(
    totalRequests,
    policy.deploymentHardCaps.maxTotalRequests,
    "deployment_total_requests_exceeded",
  );
  assertCap(
    requestRate,
    policy.deploymentHardCaps.maxRequestsPerSecond,
    "deployment_request_rate_exceeded",
  );
  assertCap(
    durationSeconds,
    policy.deploymentHardCaps.maxTrafficDurationSeconds,
    "deployment_duration_exceeded",
  );
  assertCap(
    startDelaySeconds,
    policy.deploymentHardCaps.maxTrafficStartDelaySeconds,
    "deployment_start_delay_exceeded",
  );

  if (snapshot.trafficConfig.mode === "buyer-spike") {
    assertCap(
      snapshot.trafficConfig.buyerCount,
      policy.deploymentHardCaps.maxBuyers,
      "deployment_buyers_exceeded",
    );
  }
  if (k6Vus) {
    assertCap(
      k6Vus.preAllocatedVus,
      policy.deploymentHardCaps.maxPreAllocatedVus,
      "deployment_preallocated_vus_exceeded",
    );
    assertCap(k6Vus.maxVus, policy.deploymentHardCaps.maxVus, "deployment_max_vus_exceeded");
  }

  if (options.operatorMode !== "public" || !options.enforcePublicCustomLimits) {
    return;
  }

  const limits = policy.publicCustomLimits;
  if (!limits.allowedTrafficModes.includes(snapshot.trafficConfig.mode)) {
    throw new DemoRunValidationError(
      "public_traffic_mode_not_allowed",
      "Traffic mode is not allowed for public runs.",
    );
  }
  assertCap(totalRequests, limits.maxTotalRequests, "public_total_requests_exceeded");
  assertCap(requestRate, limits.maxRequestsPerSecond, "public_request_rate_exceeded");
  assertCap(durationSeconds, limits.maxTrafficDurationSeconds, "public_duration_exceeded");
  assertCap(startDelaySeconds, limits.maxTrafficStartDelaySeconds, "public_start_delay_exceeded");
  assertCap(
    snapshot.inventoryConfig.startingStock,
    limits.maxStartingStock,
    "public_starting_stock_exceeded",
  );
  assertCap(snapshot.erpConfig.latencyMs, limits.maxErpLatencyMs, "public_erp_latency_exceeded");
  if (
    snapshot.erpConfig.maxTps < limits.minErpMaxTps ||
    snapshot.erpConfig.maxTps > limits.maxErpMaxTps
  ) {
    throw new DemoRunValidationError(
      "public_erp_tps_exceeded",
      "ERP TPS is outside public custom limits.",
    );
  }
  if (snapshot.erpConfig.errorRate > limits.maxErpErrorRate) {
    throw new DemoRunValidationError(
      "public_erp_error_rate_exceeded",
      "ERP error rate exceeds public custom limits.",
    );
  }
  if (snapshot.erpConfig.forcedOutage && !limits.allowForcedOutage) {
    throw new DemoRunValidationError(
      "public_forced_outage_not_allowed",
      "Forced outage is not allowed for public runs.",
    );
  }
  if (snapshot.trafficConfig.mode === "buyer-spike") {
    assertCap(snapshot.trafficConfig.buyerCount, limits.maxBuyers, "public_buyers_exceeded");
  }
  if (k6Vus) {
    assertCap(k6Vus.preAllocatedVus, limits.maxPreAllocatedVus, "public_preallocated_vus_exceeded");
    assertCap(k6Vus.maxVus, limits.maxVus, "public_max_vus_exceeded");
  }
}

export function validatePublicRuntimePolicyUpdate(policy: PublicRuntimePolicy): void {
  const caps = policy.deploymentHardCaps;
  const limits = policy.publicCustomLimits;

  assertCap(
    limits.maxTotalRequests,
    caps.maxTotalRequests,
    "public_limit_total_requests_exceeds_deployment_cap",
  );
  assertCap(
    limits.maxRequestsPerSecond,
    caps.maxRequestsPerSecond,
    "public_limit_request_rate_exceeds_deployment_cap",
  );
  assertCap(
    limits.maxTrafficDurationSeconds,
    caps.maxTrafficDurationSeconds,
    "public_limit_duration_exceeds_deployment_cap",
  );
  assertCap(
    limits.maxTrafficStartDelaySeconds,
    caps.maxTrafficStartDelaySeconds,
    "public_limit_start_delay_exceeds_deployment_cap",
  );
  assertCap(limits.maxBuyers, caps.maxBuyers, "public_limit_buyers_exceeds_deployment_cap");
  assertCap(
    limits.maxPreAllocatedVus,
    caps.maxPreAllocatedVus,
    "public_limit_preallocated_vus_exceeds_deployment_cap",
  );
  assertCap(limits.maxVus, caps.maxVus, "public_limit_max_vus_exceeds_deployment_cap");

  if (limits.minErpMaxTps > limits.maxErpMaxTps) {
    throw new DemoRunValidationError(
      "public_erp_tps_limit_invalid",
      "Public ERP TPS minimum cannot exceed the maximum.",
      {
        minErpMaxTps: limits.minErpMaxTps,
        maxErpMaxTps: limits.maxErpMaxTps,
      },
    );
  }

  if (limits.maxPreAllocatedVus > limits.maxVus) {
    throw new DemoRunValidationError(
      "public_vus_limit_invalid",
      "Public preallocated VUs cannot exceed max VUs.",
      {
        maxPreAllocatedVus: limits.maxPreAllocatedVus,
        maxVus: limits.maxVus,
      },
    );
  }

  try {
    validateAcceptedRunSnapshot(policy.publicCustomDefaults, policy, {
      operatorMode: "public",
      enforcePublicCustomLimits: true,
    });
  } catch (error) {
    if (error instanceof DemoRunValidationError) {
      throw new DemoRunValidationError(
        `public_custom_default_${error.code}`,
        "Public custom defaults must fit within the active public runtime policy.",
        error.details,
      );
    }

    throw error;
  }
}

function calculatePlannedRequests(trafficConfig: TrafficConfig): number {
  if (trafficConfig.mode === "buyer-spike") {
    return trafficConfig.buyerCount * (trafficConfig.duplicateEachBuyerAttempt ? 2 : 1);
  }

  return trafficConfig.ratePerSecond * trafficConfig.durationSeconds;
}

function failedBeforeTrafficStartSummary(
  config: AcceptedRunConfigSnapshot,
  failureReason: string,
): {
  httpSummary: TrafficHttpSummary;
  trafficDeliverySummary: TrafficDeliverySummary;
} {
  const plannedRequests = calculatePlannedRequests(config.trafficConfig);

  return {
    httpSummary: {
      plannedRequests,
      emittedRequests: 0,
      completedRequests: 0,
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficDeliverySummary: {
      plannedRequests,
      emittedRequests: 0,
      droppedIterations: plannedRequests,
      trafficDeliveryStatus: "failed",
      notes: [`${failureReason}_before_traffic_start`],
    },
  };
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

function assertCap(value: number, cap: number, code: string): void {
  if (value > cap) {
    throw new DemoRunValidationError(code, "Accepted run configuration exceeds a configured cap.", {
      value,
      cap,
    });
  }
}

function trafficMetricKey(runId: string): string {
  return `demo-run:${runId}:traffic-metrics`;
}

function toAdminPublicRuntimePolicyResponse(
  row: typeof publicRuntimePolicies.$inferSelect,
  correlationId: string,
  timestamp: Date,
): AdminPublicRuntimePolicyResponse {
  return adminPublicRuntimePolicyResponseSchema.parse({
    id: row.id,
    policy: row.policy,
    updatedAt: row.updatedAt.toISOString(),
    correlationId,
    timestamp: timestamp.toISOString(),
  });
}

function requireRunSaleOfferId(run: DemoRunSnapshot): string {
  if (!run.saleOfferId) {
    throw new DemoRunValidationError("run_sale_offer_missing", "Demo run has no sale offer.", {
      runId: run.runId,
    });
  }

  return run.saleOfferId;
}
