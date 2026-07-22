import { randomUUID } from "node:crypto";
import {
  type AcceptedRunConfigSnapshot,
  type AdminPresetListItem,
  type AdminPresetListResponse,
  type AdminPresetMutationResponse,
  type AdminPublicRuntimePolicyResponse,
  type AdminPublicRuntimePolicyUpdateRequest,
  type ArchiveAdminPresetRequest,
  type ArchiveAdminPresetResponse,
  acceptedRunConfigSnapshotSchema,
  adminPresetListItemSchema,
  adminPresetListResponseSchema,
  adminPresetMutationResponseSchema,
  adminPublicRuntimePolicyResponseSchema,
  archiveAdminPresetResponseSchema,
  type BusinessOutcomeSummary,
  type CopyDemoPresetToCustomRequest,
  collectAcceptedRunConfigSnapshotViolations,
  controlServiceTokenHeaderName,
  type DemoPresetContract,
  type DemoRunConfigOverride,
  type DemoRunSnapshot,
  type DeploymentHardCaps,
  type DuplicateDemoPresetRequest,
  dashboardEventSchema,
  dashboardEventsRedisChannel,
  demoPresetContractSchema,
  type ErrorPayloadCode,
  emptyHttpTimingBreakdownSummary,
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
  type TrafficExecutionAbortResponse,
  type TrafficExecutionStartRequest,
  type TrafficExecutionStartResponse,
  trafficCompletionReportSchema,
  trafficExecutionAbortPath,
  trafficExecutionAbortRequestSchema,
  trafficExecutionAbortResponseSchema,
  trafficExecutionStartPath,
  trafficExecutionStartRequestSchema,
  trafficExecutionStartResponseSchema,
  trafficExecutionStatusPath,
  trafficExecutionStatusResponseSchema,
} from "@checkout-surge/contracts";
import { verifyPublicVisitorCredential } from "@checkout-surge/contracts/public-visitor-credential";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoPresets,
  demoRunFinalizations,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  getInventoryStatus,
  initializeInventory,
  products,
  publicRuntimePolicies,
  publishDashboardEvent,
  saleOffers,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import { type CheckoutSurgeLogger, correlationIdHeaderName } from "@checkout-surge/logger";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { ApiHttpError } from "../runtime/errors.js";
import type { DashboardBusinessOutcomeReader } from "./dashboard-recovery-service.js";
import type { DemoRunFinalizationController } from "./demo-run-finalization-service.js";
import {
  emptyBusinessOutcomeSummary,
  toDemoRunSnapshot,
  toRedisTerminalInventorySnapshot,
} from "./demo-run-projections.js";
import { parsePersistedAcceptedRunConfigSnapshot } from "./persisted-demo-run-state.js";
import type {
  PublicRunBudgetReservation,
  PublicRunBudgetStore,
} from "./public-run-budget-store.js";
import type { TerminalDemoRunWriter } from "./terminal-demo-run-writer.js";
import {
  findTrafficCompletionBindingMismatch,
  findTrafficCompletionRedeliveryMismatch,
} from "./traffic-completion-binding.js";
import type { TrafficCompletionEnrichmentController } from "./traffic-completion-enrichment-service.js";
import { classifyTrafficDeliverySummary } from "./traffic-delivery-classifier.js";
import { syntheticFailedTrafficSummary } from "./traffic-delivery-plan.js";

export const demoRunStartLockKey = "checkout_surge_demo_run_start";
const singleNonTerminalRunIndexName = "demo_runs_single_non_terminal_idx";
const generatedRunSaleDurationMs = 24 * 60 * 60 * 1000;
const recentMetricLimit = 50;
export const maximumPendingMetricBatches = 10;
export type TrafficMetricIngestOutcome = "accepted" | "at_capacity" | "fenced";
export type TrafficMetricAdmissionWrapper = <T>(operation: () => Promise<T>) => Promise<T>;

export type TrafficMetricPublishResult =
  | { outcome: "fenced" }
  | {
      outcome: "attempted";
      failures: Array<{ index: number; error: Error }>;
    };

export interface TrafficExecutionGateway {
  start(request: TrafficExecutionStartRequest): Promise<TrafficExecutionStartResponse>;
}

export interface TrafficAbortGateway {
  abortCurrent(input: {
    runId: string;
    reason: string;
    correlationId: string;
  }): Promise<TrafficExecutionAbortResponse>;
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
  archiveAdminPreset(request: ArchiveAdminPresetRequest): Promise<ArchiveAdminPresetResponse>;
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
  publicVisitorCredential?: string;
};

export class RedisDashboardTrafficMetricStore implements DashboardTrafficMetricReader {
  private operationTail: Promise<void> = Promise.resolve();
  private pendingOperationCount = 0;

  constructor(private readonly redis: CheckoutSurgeRedis) {}

  /**
   * Reserves bounded process capacity before invoking the admission wrapper, then
   * serializes each accepted batch across retention and advisory publication. The
   * second fence check prevents publication after a reset that wins between them.
   */
  async appendAndPublishIfLive(
    input: LoadMetricIngestRequest,
    publishAccepted: (
      publishIfLive: (eventPayloads: string[]) => Promise<TrafficMetricPublishResult>,
    ) => Promise<void>,
    withAdmission: TrafficMetricAdmissionWrapper = async (operation) => operation(),
  ): Promise<TrafficMetricIngestOutcome> {
    if (this.pendingOperationCount >= maximumPendingMetricBatches) return "at_capacity";
    this.pendingOperationCount += 1;
    const operation = this.operationTail
      .then(() =>
        withAdmission(async () => {
          const retained = await this.appendIfLiveAtomic(input);
          if (!retained) return "fenced" as const;
          await publishAccepted((eventPayloads) =>
            this.publishIfLiveAtomic(input.runId, eventPayloads),
          );
          return "accepted" as const;
        }),
      )
      .finally(() => {
        this.pendingOperationCount -= 1;
      });
    this.operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async appendIfLiveAtomic(input: LoadMetricIngestRequest): Promise<boolean> {
    const samplePayloads = input.samples.map((sample) => JSON.stringify(sample));
    const result = await this.redis.eval(
      `
        if redis.call("EXISTS", KEYS[2]) == 1 then return 0 end
        redis.call("RPUSH", KEYS[1], unpack(ARGV))
        redis.call("LTRIM", KEYS[1], -${recentMetricLimit}, -1)
        redis.call("EXPIRE", KEYS[1], 86400)
        return 1
      `,
      2,
      trafficMetricKey(input.runId),
      trafficMetricFenceKey(input.runId),
      ...samplePayloads,
    );
    return result === 1;
  }

  private async publishIfLiveAtomic(
    runId: string,
    eventPayloads: string[],
  ): Promise<TrafficMetricPublishResult> {
    if (eventPayloads.length === 0) return { outcome: "attempted", failures: [] };
    const result = await this.redis.eval(
      `
        if redis.call("EXISTS", KEYS[1]) == 1 then return { "fenced" } end
        local outcomes = { "attempted" }
        for i = 1, #ARGV do
          local publishResult = redis.pcall("PUBLISH", KEYS[2], ARGV[i])
          if type(publishResult) == "table" and publishResult.err then
            table.insert(outcomes, publishResult.err)
          else
            table.insert(outcomes, "")
          end
        end
        return outcomes
      `,
      2,
      trafficMetricFenceKey(runId),
      dashboardEventsRedisChannel,
      ...eventPayloads,
    );
    return parseTrafficMetricPublishResult(result, eventPayloads.length);
  }

  async fenceRun(runId: string): Promise<void> {
    await this.redis.set(trafficMetricFenceKey(runId), "reset", "EX", 24 * 60 * 60);
  }

  async clearRun(runId: string): Promise<void> {
    await this.redis
      .multi()
      .set(trafficMetricFenceKey(runId), "reset", "EX", 24 * 60 * 60)
      .del(trafficMetricKey(runId))
      .exec();
  }

  async hasRunState(runId: string): Promise<boolean> {
    return (await this.redis.exists(trafficMetricKey(runId))) === 1;
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

export class HttpTrafficExecutionGateway implements TrafficExecutionGateway, TrafficAbortGateway {
  constructor(
    private readonly options: {
      loadOrchestratorBaseUrl: string;
      controlServiceToken: string;
      requestTimeoutMs?: number;
      abortRequestTimeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {}

  async start(request: TrafficExecutionStartRequest): Promise<TrafficExecutionStartResponse> {
    const startRequest = trafficExecutionStartRequestSchema.parse(request);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 5_000);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.options.loadOrchestratorBaseUrl}${trafficExecutionStartPath}`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            [correlationIdHeaderName]: startRequest.correlationId,
            [controlServiceTokenHeaderName]: this.options.controlServiceToken,
          },
          body: JSON.stringify(startRequest),
          signal: controller.signal,
        },
      );
    } catch {
      const recovered = await this.recoverAmbiguousStart(startRequest).catch(() => null);
      if (recovered) return recovered;
      throw new ApiHttpError({
        statusCode: 502,
        code: "load_orchestrator_start_ambiguous",
        message: "The load orchestrator start outcome could not be confirmed.",
      });
    } finally {
      clearTimeout(timeout);
    }

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

  async abortCurrent(input: {
    runId: string;
    reason: string;
    correlationId: string;
  }): Promise<TrafficExecutionAbortResponse> {
    const request = trafficExecutionAbortRequestSchema.parse(input);
    const controller = new AbortController();
    const abortTimeoutMs = positiveTimeout(
      this.options.abortRequestTimeoutMs ?? 20_000,
      "abortRequestTimeoutMs",
    );
    let rejectTimeout: (reason: TrafficAbortTimeoutError) => void = () => undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectTimeout(new TrafficAbortTimeoutError());
    }, abortTimeoutMs);
    const abortOperation = (async () => {
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.loadOrchestratorBaseUrl.replace(/\/+$/, "")}${trafficExecutionAbortPath}`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            [correlationIdHeaderName]: request.correlationId ?? input.correlationId,
            [controlServiceTokenHeaderName]: this.options.controlServiceToken,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        },
      );
      if (!response.ok) return { response };
      try {
        return {
          response,
          confirmation: trafficExecutionAbortResponseSchema.parse(await response.json()),
        };
      } catch {
        throw new TrafficAbortInvalidResponseError();
      }
    })();
    void abortOperation.catch(() => undefined);
    let result: Awaited<typeof abortOperation>;
    try {
      result = await Promise.race([abortOperation, timeoutFailure]);
    } catch (error) {
      if (error instanceof TrafficAbortInvalidResponseError) {
        throw new ApiHttpError({
          statusCode: 502,
          code: "load_orchestrator_abort_invalid_response",
          message: "The load orchestrator returned an invalid abort confirmation.",
        });
      }
      throw new ApiHttpError({
        statusCode: 502,
        code: "load_orchestrator_abort_unconfirmed",
        message: "Traffic termination could not be confirmed.",
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!result.response.ok) {
      if (result.response.status === 409) {
        throw new ApiHttpError({
          statusCode: 409,
          code: "load_orchestrator_run_mismatch",
          message: "The load orchestrator is running a different demo run.",
        });
      }
      throw new ApiHttpError({
        statusCode: 502,
        code: "load_orchestrator_abort_unconfirmed",
        message: "Traffic termination could not be confirmed.",
      });
    }

    const confirmation = result.confirmation;
    if (
      !confirmation ||
      confirmation.requestedRunId !== input.runId ||
      confirmation.correlationId !== input.correlationId
    ) {
      throw new ApiHttpError({
        statusCode: 502,
        code: "load_orchestrator_abort_invalid_response",
        message: "The load orchestrator returned an invalid abort confirmation.",
      });
    }
    return confirmation;
  }

  private async recoverAmbiguousStart(
    request: TrafficExecutionStartRequest,
  ): Promise<TrafficExecutionStartResponse | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 5_000);
    try {
      const statusPath = trafficExecutionStatusPath.replace(":runId", request.runId);
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.loadOrchestratorBaseUrl}${statusPath}`,
        {
          headers: {
            accept: "application/json",
            [correlationIdHeaderName]: request.correlationId,
            [controlServiceTokenHeaderName]: this.options.controlServiceToken,
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) return null;
      const status = trafficExecutionStatusResponseSchema.parse(await response.json());
      if (status.state === "unknown" || !status.acceptedAt) return null;
      return trafficExecutionStartResponseSchema.parse({
        runId: request.runId,
        status: status.state === "accepted" ? "starting" : "active",
        startedAt: status.acceptedAt,
        correlationId: request.correlationId,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class DemoRunValidationError extends Error {
  constructor(
    readonly code: ErrorPayloadCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DemoRunValidationError";
  }
}

export function isSingleNonTerminalRunViolation(error: unknown): boolean {
  let candidate: unknown = error;

  for (let depth = 0; depth < 5 && candidate !== null; depth += 1) {
    if (typeof candidate !== "object") {
      return false;
    }

    const databaseError = candidate as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    const constraintName = databaseError.constraint_name ?? databaseError.constraint;

    if (databaseError.code === "23505" && constraintName === singleNonTerminalRunIndexName) {
      return true;
    }
    candidate = databaseError.cause;
  }

  return false;
}

export class DemoRunService implements DemoRunController {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      trafficExecutionGateway: TrafficExecutionGateway;
      publicRunBudgetStore: PublicRunBudgetStore;
      trafficMetricStore: RedisDashboardTrafficMetricStore;
      businessOutcomeReader: DashboardBusinessOutcomeReader;
      terminalRunWriter: Pick<TerminalDemoRunWriter, "write">;
      completionEnrichmentService: Pick<
        TrafficCompletionEnrichmentController,
        "completePendingEnrichment"
      >;
      finalizationService: DemoRunFinalizationController;
      apiBaseUrl: string;
      buyEndpointPath: string;
      logger: CheckoutSurgeLogger;
      publicClientCookieSecret: string;
      deploymentHardCaps: DeploymentHardCaps;
      now?: () => Date;
      generateId?: () => string;
    },
  ) {}

  async listPublicPresets(): Promise<PublicPresetListResponse> {
    const rows = await this.options.db
      .select()
      .from(demoPresets)
      .where(and(eq(demoPresets.visibility, "public"), isNull(demoPresets.archivedAt)))
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
      .where(isNull(demoPresets.archivedAt))
      .orderBy(sql`(${demoPresets.display}->>'sortOrder')::int`, demoPresets.slug);

    return adminPresetListResponseSchema.parse({
      presets: rows.map(toAdminPresetListItem),
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
        isSystem: false,
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

  async archiveAdminPreset(
    request: ArchiveAdminPresetRequest,
  ): Promise<ArchiveAdminPresetResponse> {
    const now = this.now();
    const slug = request.slug;

    const [row] = await this.options.db
      .select()
      .from(demoPresets)
      .where(eq(demoPresets.slug, slug))
      .limit(1);

    if (!row || row.archivedAt !== null) {
      throw new DemoRunValidationError("preset_not_found", "Demo preset was not found.", { slug });
    }

    if (!isPresetRowArchivable(row)) {
      throw new DemoRunValidationError(
        "preset_not_archivable",
        "Only operator-created admin presets can be archived.",
        { slug },
      );
    }

    // Recheck every persisted eligibility dimension in the write itself. The
    // loaded ID anchors the update to the row that passed the service guard,
    // while the remaining conditions prevent a concurrent protection change
    // (for example, a seed repair setting isSystem) from being overwritten.
    const [updated] = await this.options.db
      .update(demoPresets)
      .set({ archivedAt: now, updatedAt: now })
      .where(archivablePresetRowCondition(row.id))
      .returning();

    if (!updated?.archivedAt) {
      const [current] = await this.options.db
        .select()
        .from(demoPresets)
        .where(eq(demoPresets.id, row.id))
        .limit(1);

      if (!current || current.archivedAt !== null) {
        throw new DemoRunValidationError("preset_not_found", "Demo preset was not found.", {
          slug,
        });
      }

      throw new DemoRunValidationError(
        "preset_not_archivable",
        "Only operator-created admin presets can be archived.",
        { slug },
      );
    }

    return archiveAdminPresetResponseSchema.parse({
      slug: updated.slug,
      archivedAt: updated.archivedAt.toISOString(),
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
    const mutablePolicy = publicRuntimePolicyMutableSchema.parse(request.policy);
    let effectivePolicy: PublicRuntimePolicy;
    try {
      effectivePolicy = resolveEffectivePublicRuntimePolicy(
        mutablePolicy,
        this.options.deploymentHardCaps,
      );
    } catch (error) {
      throwPublicRuntimePolicyUpdateError(error);
    }

    const [updated] = await this.options.db
      .update(publicRuntimePolicies)
      .set({
        policy: mutablePolicy,
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

    return toAdminPublicRuntimePolicyResponse(
      {
        ...updated,
        policy: effectivePolicy,
      },
      correlationId,
      now,
    );
  }

  async startRun(
    request: StartDemoRunCommand,
    correlationId: string,
  ): Promise<StartDemoRunResponse> {
    const now = this.now();
    const verifiedVisitor =
      request.operatorMode === "public"
        ? verifyPublicVisitorCredential(
            this.options.publicClientCookieSecret,
            request.publicVisitorCredential,
          )
        : null;
    if (request.operatorMode === "public" && !verifiedVisitor) {
      throw new DemoRunValidationError(
        "public_visitor_forbidden",
        "A valid public visitor credential is required.",
      );
    }
    const policyRow = await this.readPublicRuntimePolicyRow();
    const policy = policyRow.policy;
    const acceptedConfig = await this.resolveAcceptedConfig(request, policy);
    validateAcceptedRunSnapshot(acceptedConfig.snapshot, policy, {
      operatorMode: request.operatorMode,
      enforcePublicCustomLimits:
        request.operatorMode === "public" && acceptedConfig.preset.isCustom,
    });

    let reservation: PublicRunBudgetReservation | undefined;
    let reservePublicBudget: (() => Promise<void>) | undefined;
    if (request.operatorMode === "public" && policy.isPublicRunBudgetEnforced) {
      if (!verifiedVisitor) throw new Error("Verified public visitor invariant failed.");
      const publicVisitorId = verifiedVisitor.visitorId;
      reservePublicBudget = async () => {
        const decision = await this.options.publicRunBudgetStore.reserve({
          budget: policy.publicRunBudget,
          publicVisitorId,
          now,
        });
        if (decision.outcome === "denied") {
          throw decision.reason === "visitor"
            ? new DemoRunValidationError(
                "public_visitor_run_budget_exceeded",
                "Public visitor run budget is exhausted.",
              )
            : new DemoRunValidationError(
                "public_run_budget_exceeded",
                "Public run budget is exhausted.",
              );
        }
        reservation = decision.reservation;
      };
    }

    try {
      const accepted = await this.createAcceptedRun(
        request,
        acceptedConfig.preset,
        acceptedConfig.snapshot,
        now,
        reservePublicBudget,
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

      await this.publishRunEvent(accepted.run, correlationId, now);

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
        if (
          !(error instanceof ApiHttpError && error.code === "load_orchestrator_start_ambiguous")
        ) {
          await this.failRun(accepted.run.runId, "load_orchestrator_start_failed", correlationId);
        }
        throw error;
      }

      const runAfterTrafficStart = await this.updateRunAfterTrafficStart(
        accepted.run.runId,
        trafficResponse,
        now,
      );
      await this.publishRunEvent(runAfterTrafficStart, correlationId, now);

      return startDemoRunResponseSchema.parse({
        run: runAfterTrafficStart,
        recovery: { establishedAt: now.toISOString() },
        correlationId,
        timestamp: now.toISOString(),
      });
    } catch (error) {
      if (reservation) {
        try {
          await this.options.publicRunBudgetStore.release(reservation);
        } catch (releaseError) {
          this.options.logger.error(
            { err: releaseError, correlationId, reservationId: reservation.reservationId },
            "Failed to release a rejected public run budget reservation.",
          );
        }
      }
      throw error;
    }
  }

  async ingestMetrics(input: LoadMetricIngestRequest): Promise<void> {
    const request = loadMetricIngestRequestSchema.parse(input);
    await this.options.trafficMetricStore.appendAndPublishIfLive(
      request,
      async (publishIfLive) => {
        const publications: Array<{
          metricName: MetricSample["metricName"];
          payload: string;
        }> = [];
        for (const sample of request.samples) {
          try {
            const event = dashboardEventSchema.parse({
              type: "dashboard.metric.observed",
              runId: request.runId,
              correlationId: request.correlationId,
              metricName: sample.metricName,
              value: sample.value,
              unit: sample.unit,
              occurredAt: sample.timestamp,
              observedAt: sample.timestamp,
            });
            publications.push({ metricName: sample.metricName, payload: JSON.stringify(event) });
          } catch (error) {
            this.warnTrafficMetricPublicationFailure(error, request, sample.metricName);
          }
        }

        try {
          const result = await publishIfLive(publications.map(({ payload }) => payload));
          if (result.outcome === "attempted") {
            for (const failure of result.failures) {
              const publication = publications[failure.index];
              if (publication) {
                this.warnTrafficMetricPublicationFailure(
                  failure.error,
                  request,
                  publication.metricName,
                );
              }
            }
          }
        } catch (error) {
          for (const publication of publications) {
            this.warnTrafficMetricPublicationFailure(error, request, publication.metricName);
          }
        }
      },
      async (retainAndPublish) =>
        this.options.db.transaction(async (tx) => {
          const [run] = await tx
            .select({ status: demoRuns.status, trafficStatus: demoRuns.trafficStatus })
            .from(demoRuns)
            .where(eq(demoRuns.id, request.runId))
            .limit(1)
            .for("update");
          if (!run) {
            throw new DemoRunValidationError("run_not_found", "Demo run was not found.", {
              runId: request.runId,
            });
          }
          if (
            !(["starting", "active"] as string[]).includes(run.status) ||
            !(["starting", "active"] as string[]).includes(run.trafficStatus)
          ) {
            throw new DemoRunValidationError(
              "traffic_metric_run_not_eligible",
              "Demo run is not eligible for traffic metric ingestion.",
              { runId: request.runId, status: run.status, trafficStatus: run.trafficStatus },
            );
          }

          const outcome = await retainAndPublish();
          if (outcome === "fenced") {
            throw new DemoRunValidationError(
              "traffic_metric_run_not_eligible",
              "Demo run traffic metrics have been fenced.",
              { runId: request.runId, status: run.status, trafficStatus: run.trafficStatus },
            );
          }
          return outcome;
        }),
    );
  }

  private warnTrafficMetricPublicationFailure(
    error: unknown,
    request: Pick<LoadMetricIngestRequest, "runId" | "correlationId">,
    metricName: MetricSample["metricName"],
  ): void {
    try {
      this.options.logger.warn(
        { err: error, runId: request.runId, correlationId: request.correlationId, metricName },
        "Could not publish traffic metric dashboard event.",
      );
    } catch {
      // Reporting an advisory publication failure must not redefine accepted retention.
    }
  }

  async reconcileStartingRuns(): Promise<number> {
    const rows = await this.options.db
      .select()
      .from(demoRuns)
      .where(eq(demoRuns.status, "starting"));
    let reconciled = 0;
    for (const run of rows) {
      if (!run.saleOfferId) continue;
      const correlationId = `traffic-reconcile-${run.id}`;
      try {
        const response = await this.options.trafficExecutionGateway.start({
          runId: run.id,
          saleOfferId: run.saleOfferId,
          apiBaseUrl: this.options.apiBaseUrl,
          buyEndpointPath: this.options.buyEndpointPath,
          correlationId,
          configSnapshot: parsePersistedAcceptedRunConfigSnapshot(
            run.configSnapshot,
            `demo run ${run.id} starting reconciliation`,
          ),
        });
        await this.updateRunAfterTrafficStart(run.id, response, this.now());
        reconciled += 1;
      } catch (error) {
        this.options.logger.warn(
          { err: error, runId: run.id },
          "Starting traffic intent remains pending reconciliation.",
        );
      }
    }
    return reconciled;
  }

  async recordTrafficCompletion(input: TrafficCompletionReport): Promise<DemoRunSnapshot> {
    const report = trafficCompletionReportSchema.parse(input);
    const classifiedTrafficDeliverySummary = classifyTrafficDeliverySummary(
      report.trafficDeliverySummary,
      report.transportAttemptCounts,
    );
    const now = this.now();
    const completionClaim = await this.options.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(demoRuns)
        .where(eq(demoRuns.id, report.runId))
        .limit(1)
        .for("update");
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
      if (!run.startedAt) {
        throw new Error(`Current demo run ${run.id} has no startedAt timestamp.`);
      }

      const bindingMismatch = findTrafficCompletionBindingMismatch(
        {
          runId: run.id,
          configSnapshot: run.configSnapshot,
          acceptedAt: run.startedAt,
          trafficStartedAt: run.trafficStartedAt,
        },
        report,
      );
      if (bindingMismatch) throwCompletionMismatch(run.id, bindingMismatch);
      const [existing] = await tx
        .select()
        .from(demoRunFinalizations)
        .where(eq(demoRunFinalizations.runId, report.runId))
        .limit(1)
        .for("update");
      if (existing) {
        const redeliveryMismatch = findTrafficCompletionRedeliveryMismatch(
          run,
          existing,
          report,
          classifiedTrafficDeliverySummary,
        );
        if (redeliveryMismatch) throwCompletionMismatch(run.id, redeliveryMismatch);
        return { inserted: false };
      }
      if (
        !(["starting", "active"] as string[]).includes(run.status) ||
        !(["starting", "active"] as string[]).includes(run.trafficStatus)
      ) {
        throw new DemoRunValidationError(
          "traffic_completion_run_not_eligible",
          "Demo run is not eligible for traffic completion ingestion.",
          { runId: report.runId, status: run.status, trafficStatus: run.trafficStatus },
        );
      }

      const [inserted] = await tx
        .insert(demoRunFinalizations)
        .values({
          runId: report.runId,
          exitCode: report.exitCode ?? null,
          errorMessage: report.errorMessage ?? null,
          transportAttemptCounts: report.transportAttemptCounts,
          httpSummary: report.httpSummary,
          trafficOutcomeSummary: report.trafficOutcomeSummary,
          trafficDeliverySummary: classifiedTrafficDeliverySummary,
          httpTimingBreakdownSummary: report.httpTimingBreakdownSummary,
          loadRunDiagnosticsSummary: report.loadRunDiagnosticsSummary,
          completionEnrichmentStatus: "pending",
          trafficSummaryReceivedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ runId: demoRunFinalizations.runId });
      const [claimedRun] = await tx
        .update(demoRuns)
        .set({
          status: "draining",
          trafficStatus: report.status,
          trafficStartedAt:
            run.trafficStartedAt ?? new Date(report.loadRunDiagnosticsSummary.startedAt),
          trafficEndedAt: new Date(report.completedAt),
          updatedAt: now,
        })
        .where(
          and(
            eq(demoRuns.id, report.runId),
            inArray(demoRuns.status, ["starting", "active"]),
            inArray(demoRuns.trafficStatus, ["starting", "active"]),
          ),
        )
        .returning({ id: demoRuns.id });
      if (!inserted || !claimedRun) {
        throw new DemoRunValidationError(
          "traffic_completion_run_not_eligible",
          "Demo run completion could not claim the active traffic lifecycle.",
          { runId: report.runId },
        );
      }
      return { inserted: true };
    });

    await this.options.completionEnrichmentService.completePendingEnrichment(report.runId);

    const updatedRun = await this.readRunSnapshot(report.runId);
    if (completionClaim.inserted) await this.publishRunEvent(updatedRun, report.correlationId, now);
    return (
      (await this.options.finalizationService.finalizeRun(report.runId, report.correlationId)) ??
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

    try {
      return await this.options.db.transaction(async (tx) => {
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

        const [incompleteReset] = await tx
          .select({ runId: demoRuns.id })
          .from(demoRuns)
          .leftJoin(demoRunSummaries, eq(demoRunSummaries.runId, demoRuns.id))
          .where(
            and(
              eq(demoRuns.status, "failed"),
              eq(demoRuns.failureReason, "admin_reset"),
              isNull(demoRunSummaries.id),
            ),
          )
          .limit(1);

        if (incompleteReset) {
          throw new DemoRunValidationError(
            "demo_reset_incomplete",
            "The prior demo reset must be repaired before another run can start.",
            { runId: incompleteReset.runId },
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
    } catch (error) {
      if (isSingleNonTerminalRunViolation(error)) {
        throw new DemoRunValidationError(
          "demo_run_already_active",
          "A demo run is already starting, active, or draining.",
        );
      }
      throw error;
    }
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
      .where(and(eq(demoPresets.slug, slug), isNull(demoPresets.archivedAt)))
      .limit(1);

    if (!preset) {
      throw new DemoRunValidationError("preset_not_found", "Demo preset was not found.", { slug });
    }

    return toDemoPresetContract(preset);
  }

  private async readPublicRuntimePolicyRow(): Promise<
    Omit<typeof publicRuntimePolicies.$inferSelect, "policy"> & { policy: PublicRuntimePolicy }
  > {
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

    return {
      ...row,
      policy: resolveEffectivePublicRuntimePolicy(row.policy, this.options.deploymentHardCaps),
    };
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
      .where(and(eq(demoRuns.id, runId), eq(demoRuns.status, "starting")))
      .returning();

    if (!run) {
      // The orchestrator acknowledgement can arrive after traffic completion,
      // finalization, or an admin reset has claimed the run. In that case the
      // compare-and-set intentionally loses; return the row that won the race
      // instead of applying a stale activation and resurrecting the run.
      return this.readRunSnapshot(runId);
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
      const trafficSummary = syntheticFailedTrafficSummary(
        parsePersistedAcceptedRunConfigSnapshot(run.configSnapshot, `demo run ${run.id}`),
        [`${failureReason}_before_traffic_start`],
      );

      await this.options.terminalRunWriter.write({
        run,
        terminalStatus: "failed",
        failureReason,
        finalizedAt: now,
        transportAttemptCounts: trafficSummary.transportAttemptCounts,
        httpSummary: trafficSummary.httpSummary,
        trafficDeliverySummary: trafficSummary.trafficDeliverySummary,
        httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
        loadRunDiagnosticsSummary: {
          failureReason,
          previousTrafficStatus: run.trafficStatus,
        },
        businessOutcome,
        terminalInventorySnapshot,
        allowedCurrentStatuses: ["starting", "active"],
        terminalTrafficStatus: "failed",
      });
      const updatedRun = await this.readRunSnapshot(runId);

      if (
        (updatedRun.status === "completed" || updatedRun.status === "failed") &&
        updatedRun.saleOfferId
      ) {
        await setRunSaleEligibility(this.options.redis, {
          runId,
          saleOfferId: updatedRun.saleOfferId,
          status: "closed",
        }).catch((error: unknown) => {
          this.options.logger.warn(
            { err: error, runId, saleOfferId: updatedRun.saleOfferId },
            "Could not close run sale eligibility after run failure.",
          );
        });
      }
      await this.publishRunEvent(updatedRun, correlationId, now);
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
      return toRedisTerminalInventorySnapshot({
        saleOfferId,
        inventory,
        businessOutcome,
        capturedAt,
      });
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
    run: DemoRunSnapshot,
    correlationId: string,
    occurredAt: Date,
  ): Promise<void> {
    try {
      await publishDashboardEvent(this.options.redis, {
        type: "load.run.updated",
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

function throwCompletionMismatch(
  runId: string,
  mismatch: { field: string; expected?: unknown; actual?: unknown },
): never {
  throw new DemoRunValidationError(
    "traffic_completion_report_mismatch",
    "Traffic completion does not match the accepted demo run.",
    {
      runId,
      field: mismatch.field,
      ...(Object.hasOwn(mismatch, "expected") ? { expected: mismatch.expected } : {}),
      ...(Object.hasOwn(mismatch, "actual") ? { actual: mismatch.actual } : {}),
    },
  );
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

/**
 * Centralized archive eligibility predicate. Used both to compute the admin-list
 * `canArchive` capability and to enforce archival, so the two cannot drift.
 * Only an operator-created (non-system), editable, non-custom, active admin
 * preset may be archived.
 */
function isPresetRowArchivable(row: typeof demoPresets.$inferSelect): boolean {
  return (
    row.visibility === archivablePresetProperties.visibility &&
    row.isEditable === archivablePresetProperties.isEditable &&
    row.isCustom === archivablePresetProperties.isCustom &&
    row.isSystem === archivablePresetProperties.isSystem &&
    row.archivedAt === null
  );
}

const archivablePresetProperties = {
  visibility: "admin",
  isEditable: true,
  isCustom: false,
  isSystem: false,
} as const;

function archivablePresetRowCondition(presetId: string) {
  return and(
    eq(demoPresets.id, presetId),
    eq(demoPresets.visibility, archivablePresetProperties.visibility),
    eq(demoPresets.isEditable, archivablePresetProperties.isEditable),
    eq(demoPresets.isCustom, archivablePresetProperties.isCustom),
    eq(demoPresets.isSystem, archivablePresetProperties.isSystem),
    isNull(demoPresets.archivedAt),
  );
}

function toAdminPresetListItem(row: typeof demoPresets.$inferSelect): AdminPresetListItem {
  return adminPresetListItemSchema.parse({
    ...toDemoPresetContract(row),
    canArchive: isPresetRowArchivable(row),
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
  const [violation] = collectAcceptedRunConfigSnapshotViolations(snapshot, policy, options);
  if (violation) {
    throw new DemoRunValidationError(violation.code, violation.message, violation.details);
  }
}

/**
 * The single boundary that validates strict persisted mutable JSON and combines
 * it with the API process's environment-owned deployment caps.
 */
export function resolveEffectivePublicRuntimePolicy(
  persistedMutablePolicy: unknown,
  deploymentHardCaps: DeploymentHardCaps,
): PublicRuntimePolicy {
  const mutablePolicy = publicRuntimePolicyMutableSchema.parse(persistedMutablePolicy);
  return publicRuntimePolicySchema.parse({
    ...mutablePolicy,
    deploymentHardCaps,
  });
}

export async function validateActivePublicRuntimePolicyAtStartup(
  db: CheckoutSurgeDatabase,
  deploymentHardCaps: DeploymentHardCaps,
): Promise<void> {
  const [row] = await db
    .select({ policy: publicRuntimePolicies.policy })
    .from(publicRuntimePolicies)
    .where(eq(publicRuntimePolicies.id, "active"))
    .limit(1);

  if (!row) {
    throw new Error('Active public runtime policy "active" is missing.');
  }

  try {
    resolveEffectivePublicRuntimePolicy(row.policy, deploymentHardCaps);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const diagnostics = error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "policy";
      const params = "params" in issue ? issue.params : undefined;
      const violationCode =
        params &&
        typeof params === "object" &&
        "violationCode" in params &&
        typeof params.violationCode === "string"
          ? ` (${params.violationCode})`
          : "";
      return `${path}${violationCode}: ${issue.message}`;
    });
    throw new Error(`Active public runtime policy is invalid: ${diagnostics.join("; ")}`);
  }
}

function throwPublicRuntimePolicyUpdateError(error: unknown): never {
  if (!(error instanceof ZodError)) throw error;
  const issue = error.issues[0];
  const params = issue && "params" in issue ? issue.params : undefined;
  if (
    issue &&
    params &&
    typeof params === "object" &&
    "violationCode" in params &&
    typeof params.violationCode === "string"
  ) {
    const details =
      "details" in params &&
      params.details &&
      typeof params.details === "object" &&
      !Array.isArray(params.details)
        ? (params.details as Record<string, unknown>)
        : undefined;
    throw new DemoRunValidationError(
      params.violationCode as ErrorPayloadCode,
      issue.message,
      details,
    );
  }
  throw error;
}

function trafficMetricKey(runId: string): string {
  return `demo-run:${runId}:traffic-metrics`;
}

function trafficMetricFenceKey(runId: string): string {
  return `demo-run:${runId}:traffic-metrics-reset-fence`;
}

function parseTrafficMetricPublishResult(
  value: unknown,
  expectedOutcomeCount: number,
): TrafficMetricPublishResult {
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== "string") {
    throw new Error("Redis returned an invalid traffic metric publication result.");
  }
  if (value[0] === "fenced" && value.length === 1) return { outcome: "fenced" };
  if (value[0] !== "attempted" || value.length !== expectedOutcomeCount + 1) {
    throw new Error("Redis returned an invalid traffic metric publication result.");
  }

  const failures: Array<{ index: number; error: Error }> = [];
  for (let index = 0; index < expectedOutcomeCount; index += 1) {
    const outcome = value[index + 1];
    if (typeof outcome !== "string") {
      throw new Error("Redis returned an invalid traffic metric publication result.");
    }
    if (outcome.length > 0) failures.push({ index, error: new Error(outcome) });
  }
  return { outcome: "attempted", failures };
}

function positiveTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number.`);
  }
  return value;
}

class TrafficAbortTimeoutError extends Error {}
class TrafficAbortInvalidResponseError extends Error {}

function toAdminPublicRuntimePolicyResponse(
  row: Omit<typeof publicRuntimePolicies.$inferSelect, "policy"> & {
    policy: PublicRuntimePolicy;
  },
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
