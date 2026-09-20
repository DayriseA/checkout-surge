import {
  type AdminGeneratedRunTeardownResponse,
  adminGeneratedRunTeardownResponseSchema,
} from "@checkout-surge/contracts";
import type {
  CheckoutSurgeDatabase,
  CheckoutSurgeRedis,
  deleteGeneratedRunDurable,
  deleteGeneratedRunRedisState,
  inspectGeneratedRunTeardown,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { ApiHttpError } from "../runtime/errors.js";
import type { DemoMaintenanceAuthority } from "./demo-maintenance-authority.js";
import {
  DemoQueueMaintenanceConflict,
  type ExactRunQueueMaintenance,
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
      queueMaintenance: ExactRunQueueMaintenance;
      logger: CheckoutSurgeLogger;
      deleteGeneratedRunRedisState: typeof deleteGeneratedRunRedisState;
      inspectGeneratedRunTeardown: typeof inspectGeneratedRunTeardown;
      deleteGeneratedRunDurable: typeof deleteGeneratedRunDurable;
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
    try {
      const result = await this.teardownExactGeneratedRun(input);
      this.options.logger.info(result, "Generated demo run teardown completed.");
      return result;
    } catch (error) {
      const mapped = mapQueueMaintenanceError(error);
      if (mapped instanceof ApiHttpError && mapped.statusCode === 409) {
        this.options.logger.warn(
          {
            runId: input.runId,
            correlationId: input.correlationId,
            code: mapped.code,
          },
          "Generated demo run teardown was refused.",
        );
      }
      throw mapped;
    }
  }

  private async teardownExactGeneratedRun(
    input: GeneratedRunTeardownInput,
  ): Promise<AdminGeneratedRunTeardownResponse> {
    const now = this.options.now?.() ?? new Date();
    const inspected = await this.options.inspectGeneratedRunTeardown(this.options.db, input.runId);
    if (inspected.outcome === "absent") {
      return adminGeneratedRunTeardownResponseSchema.parse({
        outcome: "already_absent",
        runId: input.runId,
        cleanedAt: now.toISOString(),
        correlationId: input.correlationId,
      });
    }
    if (inspected.outcome !== "ready") throw teardownConflict(inspected.outcome);

    const queueCleanup = await this.options.queueMaintenance.cleanRuns([input.runId]);
    let redisCleanup: Awaited<ReturnType<typeof deleteGeneratedRunRedisState>>;
    try {
      redisCleanup = await this.options.deleteGeneratedRunRedisState(this.options.redis, inspected);
    } catch (error) {
      this.options.logger.warn(
        {
          err: error,
          runId: input.runId,
          saleOfferId: inspected.saleOfferId,
          correlationId: input.correlationId,
        },
        "Generated-run Redis cleanup failed before durable deletion; retry the same request.",
      );
      throw error;
    }

    const deleted = await this.options.deleteGeneratedRunDurable(this.options.db, inspected);
    if (deleted.outcome !== "deleted") throw teardownConflict(deleted.outcome);
    return adminGeneratedRunTeardownResponseSchema.parse({
      outcome: "deleted",
      runId: input.runId,
      saleOfferId: inspected.saleOfferId,
      cleanup: {
        redisKeysDeleted: redisCleanup.deletedKeyCount,
        queueJobsDeleted: queueCleanup.cleanedJobCount,
      },
      cleanedAt: now.toISOString(),
      correlationId: input.correlationId,
    });
  }
}

function teardownConflict(
  outcome: "absent" | "non_terminal" | "outstanding_work" | "ownership_mismatch",
): ApiHttpError {
  return new ApiHttpError({
    statusCode: 409,
    code: "run_cleanup_conflict",
    message:
      outcome === "non_terminal"
        ? "The generated run must be terminal before teardown."
        : outcome === "outstanding_work"
          ? "The generated run still has unresolved processing work."
          : outcome === "ownership_mismatch"
            ? "The run is not owned by a matching generated sale offer."
            : "The generated run disappeared before durable teardown completed.",
    details: { conflictReason: outcome },
  });
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
