import type { RunnerIdentity, TrafficExecutionAbortResponse } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { ApiHttpError } from "../runtime/errors.js";
import {
  RunnerCapacityUnavailableError,
  type RunnerHost,
  type RunnerPlacement,
  type RunnerStartHooks,
  type RunnerStopTarget,
} from "./runner-host.js";
import type { RunnerControlGateway, TrafficAbortGateway } from "./traffic-execution-gateway.js";

/** The runner boot a run is bound to. Every start or replay of the run must target it. */
export interface RunnerBoot extends RunnerPlacement {
  bootId: string;
}

/** What the API can tell about the runner of an active run. */
export type RunnerCondition = "alive" | "lost" | "unreachable";

const defaultReadyTimeoutMs = 30_000;
/**
 * The whole boot (the runner start, retries and relocation included, then its readiness) ends
 * within this. The start request waits for it behind two proxies, the web's fetch and the gate's
 * relay, which both give up after undici's default 300 s without response headers. Past the
 * deadline, the request can still take one Fly call in flight, the stop of a failed boot and the
 * run's failure, so the deadline stays well below that: a relocation takes about 14 s and a
 * readiness wait a few seconds, so it still leaves room for retries.
 */
const startDeadlineMs = 90_000;
const readyPollIntervalMs = 250;

export class RunnerBootError extends ApiHttpError {
  constructor() {
    super({
      statusCode: 503,
      code: "load_orchestrator_unavailable",
      message: "The load generator could not be started.",
    });
  }
}

export class RunnerVersionMismatchError extends ApiHttpError {
  constructor(apiVersion: string, runnerVersion: string) {
    super({
      statusCode: 503,
      code: "runner_version_mismatch",
      message: "The load generator runs a different version than the API.",
      details: { apiVersion, runnerVersion },
    });
  }
}

/**
 * The single owner of runner operations: boot for a run, stop after it, abort, and recreate.
 * Operations run one at a time in this process (the single API process contract), so a stop
 * always completes before a later boot.
 */
export class RunnerOperations implements TrafficAbortGateway {
  private tail: Promise<unknown> = Promise.resolve();
  /** The run of the latest boot in this process; a release for an older run must not touch it. */
  private lastBootRunId: string | null = null;

  constructor(
    private readonly options: {
      host: RunnerHost;
      control: Pick<RunnerControlGateway, "isReady" | "readIdentity">;
      aborter: TrafficAbortGateway;
      /** This API's commit, compared with the runner's before every run. */
      apiVersion: string;
      /** Whether two `unknown` versions match. Never on Fly, where the deploy sets both. */
      acceptUnknownVersion: boolean;
      logger: Pick<CheckoutSurgeLogger, "error" | "warn">;
      readyTimeoutMs?: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    },
  ) {}

  /**
   * Starts a freshly booted runner for `runId` and returns its boot. On failure the runner is
   * left stopped and the error is an ApiHttpError: no traffic was dispatched.
   */
  bootForRun(runId: string, hooks: RunnerStartHooks): Promise<RunnerBoot> {
    return this.serialize(() => this.boot(runId, hooks));
  }

  /**
   * Stops the runner of a terminal run, in the background. A failure is only logged. A release
   * that arrives after a later run booted is skipped: that boot already stopped the old runner.
   */
  releaseAfterRun(target: RunnerStopTarget): void {
    void this.serialize(async () => {
      if (this.lastBootRunId !== null && this.lastBootRunId !== target.runId) return;
      await this.options.host.stop(target);
    }).catch((error: unknown) => {
      this.options.logger.error(
        { err: error, ...target },
        "Could not stop the runner after a run.",
      );
    });
  }

  /**
   * Whether the runner of an active run still serves its boot. A stopped Machine, a Machine on an
   * unreachable host, or another boot means the runner was lost. Read-only, so it does not wait
   * behind other operations.
   */
  async checkRunner(boot: { bootId: string }): Promise<RunnerCondition> {
    if (await this.options.host.isLost()) return "lost";
    try {
      const identity = await this.options.control.readIdentity();
      return identity.bootId === boot.bootId ? "alive" : "lost";
    } catch {
      return "unreachable";
    }
  }

  /**
   * Stops the runner of an active run that stays unreachable, through Fly if needed. Skipped when
   * a later run booted meanwhile: the runner now serves that run.
   */
  stopUnreachable(target: RunnerStopTarget): Promise<void> {
    return this.serialize(async () => {
      if (this.lastBootRunId !== null && this.lastBootRunId !== target.runId) return;
      await this.options.host.stop(target);
    });
  }

  /** Replaces the stopped runner with a fresh one, as a capacity failure would. */
  recreate(): Promise<RunnerPlacement> {
    return this.serialize(() => this.options.host.recreate());
  }

  /** A stopped runner cannot emit traffic, so aborting it is confirmed without a call. */
  abortCurrent(input: {
    runId: string;
    reason: string;
    correlationId: string;
  }): Promise<Pick<TrafficExecutionAbortResponse, "outcome">> {
    return this.serialize(async () =>
      (await this.options.host.isStopped())
        ? { outcome: "no_current_run" as const }
        : this.options.aborter.abortCurrent(input),
    );
  }

  private async boot(runId: string, hooks: RunnerStartHooks): Promise<RunnerBoot> {
    this.lastBootRunId = runId;
    let identity: RunnerIdentity | null = null;
    const deadlineAt = this.now() + startDeadlineMs;
    try {
      const placement = await this.options.host.start(runId, hooks, deadlineAt);
      identity = await this.waitForReadyIdentity(deadlineAt);
      if (!this.versionMatches(identity.version)) {
        throw new RunnerVersionMismatchError(this.options.apiVersion, identity.version);
      }
      return { ...placement, bootId: identity.bootId };
    } catch (error) {
      if (!(error instanceof RunnerVersionMismatchError)) {
        this.options.logger.error({ err: error, runId }, "The runner could not be booted.");
      }
      await this.stopAfterFailedBoot({ runId, bootId: identity?.bootId ?? null });
      throw error instanceof RunnerVersionMismatchError ||
        error instanceof RunnerCapacityUnavailableError
        ? error
        : new RunnerBootError();
    }
  }

  private async stopAfterFailedBoot(target: RunnerStopTarget): Promise<void> {
    await this.options.host.stop(target).catch((error: unknown) => {
      this.options.logger.error(
        { err: error, ...target },
        "Could not stop a runner that failed to boot.",
      );
    });
  }

  private async waitForReadyIdentity(deadlineAt: number): Promise<RunnerIdentity> {
    const deadline = Math.min(
      deadlineAt,
      this.now() + (this.options.readyTimeoutMs ?? defaultReadyTimeoutMs),
    );
    while (!(await this.options.control.isReady())) {
      if (this.now() >= deadline) throw new Error("The runner did not become ready in time.");
      await this.sleep(readyPollIntervalMs);
    }
    return this.options.control.readIdentity();
  }

  private versionMatches(runnerVersion: string): boolean {
    const { apiVersion, acceptUnknownVersion } = this.options;
    return runnerVersion === apiVersion && (acceptUnknownVersion || apiVersion !== "unknown");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
}
