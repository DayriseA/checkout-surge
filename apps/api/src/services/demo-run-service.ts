import { randomUUID } from "node:crypto";
import {
  type AcceptedRunConfigSnapshot,
  acceptedRunConfigWriteSchema,
  type BusinessOutcomeSummary,
  type ComparisonMode,
  collectAcceptedRunConfigSnapshotViolations,
  comparisonModes,
  comparisonOfMode,
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
  deleteSettledRunInventory,
  demoRunSaleContexts,
  demoRuns,
  getInventoryStatus,
  initializeInventory,
  postgresRunStock,
  products,
  readStoreLoadCounters,
  saleOffers,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import { ApiHttpError } from "../runtime/errors.js";
import {
  assessCapacity,
  automaticConstantArrivalVus,
  type DeploymentCapacity,
  requireCapacityAdmission,
  withResolvedConstantArrivalVus,
} from "./capacity-admission.js";
import { buyTargetBaseUrl, findRunAwaitingComparisonPartner } from "./comparison-runs.js";
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
  toRedisTerminalInventorySnapshot,
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
const generatedRunSaleDurationMs = 24 * 60 * 60 * 1000;

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
      /** The buy-only processes' base URL, for the Redis comparison's runs; null without them. */
      buyPoolBaseUrl?: string | null;
      logger: CheckoutSurgeLogger;
      publicClientCookieSecret: string;
      estimatorConstants: DurationEstimatorConstants;
      deploymentCapacity: DeploymentCapacity;
      now?: () => Date;
      generateId?: () => string;
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
      return await this.launchAcceptedRun(accepted.run, correlationId, now);
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

  /**
   * Starts the second run of a comparison whose first run completed: the same preset, snapshot
   * and operator mode, with the other mode. The start of the first run paid the budget for both.
   */
  startDueComparisonPartner(): Promise<void> {
    return this.options.maintenanceAuthority.runExclusive(async () => {
      const now = this.now();
      const correlationId = `comparison-partner-${randomUUID()}`;
      const run = await this.createComparisonPartnerRun(correlationId, now);
      if (run) await this.launchAcceptedRun(run, correlationId, now);
    });
  }

  /** Initializes the accepted run's stock, boots its runner and starts its traffic. */
  private async launchAcceptedRun(
    run: DemoRunSnapshot,
    correlationId: string,
    now: Date,
  ): Promise<StartDemoRunResponse> {
    const saleOfferId = requireRunSaleOfferId(run);
    await this.removePreviousRunInventories();

    try {
      await this.options.queueLimits.synchronize();
      await initializeInventory(this.options.redis, {
        saleOfferId,
        allocatedStock: run.configSnapshot.inventoryConfig.startingStock,
        source: "demo_run_start",
        initializedAt: now,
        run: { runId: run.runId, status: "accepting" },
      });
      // Its live counters stay in Redis; its stock is decided in PostgreSQL.
      if (run.comparison?.mode === "postgres") {
        await this.options.db.insert(postgresRunStock).values({
          runId: run.runId,
          saleOfferId,
          remainingStock: run.configSnapshot.inventoryConfig.startingStock,
        });
      }
    } catch (error) {
      await this.failRun(
        run.runId,
        "inventory_initialization_failed",
        correlationId,
        "no_traffic_started",
      );
      throw error;
    }

    await publishDemoRunProjectionDirty(this.options.redis, this.options.logger, {
      run: run,
      correlationId,
    });

    let boot: RunnerBoot;
    try {
      boot = await this.options.runnerOperations.bootForRun(run.runId, {
        onRelocating: () => this.markRunnerRelocating(run.runId, correlationId),
      });
    } catch (error) {
      // The runner failed before any start was dispatched: no traffic can have started.
      await this.failRun(
        run.runId,
        error instanceof RunnerCapacityUnavailableError
          ? "runner_capacity_unavailable"
          : "load_generator_not_started",
        correlationId,
        "no_traffic_started",
      );
      throw error;
    }
    // If this write fails, the run stays starting: reconciliation then fails it when the boot
    // is not recorded, or replays it against the boot when the write did commit.
    await this.recordRunnerBoot(run.runId, boot);

    await this.captureStoreLoadStart(run);

    let trafficResponse: TrafficExecutionStartResponse;
    try {
      trafficResponse = await this.options.trafficExecutionGateway.start({
        runId: run.runId,
        saleOfferId,
        apiBaseUrl: buyTargetBaseUrl(
          this.options.apiBaseUrl,
          run.comparison?.mode,
          this.options.buyPoolBaseUrl,
        ),
        expectedBootId: boot.bootId,
        correlationId,
        configSnapshot: run.configSnapshot,
      });
    } catch (error) {
      if (!(error instanceof ApiHttpError && error.code === "load_orchestrator_start_ambiguous")) {
        const rejected = error instanceof TrafficStartRejectedError;
        await this.failRun(
          run.runId,
          rejected ? "load_generator_not_started" : "load_orchestrator_unavailable",
          correlationId,
          rejected ? "no_traffic_started" : "unavailable",
        );
      }
      throw error;
    }

    const runAfterTrafficStart = await this.updateRunAfterTrafficStart(
      run.runId,
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

        const [existingRun] = await tx
          .select({ id: demoRuns.id, status: demoRuns.status })
          .from(demoRuns)
          .where(inArray(demoRuns.status, ["starting", "active", "draining"]))
          .limit(1);

        if (existingRun) {
          throw new DemoRunValidationError(
            "run_conflict",
            "A demo run is already starting, active, or draining.",
            {
              conflictReason: "active_run_exists",
              runId: existingRun.id,
              status: existingRun.status,
            },
          );
        }

        if (await findRunAwaitingComparisonPartner(tx, now)) {
          throw new DemoRunValidationError(
            "run_conflict",
            "A comparison is about to start its second run.",
            { conflictReason: "active_run_exists" },
          );
        }

        const [incompleteReset] = await tx
          .select({ runId: demoRuns.id })
          .from(demoRuns)
          .where(incompleteAdminResetPredicate())
          .limit(1);

        if (incompleteReset) {
          throw new DemoRunValidationError(
            "run_conflict",
            "The prior demo reset must be repaired before another run can start.",
            { conflictReason: "reset_incomplete", runId: incompleteReset.runId },
          );
        }

        const config = await this.resolveValidatedConfig(request, tx);
        const { preset, snapshot, policy } = config;
        requireEstimatedDurationAdmission(
          estimateAcceptedDemoRun(snapshot, policy, this.options.estimatorConstants),
        );
        if (config.isPublicCustom) {
          requireCapacityAdmission(this.assessRunCapacity(config));
        }
        await beforeInsert(policy);

        return {
          run: await this.insertAcceptedRun(tx, {
            runId,
            saleOfferId,
            presetId: preset.id,
            presetName: preset.display.name,
            operatorMode: request.operatorMode,
            configSnapshot: snapshot,
            correlationId,
            comparisonMode: preset.comparison ? comparisonModes[preset.comparison][0] : null,
            comparisonFirstRunId: null,
            now,
          }),
        };
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

  /** Inserts the second run of a due comparison, or returns null when none is due. */
  private async createComparisonPartnerRun(
    correlationId: string,
    now: Date,
  ): Promise<DemoRunSnapshot | null> {
    return this.options.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${demoRunStartLockKey}))`);
      const due = await findRunAwaitingComparisonPartner(tx, now);
      if (!due) return null;
      const [nonterminalRun] = await tx
        .select({ id: demoRuns.id })
        .from(demoRuns)
        .where(inArray(demoRuns.status, ["starting", "active", "draining"]))
        .limit(1);
      if (nonterminalRun) return null;
      return this.insertAcceptedRun(tx, {
        runId: this.generateId(),
        saleOfferId: this.generateId(),
        presetId: due.run.presetId,
        presetName: due.run.presetName,
        operatorMode: due.run.operatorMode,
        configSnapshot: parsePersistedAcceptedRunConfigSnapshot(
          due.run.configSnapshot,
          `demo run ${due.run.id}`,
        ),
        correlationId,
        comparisonMode: comparisonModes[due.comparison][1],
        comparisonFirstRunId: due.run.id,
        now,
      });
    });
  }

  /** Creates the run's sale offer, its row and its sale context, inside the start lock. */
  private async insertAcceptedRun(
    tx: Pick<CheckoutSurgeDatabase, "select" | "insert">,
    input: {
      runId: string;
      saleOfferId: string;
      presetId: string;
      presetName: string;
      operatorMode: OperatorMode;
      configSnapshot: AcceptedRunConfigSnapshot;
      correlationId: string;
      comparisonMode: ComparisonMode | null;
      comparisonFirstRunId: string | null;
      now: Date;
    },
  ): Promise<DemoRunSnapshot> {
    const { runId, saleOfferId, now } = input;
    const [product] = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.isActive, true))
      .orderBy(desc(products.updatedAt))
      .limit(1);

    if (!product) {
      throw new DemoRunValidationError(
        "resource_not_found",
        "No active product is available for demo runs.",
      );
    }

    await tx.insert(saleOffers).values({
      id: saleOfferId,
      productId: product.id,
      name: `${input.presetName} Generated Run Offer`,
      allocatedStock: input.configSnapshot.inventoryConfig.startingStock,
      saleStartsAt: now,
      saleEndsAt: new Date(now.getTime() + generatedRunSaleDurationMs),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    const [run] = await tx
      .insert(demoRuns)
      .values({
        id: runId,
        presetId: input.presetId,
        presetName: input.presetName,
        operatorMode: input.operatorMode,
        status: "starting",
        trafficStatus: "starting",
        configSnapshot: input.configSnapshot,
        correlationId: input.correlationId,
        saleOfferId,
        startedAt: now,
        comparisonMode: input.comparisonMode,
        comparisonFirstRunId: input.comparisonFirstRunId,
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

    return toDemoRunSnapshot(run);
  }

  private async resolveAcceptedConfig(
    request: StartDemoRunCommand,
    policy: PublicRuntimePolicy,
    db?: Pick<CheckoutSurgeDatabase, "select">,
  ): Promise<{ preset: DemoPresetContract; snapshot: AcceptedRunConfigSnapshot }> {
    const preset = await this.options.presetReader.readActivePreset(request.presetSlug, db);

    if (request.operatorMode === "public" && preset.visibility !== "public") {
      throw new DemoRunValidationError(
        "preset_operation_not_allowed",
        "Public runs can only use public presets.",
      );
    }

    if (preset.comparison && request.configOverride) {
      throw new DemoRunValidationError(
        "preset_operation_not_allowed",
        "A comparison preset runs only as defined.",
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

  /**
   * Before a Redis comparison run's traffic, records PostgreSQL's and Redis's own counters; its
   * traffic completion records them again. Advisory: without them, the run's store load reads unknown.
   */
  private async captureStoreLoadStart(run: DemoRunSnapshot): Promise<void> {
    if (!run.comparison || comparisonOfMode(run.comparison.mode) !== "redis") return;
    try {
      const start = await readStoreLoadCounters(this.options.db, this.options.redis, this.now());
      await this.options.db
        .update(demoRuns)
        .set({ storeLoad: { start } })
        .where(eq(demoRuns.id, run.runId));
    } catch (error) {
      this.options.logger.warn({ err: error, runId: run.runId }, "Could not record store load.");
    }
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
      const businessOutcome = await this.readBusinessOutcomeForRun(run);
      const terminalInventorySnapshot = run.saleOfferId
        ? await this.captureTerminalInventorySnapshot(run.saleOfferId, businessOutcome, now)
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
        .select({ runId: demoRuns.id, saleOfferId: demoRuns.saleOfferId })
        .from(demoRuns)
        .where(
          and(
            inArray(demoRuns.status, ["completed", "failed"]),
            not(incompleteAdminResetPredicate() ?? sql`false`),
          ),
        );
      const runs = rows.flatMap(({ runId, saleOfferId }) =>
        saleOfferId ? [{ runId, saleOfferId }] : [],
      );
      const results = await Promise.allSettled(
        runs.map((run) => deleteSettledRunInventory(this.options.redis, run)),
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
