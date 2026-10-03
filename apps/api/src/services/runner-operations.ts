import type { RunnerIdentity, TrafficExecutionAbortResponse } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { ApiHttpError } from "../runtime/errors.js";
import type { RunnerHost, RunnerStopTarget } from "./runner-host.js";
import type { RunnerControlGateway, TrafficAbortGateway } from "./traffic-execution-gateway.js";

/** The runner boot a run is bound to. Every start or replay of the run must target it. */
export interface RunnerBoot {
  machineId: string | null;
  bootId: string;
}

const defaultReadyTimeoutMs = 30_000;
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
 * The single owner of runner operations: boot for a run, stop after it, and abort. Operations run
 * one at a time in this process (the single API process contract), so a stop always completes
 * before a later boot.
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
  bootForRun(runId: string): Promise<RunnerBoot> {
    return this.serialize(() => this.boot(runId));
  }

  /**
   * Stops the runner of a terminal run, in the background. A failure is only logged. A release
   * that arrives after a later run booted is skipped: that boot already stopped the old runner.
   */
  releaseAfterRun(target: { runId: string; bootId: string }): void {
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

  private async boot(runId: string): Promise<RunnerBoot> {
    this.lastBootRunId = runId;
    let identity: RunnerIdentity | null = null;
    try {
      const { machineId } = await this.options.host.start(runId);
      identity = await this.waitForReadyIdentity();
      if (!this.versionMatches(identity.version)) {
        throw new RunnerVersionMismatchError(this.options.apiVersion, identity.version);
      }
      return { machineId, bootId: identity.bootId };
    } catch (error) {
      if (!(error instanceof RunnerVersionMismatchError)) {
        this.options.logger.error({ err: error, runId }, "The runner could not be booted.");
      }
      await this.stopAfterFailedBoot({ runId, bootId: identity?.bootId ?? null });
      throw error instanceof RunnerVersionMismatchError ? error : new RunnerBootError();
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

  private async waitForReadyIdentity(): Promise<RunnerIdentity> {
    const deadline = this.now() + (this.options.readyTimeoutMs ?? defaultReadyTimeoutMs);
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
