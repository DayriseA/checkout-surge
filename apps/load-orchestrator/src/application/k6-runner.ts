import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  TrafficCompletionReport,
  TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { type LoadApiClient, MetricBatcher } from "./api-client.js";
import {
  type DurableExecution,
  type FileExecutionStore,
  withCompletion,
} from "./execution-store.js";
import { K6RunAccumulator, parseK6JsonLine } from "./k6-output-parser.js";
import { K6JsonLineFramer } from "./k6-json-line-framer.js";
import { K6LiveMetricAggregator } from "./k6-live-metric-aggregator.js";
import { generateK6Script } from "./k6-script.js";

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
      executionStore?: FileExecutionStore;
      retryIntervalMs?: number;
      shutdownGraceMs?: number;
      shutdownKillWaitMs?: number;
      liveMetricWindowMs?: number;
      maxK6OutputLineLength?: number;
      metricBatchSize?: number;
      maxBufferedMetricSamples?: number;
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
  private readonly completionTasks = new Set<Promise<void>>();
  private deliveryAttempt: Promise<void> | null = null;
  private pendingPersistence: {
    report: TrafficCompletionReport;
    workDir: string | null;
  } | null = null;

  async initialize(): Promise<void> {
    const execution = await this.options.executionStore?.read();
    if (execution?.state === "accepted" || execution?.state === "executing") {
      const accumulator = new K6RunAccumulator({
        runId: execution.request.runId,
        correlationId: execution.request.correlationId,
        plannedRequests: generateK6Script(execution.request).plannedRequests,
        startedAt: new Date(execution.acceptedAt),
      });
      await this.options.executionStore?.update(
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
    const execution = await this.options.executionStore?.read();
    return execution?.request.runId === runId
      ? { state: execution.state, acceptedAt: execution.acceptedAt }
      : { state: "unknown" };
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    const preparation = this.currentPreparation?.promise;
    if (!this.currentChild && preparation) await Promise.allSettled([preparation]);
    const child = this.currentChild;
    if (child) await this.terminateAndReap(child);
    if (preparation) await Promise.allSettled([preparation]);
    await Promise.allSettled([...this.completionTasks]);
    await this.deliverPending();
    if (this.pendingPersistence)
      throw new Error("Traffic completion could not be made durable during shutdown.");
  }

  async start(input: TrafficExecutionStartRequest): Promise<K6ExecutionStart> {
    if (this.closing) throw new Error("Traffic execution owner is shutting down.");
    if (this.currentPreparation) {
      if (this.currentPreparation.runId === input.runId) {
        return this.currentPreparation.promise;
      }
      throw new Error("A k6 execution is still being prepared.");
    }
    if (this.currentChild) {
      const current = await this.options.executionStore?.read();
      if (current?.request.runId === input.runId) {
        return {
          startedAt: new Date(current.acceptedAt),
          plannedRequests: generateK6Script(input).plannedRequests,
        };
      }
      throw new Error("A k6 child still owns the execution slot.");
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
    const acceptance = await this.options.executionStore?.accept(input, startedAt);
    const accepted = acceptance?.execution;
    if (accepted && !acceptance.created && accepted.state !== "accepted") {
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
    let workDir: string | null = null;
    let childWasSpawned = false;
    try {
      workDir = await mkdtemp(path.join(tmpdir(), "checkout-surge-k6-"));
      const scriptPath = path.join(workDir, "scenario.js");
      await writeFile(scriptPath, generated.contents, "utf8");
      if (this.closing)
        throw new Error("Traffic execution owner began shutting down during preparation.");
      const child = (this.options.spawnProcess ?? spawn)(
        this.options.k6Binary,
        ["run", "--quiet", "--out", "json=-", scriptPath],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      childWasSpawned = true;
      this.currentChild = child;
      this.currentChildExit = new Promise((resolve) => {
        child.once("close", resolve);
      });
      const completionSettled = this.attachProcessHandlers({
        child,
        input,
        startedAt,
        plannedRequests: generated.plannedRequests,
        workDir,
      });
      try {
        if (accepted)
          await this.options.executionStore?.update({ ...accepted, state: "executing" });
      } catch (error) {
        await this.terminateAndReap(child);
        await completionSettled;
        throw error;
      }
    } catch (error) {
      if (!childWasSpawned) {
        await this.persistPreparationFailure(
          input,
          accepted,
          generated.plannedRequests,
          startedAt,
          error,
          workDir,
        );
      }
      throw error;
    }

    return { startedAt, plannedRequests: generated.plannedRequests };
  }

  private async persistPreparationFailure(
    input: TrafficExecutionStartRequest,
    execution: DurableExecution | undefined,
    plannedRequests: number,
    startedAt: Date,
    error: unknown,
    workDir: string | null,
  ): Promise<void> {
    if (!execution || !this.options.executionStore) {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    const accumulator = new K6RunAccumulator({
      runId: input.runId,
      correlationId: input.correlationId,
      plannedRequests,
      startedAt,
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
    workDir: string;
  }): Promise<void> {
    const accumulator = new K6RunAccumulator({
      runId: input.input.runId,
      correlationId: input.input.correlationId,
      plannedRequests: input.plannedRequests,
      startedAt: input.startedAt,
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
    const stdout = input.child.stdout;
    const stderr = input.child.stderr;
    const stdoutDrain = stdout
      ? consumeK6Stdout({
          stdout,
          accumulator,
          liveMetrics,
          batcher,
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
      const task = this.reportCompletion({
        accumulator,
        liveMetrics,
        batcher,
        stdoutDrain,
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

    stderr?.on("data", (chunk) => {
      this.options.logger.warn(
        { runId: input.input.runId, stderr: chunk.toString("utf8") },
        "k6 wrote to stderr.",
      );
    });

    input.child.once("error", (error) => {
      processError = error;
    });

    input.child.once("close", (exitCode) => {
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
      }
    });
    if (!stdout || !stderr) input.child.kill("SIGTERM");
    return completionSettled;
  }

  private async terminateAndReap(child: ReturnType<typeof spawn>): Promise<void> {
    const exit = this.currentChild === child ? this.currentChildExit : null;
    if (!child.killed) child.kill("SIGTERM");
    const exited = await waitForPromise(exit, this.options.shutdownGraceMs ?? 5_000);
    if (exited || this.currentChild !== child) return;
    child.kill("SIGKILL");
    const killed = await waitForPromise(exit, this.options.shutdownKillWaitMs ?? 5_000);
    if (!killed && this.currentChild === child) {
      throw new Error("Could not confirm that the k6 child exited during shutdown.");
    }
  }

  private async reportCompletion(input: {
    accumulator: K6RunAccumulator;
    liveMetrics: K6LiveMetricAggregator;
    batcher: MetricBatcher;
    stdoutDrain: Promise<void>;
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

    const report = input.accumulator.completionReport({
      status: input.status,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      completedAt: input.completedAt,
    });

    let completionPersisted = !this.options.executionStore;
    try {
      if (this.options.executionStore) {
        const execution = await this.options.executionStore.read();
        if (execution?.request.runId !== report.runId) {
          throw new Error("The durable execution journal no longer matches the completed child.");
        }
        await this.options.executionStore.update(withCompletion(execution, report));
        completionPersisted = true;
      }
      await this.sendCompletionWithRetry(report);
      const delivered = await this.options.executionStore?.read();
      if (delivered?.request.runId === report.runId) {
        await this.options.executionStore?.update({ ...delivered, state: "completed" });
      }
    } catch (error) {
      if (!completionPersisted && this.options.executionStore) {
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
      if (this.pendingPersistence && this.options.executionStore) {
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
      const execution = await this.options.executionStore?.read();
      if (execution?.state !== "completion_pending" || !execution.completion) return;
      await this.options.apiClient.sendCompletion(execution.completion);
      await this.options.executionStore?.update({ ...execution, state: "completed" });
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

async function consumeK6Stdout(input: {
  stdout: NonNullable<ReturnType<typeof spawn>["stdout"]>;
  accumulator: K6RunAccumulator;
  liveMetrics: K6LiveMetricAggregator;
  batcher: MetricBatcher;
  maxLineLength?: number;
}): Promise<void> {
  const framer = new K6JsonLineFramer(
    input.maxLineLength === undefined ? {} : { maxLineLength: input.maxLineLength },
  );
  input.stdout.setEncoding("utf8");
  for await (const chunk of input.stdout) {
    for (const line of framer.push(String(chunk))) {
      await consumeK6Line(line, input);
    }
  }
  for (const line of framer.finish()) {
    await consumeK6Line(line, input);
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
