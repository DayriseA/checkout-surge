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
import { K6JsonLineFramer } from "./k6-json-line-framer.js";
import { K6LiveMetricAggregator } from "./k6-live-metric-aggregator.js";
import {
  BoundedStderrCollector,
  K6RunAccumulator,
  type K6SummaryMetrics,
  parseK6JsonLine,
  parseK6SummaryMetrics,
} from "./k6-output-parser.js";
import type { generateK6Script } from "./k6-script.js";
import type { collectLoadRunDiagnostics } from "./load-run-diagnostics.js";

export const defaultK6CancellationTimeoutMs = 10_000;
export const maxK6CancellationTimeoutMs = 15_000;

export type K6ExecutionLifecycle = "idle" | "starting" | "running" | "stopping" | "exited";

export type K6ChildProcessResult =
  | { outcome: "cancelled" }
  | { outcome: "completed"; report: TrafficCompletionReport };

interface ActiveExecution {
  runId: string;
  child: ReturnType<typeof spawn> | null;
  workDir: string | null;
  exit: Promise<{ exitCode: number | null; processError: Error | null }>;
  resolveExit: (result: { exitCode: number | null; processError: Error | null }) => void;
  processError: Error | null;
  completion: Promise<K6ChildProcessResult> | null;
  cancellation: Promise<"aborted" | "natural_completion"> | null;
  termination: Promise<void> | null;
  cancellationAccepted: boolean;
  cancellationDeadlineAt: number | null;
  setupSettled: Promise<void>;
  resolveSetupSettled: () => void;
  disposition: Promise<void> | null;
}

export class K6ChildProcessSupervisor {
  constructor(
    private readonly options: {
      k6Binary: string;
      apiClient: Pick<LoadApiClient, "sendMetrics">;
      logger: CheckoutSurgeLogger;
      cancellationTimeoutMs?: number;
      spawnProcess?: typeof spawn;
      now?: () => Date;
      liveMetricWindowMs?: number;
      maxK6OutputLineLength?: number;
      maxStdoutTailBytes?: number;
      readSummaryFile?: (summaryPath: string) => Promise<string>;
      metricBatchSize?: number;
      maxBufferedMetricSamples?: number;
      removeWorkDir?: (workDir: string) => Promise<void>;
    },
  ) {}

  private lifecycle: K6ExecutionLifecycle = "idle";
  private active: ActiveExecution | null = null;
  private lastSettled: {
    runId: string;
    outcome: "aborted" | "natural_completion";
  } | null = null;

  lifecycleSnapshot(): K6ExecutionLifecycle {
    return this.lifecycle;
  }

  currentRunId(): string | null {
    return this.active?.runId ?? null;
  }

  async start(input: {
    request: TrafficExecutionStartRequest;
    script: string;
    startedAt: Date;
    plannedRequests: number;
    executionPlan: ReturnType<typeof generateK6Script>["executionPlan"];
    diagnostics: Awaited<ReturnType<typeof collectLoadRunDiagnostics>>;
  }): Promise<{ completion: Promise<K6ChildProcessResult> }> {
    if (this.active || this.lifecycle !== "idle") {
      throw new Error("The k6 child-process supervisor already owns an execution.");
    }

    let resolveExit: ActiveExecution["resolveExit"] = () => undefined;
    const exit = new Promise<{ exitCode: number | null; processError: Error | null }>((resolve) => {
      resolveExit = resolve;
    });
    let resolveSetupSettled: () => void = () => undefined;
    const setupSettled = new Promise<void>((resolve) => {
      resolveSetupSettled = resolve;
    });
    const active: ActiveExecution = {
      runId: input.request.runId,
      child: null,
      workDir: null,
      exit,
      resolveExit,
      processError: null,
      completion: null,
      cancellation: null,
      termination: null,
      cancellationAccepted: false,
      cancellationDeadlineAt: null,
      setupSettled,
      resolveSetupSettled,
      disposition: null,
    };
    this.lastSettled = null;
    this.active = active;
    this.lifecycle = "starting";
    try {
      active.workDir = await mkdtemp(path.join(tmpdir(), "checkout-surge-k6-"));
      this.throwIfStartCancelled(active);
      const scriptPath = path.join(active.workDir, "scenario.js");
      const summaryPath = path.join(active.workDir, "summary.json");
      await writeFile(scriptPath, input.script, "utf8");
      this.throwIfStartCancelled(active);
      const child = (this.options.spawnProcess ?? spawn)(
        this.options.k6Binary,
        ["run", "--quiet", "--summary-export", summaryPath, "--out", "json=-", scriptPath],
        {
          detached: false,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      active.child = child;
      this.attachChildExitObservation(active);
      active.completion = this.createCompletion(active, { ...input, summaryPath });
      this.lifecycle = "running";
      active.resolveSetupSettled();
      return { completion: active.completion };
    } catch (error) {
      active.resolveSetupSettled();
      if (active.child) {
        if (active.cancellationDeadlineAt === null) {
          active.cancellationDeadlineAt = Date.now() + this.cancellationTimeoutMs();
        }
        await this.terminateAndObserveExit(active);
      }
      await this.dispose(active);
      if (active.cancellationAccepted) {
        this.lastSettled = { runId: active.runId, outcome: "aborted" };
      }
      if (active.cancellationAccepted) throw new K6StartCancelledError();
      throw error;
    }
  }

  cancel(runId: string): Promise<"aborted" | "natural_completion"> {
    const active = this.active;
    if (!active || active.runId !== runId) {
      return Promise.resolve("natural_completion");
    }
    if (this.lifecycle === "exited") {
      return Promise.resolve(active.cancellationAccepted ? "aborted" : "natural_completion");
    }
    if (active.cancellation) return active.cancellation;

    active.cancellationAccepted = true;
    active.cancellationDeadlineAt ??= Date.now() + this.cancellationTimeoutMs();
    this.lifecycle = "stopping";
    const operation = (
      active.child
        ? this.terminateAndObserveExit(active).then(() => "aborted" as const)
        : Promise.resolve("aborted" as const)
    ).catch((error) => {
      if (this.active === active) active.cancellation = null;
      throw error;
    });
    active.cancellation = operation;
    return operation;
  }

  async close(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const outcome = await this.cancel(active.runId);
    if (outcome === "natural_completion" && active.completion) {
      await active.completion;
      return;
    }
    await this.dispose(active);
  }

  cancellationAccepted(runId: string): boolean {
    return this.active?.runId === runId && this.active.cancellationAccepted;
  }

  settledOutcome(runId: string): "aborted" | "natural_completion" | null {
    return this.lastSettled?.runId === runId ? this.lastSettled.outcome : null;
  }

  clearSettledOutcome(runId: string): void {
    if (this.lastSettled?.runId === runId) this.lastSettled = null;
  }

  private createCompletion(
    active: ActiveExecution,
    input: {
      request: TrafficExecutionStartRequest;
      startedAt: Date;
      plannedRequests: number;
      executionPlan: ReturnType<typeof generateK6Script>["executionPlan"];
      diagnostics: Awaited<ReturnType<typeof collectLoadRunDiagnostics>>;
      summaryPath: string;
    },
  ): Promise<K6ChildProcessResult> {
    const stderrCollector = new BoundedStderrCollector();
    const accumulator = new K6RunAccumulator({
      runId: input.request.runId,
      correlationId: input.request.correlationId,
      plannedRequests: input.plannedRequests,
      startedAt: input.startedAt,
      executionPlan: input.executionPlan,
      diagnostics: input.diagnostics,
      stderr: stderrCollector,
    });
    const batcher = new MetricBatcher({
      runId: input.request.runId,
      correlationId: input.request.correlationId,
      client: this.options.apiClient,
      ...(this.options.metricBatchSize === undefined
        ? {}
        : { maxBatchSize: this.options.metricBatchSize }),
      ...(this.options.maxBufferedMetricSamples === undefined
        ? {}
        : { maxBufferedSamples: this.options.maxBufferedMetricSamples }),
      onFlushError: (error) => {
        this.options.logger.warn(
          { err: error, runId: input.request.runId },
          "Could not forward k6 metric batch to API.",
        );
      },
      onOverflow: (sample) => {
        this.options.logger.warn(
          { runId: input.request.runId, metricName: sample.metricName },
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
    const child = active.child;
    if (!child) throw new Error("Cannot consume k6 output before spawn.");
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      throw new Error("k6 process did not expose stdout and stderr pipes.");
    }
    const stdoutDrain = stdout
      ? consumeK6Stdout({
          stdout,
          accumulator,
          liveMetrics,
          batcher,
          stdoutTail,
          acceptPoint: () => !active.cancellationAccepted,
          ...(this.options.maxK6OutputLineLength === undefined
            ? {}
            : { maxLineLength: this.options.maxK6OutputLineLength }),
        }).catch((error) => {
          this.options.logger.warn(
            { err: error, runId: input.request.runId },
            "Could not completely consume k6 stdout.",
          );
        })
      : Promise.resolve();

    stderr?.setEncoding("utf8");
    stderr?.on("data", (chunk) => {
      stderrCollector.push(String(chunk));
      this.options.logger.warn(
        { runId: input.request.runId, stderrBytesObserved: Buffer.byteLength(chunk) },
        "k6 wrote to stderr.",
      );
    });
    return this.finishExecution(active, {
      ...input,
      accumulator,
      batcher,
      liveMetrics,
      stdoutTail,
      stdoutDrain,
      stdout,
      stderr,
      stderrCollector,
    });
  }

  private async finishExecution(
    active: ActiveExecution,
    input: {
      request: TrafficExecutionStartRequest;
      summaryPath: string;
      accumulator: K6RunAccumulator;
      batcher: MetricBatcher;
      liveMetrics: K6LiveMetricAggregator;
      stdoutTail: BoundedStdoutTail;
      stdoutDrain: Promise<void>;
      stdout: ReturnType<typeof spawn>["stdout"];
      stderr: ReturnType<typeof spawn>["stderr"];
      stderrCollector: BoundedStderrCollector;
    },
  ): Promise<K6ChildProcessResult> {
    try {
      const { exitCode, processError } = await active.exit;
      input.stderrCollector.finish();
      if (active.cancellationAccepted) {
        input.stdout?.destroy();
        input.stderr?.destroy();
        void input.stdoutDrain;
        void input.batcher.discard().catch((error) => {
          this.options.logger.warn(
            { err: error, runId: input.request.runId },
            "Could not discard cancelled k6 metric work.",
          );
        });
        return { outcome: "cancelled" };
      }

      try {
        await input.stdoutDrain;
        for (const sample of input.liveMetrics.flush()) await input.batcher.add(sample);
        await input.batcher.close();
      } catch (error) {
        this.options.logger.warn({ err: error }, "Could not flush final k6 metric batch.");
      }
      const summary = await readK6SummaryExport(
        input.summaryPath,
        input.stdoutTail.toString(),
        this.options.readSummaryFile,
      );
      const succeeded = !processError && exitCode === 0;
      return {
        outcome: "completed",
        report: input.accumulator.completionReport({
          status: succeeded ? "succeeded" : "failed",
          ...(!processError && exitCode !== null ? { exitCode } : {}),
          ...(!succeeded
            ? {
                errorMessage: processError
                  ? processError.message
                  : `k6 exited with code ${exitCode ?? "unknown"}.`,
              }
            : {}),
          completedAt: this.options.now?.() ?? new Date(),
          ...(summary.metrics ? { summaryMetrics: summary.metrics } : {}),
          ...(summary.warning ? { summaryExportWarning: summary.warning } : {}),
        }),
      };
    } finally {
      await this.dispose(active);
    }
  }

  private attachChildExitObservation(active: ActiveExecution): void {
    const child = active.child;
    if (!child) throw new Error("Cannot observe a k6 execution before spawn.");
    child.once("error", (error) => {
      active.processError = error;
    });
    child.once("close", (exitCode) => {
      if (this.active === active) this.lifecycle = "exited";
      this.lastSettled = {
        runId: active.runId,
        outcome: active.cancellationAccepted ? "aborted" : "natural_completion",
      };
      active.resolveExit({ exitCode, processError: active.processError });
    });
  }

  private throwIfStartCancelled(active: ActiveExecution): void {
    if (active.cancellationAccepted) throw new K6StartCancelledError();
  }

  private async terminateAndObserveExit(active: ActiveExecution): Promise<void> {
    if (active.termination) return active.termination;
    const termination = this.performTerminationAndObserveExit(active).catch((error) => {
      if (this.active === active) active.termination = null;
      throw error;
    });
    active.termination = termination;
    return termination;
  }

  private async performTerminationAndObserveExit(active: ActiveExecution): Promise<void> {
    const child = active.child;
    if (!child) return;
    const remainingAtStart = this.cancellationTimeRemaining(active);
    const gracefulMs = Math.floor(remainingAtStart / 2);
    let signalError: unknown;
    try {
      if (!child.killed) child.kill("SIGTERM");
    } catch (error) {
      signalError = error;
    }
    if (
      await waitForPromise(
        active.exit.then(() => undefined),
        gracefulMs,
      )
    )
      return;

    try {
      child.kill("SIGKILL");
    } catch (error) {
      signalError = error;
    }
    if (
      !(await waitForPromise(
        active.exit.then(() => undefined),
        this.cancellationTimeRemaining(active),
      ))
    ) {
      throw new TrafficTerminationUnconfirmedError(signalError);
    }
  }

  private cancellationTimeRemaining(active: ActiveExecution): number {
    return Math.max(0, (active.cancellationDeadlineAt ?? Date.now()) - Date.now());
  }

  private cancellationTimeoutMs(): number {
    return positiveIntegerOrDefault(
      this.options.cancellationTimeoutMs,
      defaultK6CancellationTimeoutMs,
    );
  }

  private dispose(active: ActiveExecution): Promise<void> {
    if (active.disposition) return active.disposition;
    active.disposition = this.performDisposition(active);
    return active.disposition;
  }

  private async performDisposition(active: ActiveExecution): Promise<void> {
    await active.setupSettled;
    try {
      active.child?.stdout?.destroy();
      active.child?.stderr?.destroy();
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId: active.runId },
        "Could not dispose k6 child streams.",
      );
    }
    if (active.workDir) await this.removeWorkDir(active.workDir);
    if (this.active === active) {
      this.active = null;
      this.lifecycle = "idle";
    }
  }

  private async removeWorkDir(workDir: string): Promise<void> {
    await (
      this.options.removeWorkDir?.(workDir) ?? rm(workDir, { recursive: true, force: true })
    ).catch((error) => {
      this.options.logger.warn({ err: error, workDir }, "Could not remove k6 work directory.");
    });
  }
}

export class TrafficTerminationUnconfirmedError extends Error {
  constructor(cause?: unknown) {
    super("Could not confirm that the k6 child exited within the cancellation timeout.", {
      cause,
    });
    this.name = "TrafficTerminationUnconfirmedError";
  }
}

export class K6StartCancelledError extends Error {
  constructor() {
    super("k6 execution was cancelled before spawn.");
    this.name = "K6StartCancelledError";
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
  for (const sample of input.liveMetrics.observe(point)) await input.batcher.add(sample);
}

export class BoundedStdoutTail {
  private retained = Buffer.alloc(0);
  private readonly maxBytes: number;

  constructor(maxBytes = 256 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("k6 stdout tail byte limit must be a positive integer.");
    }
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
    return { metrics: parseK6SummaryMetrics(stdoutTail), warning: "summary_export_invalid" };
  } catch (error) {
    const warning =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "summary_export_missing"
        : "summary_export_read_failed";
    return { metrics: parseK6SummaryMetrics(stdoutTail), warning };
  }
}

async function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
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
