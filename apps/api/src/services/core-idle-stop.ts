import type { CoreIdleStatus } from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoRuns } from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { inArray } from "drizzle-orm";

/** The core stops after this long without counted activity and without a nonterminal run. */
export const coreIdleStopAfterMs = 10 * 60_000;

/**
 * The idle-shutdown owner. It tracks counted activity and owns the deadline; callers only report
 * activity, read the status, and trigger the periodic check.
 */
export interface CoreIdleShutdown {
  recordActivity(): void;
  status(): CoreIdleStatus;
  check(): Promise<void>;
}

/** The local topology: the core never stops on its own, and no countdown is shown. */
export const disabledCoreIdleShutdown: CoreIdleShutdown = {
  recordActivity: () => undefined,
  status: () => ({ state: "disabled" }),
  check: async () => undefined,
};

export interface NonterminalRunReader {
  hasNonterminalRun(): Promise<boolean>;
}

export class PostgresNonterminalRunReader implements NonterminalRunReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async hasNonterminalRun(): Promise<boolean> {
    const rows = await this.db
      .select({ id: demoRuns.id })
      .from(demoRuns)
      .where(inArray(demoRuns.status, ["starting", "active", "draining"]))
      .limit(1);
    return rows.length > 0;
  }
}

/**
 * Stops the hosted core after 10 minutes without counted activity. A nonterminal run keeps the core
 * awake and counts as activity, so the countdown starts afresh when the run ends.
 */
export class CoreIdleStop implements CoreIdleShutdown {
  private lastActivityAt: number;
  private runInProgress = false;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly options: {
      runs: NonterminalRunReader;
      stopCore: () => Promise<void>;
      logger: Pick<CheckoutSurgeLogger, "info">;
      now?: () => number;
    },
  ) {
    this.lastActivityAt = this.now();
  }

  recordActivity(): void {
    this.lastActivityAt = this.now();
  }

  /** The run state comes from the latest check, so reading the status stays in memory. */
  status(): CoreIdleStatus {
    if (this.runInProgress) return { state: "run_in_progress" };
    const remainingMs = this.lastActivityAt + coreIdleStopAfterMs - this.now();
    return { state: "awake", sleepsInSeconds: Math.max(0, Math.ceil(remainingMs / 1000)) };
  }

  /** One check; a check still in progress, including a stop request, is joined. */
  check(): Promise<void> {
    this.pending ??= this.checkOnce().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async checkOnce(): Promise<void> {
    this.runInProgress = await this.options.runs.hasNonterminalRun();
    if (this.runInProgress) {
      this.recordActivity();
      return;
    }
    const idleMs = this.now() - this.lastActivityAt;
    if (idleMs < coreIdleStopAfterMs) return;
    this.options.logger.info(
      { idleSeconds: Math.round(idleMs / 1000) },
      "No counted activity for 10 minutes; stopping the core Machine.",
    );
    await this.options.stopCore();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
