import { ApiHttpError } from "../runtime/errors.js";

/** The run and boot a stop is for. A null boot means the runner's boot is unknown. */
export interface RunnerStopTarget {
  runId: string;
  bootId: string | null;
}

/** Where a started runner lives. Both are null without a Fly Machine. */
export interface RunnerPlacement {
  machineId: string | null;
  region: string | null;
}

export interface RunnerStartHooks {
  /** Called before the runner is recreated elsewhere after a provider capacity failure. */
  onRelocating(): Promise<void>;
}

/** The provider has no capacity for the runner in any allowed region; no traffic was started. */
export class RunnerCapacityUnavailableError extends ApiHttpError {
  constructor() {
    super({
      statusCode: 503,
      code: "runner_capacity_unavailable",
      message: "The hosting provider has no capacity for the load generator right now.",
    });
  }
}

/**
 * Where the runner (load generator) lives. The composition root picks one implementation: a Fly
 * Machine started and stopped for every run, or a local runner that is always on.
 */
export interface RunnerHost {
  /** Brings up a freshly booted runner for `runId`, and returns where it runs. */
  start(runId: string, hooks: RunnerStartHooks): Promise<RunnerPlacement>;
  /** Stops the runner of a finished run. A runner already serving another boot is left alone. */
  stop(target: RunnerStopTarget): Promise<void>;
  /** True only when the runner is known to be stopped, so it cannot emit traffic. */
  isStopped(): Promise<boolean>;
  /** True when the runner is stopped or its host is unreachable: it cannot serve its run. */
  isLost(): Promise<boolean>;
  /** Replaces a stopped runner with a fresh one, as a capacity failure would. */
  recreate(): Promise<RunnerPlacement>;
}

/**
 * The local topology: the runner is always on. Starting has no Machine to start (the operations
 * owner still checks that the runner is ready), stopping does nothing, and it cannot be recreated.
 */
export const alwaysOnRunnerHost: RunnerHost = {
  start: async () => ({ machineId: null, region: null }),
  stop: async () => undefined,
  isStopped: async () => false,
  isLost: async () => false,
  recreate: async () => {
    throw new ApiHttpError({
      statusCode: 409,
      code: "run_conflict",
      message: "The local load generator is always on and cannot be recreated.",
    });
  },
};
