import type {
  TrafficCompletionReport,
  TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { LoadApiClient } from "./api-client.js";
import { type DurableExecution, type ExecutionStore, withCompletion } from "./execution-store.js";
import {
  BoundedStdoutTail,
  K6ChildProcessSupervisor,
  K6StartCancelledError,
  readK6SummaryExport,
  TrafficTerminationUnconfirmedError,
} from "./k6-child-process-supervisor.js";
import { K6RunAccumulator } from "./k6-output-parser.js";
import { generateK6Script } from "./k6-script.js";
import { collectLoadRunDiagnostics, type DiagnosticsDependencies } from "./load-run-diagnostics.js";

export { BoundedStdoutTail, readK6SummaryExport, TrafficTerminationUnconfirmedError };

export interface K6ExecutionStart {
  startedAt: Date;
  plannedRequests: number;
}

export interface K6Runner {
  start(input: TrafficExecutionStartRequest): Promise<K6ExecutionStart>;
  statusSnapshot(
    runId: string,
  ): Promise<{ state: DurableExecution["state"] | "unknown"; acceptedAt?: string }>;
  initialize(): Promise<void>;
  currentRunId(): string | null;
  abort(
    runId: string,
    context?: { reason?: string; correlationId?: string },
  ): Promise<"aborted" | "natural_completion">;
  close(): Promise<void>;
}

type CompletionRetrySleep = (delayMs: number) => Promise<void>;

interface CompletionRetryConfig {
  maxAttempts?: number;
  initialBackoffMs?: number;
  backoffMultiplier?: number;
  sleep?: CompletionRetrySleep;
}

interface ResolvedCompletionRetryConfig {
  maxAttempts: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  sleep: CompletionRetrySleep;
}

const defaultCompletionRetryMaxAttempts = 5;
const defaultCompletionRetryInitialBackoffMs = 1000;
const defaultCompletionRetryBackoffMultiplier = 2;

type SpawnK6RunnerOptions = {
  k6Binary: string;
  apiClient: LoadApiClient;
  logger: CheckoutSurgeLogger;
  now?: () => Date;
  spawnProcess?: ConstructorParameters<typeof K6ChildProcessSupervisor>[0]["spawnProcess"];
  completionRetry?: CompletionRetryConfig;
  executionStore: ExecutionStore;
  retryIntervalMs?: number;
  cancellationTimeoutMs?: number;
  liveMetricWindowMs?: number;
  maxK6OutputLineLength?: number;
  maxStdoutTailBytes?: number;
  readSummaryFile?: (summaryPath: string) => Promise<string>;
  metricBatchSize?: number;
  maxBufferedMetricSamples?: number;
  removeWorkDir?: (workDir: string) => Promise<void>;
  diagnostics?: DiagnosticsDependencies;
};

export class SpawnK6Runner implements K6Runner {
  private readonly supervisor: K6ChildProcessSupervisor;
  private currentPreparation: {
    runId: string;
    promise: Promise<K6ExecutionStart>;
    cancelRequested: boolean;
  } | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private cancellingRunId: string | null = null;
  private cancellationRequiresJournalRelease = false;
  private cancellationOperation: Promise<"aborted" | "natural_completion"> | null = null;
  private readonly completionTasks = new Set<Promise<void>>();
  private deliveryAttempt: Promise<void> | null = null;
  private pendingPersistence: TrafficCompletionReport | null = null;

  constructor(private readonly options: SpawnK6RunnerOptions) {
    this.supervisor = new K6ChildProcessSupervisor({
      k6Binary: options.k6Binary,
      apiClient: options.apiClient,
      logger: options.logger,
      ...(options.now ? { now: options.now } : {}),
      ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
      ...(options.cancellationTimeoutMs === undefined
        ? {}
        : { cancellationTimeoutMs: options.cancellationTimeoutMs }),
      ...(options.liveMetricWindowMs === undefined
        ? {}
        : { liveMetricWindowMs: options.liveMetricWindowMs }),
      ...(options.maxK6OutputLineLength === undefined
        ? {}
        : { maxK6OutputLineLength: options.maxK6OutputLineLength }),
      ...(options.maxStdoutTailBytes === undefined
        ? {}
        : { maxStdoutTailBytes: options.maxStdoutTailBytes }),
      ...(options.readSummaryFile ? { readSummaryFile: options.readSummaryFile } : {}),
      ...(options.metricBatchSize === undefined
        ? {}
        : { metricBatchSize: options.metricBatchSize }),
      ...(options.maxBufferedMetricSamples === undefined
        ? {}
        : { maxBufferedMetricSamples: options.maxBufferedMetricSamples }),
      ...(options.removeWorkDir ? { removeWorkDir: options.removeWorkDir } : {}),
    });
  }

  async initialize(): Promise<void> {
    const execution = await this.options.executionStore.read();
    if (execution?.state === "accepted" || execution?.state === "executing") {
      const generated = generateK6Script(execution.request);
      const accumulator = new K6RunAccumulator({
        runId: execution.request.runId,
        correlationId: execution.request.correlationId,
        plannedRequests: generated.plannedRequests,
        startedAt: new Date(execution.acceptedAt),
        executionPlan: generated.executionPlan,
      });
      await this.options.executionStore.update(
        withCompletion(
          execution,
          accumulator.completionReport({
            status: "failed",
            errorMessage: "load_orchestrator_restarted_before_k6_completion",
            completedAt: this.now(),
          }),
        ),
      );
    }
    await this.deliverPending();
    this.retryTimer = setInterval(
      () => void this.deliverPending(),
      this.options.retryIntervalMs ?? 5_000,
    );
    this.retryTimer.unref();
  }

  async statusSnapshot(
    runId: string,
  ): Promise<{ state: DurableExecution["state"] | "unknown"; acceptedAt?: string }> {
    const execution = await this.options.executionStore.read();
    return execution?.request.runId === runId
      ? { state: execution.state, acceptedAt: execution.acceptedAt }
      : { state: "unknown" };
  }

  currentRunId(): string | null {
    return this.cancellingRunId ?? this.currentPreparation?.runId ?? this.supervisor.currentRunId();
  }

  abort(
    runId: string,
    context: { reason?: string; correlationId?: string } = {},
  ): Promise<"aborted" | "natural_completion"> {
    if (this.cancellingRunId === runId && this.cancellationOperation) {
      return this.cancellationOperation;
    }
    if (this.currentRunId() !== runId) return Promise.resolve("natural_completion");

    this.cancellingRunId = runId;
    this.options.logger.info(
      { runId, correlationId: context.correlationId, reason: context.reason },
      "Cancelling k6 traffic execution.",
    );
    const operation = this.performCancellation(runId);
    this.cancellationOperation = operation;
    return operation;
  }

  private async performCancellation(runId: string): Promise<"aborted" | "natural_completion"> {
    try {
      let supervisorResult: "aborted" | "natural_completion";
      const settledOutcome = this.supervisor.settledOutcome(runId);
      if (this.supervisor.currentRunId() === runId) {
        const cancellation = this.supervisor.cancel(runId);
        if (this.supervisor.cancellationAccepted(runId)) {
          this.markPreparationCancelled(runId);
        }
        supervisorResult = await cancellation;
      } else if (settledOutcome) {
        supervisorResult = settledOutcome;
      } else if (this.currentPreparation?.runId === runId) {
        this.markPreparationCancelled(runId);
        supervisorResult = "aborted";
      } else {
        supervisorResult = "natural_completion";
      }
      if (supervisorResult === "aborted") {
        this.cancellationRequiresJournalRelease = true;
      }
      if (this.cancellationRequiresJournalRelease) {
        const execution = await this.options.executionStore.read();
        if (execution?.request.runId === runId) {
          const { completion: _completion, ...withoutCompletion } = execution;
          await this.options.executionStore.update({ ...withoutCompletion, state: "completed" });
        }
      }
      this.cancellingRunId = null;
      this.cancellationOperation = null;
      const result = this.cancellationRequiresJournalRelease ? "aborted" : "natural_completion";
      this.cancellationRequiresJournalRelease = false;
      return result;
    } catch (error) {
      if (error instanceof TrafficTerminationUnconfirmedError) {
        this.cancellationRequiresJournalRelease = true;
      }
      this.cancellationOperation = null;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.retryTimer) clearInterval(this.retryTimer);

    const preparation = this.currentPreparation?.promise;
    const runId =
      this.cancellingRunId ?? this.supervisor.currentRunId() ?? this.currentPreparation?.runId;
    let outcome: "aborted" | "natural_completion" | null = null;
    if (runId) {
      const cancellation = this.cancellationOperation ?? this.performCancellation(runId);
      if (!this.cancellationOperation) this.cancellationOperation = cancellation;
      outcome = await cancellation;
    }
    await this.supervisor.close();
    if (outcome === "natural_completion" && preparation) {
      await Promise.allSettled([preparation]);
    }
    await Promise.allSettled([...this.completionTasks]);
    await this.deliverPending();
    if (this.pendingPersistence) {
      throw new Error("Traffic completion could not be made durable during shutdown.");
    }
  }

  async start(input: TrafficExecutionStartRequest): Promise<K6ExecutionStart> {
    if (this.closing) throw new Error("Traffic execution owner is shutting down.");
    if (this.cancellingRunId) throw new ExecutionSlotConflictError(this.cancellingRunId);
    if (this.currentPreparation) {
      if (this.currentPreparation.runId === input.runId) return this.currentPreparation.promise;
      throw new ExecutionSlotConflictError(this.currentPreparation.runId);
    }
    const supervisedRunId = this.supervisor.currentRunId();
    if (supervisedRunId) {
      if (supervisedRunId === input.runId) {
        const current = await this.options.executionStore.read();
        return {
          startedAt: new Date(current?.acceptedAt ?? this.now()),
          plannedRequests: generateK6Script(input).plannedRequests,
        };
      }
      throw new ExecutionSlotConflictError(supervisedRunId);
    }

    this.supervisor.clearSettledOutcome(input.runId);
    const preparation = this.prepareAndStart(input);
    this.currentPreparation = { runId: input.runId, promise: preparation, cancelRequested: false };
    try {
      return await preparation;
    } finally {
      if (this.currentPreparation?.promise === preparation) this.currentPreparation = null;
    }
  }

  private async prepareAndStart(input: TrafficExecutionStartRequest): Promise<K6ExecutionStart> {
    const startedAt = this.now();
    const acceptance = await this.options.executionStore.accept(input, startedAt);
    const accepted = acceptance.execution;
    if (!acceptance.created && accepted.state !== "accepted") {
      return {
        startedAt: new Date(accepted.acceptedAt),
        plannedRequests: generateK6Script(input).plannedRequests,
      };
    }
    if (this.pendingPersistence?.runId === input.runId) {
      await this.deliverPending();
      throw new Error("A previous preparation failure is still being reconciled.");
    }

    const generated = generateK6Script(input);
    const diagnostics = await collectLoadRunDiagnostics(
      this.options.k6Binary,
      generated.executionPlan,
      this.options.diagnostics,
    );
    let spawned = false;
    try {
      if (this.preparationCancelled(input.runId)) throw new CancellationRequestedError();
      if (this.closing) {
        throw new Error("Traffic execution owner began shutting down during preparation.");
      }
      const execution = await this.supervisor.start({
        request: input,
        script: generated.contents,
        startedAt,
        plannedRequests: generated.plannedRequests,
        executionPlan: generated.executionPlan,
        diagnostics,
      });
      spawned = true;
      try {
        await this.options.executionStore.update({ ...accepted, state: "executing" });
      } catch (error) {
        await this.supervisor.cancel(input.runId);
        if (!this.preparationCancelled(input.runId)) {
          await this.persistPreparationFailure(
            input,
            accepted,
            generated.plannedRequests,
            generated.executionPlan,
            diagnostics,
            startedAt,
            error,
          );
        }
        throw error;
      }
      if (this.preparationCancelled(input.runId)) {
        await this.completeCancelledJournal(accepted);
        throw new CancellationRequestedError();
      }
      const completionTask = execution.completion.then((result) =>
        result.outcome === "completed" ? this.reportCompletion(result.report) : undefined,
      );
      this.completionTasks.add(completionTask);
      void completionTask.finally(() => this.completionTasks.delete(completionTask));
    } catch (error) {
      if (
        !spawned &&
        !(error instanceof CancellationRequestedError) &&
        !(error instanceof K6StartCancelledError)
      ) {
        await this.persistPreparationFailure(
          input,
          accepted,
          generated.plannedRequests,
          generated.executionPlan,
          diagnostics,
          startedAt,
          error,
        );
      }
      if (
        (error instanceof CancellationRequestedError || error instanceof K6StartCancelledError) &&
        acceptance.created
      ) {
        await this.completeCancelledJournal(accepted);
      }
      throw error;
    }
    return { startedAt, plannedRequests: generated.plannedRequests };
  }

  private markPreparationCancelled(runId: string): void {
    if (this.currentPreparation?.runId === runId) {
      this.currentPreparation.cancelRequested = true;
    }
  }

  private preparationCancelled(runId: string): boolean {
    return this.currentPreparation?.runId === runId && this.currentPreparation.cancelRequested;
  }

  private async completeCancelledJournal(execution: DurableExecution): Promise<void> {
    const current = await this.options.executionStore.read();
    if (current?.request.runId !== execution.request.runId || current.state === "completed") return;
    const { completion: _completion, ...withoutCompletion } = current;
    await this.options.executionStore.update({ ...withoutCompletion, state: "completed" });
  }

  private async persistPreparationFailure(
    input: TrafficExecutionStartRequest,
    execution: DurableExecution,
    plannedRequests: number,
    executionPlan: ReturnType<typeof generateK6Script>["executionPlan"],
    diagnostics: Awaited<ReturnType<typeof collectLoadRunDiagnostics>>,
    startedAt: Date,
    error: unknown,
  ): Promise<void> {
    const accumulator = new K6RunAccumulator({
      runId: input.runId,
      correlationId: input.correlationId,
      plannedRequests,
      startedAt,
      executionPlan,
      diagnostics,
    });
    const report = accumulator.completionReport({
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "k6 preparation failed",
      completedAt: this.now(),
    });
    try {
      await this.options.executionStore.update(withCompletion(execution, report));
      await this.deliverPending();
    } catch (persistenceError) {
      this.pendingPersistence = report;
      this.options.logger.error(
        { err: persistenceError, runId: report.runId },
        "Preparation failure remains owned in memory until it can be made durable.",
      );
    }
  }

  private async reportCompletion(report: TrafficCompletionReport): Promise<void> {
    let completionPersisted = false;
    try {
      const execution = await this.options.executionStore.read();
      if (execution?.request.runId !== report.runId) {
        throw new Error("The durable execution journal no longer matches the completed child.");
      }
      await this.options.executionStore.update(withCompletion(execution, report));
      completionPersisted = true;
      await this.sendCompletionWithRetry(report);
      const delivered = await this.options.executionStore.read();
      if (delivered?.request.runId === report.runId) {
        await this.options.executionStore.update({ ...delivered, state: "completed" });
      }
    } catch (error) {
      if (!completionPersisted) this.pendingPersistence = report;
      this.options.logger.error(
        {
          err: error,
          runId: report.runId,
          maxAttempts: this.resolveCompletionRetryConfig().maxAttempts,
        },
        "Could not report k6 traffic completion to API.",
      );
    }
  }

  private async deliverPending(): Promise<void> {
    if (this.deliveryAttempt) return this.deliveryAttempt;
    this.deliveryAttempt = this.attemptPendingDelivery().finally(() => {
      this.deliveryAttempt = null;
    });
    return this.deliveryAttempt;
  }

  private async attemptPendingDelivery(): Promise<void> {
    try {
      if (this.pendingPersistence) {
        const execution = await this.options.executionStore.read();
        if (execution?.request.runId === this.pendingPersistence.runId) {
          await this.options.executionStore.update(
            withCompletion(execution, this.pendingPersistence),
          );
          this.pendingPersistence = null;
        }
      }
      const execution = await this.options.executionStore.read();
      if (execution?.state !== "completion_pending" || !execution.completion) return;
      await this.options.apiClient.sendCompletion(execution.completion);
      await this.options.executionStore.update({ ...execution, state: "completed" });
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Pending traffic completion remains durably queued.",
      );
    }
  }

  private async sendCompletionWithRetry(report: TrafficCompletionReport): Promise<void> {
    const retry = this.resolveCompletionRetryConfig();
    let nextBackoffMs = retry.initialBackoffMs;
    let lastError: unknown;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      try {
        await this.options.apiClient.sendCompletion(report);
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= retry.maxAttempts) break;
        this.options.logger.warn(
          {
            err: error,
            runId: report.runId,
            attempt,
            maxAttempts: retry.maxAttempts,
            retryInMs: nextBackoffMs,
          },
          "Could not report k6 traffic completion to API. Retrying.",
        );
        await retry.sleep(nextBackoffMs);
        nextBackoffMs = Math.round(nextBackoffMs * retry.backoffMultiplier);
      }
    }
    throw lastError ?? new Error("Traffic completion reporting failed.");
  }

  private resolveCompletionRetryConfig(): ResolvedCompletionRetryConfig {
    const retry = this.options.completionRetry;
    return {
      maxAttempts: positiveIntegerOrDefault(retry?.maxAttempts, defaultCompletionRetryMaxAttempts),
      initialBackoffMs: nonnegativeNumberOrDefault(
        retry?.initialBackoffMs,
        defaultCompletionRetryInitialBackoffMs,
      ),
      backoffMultiplier: positiveNumberOrDefault(
        retry?.backoffMultiplier,
        defaultCompletionRetryBackoffMultiplier,
      ),
      sleep: retry?.sleep ?? defaultSleep,
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

class CancellationRequestedError extends Error {
  constructor() {
    super("Traffic execution was cancelled during preparation.");
  }
}

export class ExecutionSlotConflictError extends Error {
  constructor(readonly currentRunId: string) {
    super(`Traffic execution ${currentRunId} still owns the execution slot.`);
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : fallback;
}

function nonnegativeNumberOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveNumberOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
