import {
  automaticRunResetDeadlineSeconds,
  type RunnerShutdownRequest,
  type RunnerShutdownResponse,
} from "@checkout-surge/contracts";
import type { ExecutionStore } from "./execution-store.js";
import type { TrafficExecutionService } from "./traffic-execution-service.js";

export const runnerIdleTimeoutMs = 3 * 60 * 1000;
export const runnerMaximumLifetimeMs = (automaticRunResetDeadlineSeconds + 30) * 1000;

/** Hosted exit policy; completion delivery remains untouched until an exit is accepted. */
export class RunnerLifecycleService {
  private idleSince = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private maximumTimer: NodeJS.Timeout | null = null;
  private checkingIdle = false;
  private stopping = false;

  constructor(
    private readonly options: {
      trafficExecutionService: TrafficExecutionService;
      executionStore: Pick<ExecutionStore, "read">;
      requestExit: () => void;
      onError: (error: unknown) => void;
      startedAt?: number;
    },
  ) {
    this.idleSince = options.startedAt ?? Date.now();
  }

  start(): void {
    this.idleTimer = setInterval(() => {
      if (this.checkingIdle || this.stopping) return;
      this.checkingIdle = true;
      void this.checkIdle()
        .catch(this.options.onError)
        .finally(() => {
          this.checkingIdle = false;
        });
    }, 1000);
    this.idleTimer.unref();
    this.maximumTimer = setTimeout(
      () => this.exit(),
      Math.max(
        0,
        runnerMaximumLifetimeMs - (Date.now() - (this.options.startedAt ?? this.idleSince)),
      ),
    );
    this.maximumTimer.unref();
  }

  stop(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.maximumTimer) clearTimeout(this.maximumTimer);
    this.idleTimer = null;
    this.maximumTimer = null;
  }

  async shutdown(input: RunnerShutdownRequest): Promise<RunnerShutdownResponse> {
    const bootId = this.options.trafficExecutionService.identity.bootId;
    if (input.bootId !== bootId) return { ...input, outcome: "ignored_boot_mismatch" };
    const traffic = this.options.trafficExecutionService;
    const generation = traffic.admissionGeneration;
    const hadExecution = traffic.hasExecution();
    const execution = await this.options.executionStore.read();
    // A completed admission can publish a report while the read still returns the old journal slot.
    const unstable = hadExecution || generation !== traffic.admissionGeneration;
    const currentRunId =
      this.options.trafficExecutionService.currentRunId() ?? execution?.request.runId;
    if (currentRunId && input.runId !== currentRunId)
      return { ...input, outcome: "ignored_run_mismatch" };
    if (unstable || this.busy(execution)) return { ...input, outcome: "deferred_busy" };
    // Defer closing the HTTP listener until the route can send its acknowledgement.
    this.options.trafficExecutionService.beginDrain();
    setImmediate(() => this.exit());
    return { ...input, outcome: "shutdown_requested" };
  }

  private busy(execution: Awaited<ReturnType<ExecutionStore["read"]>>): boolean {
    return (
      this.options.trafficExecutionService.hasExecution() ||
      (execution !== null && execution.state !== "completed")
    );
  }

  private async checkIdle(): Promise<void> {
    const traffic = this.options.trafficExecutionService;
    const generation = traffic.admissionGeneration;
    const hadExecution = traffic.hasExecution();
    const execution = await this.options.executionStore.read();
    const unstable = hadExecution || generation !== traffic.admissionGeneration;
    if (unstable || this.busy(execution)) {
      this.idleSince = Date.now();
      return;
    }
    this.idleSince = Math.max(this.idleSince, this.options.trafficExecutionService.lastActivityAt);
    if (Date.now() - this.idleSince >= runnerIdleTimeoutMs) this.exit();
  }

  private exit(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.stop();
    this.options.trafficExecutionService.beginDrain();
    this.options.requestExit();
  }
}
