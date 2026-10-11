import { randomUUID } from "node:crypto";
import {
  type AcceptedRunConfigSnapshot,
  acceptedRunConfigWriteSchema,
  type BusinessOutcomeSummary,
  collectAcceptedRunConfigSnapshotViolations,
  comparisonPresetSlug,
  type DemoPresetContract,
  type DemoRunConfigOverride,
  type DemoRunSnapshot,
  emptyHttpTimingBreakdownSummary,
  emptyServerReservationTimingSummary,
  type InternalRunFailureReason,
  isReplayPossible,
  type OperatorMode,
  type PreviewDemoRunResponse,
  type PublicRuntimePolicy,
  previewDemoRunResponseSchema,
  type StartDemoRunRequest,
  type StartDemoRunResponse,
  startDemoRunResponseSchema,
  type TerminalInventorySnapshot,
  type TrafficExecutionStartResponse,
} from "@checkout-surge/contracts";
import { verifyPublicVisitorCredential } from "@checkout-surge/contracts/public-visitor-credential";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRuns,
  InventoryNotInitializedError,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq, inArray, not, sql } from "drizzle-orm";
import { ApiHttpError } from "../runtime/errors.js";
import {
  AcceptedRunLaunchRejectedError,
  insertStartingRun,
  requireDemoStartSlot,
} from "./accepted-demo-run.js";
import {
  assessCapacity,
  automaticConstantArrivalVus,
  type DeploymentCapacity,
  requireCapacityAdmission,
  withResolvedConstantArrivalVus,
} from "./capacity-admission.js";
import type { DashboardBusinessOutcomeReader } from "./dashboard-recovery-service.js";
import {
  estimateAcceptedDemoRun,
  requireEstimatedDurationAdmission,
} from "./demo-duration-admission-service.js";
import type { DurationEstimatorConstants } from "./demo-duration-estimator.js";
import type { DemoMaintenanceAuthority } from "./demo-maintenance-authority.js";
import type { ActiveDemoPresetReader } from "./demo-preset-service.js";
import {
  emptyBusinessOutcomeSummary,
  toDemoRunSnapshot,
  toTerminalInventorySnapshot,
} from "./demo-run-projections.js";
import {
  publishDemoRunProjectionDirty,
  readDemoRunSnapshot,
} from "./demo-run-snapshot-operations.js";
import { DemoRunValidationError } from "./demo-run-validation-error.js";
import { incompleteAdminResetPredicate } from "./incomplete-admin-reset.js";
import type { OrderProcessQueueLimits } from "./order-process-queue-limits.js";
import { parsePersistedAcceptedRunConfigSnapshot } from "./persisted-demo-run-state.js";
import type {
  PublicRunBudgetReservation,
  PublicRunBudgetStore,
} from "./public-run-budget-store.js";
import type { EffectivePublicRuntimePolicyReader } from "./public-runtime-policy-service.js";
import type { RunInventoryLifecycle } from "./run-inventory-lifecycle.js";
import { RunnerCapacityUnavailableError } from "./runner-host.js";
import type { RunnerBoot, RunnerOperations } from "./runner-operations.js";
import type { TerminalDemoRunWriter } from "./terminal-demo-run-writer.js";
import { syntheticFailedTrafficSummary } from "./traffic-delivery-plan.js";
import {
  type TrafficExecutionGateway,
  TrafficStartRejectedError,
} from "./traffic-execution-gateway.js";

export const demoRunStartLockKey = "checkout_surge_demo_run_start";
const singleNonTerminalRunIndexName = "demo_runs_single_non_terminal_idx";

export interface DemoRunLifecycleController {
  previewRun(request: StartDemoRunCommand): Promise<PreviewDemoRunResponse>;
  startRun(request: StartDemoRunCommand, correlationId: string): Promise<StartDemoRunResponse>;
}

export type StartDemoRunCommand = StartDemoRunRequest & {
  operatorMode: OperatorMode;
  publicVisitorCredential?: string;
};

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

export class DemoRunLifecycleService implements DemoRunLifecycleController {
  constructor(
    private readonly options: {
      maintenanceAuthority: DemoMaintenanceAuthority;
      db: CheckoutSurgeDatabase;
      inventory: Pick<RunInventoryLifecycle, "initialize" | "close" | "read" | "retire">;
      redis: CheckoutSurgeRedis;
      trafficExecutionGateway: TrafficExecutionGateway;
      runnerOperations: Pick<RunnerOperations, "bootForRun" | "releaseAfterRun">;
      publicRunBudgetStore: PublicRunBudgetStore;
      presetReader: ActiveDemoPresetReader;
      runtimePolicyReader: EffectivePublicRuntimePolicyReader;
      businessOutcomeReader: DashboardBusinessOutcomeReader;
      queueLimits: OrderProcessQueueLimits;
      terminalRunWriter: Pick<TerminalDemoRunWriter, "write">;
      apiBaseUrl: string;
      logger: CheckoutSurgeLogger;
      publicClientCookieSecret: string;
      estimatorConstants: DurationEstimatorConstants;
      deploymentCapacity: DeploymentCapacity;
      now?: () => Date;
      generateId?: () => string;
      onRunAccepted?: (runId: string) => Promise<void>;
    },
  ) {}

  async startRun(
    request: StartDemoRunCommand,
    correlationId: string,
  ): Promise<StartDemoRunResponse> {
    return this.options.maintenanceAuthority.runExclusive(() =>
      this.startRunExclusive(request, correlationId),
    );
  }

  private async startRunExclusive(
    request: StartDemoRunCommand,
    correlationId: string,
  ): Promise<StartDemoRunResponse> {
    const now = this.now();
    const verifiedVisitor = this.verifyVisitor(request);
    await this.resolveValidatedConfig(request);

    let reservation: PublicRunBudgetReservation | undefined;
    const reservePublicBudget = async (policy: PublicRuntimePolicy) => {
      if (request.operatorMode === "public" && policy.isPublicRunBudgetEnforced) {
        if (!verifiedVisitor) throw new Error("Verified public visitor invariant failed.");
        const publicVisitorId = verifiedVisitor.visitorId;
        const decision = await this.options.publicRunBudgetStore.reserve({
          budget: policy.publicRunBudget,
          publicVisitorId,
          now,
        });
        if (decision.outcome === "denied") {
          throw new DemoRunValidationError(
            "public_run_budget_exceeded",
            decision.reason === "visitor"
              ? "Public visitor run budget is exhausted."
              : "Public run budget is exhausted.",
            { budget: decision.reason },
            decision.retryAfterSeconds,
          );
        }
        reservation = decision.reservation;
      }
    };

    try {
      const accepted = await this.createAcceptedRun(
        request,
        correlationId,
        now,
        reservePublicBudget,
      );
      return await this.launchAcceptedRunExclusive(accepted.run, correlationId);
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
      throw error instanceof AcceptedRunLaunchRejectedError ? error.cause : error;
    }
  }

  /** Caller holds the composed control maintenance authority; no SQL transaction is open. */
  async launchAcceptedRunExclusive(
    acceptedRun: DemoRunSnapshot,
    correlationId: string,
  ): Promise<StartDemoRunResponse> {
    const now = acceptedRun.startedAt ? new Date(acceptedRun.startedAt) : this.now();
    const saleOfferId = requireRunSaleOfferId(acceptedRun);
    await this.removePreviousRunInventories();

    try {
      // Select the buying implementation on every peer before stock becomes accepting.
      await this.options.onRunAccepted?.(acceptedRun.runId);
      await this.options.queueLimits.synchronize();
      await this.options.inventory.initialize(
        {
          runId: acceptedRun.runId,
          saleOfferId,
          executionMode: acceptedRun.executionMode,
        },
        acceptedRun.configSnapshot.inventoryConfig.startingStock,
        now,
      );
    } catch (error) {
      await this.failRun(
        acceptedRun.runId,
        "inventory_initialization_failed",
        correlationId,
        "no_traffic_started",
      );
      throw new AcceptedRunLaunchRejectedError(error);
    }

    await publishDemoRunProjectionDirty(this.options.redis, this.options.logger, {
      run: acceptedRun,
      correlationId,
    });

    let boot: RunnerBoot;
    try {
      boot = await this.options.runnerOperations.bootForRun(acceptedRun.runId, {
        onRelocating: () => this.markRunnerRelocating(acceptedRun.runId, correlationId),
      });
    } catch (error) {
      // The runner failed before any start was dispatched: no traffic can have started.
      await this.failRun(
        acceptedRun.runId,
        error instanceof RunnerCapacityUnavailableError
          ? "runner_capacity_unavailable"
          : "load_generator_not_started",
        correlationId,
        "no_traffic_started",
      );
      throw new AcceptedRunLaunchRejectedError(error);
    }
    // If this write fails, the run stays starting: reconciliation then fails it when the boot
    // is not recorded, or replays it against the boot when the write did commit.
    await this.recordRunnerBoot(acceptedRun.runId, boot);

    let trafficResponse: TrafficExecutionStartResponse;
    try {
      trafficResponse = await this.options.trafficExecutionGateway.start({
        runId: acceptedRun.runId,
        saleOfferId,
        apiBaseUrl: this.options.apiBaseUrl,
        expectedBootId: boot.bootId,
        correlationId,
        configSnapshot: acceptedRun.configSnapshot,
      });
    } catch (error) {
      if (!(error instanceof ApiHttpError && error.code === "load_orchestrator_start_ambiguous")) {
        const rejected = error instanceof TrafficStartRejectedError;
        await this.failRun(
          acceptedRun.runId,
          rejected ? "load_generator_not_started" : "load_orchestrator_unavailable",
          correlationId,
          rejected ? "no_traffic_started" : "unavailable",
        );
      }
      throw error instanceof TrafficStartRejectedError
        ? new AcceptedRunLaunchRejectedError(error)
        : error;
    }

    const runAfterTrafficStart = await this.updateRunAfterTrafficStart(
      acceptedRun.runId,
      trafficResponse,
      now,
    );
    await publishDemoRunProjectionDirty(this.options.redis, this.options.logger, {
      run: runAfterTrafficStart,
      correlationId,
    });

    return startDemoRunResponseSchema.parse({
      run: runAfterTrafficStart,
      recovery: { establishedAt: now.toISOString() },
      correlationId,
      timestamp: now.toISOString(),
    });
  }

  /**
   * Fails an active or starting run whose runner was lost before its completion report was
   * persisted. Traffic may have started, so its counts are unavailable. A run already draining
   * (its report persisted) is left to finalization.
   */
  failLostRun(runId: string): Promise<void> {
    return this.options.maintenanceAuthority.runExclusive(() =>
      this.failRun(runId, "load_generator_lost", `runner-loss-${runId}`, "unavailable"),
    );
  }

  /**
   * Fails a starting run whose runner boot was never recorded: its start was never dispatched,
   * so no traffic started. Stops any runner booted for it. The caller holds the maintenance
   * authority, so no start of this run is in progress.
   */
  async failUndispatchedRun(runId: string): Promise<void> {
    await this.failRun(
      runId,
      "load_generator_not_started",
      `traffic-reconcile-${runId}`,
      "no_traffic_started",
    );
    this.options.runnerOperations.releaseAfterRun({ runId, bootId: null });
  }

  async previewRun(request: StartDemoRunCommand): Promise<PreviewDemoRunResponse> {
    this.verifyVisitor(request);
    const config = await this.resolveValidatedConfig(request);
    const traffic = config.snapshot.trafficConfig;
    return previewDemoRunResponseSchema.parse({
      result: estimateAcceptedDemoRun(
        config.snapshot,
        config.policy,
        this.options.estimatorConstants,
      ),
      capacity: this.assessRunCapacity(config),
      automaticVus:
        traffic.mode === "constant-arrival-rate"
          ? automaticConstantArrivalVus(
              traffic.ratePerSecond,
              this.options.deploymentCapacity.vuLatencyBudgetSeconds,
              config.policy.deploymentHardCaps,
            )
          : null,
    });
  }

  private verifyVisitor(request: StartDemoRunCommand) {
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
    return verifiedVisitor;
  }

  private async resolveValidatedConfig(
    request: StartDemoRunCommand,
    db?: Pick<CheckoutSurgeDatabase, "select">,
  ) {
    const policy = await this.options.runtimePolicyReader.readEffectivePolicy(db);
    const { preset, snapshot } = await this.resolveAcceptedConfig(request, policy, db);
    const isPublicCustom = request.operatorMode === "public" && preset.isCustom;
    const validation = {
      operatorMode: request.operatorMode,
      enforcePublicCustomLimits: isPublicCustom,
    };
    validateAcceptedRunSnapshot(snapshot, policy, validation);
    return {
      preset,
      // Resolved after validation: the public VU limits bind only VUs the caller set.
      snapshot: withResolvedConstantArrivalVus(
        snapshot,
        this.options.deploymentCapacity.vuLatencyBudgetSeconds,
        policy.deploymentHardCaps,
      ),
      policy,
      validation,
      isPublicCustom,
    };
  }

  /** A suggested safety cutoff must itself pass the duration estimate and the run limits. */
  private assessRunCapacity({
    snapshot,
    policy,
    validation,
  }: {
    snapshot: AcceptedRunConfigSnapshot;
    policy: PublicRuntimePolicy;
    validation: { operatorMode: OperatorMode; enforcePublicCustomLimits: boolean };
  }) {
    return assessCapacity(snapshot, this.options.deploymentCapacity, (cutoffSeconds) => {
      if (snapshot.trafficConfig.mode !== "buyer-spike") return false;
      const candidate = {
        ...snapshot,
        trafficConfig: { ...snapshot.trafficConfig, maxDurationSeconds: cutoffSeconds },
      };
      return (
        estimateAcceptedDemoRun(candidate, policy, this.options.estimatorConstants).decision ===
          "admitted" &&
        collectAcceptedRunConfigSnapshotViolations(candidate, policy, validation).length === 0
      );
    });
  }

  private async createAcceptedRun(
    request: StartDemoRunCommand,
    correlationId: string,
    now: Date,
    beforeInsert: (policy: PublicRuntimePolicy) => Promise<void>,
  ): Promise<{ run: DemoRunSnapshot }> {
    const runId = this.generateId();
    const saleOfferId = this.generateId();

    try {
      return await this.options.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${demoRunStartLockKey}))`);

        await requireDemoStartSlot(tx);

        const config = await this.resolveValidatedConfig(request, tx);
        const { preset, snapshot, policy } = config;
        requireEstimatedDurationAdmission(
          estimateAcceptedDemoRun(snapshot, policy, this.options.estimatorConstants),
        );
        if (config.isPublicCustom) {
          requireCapacityAdmission(this.assessRunCapacity(config));
        }
        await beforeInsert(policy);

        const run = await insertStartingRun(tx, {
          runId,
          saleOfferId,
          presetId: preset.id,
          presetName: preset.display.name,
          snapshot,
          executionMode: "demo",
          operatorMode: request.operatorMode,
          correlationId,
          acceptedAt: now,
        });
        return { run };
      });
    } catch (error) {
      if (isSingleNonTerminalRunViolation(error)) {
        throw new DemoRunValidationError(
          "run_conflict",
          "A demo run is already starting, active, or draining.",
          { conflictReason: "active_run_exists" },
        );
      }
      throw error;
    }
  }

  private async resolveAcceptedConfig(
    request: StartDemoRunCommand,
    policy: PublicRuntimePolicy,
    db?: Pick<CheckoutSurgeDatabase, "select">,
  ): Promise<{ preset: DemoPresetContract; snapshot: AcceptedRunConfigSnapshot }> {
    const preset = await this.options.presetReader.readActivePreset(request.presetSlug, db);
    if (preset.slug === comparisonPresetSlug) {
      throw new DemoRunValidationError(
        "preset_operation_not_allowed",
        "Use the fixed comparison start for this preset.",
      );
    }

    if (request.operatorMode === "public" && preset.visibility !== "public") {
      throw new DemoRunValidationError(
        "preset_operation_not_allowed",
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
      snapshot: acceptedRunConfigWriteSchema.parse(
        mergeConfigSnapshot(base, request.configOverride),
      ),
    };
  }

  private async recordRunnerBoot(runId: string, boot: RunnerBoot): Promise<void> {
    await this.options.db
      .update(demoRuns)
      .set({
        runnerMachineId: boot.machineId,
        runnerBootId: boot.bootId,
        runnerRegion: boot.region,
        runnerRelocating: false,
        updatedAt: this.now(),
      })
      .where(eq(demoRuns.id, runId));
  }

  /** Lets viewers of the starting run know the runner is being relocated. Best effort. */
  private async markRunnerRelocating(runId: string, correlationId: string): Promise<void> {
    try {
      const [run] = await this.options.db
        .update(demoRuns)
        .set({ runnerRelocating: true, updatedAt: this.now() })
        .where(and(eq(demoRuns.id, runId), eq(demoRuns.status, "starting")))
        .returning();
      if (run) {
        await publishDemoRunProjectionDirty(this.options.redis, this.options.logger, {
          run: toDemoRunSnapshot(run),
          correlationId,
        });
      }
    } catch (error) {
      this.options.logger.warn({ err: error, runId }, "Could not record the runner relocation.");
    }
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
      return readDemoRunSnapshot(this.options.db, runId);
    }

    return toDemoRunSnapshot(run);
  }

  private async failRun(
    runId: string,
    failureReason: InternalRunFailureReason,
    correlationId: string,
    evidence: "no_traffic_started" | "unavailable",
  ): Promise<void> {
    const now = this.now();
    const [run] = await this.options.db.select().from(demoRuns).where(eq(demoRuns.id, runId));

    if (run) {
      if (run.saleOfferId) {
        await this.options.inventory
          .close({ runId: run.id, saleOfferId: run.saleOfferId, executionMode: run.executionMode })
          .catch((error: unknown) => {
            if (!(error instanceof InventoryNotInitializedError)) {
              this.options.logger.warn(
                { err: error, runId: run.id },
                "Could not close inventory before failure capture; terminal admission is fenced by the writer.",
              );
            }
          });
      }
      const businessOutcome = await this.readBusinessOutcomeForRun(run);
      const terminalInventorySnapshot = run.saleOfferId
        ? await this.captureTerminalInventorySnapshot(run, businessOutcome, now)
        : null;
      const trafficSummary = syntheticFailedTrafficSummary(
        parsePersistedAcceptedRunConfigSnapshot(run.configSnapshot, `demo run ${run.id}`),
        [
          evidence === "no_traffic_started"
            ? `${failureReason}_before_traffic_start`
            : failureReason === "load_generator_lost"
              ? "Traffic evidence is unavailable: the load generator was lost before its completion report."
              : "Traffic evidence is unavailable: start failed without a definitive rejection.",
        ],
        evidence,
      );

      await this.options.terminalRunWriter.write({
        run,
        terminalStatus: "failed",
        failureReason,
        replayPossible: isReplayPossible(
          parsePersistedAcceptedRunConfigSnapshot(run.configSnapshot, `demo run ${run.id}`),
        ),
        finalizedAt: now,
        transportAttemptCounts: trafficSummary.transportAttemptCounts,
        httpSummary: trafficSummary.httpSummary,
        trafficDeliverySummary: trafficSummary.trafficDeliverySummary,
        httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
        serverReservationTimingSummary: emptyServerReservationTimingSummary,
        loadRunDiagnosticsSummary: {
          failureReason,
          previousTrafficStatus: run.trafficStatus,
        },
        businessOutcome,
        terminalInventorySnapshot,
        runSignalTimelineSummary: null,
        allowedCurrentStatuses: ["starting", "active"],
        terminalTrafficStatus: "failed",
      });
      if (run.runnerBootId) {
        this.options.runnerOperations.releaseAfterRun({ runId, bootId: run.runnerBootId });
      }
      const updatedRun = await readDemoRunSnapshot(this.options.db, runId);

      if (
        (updatedRun.status === "completed" || updatedRun.status === "failed") &&
        updatedRun.saleOfferId
      ) {
        await this.options.inventory
          .close({
            runId,
            saleOfferId: updatedRun.saleOfferId,
            executionMode: updatedRun.executionMode,
          })
          .catch((error: unknown) => {
            this.options.logger.warn(
              { err: error, runId, saleOfferId: updatedRun.saleOfferId },
              "Could not close run sale eligibility after run failure.",
            );
          });
      }
      await publishDemoRunProjectionDirty(this.options.redis, this.options.logger, {
        run: updatedRun,
        correlationId,
      });
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

  /**
   * Removes earlier terminal runs' inventory namespaces and dashboard revisions. Not at
   * finalization: the dashboard rebuilds a finished run's terminal projection from them until a
   * new run is admitted. A run with a hold still awaiting persistence, or an unfinished reset,
   * keeps its namespace. Best effort: retention cleanup remains the fallback. Decision HD-61
   * (docs/decisions/hosted_deployment.md).
   */
  private async removePreviousRunInventories(): Promise<void> {
    try {
      const rows = await this.options.db
        .select({
          runId: demoRuns.id,
          saleOfferId: demoRuns.saleOfferId,
          executionMode: demoRuns.executionMode,
        })
        .from(demoRuns)
        .where(
          and(
            inArray(demoRuns.status, ["completed", "failed"]),
            not(incompleteAdminResetPredicate() ?? sql`false`),
          ),
        );
      const runs = rows.flatMap(({ runId, saleOfferId, executionMode }) =>
        saleOfferId ? [{ runId, saleOfferId, executionMode }] : [],
      );
      const results = await Promise.allSettled(
        runs.map((run) => this.options.inventory.retire(run)),
      );
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          this.options.logger.warn(
            { err: result.reason, runId: runs[index]?.runId },
            "Could not remove a previous run's inventory namespace; the retention cleanup remains the fallback.",
          );
        }
      }
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Could not list previous runs' inventory namespaces; the retention cleanup remains the fallback.",
      );
    }
  }

  private async captureTerminalInventorySnapshot(
    run: typeof demoRuns.$inferSelect,
    businessOutcome: { acceptedReservations: number },
    capturedAt: Date,
  ): Promise<TerminalInventorySnapshot | null> {
    try {
      if (!run.saleOfferId) return null;
      const saleOfferId = run.saleOfferId;
      const inventory = await this.options.inventory.read(
        { runId: run.id, saleOfferId, executionMode: run.executionMode },
        capturedAt,
      );
      return toTerminalInventorySnapshot({
        source: run.executionMode === "without_redis" ? "postgres" : "redis",
        saleOfferId,
        inventory,
        businessOutcome,
        capturedAt,
      });
    } catch (error) {
      this.options.logger.warn(
        { err: error, saleOfferId: run.saleOfferId },
        "Could not capture terminal inventory snapshot at traffic completion.",
      );
      return null;
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private generateId(): string {
    return this.options.generateId?.() ?? randomUUID();
  }
}

function mergeConfigSnapshot(
  base: AcceptedRunConfigSnapshot,
  override: DemoRunConfigOverride | undefined,
): AcceptedRunConfigSnapshot {
  if (!override) {
    return base;
  }

  return acceptedRunConfigWriteSchema.parse({
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
    throw new DemoRunValidationError("invalid_run_configuration", violation.message, {
      violationCode: violation.code,
      path: violation.path,
      ...violation.details,
    });
  }
}

function requireRunSaleOfferId(run: DemoRunSnapshot): string {
  if (!run.saleOfferId) {
    throw new DemoRunValidationError("run_conflict", "Demo run has no sale offer.", {
      conflictReason: "sale_offer_missing",
      runId: run.runId,
    });
  }

  return run.saleOfferId;
}
