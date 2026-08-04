import type { TrafficExecutionStartRequest } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { LoadApiClient } from "./api-client.js";
import type { CompletionDelivery } from "./completion-delivery-coordinator.js";
import type { DurableExecution, ExecutionStore } from "./execution-store.js";
import type { StartGeneratorResourceSampler } from "./generator-resource-sampler.js";
import {
  K6ChildProcessSupervisor,
  K6StartCancelledError,
  readK6SummaryExport,
  TrafficTerminationUnconfirmedError,
} from "./k6-child-process-supervisor.js";
import { K6RunAccumulator } from "./k6-output-parser.js";
import { generateK6Script } from "./k6-script.js";
import { collectLoadRunDiagnostics, type DiagnosticsDependencies } from "./load-run-diagnostics.js";

export { readK6SummaryExport, TrafficTerminationUnconfirmedError };

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

type SpawnK6RunnerOptions = {
  k6Binary: string;
  apiClient: LoadApiClient;
  completionDelivery: CompletionDelivery;
  logger: CheckoutSurgeLogger;
  now?: () => Date;
  spawnProcess?: ConstructorParameters<typeof K6ChildProcessSupervisor>[0]["spawnProcess"];
  executionStore: ExecutionStore;
  cancellationTimeoutMs?: number;
  maxK6OutputLineLength?: number;
  readSummaryFile?: (summaryPath: string) => Promise<string>;
  metricBatchSize?: number;
  maxBufferedMetricSamples?: number;
  removeWorkDir?: (workDir: string) => Promise<void>;
  startGeneratorResourceSampler?: StartGeneratorResourceSampler;
  diagnostics?: DiagnosticsDependencies;
};

export class SpawnK6Runner implements K6Runner {
  private readonly supervisor: K6ChildProcessSupervisor;
  private currentPreparation: {
    runId: string;
    promise: Promise<K6ExecutionStart>;
    cancelRequested: boolean;
  } | null = null;
  private closing = false;
  private cancellingRunId: string | null = null;
  private cancellationRequiresJournalRelease = false;
  private cancellationOperation: Promise<"aborted" | "natural_completion"> | null = null;
  private readonly completionTasks = new Set<Promise<void>>();
  private completionFailure: unknown = null;
  private initializationOperation: Promise<void> | null = null;

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
      ...(options.maxK6OutputLineLength === undefined
        ? {}
        : { maxK6OutputLineLength: options.maxK6OutputLineLength }),
      ...(options.readSummaryFile ? { readSummaryFile: options.readSummaryFile } : {}),
      ...(options.metricBatchSize === undefined
        ? {}
        : { metricBatchSize: options.metricBatchSize }),
      ...(options.maxBufferedMetricSamples === undefined
        ? {}
        : { maxBufferedMetricSamples: options.maxBufferedMetricSamples }),
      ...(options.removeWorkDir ? { removeWorkDir: options.removeWorkDir } : {}),
      ...(options.startGeneratorResourceSampler
        ? { startGeneratorResourceSampler: options.startGeneratorResourceSampler }
        : {}),
    });
  }

  initialize(): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error("Traffic execution owner is shutting down."));
    }
    if (!this.initializationOperation) {
      const initialization = this.performInitialization().catch((error) => {
        if (this.initializationOperation === initialization) this.initializationOperation = null;
        throw error;
      });
      this.initializationOperation = initialization;
    }
    return this.initializationOperation;
  }

  private async performInitialization(): Promise<void> {
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
      await this.options.completionDelivery.persist(
        accumulator.completionReport({
          status: "failed",
          errorMessage: "load_orchestrator_restarted_before_k6_completion",
          completedAt: this.now(),
        }),
      );
    }
    await this.options.completionDelivery.start();
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
    if (this.initializationOperation) {
      try {
        await this.initializationOperation;
      } catch (error) {
        this.completionFailure ??= error;
      }
    }
    if (this.completionFailure) {
      await this.options.completionDelivery.close();
      throw this.completionFailure;
    }

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
    await this.options.completionDelivery.close();
    if (this.completionFailure) throw this.completionFailure;
  }

  async start(input: TrafficExecutionStartRequest): Promise<K6ExecutionStart> {
    if (this.closing) throw new Error("Traffic execution owner is shutting down.");
    if (this.completionFailure) throw this.completionFailure;
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
        const { completion: _completion, ...acceptedWithoutCompletion } = accepted;
        await this.options.executionStore.update({
          ...acceptedWithoutCompletion,
          state: "executing",
        });
      } catch (error) {
        if (this.preparationCancelled(input.runId)) {
          await this.supervisor.cancel(input.runId);
        } else {
          await this.supervisor.stopForPreparationFailure(input.runId);
          await this.persistPreparationFailure(
            input,
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
      const completionTask = execution.completion.then(async (result) => {
        if (result.outcome !== "completed") return;
        await this.options.completionDelivery.persist(result.report);
        await this.supervisor.release(input.runId);
      });
      this.completionTasks.add(completionTask);
      void completionTask.then(
        () => this.completionTasks.delete(completionTask),
        (error) => {
          this.completionTasks.delete(completionTask);
          this.completionFailure = error;
          this.options.logger.error(
            { err: error, runId: input.runId },
            "Could not make the produced traffic completion durable.",
          );
        },
      );
    } catch (error) {
      if (
        !spawned &&
        !(error instanceof CancellationRequestedError) &&
        !(error instanceof K6StartCancelledError)
      ) {
        await this.persistPreparationFailure(
          input,
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
      await this.options.completionDelivery.persist(report);
      await this.supervisor.release(input.runId);
    } catch (persistenceError) {
      this.completionFailure = persistenceError;
      throw persistenceError;
    }
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
