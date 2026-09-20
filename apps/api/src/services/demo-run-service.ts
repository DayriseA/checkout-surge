import { randomUUID } from "node:crypto";
import {
  type AcceptedRunConfigSnapshot,
  acceptedRunConfigWriteSchema,
  type BusinessOutcomeSummary,
  collectAcceptedRunConfigSnapshotViolations,
  type DemoPresetContract,
  type DemoRunConfigOverride,
  type DemoRunSnapshot,
  emptyHttpTimingBreakdownSummary,
  emptyServerReservationTimingSummary,
  type InternalRunFailureReason,
  isReplayPossible,
  type OperatorMode,
  type PublicRuntimePolicy,
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
  demoRunSaleContexts,
  demoRuns,
  getInventoryStatus,
  initializeInventory,
  products,
  saleOffers,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ApiHttpError } from "../runtime/errors.js";
import type { DashboardBusinessOutcomeReader } from "./dashboard-recovery-service.js";
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
import { parsePersistedAcceptedRunConfigSnapshot } from "./persisted-demo-run-state.js";
import type {
  PublicRunBudgetReservation,
  PublicRunBudgetStore,
} from "./public-run-budget-store.js";
import type { EffectivePublicRuntimePolicyReader } from "./public-runtime-policy-service.js";
import type { TerminalDemoRunWriter } from "./terminal-demo-run-writer.js";
import { syntheticFailedTrafficSummary } from "./traffic-delivery-plan.js";
import type { TrafficExecutionGateway } from "./traffic-execution-gateway.js";

export const demoRunStartLockKey = "checkout_surge_demo_run_start";
const singleNonTerminalRunIndexName = "demo_runs_single_non_terminal_idx";
const generatedRunSaleDurationMs = 24 * 60 * 60 * 1000;

export interface DemoRunLifecycleController {
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
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      trafficExecutionGateway: TrafficExecutionGateway;
      publicRunBudgetStore: PublicRunBudgetStore;
      presetReader: ActiveDemoPresetReader;
      runtimePolicyReader: EffectivePublicRuntimePolicyReader;
      businessOutcomeReader: DashboardBusinessOutcomeReader;
      terminalRunWriter: Pick<TerminalDemoRunWriter, "write">;
      apiBaseUrl: string;
      logger: CheckoutSurgeLogger;
      publicClientCookieSecret: string;
      now?: () => Date;
      generateId?: () => string;
    },
  ) {}

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
    const policy = await this.options.runtimePolicyReader.readEffectivePolicy();
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
      };
    }

    try {
      const accepted = await this.createAcceptedRun(
        request,
        acceptedConfig.preset,
        acceptedConfig.snapshot,
        correlationId,
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

      await publishDemoRunProjectionDirty(this.options.redis, this.options.logger, {
        run: accepted.run,
        correlationId,
      });

      let trafficResponse: TrafficExecutionStartResponse;
      try {
        trafficResponse = await this.options.trafficExecutionGateway.start({
          runId: accepted.run.runId,
          saleOfferId,
          apiBaseUrl: this.options.apiBaseUrl,
          correlationId,
          configSnapshot: acceptedConfig.snapshot,
        });
      } catch (error) {
        if (
          !(error instanceof ApiHttpError && error.code === "load_orchestrator_start_ambiguous")
        ) {
          await this.failRun(accepted.run.runId, "load_orchestrator_unavailable", correlationId);
        }
        throw error;
      }

      const runAfterTrafficStart = await this.updateRunAfterTrafficStart(
        accepted.run.runId,
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

  private async createAcceptedRun(
    request: StartDemoRunCommand,
    preset: DemoPresetContract,
    snapshot: AcceptedRunConfigSnapshot,
    correlationId: string,
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
            "run_conflict",
            "A demo run is already starting, active, or draining.",
            {
              conflictReason: "active_run_exists",
              runId: existingRun.id,
              status: existingRun.status,
            },
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

        await beforeInsert?.();

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
            correlationId,
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
  ): Promise<{ preset: DemoPresetContract; snapshot: AcceptedRunConfigSnapshot }> {
    const preset = await this.options.presetReader.readActivePreset(request.presetSlug);

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
