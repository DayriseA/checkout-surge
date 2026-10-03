import { type CheckoutSurgeDatabase, demoRuns } from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, inArray, isNotNull } from "drizzle-orm";
import type { DemoRunLifecycleService } from "./demo-run-service.js";
import type { RunnerOperations } from "./runner-operations.js";

/** How long a started runner may stay unreachable before it is stopped through Fly. */
const defaultUnreachableStopAfterMs = 60_000;

export interface MonitoredRun {
  runId: string;
  bootId: string;
}

/**
 * The run whose traffic is dispatched or being dispatched: `starting` or `active` with a recorded
 * boot, so no completion report is persisted yet.
 */
export interface MonitoredRunReader {
  readMonitoredRun(): Promise<MonitoredRun | null>;
}

export class PostgresMonitoredRunReader implements MonitoredRunReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async readMonitoredRun(): Promise<MonitoredRun | null> {
    const [run] = await this.db
      .select({ runId: demoRuns.id, bootId: demoRuns.runnerBootId })
      .from(demoRuns)
      .where(
        and(inArray(demoRuns.status, ["starting", "active"]), isNotNull(demoRuns.runnerBootId)),
      )
      .limit(1);
    return run?.bootId ? { runId: run.runId, bootId: run.bootId } : null;
  }
}

/**
 * Watches the runner of the monitored run. A stopped Machine or another boot fails the run at once
 * as `load_generator_lost`. A runner that stays unreachable is stopped after about a minute, and
 * the same rule then applies.
 */
export class RunnerLossMonitor {
  private pending: Promise<void> | undefined;
  private unreachable: { bootId: string; since: number } | null = null;

  constructor(
    private readonly options: {
      runs: MonitoredRunReader;
      runner: Pick<RunnerOperations, "checkRunner" | "stopUnreachable">;
      lostRuns: Pick<DemoRunLifecycleService, "failLostRun">;
      logger: Pick<CheckoutSurgeLogger, "warn">;
      unreachableStopAfterMs?: number;
      now?: () => number;
    },
  ) {}

  /** One check; a check still in progress is joined rather than repeated. */
  check(): Promise<void> {
    this.pending ??= this.checkOnce().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async checkOnce(): Promise<void> {
    const run = await this.options.runs.readMonitoredRun();
    if (!run) {
      this.unreachable = null;
      return;
    }
    let condition = await this.options.runner.checkRunner(run);
    if (condition === "unreachable") {
      if (!this.unreachableLongEnough(run)) return;
      this.options.logger.warn(run, "The runner stays unreachable; stopping it.");
      await this.options.runner.stopUnreachable(run);
      condition = await this.options.runner.checkRunner(run);
    }
    if (condition === "alive") {
      this.unreachable = null;
      return;
    }
    if (condition === "lost") {
      this.options.logger.warn(run, "The runner was lost before its completion report.");
      await this.options.lostRuns.failLostRun(run.runId);
    }
  }

  private unreachableLongEnough(run: MonitoredRun): boolean {
    const now = this.options.now?.() ?? Date.now();
    const unreachable =
      this.unreachable?.bootId === run.bootId
        ? this.unreachable
        : { bootId: run.bootId, since: now };
    this.unreachable = unreachable;
    return (
      now - unreachable.since >=
      (this.options.unreachableStopAfterMs ?? defaultUnreachableStopAfterMs)
    );
  }
}
