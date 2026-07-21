import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  TrafficCompletionReport,
  TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { type LoadApiClient, MetricBatcher } from "./api-client.js";
import { type DurableExecution, type ExecutionStore, withCompletion } from "./execution-store.js";
import { K6JsonLineFramer } from "./k6-json-line-framer.js";
import { K6LiveMetricAggregator } from "./k6-live-metric-aggregator.js";
import {
  BoundedStderrCollector,
  K6RunAccumulator,
  type K6SummaryMetrics,
  parseK6JsonLine,
  parseK6SummaryMetrics,
} from "./k6-output-parser.js";
import { generateK6Script } from "./k6-script.js";
import { collectLoadRunDiagnostics, type DiagnosticsDependencies } from "./load-run-diagnostics.js";

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

export class SpawnK6Runner implements K6Runner {
  constructor(
    private readonly options: {
      k6Binary: string;
      apiClient: LoadApiClient;
      logger: CheckoutSurgeLogger;
      now?: () => Date;
      spawnProcess?: typeof spawn;
      completionRetry?: CompletionRetryConfig;
      executionStore: ExecutionStore;
      retryIntervalMs?: number;
      shutdownGraceMs?: number;
      shutdownKillWaitMs?: number;
      liveMetricWindowMs?: number;
      maxK6OutputLineLength?: number;
      maxStdoutTailBytes?: number;
      readSummaryFile?: (summaryPath: string) => Promise<string>;
      metricBatchSize?: number;
      maxBufferedMetricSamples?: number;
      diagnostics?: DiagnosticsDependencies;
    },
  ) {}

  private currentChild: ReturnType<typeof spawn> | null = null;
  private currentChildExit: Promise<void> | null = null;
  private currentPreparation: {
    runId: string;
    promise: Promise<K6ExecutionStart>;
  } | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private cancellingRunId: string | null = null;
  private cancellationOperation: Promise<"aborted" | "natural_completion"> | null = null;
  private activeCleanup: Promise<void> | null = null;
  private unconfirmedTerminationRunId: string | null = null;
  private readonly terminationOperations = new Map<ReturnType<typeof spawn>, Promise<void>>();
  private readonly completionTasks = new Set<Promise<void>>();
  private deliveryAttempt: Promise<void> | null = null;
  private pendingPersistence: {
    report: TrafficCompletionReport;
    workDir: string | null;
  } | null = null;

  async initialize(): Promise<void> {
    const execution = await this.options.executionStore.read();
    if (execution?.state === "accepted" || execution?.state === "executing") {
      const accumulator = new K6RunAccumulator({
        runId: execution.request.runId,
        correlationId: execution.request.correlationId,
        plannedRequests: generateK6Script(execution.request).plannedRequests,
        startedAt: new Date(execution.acceptedAt),
        executionPlan: generateK6Script(execution.request).executionPlan,
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
    return (
      this.cancellingRunId ??
      this.currentPreparation?.runId ??
      (this.currentChild ? this.activeRunId : null)
    );
  }

  private activeRunId: string | null = null;

  abort(
    runId: string,
    context: { reason?: string; correlationId?: string } = {},
  ): Promise<"aborted" | "natural_completion"> {
    if (this.cancellingRunId === runId && this.cancellationOperation)
      return this.cancellationOperation;
    if (this.unconfirmedTerminationRunId === runId && this.currentChild)
      return Promise.reject(new TrafficTerminationUnconfirmedError());
    if (this.currentRunId() !== runId) return Promise.resolve("natural_completion");
    this.cancellingRunId = runId;
    this.options.logger.info(
      { runId, correlationId: context.correlationId, reason: context.reason },
      "Cancelling k6 traffic execution.",
    );
    return this.startCancellationOperation(runId);
  }

  private startCancellationOperation(runId: string): Promise<"aborted" | "natural_completion"> {
    const operation = this.performCancellation(runId);
    this.cancellationOperation = operation;
    return operation;
  }

  private async performCancellation(runId: string): Promise<"aborted"> {
    const ownedChild = this.currentChild;
    const termination = ownedChild ? this.terminateAndReap(ownedChild) : null;
    try {
      const preparation = this.currentPreparation?.promise;
      if (preparation) await Promise.allSettled([preparation]);
      const child = ownedChild ?? this.currentChild;
      if (termination) await termination;
      else if (child) await this.terminateAndReap(child);
      if (this.activeCleanup) await this.activeCleanup;
      const execution = await this.options.executionStore.read();
      if (execution?.request.runId === runId) {
        const { completion: _completion, ...withoutCompletion } = execution;
        await this.options.executionStore.update({ ...withoutCompletion, state: "completed" });
      }
      this.cancellingRunId = null;
      this.unconfirmedTerminationRunId = null;
      this.cancellationOperation = null;
      return "aborted";
    } catch (error) {
      // Retain ownership while allowing an explicit abort or shutdown call to retry cleanup.
      this.cancellationOperation = null;
      if (error instanceof TrafficTerminationUnconfirmedError)
        this.unconfirmedTerminationRunId = runId;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    const cancellationRunId = this.cancellingRunId;
    const cancellation = cancellationRunId
      ? (this.cancellationOperation ?? this.startCancellationOperation(cancellationRunId))
      : null;
    if (cancellation) {
      await cancellation;
    } else {
      const preparation = this.currentPreparation?.promise;
      if (!this.currentChild && preparation) await Promise.allSettled([preparation]);
      const child = this.currentChild;
      if (child) await this.terminateAndReap(child);
      if (preparation) await Promise.allSettled([preparation]);
    }
    await Promise.allSettled([...this.completionTasks]);
    await this.deliverPending();
    if (this.pendingPersistence)
      throw new Error("Traffic completion could not be made durable during shutdown.");
  }

  async start(input: TrafficExecutionStartRequest): Promise<K6ExecutionStart> {
    if (this.closing) throw new Error("Traffic execution owner is shutting down.");
    if (this.cancellingRunId) throw new ExecutionSlotConflictError(this.cancellingRunId);
    if (this.currentPreparation) {
      if (this.currentPreparation.runId === input.runId) {
        return this.currentPreparation.promise;
      }
      throw new ExecutionSlotConflictError(this.currentPreparation.runId);
    }
    if (this.currentChild) {
      const current = await this.options.executionStore.read();
      if (current?.request.runId === input.runId) {
        return {
          startedAt: new Date(current.acceptedAt),
          plannedRequests: generateK6Script(input).plannedRequests,
        };
      }
      throw new ExecutionSlotConflictError(this.activeRunId ?? "unknown");
    }

    const preparation = this.prepareAndStart(input);
    this.currentPreparation = { runId: input.runId, promise: preparation };
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
    if (this.pendingPersistence?.report.runId === input.runId) {
      await this.deliverPending();
      throw new Error("A previous preparation failure is still being reconciled.");
    }
    const generated = generateK6Script(input);
    const diagnostics = await collectLoadRunDiagnostics(
      this.options.k6Binary,
      generated.executionPlan,
      this.options.diagnostics,
    );
    let workDir: string | null = null;
    let childWasSpawned = false;
    try {
      workDir = await mkdtemp(path.join(tmpdir(), "checkout-surge-k6-"));
      const scriptPath = path.join(workDir, "scenario.js");
      const summaryPath = path.join(workDir, "summary.json");
      await writeFile(scriptPath, generated.contents, "utf8");
      if (this.cancellingRunId === input.runId) throw new CancellationRequestedError();
      if (this.closing)
        throw new Error("Traffic execution owner began shutting down during preparation.");
      const child = (this.options.spawnProcess ?? spawn)(
        this.options.k6Binary,
        ["run", "--quiet", "--summary-export", summaryPath, "--out", "json=-", scriptPath],
        {
          detached: false,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      childWasSpawned = true;
      this.currentChild = child;
      this.activeRunId = input.runId;
      this.currentChildExit = new Promise((resolve) => {
        child.once("close", resolve);
      });
      const completionSettled = this.attachProcessHandlers({
        child,
        input,
        startedAt,
        plannedRequests: generated.plannedRequests,
        executionPlan: generated.executionPlan,
        diagnostics,
        workDir,
        summaryPath,
      });
      this.activeCleanup = completionSettled;
      try {
        await this.options.executionStore.update({ ...accepted, state: "executing" });
      } catch (error) {
        await this.terminateAndReap(child);
        await completionSettled;
        throw error;
      }
    } catch (error) {
      if (!childWasSpawned && !(error instanceof CancellationRequestedError)) {
        await this.persistPreparationFailure(
          input,
          accepted,
          generated.plannedRequests,
          generated.executionPlan,
          diagnostics,
          startedAt,
          error,
          workDir,
        );
      }
      if (!childWasSpawned && error instanceof CancellationRequestedError && workDir)
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    return { startedAt, plannedRequests: generated.plannedRequests };
  }

  private async persistPreparationFailure(
    input: TrafficExecutionStartRequest,
    execution: DurableExecution,
    plannedRequests: number,
    executionPlan: ReturnType<typeof generateK6Script>["executionPlan"],
    diagnostics: Awaited<ReturnType<typeof collectLoadRunDiagnostics>>,
    startedAt: Date,
    error: unknown,
    workDir: string | null,
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
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      await this.deliverPending();
    } catch (persistenceError) {
      this.pendingPersistence = { report, workDir };
      this.options.logger.error(
        { err: persistenceError, runId: report.runId },
        "Preparation failure remains owned in memory until it can be made durable.",
      );
    }
  }

  private attachProcessHandlers(input: {
    child: ReturnType<typeof spawn>;
    input: TrafficExecutionStartRequest;
    startedAt: Date;
    plannedRequests: number;
    executionPlan: ReturnType<typeof generateK6Script>["executionPlan"];
    diagnostics: Awaited<ReturnType<typeof collectLoadRunDiagnostics>>;
    workDir: string;
    summaryPath: string;
  }): Promise<void> {
    const stderrCollector = new BoundedStderrCollector();
    const accumulator = new K6RunAccumulator({
      runId: input.input.runId,
      correlationId: input.input.correlationId,
      plannedRequests: input.plannedRequests,
      startedAt: input.startedAt,
      executionPlan: input.executionPlan,
      diagnostics: input.diagnostics,
      stderr: stderrCollector,
    });
    const batcher = new MetricBatcher({
      runId: input.input.runId,
      correlationId: input.input.correlationId,
      client: this.options.apiClient,
      ...(this.options.metricBatchSize === undefined
        ? {}
        : { maxBatchSize: this.options.metricBatchSize }),
      ...(this.options.maxBufferedMetricSamples === undefined
        ? {}
        : { maxBufferedSamples: this.options.maxBufferedMetricSamples }),
      onFlushError: (error) => {
        this.options.logger.warn(
          { err: error, runId: input.input.runId },
          "Could not forward k6 metric batch to API.",
        );
      },
      onOverflow: (sample) => {
        this.options.logger.warn(
          { runId: input.input.runId, metricName: sample.metricName },
          "Dropped newest k6 live metric because the bounded metric buffer was full.",
        );
      },
    });
    const liveMetrics = new K6LiveMetricAggregator(
      this.options.liveMetricWindowMs === undefined
        ? {}
        : { windowMs: this.options.liveMetricWindowMs },
    );
    const stdoutTail = new BoundedStdoutTail(this.options.maxStdoutTailBytes);
    const stdout = input.child.stdout;
    const stderr = input.child.stderr;
    const stdoutDrain = stdout
      ? consumeK6Stdout({
          stdout,
          accumulator,
          liveMetrics,
          batcher,
          stdoutTail,
          acceptPoint: () => this.cancellingRunId !== input.input.runId,
          ...(this.options.maxK6OutputLineLength === undefined
            ? {}
            : { maxLineLength: this.options.maxK6OutputLineLength }),
        }).catch((error) => {
          this.options.logger.warn(
            { err: error, runId: input.input.runId },
            "Could not completely consume k6 stdout.",
          );
        })
      : Promise.resolve();
    let processError: Error | null = null;
    let completionReported = false;
    let settleCompletion: () => void = () => undefined;
    const completionSettled = new Promise<void>((resolve) => {
      settleCompletion = resolve;
    });
    const reportCompletionOnce = (completion: {
      status: "succeeded" | "failed";
      exitCode?: number;
      errorMessage?: string;
      completedAt: Date;
    }) => {
      if (completionReported) {
        return;
      }

      completionReported = true;
      if (this.cancellingRunId === input.input.runId) {
        completionReported = true;
        stderrCollector.finish();
        const task = Promise.allSettled([stdoutDrain, batcher.discard()]).then(async () => {
          await rm(input.workDir, { recursive: true, force: true }).catch(() => undefined);
        });
        this.completionTasks.add(task);
        void task.finally(() => {
          this.completionTasks.delete(task);
          settleCompletion();
        });
        return;
      }
      const task = this.reportCompletion({
        accumulator,
        liveMetrics,
        batcher,
        stdoutDrain,
        stdoutTail,
        summaryPath: input.summaryPath,
        workDir: input.workDir,
        ...completion,
      });
      this.completionTasks.add(task);
      void task.then(
        () => {
          this.completionTasks.delete(task);
          settleCompletion();
        },
        () => {
          this.completionTasks.delete(task);
          settleCompletion();
        },
      );
    };

    stderr?.setEncoding("utf8");
    stderr?.on("data", (chunk) => {
      stderrCollector.push(String(chunk));
      this.options.logger.warn(
        { runId: input.input.runId, stderrBytesObserved: Buffer.byteLength(chunk) },
        "k6 wrote to stderr.",
      );
    });

    input.child.once("error", (error) => {
      processError = error;
    });

    input.child.once("close", (exitCode) => {
      this.terminationOperations.delete(input.child);
      stderrCollector.finish();
      reportCompletionOnce({
        status: !processError && stdout && stderr && exitCode === 0 ? "succeeded" : "failed",
        completedAt: this.now(),
        ...(processError || exitCode === null ? {} : { exitCode }),
        ...(!processError && stdout && stderr && exitCode === 0
          ? {}
          : {
              errorMessage: processError
                ? processError.message
                : stdout && stderr
                  ? `k6 exited with code ${exitCode ?? "unknown"}.`
                  : "k6 process did not expose stdout and stderr pipes.",
            }),
      });
      if (this.currentChild === input.child) {
        this.currentChild = null;
        this.currentChildExit = null;
        this.activeRunId = null;
      }
    });
    if (!stdout || !stderr) input.child.kill("SIGTERM");
    void completionSettled.finally(() => {
      if (this.activeCleanup === completionSettled) this.activeCleanup = null;
    });
    return completionSettled;
  }

  private async terminateAndReap(child: ReturnType<typeof spawn>): Promise<void> {
    const existing = this.terminationOperations.get(child);
    if (existing) return existing;
    const operation = this.performTerminationAndReap(child);
    this.terminationOperations.set(child, operation);
    void operation.then(
      () => {
        if (this.terminationOperations.get(child) === operation)
          this.terminationOperations.delete(child);
      },
      () => undefined,
    );
    return operation;
  }

  private async performTerminationAndReap(child: ReturnType<typeof spawn>): Promise<void> {
    const exit = this.currentChild === child ? this.currentChildExit : null;
    try {
      if (!child.killed) child.kill("SIGTERM");
    } catch (error) {
      throw new TrafficTerminationUnconfirmedError(error);
    }
    const exited = await waitForPromise(exit, this.options.shutdownGraceMs ?? 5_000);
    if (exited || this.currentChild !== child) return;
    try {
      child.kill("SIGKILL");
    } catch (error) {
      throw new TrafficTerminationUnconfirmedError(error);
    }
    const killed = await waitForPromise(exit, this.options.shutdownKillWaitMs ?? 5_000);
    if (!killed && this.currentChild === child) {
      throw new TrafficTerminationUnconfirmedError();
    }
  }

  private async reportCompletion(input: {
    accumulator: K6RunAccumulator;
    liveMetrics: K6LiveMetricAggregator;
    batcher: MetricBatcher;
    stdoutDrain: Promise<void>;
    stdoutTail: BoundedStdoutTail;
    summaryPath: string;
    status: "succeeded" | "failed";
    exitCode?: number;
    errorMessage?: string;
    completedAt: Date;
    workDir: string;
  }): Promise<void> {
    try {
      await input.stdoutDrain;
      for (const sample of input.liveMetrics.flush()) {
        await input.batcher.add(sample);
      }
      await input.batcher.close();
    } catch (error) {
      this.options.logger.warn({ err: error }, "Could not flush final k6 metric batch.");
    }

    const summary = await readK6SummaryExport(
      input.summaryPath,
      input.stdoutTail.toString(),
      this.options.readSummaryFile,
    );

    const report = input.accumulator.completionReport({
      status: input.status,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      completedAt: input.completedAt,
      ...(summary.metrics ? { summaryMetrics: summary.metrics } : {}),
      ...(summary.warning ? { summaryExportWarning: summary.warning } : {}),
    });

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
      if (!completionPersisted) {
        this.pendingPersistence = { report, workDir: input.workDir };
      }
      this.options.logger.error(
        {
          err: error,
          runId: report.runId,
          maxAttempts: this.resolveCompletionRetryConfig().maxAttempts,
        },
        "Could not report k6 traffic completion to API.",
      );
    } finally {
      if (completionPersisted)
        await rm(input.workDir, { recursive: true, force: true }).catch(() => undefined);
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
        if (execution?.request.runId === this.pendingPersistence.report.runId) {
          await this.options.executionStore.update(
            withCompletion(execution, this.pendingPersistence.report),
          );
          if (this.pendingPersistence.workDir)
            await rm(this.pendingPersistence.workDir, { recursive: true, force: true }).catch(
              () => undefined,
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
        if (attempt >= retry.maxAttempts) {
          break;
        }

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

class CancellationRequestedError extends Error {}
export class TrafficTerminationUnconfirmedError extends Error {
  constructor(cause?: unknown) {
    super("Could not confirm that the k6 child exited after cancellation.", { cause });
    this.name = "TrafficTerminationUnconfirmedError";
  }
}
export class ExecutionSlotConflictError extends Error {
  constructor(readonly currentRunId: string) {
    super(`Traffic execution ${currentRunId} still owns the execution slot.`);
  }
}

async function consumeK6Stdout(input: {
  stdout: NonNullable<ReturnType<typeof spawn>["stdout"]>;
  accumulator: K6RunAccumulator;
  liveMetrics: K6LiveMetricAggregator;
  batcher: MetricBatcher;
  stdoutTail: BoundedStdoutTail;
  maxLineLength?: number;
  acceptPoint: () => boolean;
}): Promise<void> {
  const framer = new K6JsonLineFramer(
    input.maxLineLength === undefined ? {} : { maxLineLength: input.maxLineLength },
  );
  input.stdout.setEncoding("utf8");
  for await (const chunk of input.stdout) {
    const text = String(chunk);
    input.stdoutTail.push(text);
    for (const line of framer.push(text)) {
      if (input.acceptPoint()) await consumeK6Line(line, input);
    }
  }
  for (const line of framer.finish()) {
    if (input.acceptPoint()) await consumeK6Line(line, input);
  }
}

export class BoundedStdoutTail {
  private retained = Buffer.alloc(0);
  private readonly maxBytes: number;

  constructor(maxBytes = 256 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("k6 stdout tail byte limit must be a positive integer.");
    this.maxBytes = maxBytes;
  }

  push(chunk: string | Buffer): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (next.byteLength >= this.maxBytes) {
      this.retained = Buffer.from(next.subarray(next.byteLength - this.maxBytes));
      return;
    }
    const combined = Buffer.concat([this.retained, next]);
    this.retained =
      combined.byteLength <= this.maxBytes
        ? combined
        : Buffer.from(combined.subarray(combined.byteLength - this.maxBytes));
  }

  toString(): string {
    return this.retained.toString("utf8");
  }

  byteLength(): number {
    return this.retained.byteLength;
  }
}

export async function readK6SummaryExport(
  summaryPath: string,
  stdoutTail: string,
  reader: (summaryPath: string) => Promise<string> = (filePath) => readFile(filePath, "utf8"),
): Promise<{
  metrics: K6SummaryMetrics | null;
  warning?: "summary_export_missing" | "summary_export_invalid" | "summary_export_read_failed";
}> {
  try {
    const exported = parseK6SummaryMetrics(await reader(summaryPath));
    if (exported) return { metrics: exported };
    return {
      metrics: parseK6SummaryMetrics(stdoutTail),
      warning: "summary_export_invalid",
    };
  } catch (error) {
    const warning =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "summary_export_missing"
        : "summary_export_read_failed";
    return { metrics: parseK6SummaryMetrics(stdoutTail), warning };
  }
}

async function consumeK6Line(
  line: string,
  input: {
    accumulator: K6RunAccumulator;
    liveMetrics: K6LiveMetricAggregator;
    batcher: MetricBatcher;
  },
): Promise<void> {
  const point = parseK6JsonLine(line);
  if (!point) return;
  input.accumulator.observe(point);
  for (const sample of input.liveMetrics.observe(point)) {
    await input.batcher.add(sample);
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function waitForPromise(promise: Promise<void> | null, timeoutMs: number): Promise<boolean> {
  if (!promise) return true;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    timer.unref();
    void promise.then(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
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
