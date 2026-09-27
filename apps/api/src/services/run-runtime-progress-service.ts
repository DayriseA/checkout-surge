import {
  type DownstreamErpStatus,
  type RunRuntimeProgress,
  runRuntimeProgressSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeDatabase } from "@checkout-surge/db";
import {
  type RunRuntimeProgressReadModel,
  readDownstreamErpStatus,
  readRunRuntimeProgress,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";

export const defaultConfirmationRateWindowSeconds = 10;

export interface RunRuntimeProgressReader {
  read(
    runId: string,
    windowStartedAt: Date,
    measuredAt: Date,
  ): Promise<RunRuntimeProgressReadModel>;
}

export class PostgresRunRuntimeProgressReader implements RunRuntimeProgressReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  read(runId: string, windowStartedAt: Date, measuredAt: Date) {
    return readRunRuntimeProgress(this.db, { runId }, windowStartedAt, measuredAt);
  }
}

export interface RunDownstreamErpStatusReader {
  read(runId: string, now: Date): Promise<DownstreamErpStatus>;
}

export class PostgresRunDownstreamErpStatusReader implements RunDownstreamErpStatusReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  read(runId: string, now: Date) {
    return readDownstreamErpStatus(this.db, runId, now);
  }
}

/**
 * Derives the runtime-progress projection for one run: outstanding
 * orders, oldest outstanding age, and the observed confirmation rate over the
 * effective window from durable order records, plus one downstream status from
 * the worker's durable protection state. A failed status read is reported as
 * explicitly unavailable; it never defaults to `nominal`. A failed progress
 * read propagates so the projection degrades the whole section.
 */
export class RunRuntimeProgressService {
  constructor(
    private readonly options: {
      progressReader: RunRuntimeProgressReader;
      downstreamStatusReader: RunDownstreamErpStatusReader;
      logger: CheckoutSurgeLogger;
      confirmationRateWindowSeconds?: number;
      now?: () => Date;
    },
  ) {}

  async getProgress(runId: string): Promise<RunRuntimeProgress> {
    const now = this.options.now?.() ?? new Date();
    const windowSeconds =
      this.options.confirmationRateWindowSeconds ?? defaultConfirmationRateWindowSeconds;
    const [model, statusResult] = await Promise.all([
      this.options.progressReader.read(runId, windowStartedAt(now, windowSeconds), now),
      readStatusSafely(() => this.options.downstreamStatusReader.read(runId, now)),
    ]);

    if (!statusResult.ok) {
      this.options.logger.error(
        { err: statusResult.error, runId },
        "Run downstream ERP status read failed.",
      );
    }

    const effectiveWindowSeconds = model.processingStartedAt
      ? Math.min(
          windowSeconds,
          Math.max(0, (now.getTime() - model.processingStartedAt.getTime()) / 1000),
        )
      : 0;

    return runRuntimeProgressSchema.parse({
      runId,
      outstandingOrders: model.outstandingOrders,
      oldestOutstandingAgeSeconds: model.oldestOutstandingAgeSeconds,
      confirmationRatePerSecond:
        effectiveWindowSeconds > 0 ? model.confirmedOrdersInWindow / effectiveWindowSeconds : null,
      confirmationRateWindowSeconds: effectiveWindowSeconds,
      downstreamErpStatus: statusResult.ok ? statusResult.value : null,
      downstreamErpStatusReadStatus: statusResult.ok ? "available" : "unavailable",
      observedAt: now.toISOString(),
    });
  }
}

function windowStartedAt(now: Date, windowSeconds: number): Date {
  return new Date(now.getTime() - windowSeconds * 1000);
}

async function readStatusSafely(
  read: () => Promise<DownstreamErpStatus>,
): Promise<{ ok: true; value: DownstreamErpStatus } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error };
  }
}
