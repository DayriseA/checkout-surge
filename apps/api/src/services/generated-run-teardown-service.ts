import {
  type AdminGeneratedRunTeardownResponse,
  adminGeneratedRunTeardownResponseSchema,
} from "@checkout-surge/contracts";
import type {
  CheckoutSurgeDatabase,
  CheckoutSurgeRedis,
  completeGeneratedRunTeardown,
  deleteGeneratedRunRedisState,
  prepareGeneratedRunTeardown,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { ApiHttpError } from "../runtime/errors.js";
import type { DemoMaintenanceAuthority } from "./demo-maintenance-authority.js";
import {
  DemoQueueMaintenanceConflict,
  type GeneratedRunQueueMaintenance,
} from "./demo-queue-maintenance.js";

export interface GeneratedRunTeardownInput {
  runId: string;
  correlationId: string;
}

export interface GeneratedRunTeardownWorkflow {
  teardownGeneratedRun(
    input: GeneratedRunTeardownInput,
  ): Promise<AdminGeneratedRunTeardownResponse>;
}

export interface RetentionGeneratedRunTeardown {
  /** Called only while the shared maintenance authority is already held. */
  teardownRetentionCandidate(
    input: GeneratedRunTeardownInput,
  ): Promise<AdminGeneratedRunTeardownResponse>;
}

export class GeneratedRunTeardownService
  implements GeneratedRunTeardownWorkflow, RetentionGeneratedRunTeardown
{
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      queueMaintenance: GeneratedRunQueueMaintenance;
      logger: CheckoutSurgeLogger;
      deleteGeneratedRunRedisState: typeof deleteGeneratedRunRedisState;
      prepareGeneratedRunTeardown: typeof prepareGeneratedRunTeardown;
      completeGeneratedRunTeardown: typeof completeGeneratedRunTeardown;
      maintenanceAuthority: DemoMaintenanceAuthority;
      now?: () => Date;
    },
  ) {}

  teardownGeneratedRun(
    input: GeneratedRunTeardownInput,
  ): Promise<AdminGeneratedRunTeardownResponse> {
    return this.options.maintenanceAuthority.runExclusive(() =>
      this.teardownRetentionCandidate(input),
    );
  }

  async teardownRetentionCandidate(
    input: GeneratedRunTeardownInput,
  ): Promise<AdminGeneratedRunTeardownResponse> {
    const targeted = this.options.queueMaintenance;
    let lease: Awaited<ReturnType<typeof targeted.acquireGeneratedRunQuiescence>> | undefined;
    let result: AdminGeneratedRunTeardownResponse | undefined;
    let primaryError: unknown;
    try {
      lease = await targeted.acquireGeneratedRunQuiescence(input.runId);
      result = await this.teardownQuiescedGeneratedRun(input, targeted);
    } catch (error) {
      primaryError = mapQueueMaintenanceError(error);
      if (primaryError instanceof ApiHttpError && primaryError.statusCode === 409) {
        this.options.logger.warn(
          {
            runId: input.runId,
            correlationId: input.correlationId,
            code: primaryError.code,
          },
          "Generated demo run teardown was refused.",
        );
      }
    } finally {
      if (lease) {
        try {
          await lease.release();
        } catch (error) {
          this.options.logger.warn(
            { err: error, runId: input.runId, correlationId: input.correlationId },
            "Generated-run teardown could not restore queue availability; retry the same cleanup request.",
          );
          primaryError = primaryError
            ? new AggregateError(
                [primaryError, error],
                `Generated-run teardown failed and queue state restoration also failed: ${messageOf(primaryError)}`,
              )
            : error;
        }
      }
    }
    if (primaryError) throw primaryError;
    if (!result) throw new Error("Generated-run teardown completed without a response.");
    if (result.outcome === "deleted") {
      try {
        await this.options.completeGeneratedRunTeardown(this.options.db, input.runId);
      } catch (error) {
        this.options.logger.warn(
          {
            err: error,
            runId: input.runId,
            saleOfferId: result.saleOfferId,
            correlationId: input.correlationId,
          },
          "Generated-run external cleanup succeeded but receipt completion requires retry.",
        );
        throw error;
      }
      this.options.logger.info(result, "Generated demo run teardown completed.");
    } else {
      this.options.logger.info(result, "Generated demo run teardown was already absent.");
    }
    return result;
  }

  private async teardownQuiescedGeneratedRun(
    input: GeneratedRunTeardownInput,
    targeted: GeneratedRunQueueMaintenance,
  ): Promise<AdminGeneratedRunTeardownResponse> {
    const now = this.options.now?.() ?? new Date();
    await targeted.preflightGeneratedRun(input.runId);

    const prepared = await this.options.prepareGeneratedRunTeardown(
      this.options.db,
      input.runId,
      now,
    );
    if (prepared.outcome === "absent") {
      return adminGeneratedRunTeardownResponseSchema.parse({
        outcome: "already_absent",
        runId: input.runId,
        cleanedAt: now.toISOString(),
        correlationId: input.correlationId,
      });
    }
    if (prepared.outcome !== "ready") {
      throw new ApiHttpError({
        statusCode: 409,
        code: "run_cleanup_conflict",
        message:
          prepared.outcome === "non_terminal"
            ? "The generated run must be terminal before teardown."
            : "The run is not owned by a matching generated sale offer.",
        details: { conflictReason: prepared.outcome },
      });
    }

    let queueCleanup: Awaited<ReturnType<GeneratedRunQueueMaintenance["cleanGeneratedRun"]>>;
    try {
      queueCleanup = await targeted.cleanGeneratedRun(input.runId);
    } catch (error) {
      this.options.logger.warn(
        {
          err: error,
          runId: input.runId,
          saleOfferId: prepared.saleOfferId,
          correlationId: input.correlationId,
          queueResumeWillBeAttempted: true,
        },
        "Generated-run queue convergence failed after durable deletion; queue availability will be restored before returning the retryable failure.",
      );
      throw error;
    }

    try {
      const redisCleanup = await this.options.deleteGeneratedRunRedisState(
        this.options.redis,
        prepared,
      );
      return adminGeneratedRunTeardownResponseSchema.parse({
        outcome: "deleted",
        runId: input.runId,
        saleOfferId: prepared.saleOfferId,
        cleanup: {
          redisKeysDeleted: redisCleanup.deletedKeyCount,
          queueJobsDeleted: queueCleanup.deletedJobCount,
        },
        cleanedAt: now.toISOString(),
        correlationId: input.correlationId,
      });
    } catch (error) {
      this.options.logger.warn(
        {
          err: error,
          runId: input.runId,
          saleOfferId: prepared.saleOfferId,
          correlationId: input.correlationId,
        },
        "Generated demo run teardown requires retry after durable deletion.",
      );
      throw error;
    }
  }
}

function mapQueueMaintenanceError(error: unknown): unknown {
  if (!(error instanceof DemoQueueMaintenanceConflict)) return error;
  return new ApiHttpError({
    statusCode: 409,
    code: "run_cleanup_conflict",
    message: error.message,
    details: { conflictReason: error.code },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
