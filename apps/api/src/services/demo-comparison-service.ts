import { randomUUID } from "node:crypto";
import {
  type DemoRunSnapshot,
  estimatedDemoOccupancyCeilingSeconds,
} from "@checkout-surge/contracts";
import { verifyPublicVisitorCredential } from "@checkout-surge/contracts/public-visitor-credential";
import {
  type CheckoutSurgeDatabase,
  type ComparisonChildren,
  comparisonPresetRegistry,
  demoComparisons,
  demoPresets,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { eq, sql } from "drizzle-orm";
import {
  AcceptedRunLaunchRejectedError,
  insertStartingRun,
  requireDemoStartSlot,
} from "./accepted-demo-run.js";
import { comparisonWorkloads } from "./comparison-workloads.js";
import {
  estimateAcceptedDemoRun,
  requireEstimatedDurationAdmission,
} from "./demo-duration-admission-service.js";
import type { DurationEstimatorConstants } from "./demo-duration-estimator.js";
import type { DemoMaintenanceAuthority } from "./demo-maintenance-authority.js";
import {
  type DemoRunLifecycleService,
  demoRunStartLockKey,
  validateAcceptedRunSnapshot,
} from "./demo-run-service.js";
import { DemoRunValidationError } from "./demo-run-validation-error.js";
import type {
  PublicRunBudgetReservation,
  PublicRunBudgetStore,
} from "./public-run-budget-store.js";
import type { EffectivePublicRuntimePolicyReader } from "./public-runtime-policy-service.js";

/** The control authority owns acceptance and launch. Sequencing is added separately. */
export class DemoComparisonService {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      maintenanceAuthority: DemoMaintenanceAuthority;
      lifecycle: Pick<DemoRunLifecycleService, "launchAcceptedRunExclusive">;
      runtimePolicyReader: EffectivePublicRuntimePolicyReader;
      publicRunBudgetStore: PublicRunBudgetStore;
      publicClientCookieSecret: string;
      estimatorConstants: DurationEstimatorConstants;
      logger: CheckoutSurgeLogger;
      now?: () => Date;
      generateId?: () => string;
    },
  ) {}

  async startComparison(
    publicVisitorCredential: string | undefined,
    correlationId: string,
  ): Promise<{ comparisonId: string; run: DemoRunSnapshot }> {
    const visitor = verifyPublicVisitorCredential(
      this.options.publicClientCookieSecret,
      publicVisitorCredential,
    );
    if (!visitor)
      throw new DemoRunValidationError(
        "public_visitor_forbidden",
        "A valid public visitor credential is required.",
      );
    return this.options.maintenanceAuthority.runExclusive(async () => {
      const now = this.options.now?.() ?? new Date();
      const generateId = this.options.generateId ?? randomUUID;
      const comparisonId = generateId();
      let reservation: PublicRunBudgetReservation | undefined;
      let accepted: DemoRunSnapshot | undefined;
      try {
        accepted = await this.options.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${demoRunStartLockKey}))`);
          await requireDemoStartSlot(tx);
          const policy = await this.options.runtimePolicyReader.readEffectivePolicy(tx);
          // One archived backing row until publication; never one selectable preset per child.
          const [preset] = await tx
            .select({ id: demoPresets.id })
            .from(demoPresets)
            .where(eq(demoPresets.id, comparisonPresetRegistry.id))
            .limit(1);
          if (!preset)
            throw new DemoRunValidationError(
              "resource_not_found",
              "The comparison preset is not installed.",
            );
          const workloads = comparisonWorkloads();
          let occupancySeconds = 0;
          for (const workload of workloads) {
            validateAcceptedRunSnapshot(workload.snapshot, policy, {
              operatorMode: "public",
              enforcePublicCustomLimits: false,
            });
            const estimate = estimateAcceptedDemoRun(
              workload.snapshot,
              policy,
              this.options.estimatorConstants,
            );
            requireEstimatedDurationAdmission(estimate);
            if (estimate.conservativeDurationSeconds === undefined)
              throw new Error("Admitted comparison estimate has no duration.");
            occupancySeconds += estimate.conservativeDurationSeconds;
          }
          if (
            occupancySeconds >
            Math.min(
              estimatedDemoOccupancyCeilingSeconds,
              policy.estimatedDemoOccupancyCeilingSeconds,
            )
          ) {
            throw new DemoRunValidationError(
              "estimated_duration_rejected",
              "The complete comparison exceeds the estimated demo occupancy ceiling.",
              { conservativeDurationSeconds: occupancySeconds },
            );
          }
          const children = workloads.map((workload) => ({
            runId: generateId(),
            saleOfferId: generateId(),
            executionMode: workload.executionMode,
            presetId: preset.id,
            presetName: workload.name,
            snapshot: workload.snapshot,
          })) as ComparisonChildren;
          if (policy.isPublicRunBudgetEnforced) {
            const decision = await this.options.publicRunBudgetStore.reserve({
              budget: policy.publicRunBudget,
              publicVisitorId: visitor.visitorId,
              now,
            });
            if (decision.outcome === "denied")
              throw new DemoRunValidationError(
                "public_run_budget_exceeded",
                "Public run budget is exhausted.",
                { budget: decision.reason },
                decision.retryAfterSeconds,
              );
            reservation = decision.reservation;
          }
          await tx.insert(demoComparisons).values({
            id: comparisonId,
            acceptedAt: now,
            correlationId,
            children,
            currentStage: 0,
            state: "running",
            budgetCompensation: reservation ?? null,
          });
          const child = children[0];
          return insertStartingRun(tx, {
            ...child,
            operatorMode: "public",
            correlationId,
            acceptedAt: now,
            comparisonId,
          });
        });
      } catch (error) {
        // A lost connection can surface before the original transaction settles. Wait for its
        // START lock, then read in a separate READ COMMITTED statement with a fresh snapshot.
        let verifiedAbsent = false;
        try {
          verifiedAbsent = await this.options.db.transaction(async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${demoRunStartLockKey}))`);
            const [persisted] = await tx
              .select({ id: demoComparisons.id })
              .from(demoComparisons)
              .where(eq(demoComparisons.id, comparisonId))
              .limit(1);
            return !persisted;
          });
        } catch (verificationError) {
          this.options.logger.error(
            { err: verificationError, correlationId, comparisonId },
            "Could not verify comparison acceptance settlement; its budget charge is retained.",
          );
        }
        if (verifiedAbsent && reservation) await this.compensate(reservation, correlationId);
        throw error;
      }
      try {
        const launched = await this.options.lifecycle.launchAcceptedRunExclusive(
          accepted,
          correlationId,
        );
        return { comparisonId, run: launched.run };
      } catch (error) {
        // Exclusive ownership remains until exact child cleanup completes in the coordinator.
        await this.options.db
          .update(demoComparisons)
          .set({ state: "cleanup_pending", terminalReason: "child_launch_failed" })
          .where(eq(demoComparisons.id, comparisonId));
        if (error instanceof AcceptedRunLaunchRejectedError && reservation) {
          await this.compensate(reservation, correlationId);
          await this.options.db
            .update(demoComparisons)
            .set({ budgetCompensation: null })
            .where(eq(demoComparisons.id, comparisonId));
        }
        throw error instanceof AcceptedRunLaunchRejectedError ? error.cause : error;
      }
    });
  }

  private async compensate(
    reservation: PublicRunBudgetReservation,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.options.publicRunBudgetStore.release(reservation);
    } catch (error) {
      this.options.logger.error(
        { err: error, correlationId, reservationId: reservation.reservationId },
        "Failed to compensate a rejected comparison budget charge.",
      );
      throw error;
    }
  }
}
