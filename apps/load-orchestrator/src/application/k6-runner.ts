import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { TrafficExecutionStartRequest } from "@checkout-surge/contracts";
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

export class SpawnK6Runner implements K6Runner {
  constructor(
    private readonly options: {
      k6Binary: string;
      apiClient: LoadApiClient;
      logger: CheckoutSurgeLogger;
      now?: () => Date;
      spawnProcess?: typeof spawn;
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

    if (!stdout || !stderr) {
      void this.reportCompletion({
        accumulator,
        batcher,
        status: "failed",
        errorMessage: "k6 process did not expose stdout and stderr pipes.",
        completedAt: this.now(),
        workDir: input.workDir,
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
      void this.reportCompletion({
        accumulator,
        batcher,
        status: "failed",
        errorMessage: error.message,
        completedAt: this.now(),
        workDir: input.workDir,
      });
    });

    input.child.once("close", (exitCode) => {
      const completion = {
        accumulator,
        batcher,
        status: exitCode === 0 ? "succeeded" : "failed",
        completedAt: this.now(),
        workDir: input.workDir,
        ...(exitCode === null ? {} : { exitCode }),
        ...(exitCode === 0
          ? {}
          : { errorMessage: `k6 exited with code ${exitCode ?? "unknown"}.` }),
      } as const;
      void this.reportCompletion(completion);
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
      await this.options.apiClient.sendCompletion(
        input.accumulator.completionReport({
          status: input.status,
          ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
          ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
          completedAt: input.completedAt,
        }),
      );
    } catch (error) {
      this.options.logger.error({ err: error }, "Could not report k6 traffic completion to API.");
    } finally {
      await rm(input.workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
