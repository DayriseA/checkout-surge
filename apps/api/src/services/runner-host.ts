/** The run and boot a stop is for. A null boot means the runner's boot is unknown. */
export interface RunnerStopTarget {
  runId: string;
  bootId: string | null;
}

/**
 * Where the runner (load generator) lives. The composition root picks one implementation: a Fly
 * Machine started and stopped for every run, or a local runner that is always on.
 */
export interface RunnerHost {
  /** Brings up a freshly booted runner for `runId`, and returns its Machine, if it has one. */
  start(runId: string): Promise<{ machineId: string | null }>;
  /** Stops the runner of a finished run. A runner already serving another boot is left alone. */
  stop(target: RunnerStopTarget): Promise<void>;
  /** True only when the runner is known to be stopped, so it cannot emit traffic. */
  isStopped(): Promise<boolean>;
}

/**
 * The local topology: the runner is always on. Starting has no Machine to start (the operations
 * owner still checks that the runner is ready), and stopping does nothing.
 */
export const alwaysOnRunnerHost: RunnerHost = {
  start: async () => ({ machineId: null }),
  stop: async () => undefined,
  isStopped: async () => false,
};
