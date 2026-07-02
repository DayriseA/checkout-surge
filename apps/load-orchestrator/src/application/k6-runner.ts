import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  TrafficCompletionReport,
  TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { type LoadApiClient, MetricBatcher } from "./api-client.js";
import { K6RunAccumulator, parseK6JsonLine } from "./k6-output-parser.js";
import { generateK6Script } from "./k6-script.js";

export interface K6ExecutionStart {
  startedAt: Date;
  plannedRequests: number;
}

export interface K6Runner {
  start(input: TrafficExecutionStartRequest): Promise<K6ExecutionStart>;
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
    },
  ) {}

  async start(input: TrafficExecutionStartRequest): Promise<K6ExecutionStart> {
    const startedAt = this.now();
    const generated = generateK6Script(input);
    const workDir = await mkdtemp(path.join(tmpdir(), "checkout-surge-k6-"));
    const scriptPath = path.join(workDir, "scenario.js");
    await writeFile(scriptPath, generated.contents, "utf8");

    const child = (this.options.spawnProcess ?? spawn)(
      this.options.k6Binary,
      ["run", "--quiet", "--out", "json=-", scriptPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    this.attachProcessHandlers({
      child,
      input,
      startedAt,
      plannedRequests: generated.plannedRequests,
      workDir,
    });

    return { startedAt, plannedRequests: generated.plannedRequests };
  }

  private attachProcessHandlers(input: {
    child: ReturnType<typeof spawn>;
    input: TrafficExecutionStartRequest;
    startedAt: Date;
    plannedRequests: number;
    workDir: string;
  }): void {
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
      onFlushError: (error) => {
        this.options.logger.warn(
          { err: error, runId: input.input.runId },
          "Could not forward k6 metric batch to API.",
        );
      },
    });
    const stdout = input.child.stdout;
    const stderr = input.child.stderr;
    let completionReported = false;
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
      void this.reportCompletion({
        accumulator,
        batcher,
        workDir: input.workDir,
        ...completion,
      });
    };

    if (!stdout || !stderr) {
      reportCompletionOnce({
        status: "failed",
        errorMessage: "k6 process did not expose stdout and stderr pipes.",
        completedAt: this.now(),
      });
      return;
    }

    createInterface({ input: stdout }).on("line", (line) => {
      const point = parseK6JsonLine(line);
      if (!point) {
        return;
      }

      const sample = accumulator.observe(point);
      if (sample) {
        batcher.add(sample);
      }
    });

    stderr.on("data", (chunk) => {
      this.options.logger.warn(
        { runId: input.input.runId, stderr: chunk.toString("utf8") },
        "k6 wrote to stderr.",
      );
    });

    input.child.once("error", (error) => {
      reportCompletionOnce({
        status: "failed",
        errorMessage: error.message,
        completedAt: this.now(),
      });
    });

    input.child.once("close", (exitCode) => {
      reportCompletionOnce({
        status: exitCode === 0 ? "succeeded" : "failed",
        completedAt: this.now(),
        ...(exitCode === null ? {} : { exitCode }),
        ...(exitCode === 0
          ? {}
          : { errorMessage: `k6 exited with code ${exitCode ?? "unknown"}.` }),
      });
    });
  }

  private async reportCompletion(input: {
    accumulator: K6RunAccumulator;
    batcher: MetricBatcher;
    status: "succeeded" | "failed";
    exitCode?: number;
    errorMessage?: string;
    completedAt: Date;
    workDir: string;
  }): Promise<void> {
    try {
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

    try {
      await this.sendCompletionWithRetry(report);
    } catch (error) {
      this.options.logger.error(
        {
          err: error,
          runId: report.runId,
          maxAttempts: this.resolveCompletionRetryConfig().maxAttempts,
        },
        "Could not report k6 traffic completion to API.",
      );
    } finally {
      await rm(input.workDir, { recursive: true, force: true }).catch(() => undefined);
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

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
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
