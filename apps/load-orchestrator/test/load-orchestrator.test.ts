import { type spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  buyOutcomeHeaderName,
  type LoadMetricIngestRequest,
  loadRunIdHeaderName,
  type TrafficCompletionReport,
  type TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { HttpLoadApiClient, type LoadApiClient } from "../src/application/api-client.js";
import { CompletionDeliveryCoordinator } from "../src/application/completion-delivery-coordinator.js";
import {
  type CompletionPublishOutcome,
  type CompletionRejection,
  type DurableExecution,
  ExecutionConflictError,
  type ExecutionStore,
  FileExecutionStore,
  withCompletion,
} from "../src/application/execution-store.js";
import {
  K6ChildProcessSupervisor,
  K6StartCancelledError,
} from "../src/application/k6-child-process-supervisor.js";
import { K6LiveMetricAggregator } from "../src/application/k6-live-metric-aggregator.js";
import {
  BoundedStderrCollector,
  K6RunAccumulator,
  parseK6JsonLine,
} from "../src/application/k6-output-parser.js";
import {
  ExecutionSlotConflictError,
  SpawnK6Runner as ProductionSpawnK6Runner,
  TrafficTerminationUnconfirmedError,
} from "../src/application/k6-runner.js";
import { generateK6Script, k6ScenarioGracefulStop } from "../src/application/k6-script.js";
import {
  collectLoadRunDiagnostics,
  runBoundedDiagnosticCommand,
} from "../src/application/load-run-diagnostics.js";
import { loadLoadOrchestratorConfig } from "../src/runtime/config.js";
import {
  trafficExecutionStartRequestFixture,
  waitForCondition,
} from "./load-orchestrator-test-helper.js";

const timestamp = "2026-06-20T12:00:00.000Z";
const completionTimestamp = "2026-06-20T12:00:05.000Z";
const startRequest = trafficExecutionStartRequestFixture();

function diagnosticReader(files: Record<string, string>) {
  return async (file: string) => {
    const value = files[file];
    if (value === undefined) throw new Error(`missing ${file}`);
    return value;
  };
}

class InMemoryExecutionStore implements ExecutionStore {
  private execution: DurableExecution | null = null;
  private mutationChain = Promise.resolve();

  async read(): Promise<DurableExecution | null> {
    return this.execution;
  }

  async accept(
    request: TrafficExecutionStartRequest,
    acceptedAt: Date,
  ): Promise<{ execution: DurableExecution; created: boolean }> {
    return this.mutate(async () => {
      if (
        this.execution?.state === "completion_rejected" &&
        this.execution.request.runId === request.runId
      ) {
        return { execution: this.execution, created: false };
      }
      if (
        this.execution &&
        this.execution.state !== "completed" &&
        this.execution.state !== "completion_rejected"
      ) {
        if (this.execution.request.runId === request.runId) {
          return { execution: this.execution, created: false };
        }
        throw new ExecutionConflictError(this.execution.request.runId);
      }
      this.execution = {
        request,
        state: "accepted",
        acceptedAt: acceptedAt.toISOString(),
      };
      return { execution: this.execution, created: true };
    });
  }

  async update(execution: DurableExecution): Promise<void> {
    await this.mutate(async () => {
      this.execution = execution;
    });
  }

  async publishCompletion(report: TrafficCompletionReport): Promise<CompletionPublishOutcome> {
    return this.mutate(async () => {
      if (!this.execution || this.execution.request.runId !== report.runId) {
        return "execution_mismatch";
      }
      if (this.execution.completion) {
        return JSON.stringify(this.execution.completion) === JSON.stringify(report)
          ? "already_published"
          : "completion_conflict";
      }
      if (this.execution.state === "completed") return "completion_conflict";
      this.execution = withCompletion(this.execution, report);
      return "published";
    });
  }

  async acknowledgeCompletion(report: TrafficCompletionReport): Promise<boolean> {
    return this.mutate(async () => {
      if (
        this.execution?.state !== "completion_pending" ||
        JSON.stringify(this.execution.completion) !== JSON.stringify(report)
      ) {
        return false;
      }
      this.execution = { ...this.execution, state: "completed" };
      return true;
    });
  }

  async rejectCompletion(
    report: TrafficCompletionReport,
    rejection: CompletionRejection,
  ): Promise<boolean> {
    return this.mutate(async () => {
      if (
        this.execution?.state !== "completion_pending" ||
        JSON.stringify(this.execution.completion) !== JSON.stringify(report)
      ) {
        return false;
      }
      this.execution = { ...this.execution, state: "completion_rejected", rejection };
      return true;
    });
  }

  async completeCancellation(runId: string): Promise<boolean> {
    return this.mutate(async () => {
      if (
        this.execution?.request.runId !== runId ||
        (this.execution.state !== "accepted" && this.execution.state !== "executing")
      ) {
        return false;
      }
      this.execution = { ...this.execution, state: "completed" };
      return true;
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation);
    this.mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

type SpawnK6RunnerOptions = ConstructorParameters<typeof ProductionSpawnK6Runner>[0];

class SpawnK6Runner extends ProductionSpawnK6Runner {
  constructor(
    options: Omit<SpawnK6RunnerOptions, "completionDelivery" | "executionStore"> &
      Partial<Pick<SpawnK6RunnerOptions, "completionDelivery" | "executionStore">> & {
        completionDeliveryRetryIntervalMs?: number;
      },
  ) {
    const {
      completionDeliveryRetryIntervalMs,
      executionStore = new InMemoryExecutionStore(),
      completionDelivery = new CompletionDeliveryCoordinator({
        executionStore,
        apiClient: options.apiClient,
        logger: options.logger,
        ...(completionDeliveryRetryIntervalMs === undefined
          ? {}
          : { retryIntervalMs: completionDeliveryRetryIntervalMs }),
      }),
      ...runnerOptions
    } = options;
    void completionDelivery.start();
    super({ ...runnerOptions, executionStore, completionDelivery });
  }
}

function constantArrivalStartRequest(
  ratePerSecond: number,
  durationSeconds: number,
  k6Vus?: { preAllocatedVus: number; maxVus: number },
): TrafficExecutionStartRequest {
  return {
    ...startRequest,
    configSnapshot: {
      ...startRequest.configSnapshot,
      trafficConfig: {
        mode: "constant-arrival-rate",
        ratePerSecond,
        startDelaySeconds: 2,
        durationSeconds,
        quantityPerAttempt: 1,
        ...(k6Vus ? { k6Vus } : {}),
      },
    },
  };
}

function generatedScenario(scriptContents: string): Record<string, unknown> {
  const optionsLine = scriptContents
    .split("\n")
    .find((line) => line.startsWith("export const options = "));
  if (!optionsLine) throw new Error("Generated script did not contain k6 options.");
  const options = JSON.parse(optionsLine.slice("export const options = ".length, -1)) as {
    scenarios: { checkout: Record<string, unknown> };
  };
  return options.scenarios.checkout;
}

describe("load-orchestrator configuration", () => {
  it.each([
    undefined,
    "  ",
    "change-me-shared-control-token",
  ])("rejects unsafe control tokens (%s)", (token) => {
    expect(() =>
      loadLoadOrchestratorConfig({ NODE_ENV: "test", CONTROL_SERVICE_TOKEN: token }),
    ).toThrow(/CONTROL_SERVICE_TOKEN/);
  });

  it("accepts a deployment-specific control token", () => {
    const config = loadLoadOrchestratorConfig({
      NODE_ENV: "test",
      CONTROL_SERVICE_TOKEN: "deployment-token",
    });
    expect(config.controlServiceToken).toBe("deployment-token");
    expect(config.k6CancellationTimeoutMs).toBe(10_000);
    expect(config.completionDeliveryRetryIntervalMs).toBe(5_000);
  });

  it("accepts one positive end-to-end k6 cancellation timeout", () => {
    expect(
      loadLoadOrchestratorConfig({
        NODE_ENV: "test",
        CONTROL_SERVICE_TOKEN: "deployment-token",
        K6_CANCELLATION_TIMEOUT_MS: "1250",
      }).k6CancellationTimeoutMs,
    ).toBe(1250);
    expect(() =>
      loadLoadOrchestratorConfig({
        NODE_ENV: "test",
        CONTROL_SERVICE_TOKEN: "deployment-token",
        K6_CANCELLATION_TIMEOUT_MS: "0",
      }),
    ).toThrow(/K6_CANCELLATION_TIMEOUT_MS/);
    expect(
      loadLoadOrchestratorConfig({
        NODE_ENV: "test",
        CONTROL_SERVICE_TOKEN: "deployment-token",
        K6_CANCELLATION_TIMEOUT_MS: "15000",
      }).k6CancellationTimeoutMs,
    ).toBe(15_000);
    for (const value of ["15001", "9007199254740992"]) {
      expect(() =>
        loadLoadOrchestratorConfig({
          NODE_ENV: "test",
          CONTROL_SERVICE_TOKEN: "deployment-token",
          K6_CANCELLATION_TIMEOUT_MS: value,
        }),
      ).toThrow(/no greater than 15000/);
    }
  });

  it("bounds the single completion delivery retry interval", () => {
    expect(
      loadLoadOrchestratorConfig({
        NODE_ENV: "test",
        CONTROL_SERVICE_TOKEN: "deployment-token",
        COMPLETION_DELIVERY_RETRY_INTERVAL_MS: "250",
      }).completionDeliveryRetryIntervalMs,
    ).toBe(250);
    for (const value of ["0", "60001"]) {
      expect(() =>
        loadLoadOrchestratorConfig({
          NODE_ENV: "test",
          CONTROL_SERVICE_TOKEN: "deployment-token",
          COMPLETION_DELIVERY_RETRY_INTERVAL_MS: value,
        }),
      ).toThrow(/COMPLETION_DELIVERY_RETRY_INTERVAL_MS/);
    }
  });
});

describe("durable execution ownership", () => {
  it("enforces completion presence by durable execution state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-state-journal-"));
    const journalPath = path.join(directory, "execution.json");
    const report = new K6RunAccumulator({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 400,
      startedAt: new Date(timestamp),
      executionPlan: generateK6Script(startRequest).executionPlan,
    }).completionReport({ status: "succeeded", completedAt: new Date(completionTimestamp) });
    const store = new FileExecutionStore(directory);
    try {
      for (const state of ["accepted", "executing"] as const) {
        await writeFile(
          journalPath,
          JSON.stringify({
            request: startRequest,
            state,
            acceptedAt: timestamp,
            completion: report,
          }),
        );
        await expect(store.read()).rejects.toThrow(/execution\.json.*completion/);
      }

      await writeFile(
        journalPath,
        JSON.stringify({
          request: startRequest,
          state: "completion_pending",
          acceptedAt: timestamp,
        }),
      );
      await expect(store.read()).rejects.toThrow(/execution\.json.*completion/);

      await writeFile(
        journalPath,
        JSON.stringify({
          request: startRequest,
          state: "completed",
          acceptedAt: timestamp,
        }),
      );
      const cancelled = await store.read();
      expect(cancelled).toMatchObject({ state: "completed" });
      expect(cancelled?.completion).toBeUndefined();

      await writeFile(
        journalPath,
        JSON.stringify({
          request: startRequest,
          state: "completed",
          acceptedAt: timestamp,
          completion: report,
        }),
      );
      await expect(store.read()).resolves.toMatchObject({
        state: "completed",
        completion: report,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("atomically publishes one report and conditionally records its acknowledgement", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-atomic-journal-"));
    const store = new FileExecutionStore(directory);
    const generated = generateK6Script(startRequest);
    const first = new K6RunAccumulator({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: generated.plannedRequests,
      startedAt: new Date(timestamp),
      executionPlan: generated.executionPlan,
    }).completionReport({ status: "succeeded", completedAt: new Date(completionTimestamp) });
    const conflicting: TrafficCompletionReport = {
      ...first,
      status: "failed",
      errorMessage: "conflicting completion",
    };
    try {
      await store.accept(startRequest, new Date(timestamp));
      await expect(
        Promise.all([store.publishCompletion(first), store.publishCompletion(conflicting)]),
      ).resolves.toEqual(["published", "completion_conflict"]);
      expect(await store.read()).toMatchObject({
        state: "completion_pending",
        completion: first,
      });

      const successor: DurableExecution = {
        request: {
          ...startRequest,
          runId: "66666666-6666-4666-8666-666666666666",
        },
        state: "accepted",
        acceptedAt: completionTimestamp,
      };
      const [, acknowledged] = await Promise.all([
        store.update(successor),
        store.acknowledgeCompletion(first),
      ]);

      expect(acknowledged).toBe(false);
      expect(await store.read()).toEqual(successor);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("conditionally parks a rejected completion and releases the execution slot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-rejected-journal-"));
    const store = new FileExecutionStore(directory);
    const generated = generateK6Script(startRequest);
    const report = new K6RunAccumulator({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: generated.plannedRequests,
      startedAt: new Date(timestamp),
      executionPlan: generated.executionPlan,
    }).completionReport({ status: "succeeded", completedAt: new Date(completionTimestamp) });
    const rejection = {
      reason: "API load ingestion failed with HTTP 409.",
      httpStatus: 409,
      rejectedAt: "2026-06-20T12:00:06.000Z",
    };
    const successor = {
      ...startRequest,
      runId: "66666666-6666-4666-8666-666666666666",
    };
    try {
      await store.accept(startRequest, new Date(timestamp));
      await store.publishCompletion(report);

      await expect(
        store.rejectCompletion({ ...report, status: "failed" }, rejection),
      ).resolves.toBe(false);
      await expect(
        Promise.all([
          store.completeCancellation(startRequest.runId),
          store.rejectCompletion(report, rejection),
        ]),
      ).resolves.toEqual([false, true]);
      await expect(store.completeCancellation(startRequest.runId)).resolves.toBe(false);
      await expect(store.read()).resolves.toMatchObject({
        state: "completion_rejected",
        completion: report,
        rejection,
      });
      await expect(store.accept(successor, new Date(completionTimestamp))).resolves.toMatchObject({
        created: true,
        execution: { request: successor, state: "accepted" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a rejected completion when the same run is accepted after reopening", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-rejected-replay-"));
    const generated = generateK6Script(startRequest);
    const report = new K6RunAccumulator({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: generated.plannedRequests,
      startedAt: new Date(timestamp),
      executionPlan: generated.executionPlan,
    }).completionReport({ status: "succeeded", completedAt: new Date(completionTimestamp) });
    const rejection = {
      reason: "API load ingestion failed with HTTP 409.",
      httpStatus: 409,
      rejectedAt: "2026-06-20T12:00:06.000Z",
    };
    try {
      const firstStore = new FileExecutionStore(directory);
      await firstStore.accept(startRequest, new Date(timestamp));
      await expect(firstStore.publishCompletion(report)).resolves.toBe("published");
      await expect(firstStore.rejectCompletion(report, rejection)).resolves.toBe(true);
      const rejected = await firstStore.read();
      expect(rejected).toMatchObject({
        state: "completion_rejected",
        completion: report,
        rejection,
      });

      const reopenedStore = new FileExecutionStore(directory);
      await expect(
        reopenedStore.accept(
          { ...startRequest, correlationId: "same-run-replay-correlation" },
          new Date("2026-06-20T12:01:00.000Z"),
        ),
      ).resolves.toEqual({ execution: rejected, created: false });
      await expect(reopenedStore.read()).resolves.toEqual(rejected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a parked completion through the existing public terminal status", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-rejected-status-"));
    const store = new FileExecutionStore(directory);
    const generated = generateK6Script(startRequest);
    const report = new K6RunAccumulator({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: generated.plannedRequests,
      startedAt: new Date(timestamp),
      executionPlan: generated.executionPlan,
    }).completionReport({ status: "succeeded", completedAt: new Date(completionTimestamp) });
    const runner = new ProductionSpawnK6Runner({
      k6Binary: "k6",
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
      completionDelivery: {
        start: async () => undefined,
        persist: async () => undefined,
        close: async () => undefined,
      },
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
    });
    try {
      await store.accept(startRequest, new Date(timestamp));
      await store.publishCompletion(report);
      await store.rejectCompletion(report, {
        reason: "API load ingestion failed with HTTP 409.",
        httpStatus: 409,
        rejectedAt: "2026-06-20T12:00:06.000Z",
      });

      await expect(runner.statusSnapshot(startRequest.runId)).resolves.toEqual({
        state: "completed",
        acceptedAt: timestamp,
      });
    } finally {
      await runner.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects journals whose stored request relies on a wire default", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-incomplete-journal-"));
    try {
      if (startRequest.configSnapshot.trafficConfig.mode !== "buyer-spike") {
        throw new Error("Expected the shared start fixture to use buyer-spike traffic.");
      }
      const { duplicateEachBuyerAttempt: _defaulted, ...incompleteTrafficConfig } =
        startRequest.configSnapshot.trafficConfig;
      await writeFile(
        path.join(directory, "execution.json"),
        JSON.stringify({
          request: {
            ...startRequest,
            configSnapshot: {
              ...startRequest.configSnapshot,
              trafficConfig: incompleteTrafficConfig,
            },
          },
          state: "accepted",
          acceptedAt: timestamp,
        }),
      );

      await expect(new FileExecutionStore(directory).read()).rejects.toThrow(
        /execution\.json.*request\.configSnapshot\.trafficConfig\.duplicateEachBuyerAttempt/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects journals whose stored completion relies on a wire default", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-incomplete-journal-"));
    try {
      const report = new K6RunAccumulator({
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        plannedRequests: 400,
        startedAt: new Date(timestamp),
        executionPlan: generateK6Script(startRequest).executionPlan,
      }).completionReport({ status: "failed", completedAt: new Date(completionTimestamp) });
      const { completedIterations: _defaulted, ...incompleteDeliverySummary } =
        report.trafficDeliverySummary;
      await writeFile(
        path.join(directory, "execution.json"),
        JSON.stringify({
          request: startRequest,
          state: "completion_pending",
          acceptedAt: timestamp,
          completion: {
            ...report,
            trafficDeliverySummary: incompleteDeliverySummary,
          },
        }),
      );

      await expect(new FileExecutionStore(directory).read()).rejects.toThrow(
        /execution\.json.*completion\.trafficDeliverySummary\.completedIterations/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers accepted state and fences a different run across store instances", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-execution-store-"));
    try {
      const first = new FileExecutionStore(directory);
      await first.accept(startRequest, new Date(timestamp));
      const recovered = await new FileExecutionStore(directory).read();
      expect(recovered).toMatchObject({
        state: "accepted",
        request: { runId: startRequest.runId },
      });
      await expect(
        first.accept(
          { ...startRequest, runId: "66666666-6666-4666-8666-666666666666" },
          new Date(timestamp),
        ),
      ).rejects.toBeInstanceOf(ExecutionConflictError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("load-orchestrator k6 mapping", () => {
  it("retains at most 2,000 characters from successful diagnostic stdout or stderr", async () => {
    for (const target of ["stdout", "stderr"] as const) {
      const result = await runBoundedDiagnosticCommand(process.execPath, [
        "-e",
        `process.${target}.write("v".repeat(2_500))`,
      ]);
      expect(result).toHaveLength(2_000);
    }
  });

  it.each([
    {
      name: "timeout",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      options: { timeoutMs: 50 },
    },
    {
      name: "excessive output",
      command: process.execPath,
      args: ["-e", 'process.stdout.write("x".repeat(20_000))'],
      options: {},
    },
    {
      name: "missing executable",
      command: "checkout-surge-missing-diagnostic-executable",
      args: [],
      options: {},
    },
    {
      name: "synchronous spawn error",
      command: "invalid\u0000path",
      args: [],
      options: {},
    },
  ])("degrades $name diagnostics to null", async ({ command, args, options }) => {
    await expect(runBoundedDiagnosticCommand(command, args, options)).resolves.toBeNull();
  });

  it("collects bounded diagnostics and degrades malformed facts to null", async () => {
    const plan = generateK6Script(startRequest).executionPlan;
    const diagnostics = await collectLoadRunDiagnostics("k6", plan, {
      runCommand: vi.fn(async (command, args) =>
        command === "nproc"
          ? "8\n"
          : command === "sh"
            ? "bad"
            : args[0] === "version"
              ? "k6 v1\nextra"
              : null,
      ),
      readText: vi.fn(async (file) =>
        file.endsWith("limits")
          ? "Max open files 1024 2048 files\n"
          : file.endsWith("ip_local_port_range")
            ? "32768\t60999\n"
            : file.endsWith("tcp_tw_reuse")
              ? "2"
              : "malformed",
      ),
    });
    expect(diagnostics).toEqual({
      nproc: 8,
      ulimitNofile: null,
      processMaxOpenFiles: { soft: 1024, hard: 2048 },
      generatorCapacity: null,
      networkDiagnostics: { ipLocalPortRange: "32768 60999", tcpTwReuse: 2, tcpTimestamps: null },
      k6Version: "k6 v1",
      executionPlan: plan,
    });
  });

  it("rejects partially parsed diagnostic integers and malformed port ranges", async () => {
    const plan = generateK6Script(startRequest).executionPlan;
    const diagnostics = await collectLoadRunDiagnostics("k6", plan, {
      runCommand: vi.fn(async (command) => (command === "nproc" ? "8junk" : "2 garbage")),
      readText: vi.fn(async (file) =>
        file.endsWith("limits")
          ? "Max open files 1024garbage 2048 files\n"
          : file.endsWith("ip_local_port_range")
            ? "32768 60999 trailing"
            : file.endsWith("tcp_tw_reuse")
              ? "2garbage"
              : "malformed",
      ),
    });
    expect(diagnostics).toMatchObject({
      nproc: null,
      ulimitNofile: null,
      processMaxOpenFiles: null,
      generatorCapacity: null,
      networkDiagnostics: null,
      k6Version: "2 garbage",
    });
  });

  it("collects meminfo and finite cgroup v2 capacity", async () => {
    const plan = generateK6Script(startRequest).executionPlan;
    const diagnostics = await collectLoadRunDiagnostics("k6", plan, {
      runCommand: async () => null,
      readText: diagnosticReader({
        "/proc/meminfo":
          "MemTotal:       8388608 kB\nMemAvailable:   6291456 kB\nSwapTotal:            0 kB\n",
        "/sys/fs/cgroup/memory.max": "4294967296\n",
        "/sys/fs/cgroup/cpu.max": "150000 100000\n",
      }),
    });
    expect(diagnostics.generatorCapacity).toEqual({
      memTotalBytes: 8_589_934_592,
      memAvailableBytes: 6_442_450_944,
      swapTotalBytes: 0,
      cgroupMemoryLimitBytes: 4_294_967_296,
      cgroupMemoryLimitUnlimited: false,
      cgroupCpuQuota: 1.5,
      cgroupCpuQuotaUnlimited: false,
    });
  });

  it("retains partial meminfo and distinguishes unlimited cgroup v2 capacity", async () => {
    const plan = generateK6Script(startRequest).executionPlan;
    const diagnostics = await collectLoadRunDiagnostics("k6", plan, {
      runCommand: async () => null,
      readText: diagnosticReader({
        "/proc/meminfo": "MemTotal: malformed\nMemAvailable: 1024 kB\nSwapTotal: 0 kB\n",
        "/sys/fs/cgroup/memory.max": "max\n",
        "/sys/fs/cgroup/cpu.max": "max 100000\n",
      }),
    });
    expect(diagnostics.generatorCapacity).toEqual({
      memTotalBytes: null,
      memAvailableBytes: 1_048_576,
      swapTotalBytes: 0,
      cgroupMemoryLimitBytes: null,
      cgroupMemoryLimitUnlimited: true,
      cgroupCpuQuota: null,
      cgroupCpuQuotaUnlimited: true,
    });
  });

  it("falls back to finite and unlimited cgroup v1 capacity", async () => {
    const plan = generateK6Script(startRequest).executionPlan;
    const finite = await collectLoadRunDiagnostics("k6", plan, {
      runCommand: async () => null,
      readText: diagnosticReader({
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2147483648\n",
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "50000\n",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
      }),
    });
    expect(finite.generatorCapacity).toMatchObject({
      cgroupMemoryLimitBytes: 2_147_483_648,
      cgroupMemoryLimitUnlimited: false,
      cgroupCpuQuota: 0.5,
      cgroupCpuQuotaUnlimited: false,
    });

    const unlimited = await collectLoadRunDiagnostics("k6", plan, {
      runCommand: async () => null,
      readText: diagnosticReader({
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
      }),
    });
    expect(unlimited.generatorCapacity).toMatchObject({
      cgroupMemoryLimitBytes: null,
      cgroupMemoryLimitUnlimited: true,
      cgroupCpuQuota: null,
      cgroupCpuQuotaUnlimited: true,
    });
  });

  it("degrades invalid quota and malformed or missing capacity files without throwing", async () => {
    const plan = generateK6Script(startRequest).executionPlan;
    await expect(
      collectLoadRunDiagnostics("k6", plan, {
        runCommand: async () => null,
        readText: diagnosticReader({
          "/proc/meminfo": "MemTotal: nope\n",
          "/sys/fs/cgroup/cpu.max": "100000 0\n",
          "/sys/fs/cgroup/memory.max": "not-a-limit\n",
        }),
      }),
    ).resolves.toMatchObject({ generatorCapacity: null });
    await expect(
      collectLoadRunDiagnostics("k6", plan, {
        runCommand: async () => null,
        readText: async () => {
          throw new Error("missing");
        },
      }),
    ).resolves.toMatchObject({ generatorCapacity: null });
  });

  it("frames and bounds retained stderr by logical line", () => {
    const collector = new BoundedStderrCollector();
    collector.push("split");
    collector.push("-line\nsecond\n");
    for (let index = 0; index < 50; index += 1) collector.push(`line-${index}\n`);
    collector.push("x".repeat(501));
    collector.finish();
    expect(collector.snapshot()).toMatchObject({
      stderrLineCountObserved: 53,
      stderrLineCountRetained: 50,
      stderrLineTruncatedCount: 1,
    });
    expect(collector.snapshot().stderrLines.at(-1)).toHaveLength(500);
    expect(collector.snapshot().stderrLines[0]).toBe("line-1");
    const huge = new BoundedStderrCollector();
    huge.push("z".repeat(1_000_000));
    huge.finish();
    expect(huge.snapshot()).toMatchObject({
      stderrLines: ["z".repeat(500)],
      stderrLineTruncatedCount: 1,
    });
  });

  it("frames CRLF split across chunks without retaining the carriage return", () => {
    const collector = new BoundedStderrCollector();
    collector.push("first\r");
    collector.push("\n\r");
    collector.push("\nlast\r");
    collector.finish();
    expect(collector.snapshot()).toMatchObject({
      stderrLines: ["first", "", "last\r"],
      stderrLineCountObserved: 3,
      stderrLineTruncatedCount: 0,
    });
  });
  it("generates a contract-driven buyer-spike script without shell interpolation", () => {
    const script = generateK6Script({
      ...startRequest,
      apiBaseUrl: "http://api.test///",
    });

    expect(script.plannedRequests).toBe(400);
    expect(script.plannedRequests).toBe(script.executionPlan.plannedEmittedAttempts);
    expect(script.executionPlan).toEqual({
      trafficMode: "buyer-spike",
      buyerCount: 200,
      duplicateEachBuyerAttempt: true,
      iterationsPerVu: 2,
      plannedEmittedAttempts: 400,
      startDelaySeconds: 1,
      maxDurationSeconds: 5,
    });
    expect(script.contents).toContain('"executor":"per-vu-iterations"');
    expect(script.contents).toContain('"vus":200');
    expect(script.contents).toContain('"iterations":2');
    expect(script.contents).toContain('"apiBaseUrl":"http://api.test"');
    expect(script.contents).toContain("config.apiBaseUrl}/buy");
    expect(script.contents).toContain(
      "const expectedCheckoutStatuses = http.expectedStatuses(202, 409);",
    );
    expect(script.contents).toContain("responseCallback: expectedCheckoutStatuses");
    expect(script.contents).toContain('"discardResponseBodies":true');
    expect(script.contents).toContain('"systemTags":["scenario"]');
    expect(script.contents).toContain(
      `const checkoutOutcomeHeaderName = "${buyOutcomeHeaderName}"`,
    );
    expect(script.contents).toContain(`"${correlationIdHeaderName}": correlationId`);
    expect(script.contents).toContain('outcome === "reservation_secured"');
    expect(script.contents).not.toContain('outcome === "idempotent_replay"');
    expect(script.contents).toContain('outcome === "reservation_pending_persistence"');
    expect(script.contents).toContain('response.status === 409 && outcome === "sold_out"');
    expect(script.contents).toContain("key.toLowerCase() === headerName");
    expect(script.contents).toContain("config.duplicateEachBuyerAttempt ? __VU : iteration");
    expect(script.contents).toContain(`"${loadRunIdHeaderName}": config.runId`);
    expect(generatedScenario(script.contents)).toMatchObject({
      maxDuration: "5s",
      gracefulStop: k6ScenarioGracefulStop,
    });
  });

  it("generates a constant-arrival scenario with k6 VU controls", () => {
    const script = generateK6Script({
      ...startRequest,
      configSnapshot: {
        ...startRequest.configSnapshot,
        trafficConfig: {
          mode: "constant-arrival-rate",
          ratePerSecond: 20,
          startDelaySeconds: 2,
          durationSeconds: 10,
          quantityPerAttempt: 1,
          k6Vus: { preAllocatedVus: 10, maxVus: 50 },
        },
      },
    });

    expect(script.plannedRequests).toBe(200);
    expect(script.plannedRequests).toBe(script.executionPlan.plannedEmittedAttempts);
    expect(script.contents).toContain('"executor":"constant-arrival-rate"');
    expect(script.contents).toContain('"rate":20');
    expect(script.contents).toContain('"preAllocatedVUs":10');
    expect(script.contents).toContain('"maxVUs":50');
    expect(script.contents).toContain(
      'config.trafficMode === "constant-arrival-rate" && iteration >= config.plannedRequests',
    );
    expect(script.executionPlan).toMatchObject({
      preAllocatedVus: 10,
      maxVus: 50,
      plannedEmittedAttempts: 200,
    });
    expect(generatedScenario(script.contents)).toMatchObject({
      duration: "10s",
      preAllocatedVUs: 10,
      maxVUs: 50,
      gracefulStop: k6ScenarioGracefulStop,
    });
  });

  it.each([
    { rate: 1, expectedPreAllocatedVus: 1, expectedMaxVus: 2 },
    { rate: 1_000, expectedPreAllocatedVus: 1_000, expectedMaxVus: 2_000 },
    { rate: 4_999, expectedPreAllocatedVus: 4_999, expectedMaxVus: 9_998 },
    { rate: 5_000, expectedPreAllocatedVus: 5_000, expectedMaxVus: 10_000 },
    { rate: 5_001, expectedPreAllocatedVus: 5_001, expectedMaxVus: 10_000 },
    { rate: 10_000, expectedPreAllocatedVus: 10_000, expectedMaxVus: 10_000 },
    { rate: 12_000, expectedPreAllocatedVus: 10_000, expectedMaxVus: 10_000 },
  ])("resolves rate $rate into capped automatic VUs shared by scenario and diagnostics", ({
    rate,
    expectedPreAllocatedVus,
    expectedMaxVus,
  }) => {
    const script = generateK6Script(constantArrivalStartRequest(rate, 3));
    const scenario = generatedScenario(script.contents);

    expect(script.plannedRequests).toBe(rate * 3);
    expect(script.executionPlan).toEqual({
      trafficMode: "constant-arrival-rate",
      ratePerSecond: rate,
      durationSeconds: 3,
      plannedEmittedAttempts: rate * 3,
      startDelaySeconds: 2,
      preAllocatedVus: expectedPreAllocatedVus,
      maxVus: expectedMaxVus,
    });
    expect(scenario).toMatchObject({
      rate,
      duration: "3s",
      startTime: "2s",
      preAllocatedVUs: expectedPreAllocatedVus,
      maxVUs: expectedMaxVus,
      gracefulStop: "30s",
    });
  });

  it("sources buy quantity from traffic attempts", () => {
    const script = generateK6Script({
      ...startRequest,
      configSnapshot: {
        ...startRequest.configSnapshot,
        trafficConfig: { ...startRequest.configSnapshot.trafficConfig, quantityPerAttempt: 3 },
      },
    });

    expect(script.contents).toContain('"quantity":3');
  });

  it("emits a parseable k6 module using the expected public k6 APIs", async () => {
    const script = generateK6Script(startRequest);
    const workDir = await mkdtemp(path.join(tmpdir(), "checkout-surge-k6-script-check-"));
    const scriptPath = path.join(workDir, "scenario.mjs");

    try {
      await writeFile(scriptPath, script.contents, "utf8");
      const checkResult = spawnSync(process.execPath, ["--check", scriptPath], {
        encoding: "utf8",
      });

      if (checkResult.status !== 0) {
        throw new Error(
          `Generated k6 script failed Node syntax validation.\nstdout:\n${checkResult.stdout}\nstderr:\n${checkResult.stderr}`,
        );
      }

      expect(script.contents).toContain('import http from "k6/http";');
      expect(script.contents).toContain('import { check } from "k6";');
      expect(script.contents).toContain('import exec from "k6/execution";');
      expect(script.contents).toContain('import { Counter } from "k6/metrics";');
      expect(script.contents).toContain("exec.scenario.iterationInTest");
      expect(script.contents).toContain('new Counter("checkout_attempts_started")');
      expect(script.contents).toContain('new Counter("checkout_responses_completed")');
      expect(script.contents).toContain('new Counter("checkout_reservation_accepted")');
      expect(script.contents).toContain('new Counter("checkout_sold_out_rejections")');
      expect(script.contents).toContain('new Counter("checkout_transport_failures")');
      expect(script.contents).toContain('new Counter("checkout_unexpected_responses")');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("increments the started counter before http.post and the completed counter after it returns", () => {
    for (const request of [startRequest, constantArrivalStartRequest(5, 3)]) {
      const script = generateK6Script(request).contents;
      const guardIndex = script.indexOf("iteration >= config.plannedRequests");
      const startedIndex = script.indexOf("attemptsStarted.add(1)");
      const postIndex = script.indexOf("http.post(");
      const completedIndex = script.indexOf("responsesCompleted.add(1)");
      const classificationIndex = script.indexOf("const outcome = readResponseHeader(response");

      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(startedIndex).toBeGreaterThan(guardIndex);
      expect(postIndex).toBeGreaterThan(startedIndex);
      expect(completedIndex).toBeGreaterThan(postIndex);
      expect(classificationIndex).toBeGreaterThan(completedIndex);
    }
  });

  it("classifies status-zero returns before application responses", () => {
    const script = generateK6Script(startRequest).contents;
    const transportIndex = script.indexOf("if (response.status === 0)");
    const acceptedIndex = script.indexOf("else if (isAccepted)");
    const unexpectedIndex = script.indexOf("unexpectedResponses.add(1)");

    expect(transportIndex).toBeGreaterThanOrEqual(0);
    expect(acceptedIndex).toBeGreaterThan(transportIndex);
    expect(unexpectedIndex).toBeGreaterThan(acceptedIndex);
  });

  it("keeps terminal totals independent from windowed dashboard metrics", () => {
    const accumulator = new K6RunAccumulator({
      executionPlan: generateK6Script(startRequest).executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 2,
      startedAt: new Date(timestamp),
    });
    const lines = [
      JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } }),
      JSON.stringify({
        type: "Point",
        metric: "http_req_duration",
        data: {
          value: 42,
          time: timestamp,
          tags: {
            error_code: "1404",
            expected_response: "false",
            group: "",
            method: "POST",
            name: "http://api:4000/buy",
            proto: "HTTP/1.1",
            scenario: "checkout",
            status: "404",
            url: "http://api:4000/buy",
          },
        },
      }),
      JSON.stringify({
        type: "Point",
        metric: "http_req_failed",
        data: { value: 0, time: timestamp, tags: { scenario: "checkout" } },
      }),
      JSON.stringify({
        type: "Point",
        metric: "checkout_reservation_accepted",
        data: { value: 1, time: timestamp },
      }),
      JSON.stringify({
        type: "Point",
        metric: "checkout_sold_out_rejections",
        data: { value: 1, time: timestamp },
      }),
    ];
    const liveMetrics = new K6LiveMetricAggregator();
    for (const line of lines) {
      const point = parseK6JsonLine(line);
      if (point) {
        accumulator.observe(point);
        liveMetrics.observe(point);
      }
    }
    const samples = liveMetrics.flush();

    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date(completionTimestamp),
    });

    expect(samples.map((sample) => sample.metricName)).toEqual([
      "traffic.response_completion_rate",
      "traffic.latency",
      "traffic.failure_rate",
    ]);
    expect(report.transportAttemptCounts).toMatchObject({
      plannedRequests: 2,
      startedRequests: 1,
      completedRequests: 1,
      interruptedRequests: 0,
      unstartedRequests: 1,
    });
    expect(report.httpSummary).toMatchObject({
      acceptedResponses: 1,
      soldOutResponses: 1,
      unexpectedResponses: 0,
    });
    expect(report.trafficDeliverySummary).toMatchObject({
      trafficMode: "buyer-spike",
      plannedBuyers: 200,
    });
    expect(report.trafficDeliverySummary).not.toHaveProperty("trafficDeliveryStatus");
  });

  it("does not count clean sold-out responses as failed HTTP summary outcomes", () => {
    const accumulator = new K6RunAccumulator({
      executionPlan: generateK6Script(startRequest).executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 2,
      startedAt: new Date(timestamp),
    });

    [
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 1, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_sold_out_rejections",
        data: { value: 1, time: timestamp },
      },
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 1, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_sold_out_rejections",
        data: { value: 1, time: timestamp },
      },
    ].forEach((point) => {
      accumulator.observe(point);
    });

    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date(completionTimestamp),
    });

    expect(report.httpSummary).toMatchObject({
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 2,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 1,
    });
    expect(report.transportAttemptCounts).toMatchObject({
      startedRequests: 2,
      completedRequests: 2,
      interruptedRequests: 0,
      unstartedRequests: 0,
    });
  });

  it("counts unexpected checkout responses as failed HTTP summary outcomes", () => {
    const accumulator = new K6RunAccumulator({
      executionPlan: generateK6Script(startRequest).executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 1,
      startedAt: new Date(timestamp),
    });

    [
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 0, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_unexpected_responses",
        data: { value: 1, time: timestamp },
      },
    ].forEach((point) => {
      accumulator.observe(point);
    });

    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date(completionTimestamp),
    });

    expect(report.httpSummary).toMatchObject({
      failedRequests: 1,
      soldOutResponses: 0,
      transportFailures: 0,
      unexpectedResponses: 1,
      failureRate: 0,
    });
    expect(report.transportAttemptCounts).toMatchObject({
      startedRequests: 1,
      completedRequests: 1,
      interruptedRequests: 0,
      unstartedRequests: 0,
    });
    expect(report.trafficDeliverySummary).toMatchObject({ notes: [] });
  });

  it("reports buyer-spike plan facts and derives terminal iteration diagnostics", () => {
    const executionPlan = generateK6Script(startRequest).executionPlan;
    const accumulator = new K6RunAccumulator({
      executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: executionPlan.plannedEmittedAttempts,
      startedAt: new Date(timestamp),
    });
    accumulator.observe({
      type: "Point",
      metric: "checkout_attempts_started",
      data: { value: 400 },
    });
    accumulator.observe({
      type: "Point",
      metric: "checkout_responses_completed",
      data: { value: 400 },
    });
    accumulator.observe({ type: "Point", metric: "iterations", data: { value: 398 } });
    accumulator.observe({ type: "Point", metric: "dropped_iterations", data: { value: 1 } });

    expect(
      accumulator.completionReport({
        status: "succeeded",
        completedAt: new Date(completionTimestamp),
      }).trafficDeliverySummary,
    ).toMatchObject({
      trafficMode: "buyer-spike",
      plannedBuyers: 200,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      completedIterations: 398,
      droppedIterations: 1,
    });
  });

  it("reports exact effective constant-arrival plan facts and null unavailable iterations", () => {
    const constantArrivalRequest = {
      ...startRequest,
      configSnapshot: {
        ...startRequest.configSnapshot,
        trafficConfig: {
          mode: "constant-arrival-rate" as const,
          ratePerSecond: 9,
          startDelaySeconds: 0,
          durationSeconds: 7,
          quantityPerAttempt: 1,
        },
      },
    };
    const executionPlan = generateK6Script(constantArrivalRequest).executionPlan;
    const accumulator = new K6RunAccumulator({
      executionPlan,
      runId: constantArrivalRequest.runId,
      correlationId: constantArrivalRequest.correlationId,
      plannedRequests: executionPlan.plannedEmittedAttempts,
      startedAt: new Date(timestamp),
    });

    expect(
      accumulator.completionReport({
        status: "succeeded",
        completedAt: new Date(completionTimestamp),
      }).trafficDeliverySummary,
    ).toMatchObject({
      trafficMode: "constant-arrival-rate",
      plannedBuyers: null,
      scheduledRatePerSecond: 9,
      configuredDurationSeconds: 7,
      preAllocatedVUs: 9,
      maxVUs: 18,
      completedIterations: null,
    });
  });
});

describe("SpawnK6Runner completion reporting", () => {
  it("persists a failed report and delivers it when shutdown interrupts an executing run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-shutdown-report-"));
    const store = new FileExecutionStore(directory);
    const fixture = createK6ProcessFixture();
    const sendCompletion = vi.fn(async () => undefined);
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      apiClient: { sendMetrics: async () => undefined, sendCompletion },
    });
    try {
      await runner.start(startRequest);
      const closing = runner.close();
      await waitForCondition(
        () => vi.mocked(fixture.child.kill).mock.calls.length === 1,
        "shutdown signal",
      );
      fixture.child.emit("close", null, "SIGTERM");
      await closing;

      expect(sendCompletion).toHaveBeenCalledTimes(1);
      expect(sendCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: startRequest.runId,
          status: "failed",
          errorMessage: "load_orchestrator_shutdown_before_k6_completion",
        }),
      );
      expect(await store.read()).toMatchObject({
        state: "completed",
        completion: { status: "failed" },
      });
      expect(runner.currentRunId()).toBeNull();
      expect(fixture.child.kill).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains the shutdown interruption report for startup delivery when the API is unreachable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-shutdown-recovery-"));
    const store = new FileExecutionStore(directory);
    const fixture = createK6ProcessFixture();
    const failedDelivery = vi.fn(async () => {
      throw new Error("API unavailable");
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      completionDeliveryRetryIntervalMs: 60_000,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      apiClient: { sendMetrics: async () => undefined, sendCompletion: failedDelivery },
    });
    try {
      await runner.start(startRequest);
      const closing = runner.close();
      await waitForCondition(
        () => vi.mocked(fixture.child.kill).mock.calls.length === 1,
        "shutdown signal",
      );
      fixture.child.emit("close", null, "SIGTERM");
      await closing;

      expect(failedDelivery).toHaveBeenCalledTimes(1);
      expect(await store.read()).toMatchObject({
        state: "completion_pending",
        completion: {
          errorMessage: "load_orchestrator_shutdown_before_k6_completion",
        },
      });

      const delivered: TrafficCompletionReport[] = [];
      const restarted = new SpawnK6Runner({
        k6Binary: "k6",
        executionStore: store,
        logger: createSilentLogger("load-orchestrator"),
        apiClient: {
          sendMetrics: async () => undefined,
          sendCompletion: async (report) => {
            delivered.push(report);
          },
        },
      });
      await restarted.initialize();
      await waitForCondition(
        async () => (await store.read())?.state === "completed",
        "shutdown report startup delivery",
      );
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        runId: startRequest.runId,
        status: "failed",
        errorMessage: "load_orchestrator_shutdown_before_k6_completion",
      });
      expect(delivered).not.toContainEqual(
        expect.objectContaining({
          errorMessage: "load_orchestrator_restarted_before_k6_completion",
        }),
      );
      await restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for executing-state publication before persisting a shutdown interruption", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-shutdown-publish-race-"));
    let releaseUpdate: () => void = () => undefined;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    class GatedExecutingUpdateStore extends FileExecutionStore {
      updateStarted = false;

      override async update(execution: Parameters<FileExecutionStore["update"]>[0]) {
        if (execution.state === "executing") {
          this.updateStarted = true;
          await updateGate;
        }
        return super.update(execution);
      }
    }
    const store = new GatedExecutingUpdateStore(directory);
    const fixture = createK6ProcessFixture();
    const sendCompletion = vi.fn(async () => undefined);
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      apiClient: { sendMetrics: async () => undefined, sendCompletion },
    });
    try {
      const start = runner.start(startRequest);
      await waitForCondition(() => store.updateStarted, "executing-state publication");
      const closing = runner.close();
      await waitForCondition(
        () => vi.mocked(fixture.child.kill).mock.calls.length === 1,
        "shutdown signal",
      );
      fixture.child.emit("close", null, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sendCompletion).not.toHaveBeenCalled();
      expect((await store.read())?.state).toBe("accepted");
      releaseUpdate();
      await expect(start).rejects.toThrow("cancelled during preparation");
      await closing;

      expect(sendCompletion).toHaveBeenCalledTimes(1);
      expect(sendCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: startRequest.runId,
          status: "failed",
          errorMessage: "load_orchestrator_shutdown_before_k6_completion",
        }),
      );
      expect(await store.read()).toMatchObject({
        state: "completed",
        completion: {
          status: "failed",
          errorMessage: "load_orchestrator_shutdown_before_k6_completion",
        },
      });
    } finally {
      releaseUpdate();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not restart traffic when the same run replays a rejected completion", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-rejected-runner-replay-"));
    const store = new FileExecutionStore(directory);
    const generated = generateK6Script(startRequest);
    const report = new K6RunAccumulator({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: generated.plannedRequests,
      startedAt: new Date(timestamp),
      executionPlan: generated.executionPlan,
    }).completionReport({ status: "succeeded", completedAt: new Date(completionTimestamp) });
    const persist = vi.fn(async () => undefined);
    const spawnProcess = vi.fn() as unknown as typeof spawn;
    const runner = new ProductionSpawnK6Runner({
      k6Binary: "k6",
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
      completionDelivery: {
        start: async () => undefined,
        persist,
        close: async () => undefined,
      },
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      now: () => new Date("2026-06-20T12:01:00.000Z"),
      spawnProcess,
    });
    try {
      await store.accept(startRequest, new Date(timestamp));
      await expect(store.publishCompletion(report)).resolves.toBe("published");
      await expect(
        store.rejectCompletion(report, {
          reason: "API load ingestion failed with HTTP 409.",
          httpStatus: 409,
          rejectedAt: "2026-06-20T12:00:06.000Z",
        }),
      ).resolves.toBe(true);
      const rejected = await store.read();
      expect(rejected).toMatchObject({ state: "completion_rejected", completion: report });

      await expect(runner.start(startRequest)).resolves.toEqual({
        startedAt: new Date(timestamp),
        plannedRequests: generated.plannedRequests,
      });
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      await expect(store.read()).resolves.toEqual(rejected);
    } finally {
      await runner.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for the authoritative summary, reuses one report across retries, then cleans up", async () => {
    const k6Process = createK6ProcessFixture();
    const reports: TrafficCompletionReport[] = [];
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      now: createClock([timestamp, completionTimestamp]),
      readSummaryFile: async () => {
        await summaryGate;
        return JSON.stringify({
          metrics: {
            http_reqs: { count: 0 },
            checkout_reservation_accepted: { count: 0 },
            checkout_sold_out_rejections: { count: 0 },
            checkout_transport_failures: { count: 0 },
            checkout_unexpected_responses: { count: 0 },
            iterations: { count: 0 },
            dropped_iterations: { count: 0 },
            http_req_failed: { value: 0 },
            http_req_duration: { avg: 0, "p(95)": 0 },
          },
        });
      },
      completionDeliveryRetryIntervalMs: 1,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
          if (reports.length === 1) throw new Error("transient completion failure");
        },
      },
    });

    await runner.start(startRequest);
    const workDir = path.dirname(getSingleSpawnCall(k6Process).scriptPath);
    k6Process.stdout.write(
      `${JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 9, time: timestamp } })}\n`,
    );
    k6Process.child.emit("close", 0);
    await waitForReadline();
    expect(reports).toHaveLength(0);
    expect(await pathMissing(workDir)).toBe(false);

    releaseSummary();
    await waitForCompletionReport(reports, 2);
    await waitForCondition(() => pathMissing(workDir), "summary-owned temp directory cleanup");

    expect(reports[0]).toBe(reports[1]);
    expect(reports[1]?.transportAttemptCounts.startedRequests).toBe(0);
    expect(reports[1]?.loadRunDiagnosticsSummary).toMatchObject({
      terminalMetricSources: {
        startedRequests: "summary_export",
        completedRequests: "summary_export",
      },
      summaryExportWarnings: [],
    });
  });

  it.each([
    { name: "missing", warning: "summary_export_missing" as const, errorCode: "ENOENT" },
    { name: "invalid", warning: "summary_export_invalid" as const, contents: "{}" },
    {
      name: "read failure",
      warning: "summary_export_read_failed" as const,
      errorCode: "EACCES",
    },
  ])("delivers point fallback once after a $name summary is resolved", async ({
    warning,
    errorCode,
    contents,
  }) => {
    const k6Process = createK6ProcessFixture();
    const reports: TrafficCompletionReport[] = [];
    let releaseSummary: () => void = () => undefined;
    let markSummaryReadStarted: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const summaryReadStarted = new Promise<void>((resolve) => {
      markSummaryReadStarted = resolve;
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      now: createClock([timestamp, completionTimestamp]),
      readSummaryFile: async () => {
        markSummaryReadStarted();
        await summaryGate;
        if (errorCode) throw Object.assign(new Error("summary read failed"), { code: errorCode });
        return contents ?? "{}";
      },
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
    });

    await runner.start(startRequest);
    const workDir = path.dirname(getSingleSpawnCall(k6Process).scriptPath);
    writeK6JsonLines(k6Process.stdout, [
      { type: "Point", metric: "http_reqs", data: { value: 2, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_reservation_accepted",
        data: { value: 1, time: timestamp },
      },
    ]);
    k6Process.child.emit("close", 0);
    await summaryReadStarted;
    expect(reports).toHaveLength(0);
    expect(await pathMissing(workDir)).toBe(false);

    releaseSummary();
    const report = await waitForCompletionReport(reports, 1);
    await waitForCondition(() => pathMissing(workDir), "degraded summary cleanup");
    await waitForReadline();

    expect(reports).toHaveLength(1);
    expect(report.transportAttemptCounts).toMatchObject({
      startedRequests: 2,
      completedRequests: 2,
      interruptedRequests: 0,
    });
    expect(report.httpSummary).toMatchObject({
      acceptedResponses: 1,
    });
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources).toMatchObject({
      startedRequests: "point_stream",
      completedRequests: "point_stream",
      acceptedResponses: "point_stream",
    });
    expect(report.loadRunDiagnosticsSummary.summaryExportWarnings).toEqual([
      warning,
      "k6_outcome_counter_point_stream_fallback_used",
      "k6_outcome_counter_summary_export_unavailable",
    ]);
  });

  it("includes bounded live-metric loss in the terminal diagnostics", async () => {
    const k6Process = createK6ProcessFixture();
    const reports: TrafficCompletionReport[] = [];
    const sendMetrics = vi.fn(async () => {
      throw new Error("metric ingestion unavailable");
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      metricBatchSize: 1,
      readSummaryFile: async () => "{}",
      apiClient: {
        sendMetrics,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
    });

    await runner.start(startRequest);
    writeK6JsonLines(k6Process.stdout, [
      {
        type: "Point",
        metric: "checkout_attempts_started",
        data: { value: 1, time: timestamp },
      },
    ]);
    k6Process.child.emit("close", 0);

    const report = await waitForCompletionReport(reports, 1);

    expect(sendMetrics).toHaveBeenCalledTimes(6);
    expect(report.loadRunDiagnosticsSummary.liveMetricLoss).toEqual({
      sampleCount: 2,
      batchCount: 2,
    });
  });

  it("cancels preparation before spawn and retains the slot until preparation settles", async () => {
    let releaseDiagnostics: () => void = () => undefined;
    const diagnosticGate = new Promise<string | null>((resolve) => {
      releaseDiagnostics = () => resolve(null);
    });
    const spawnProcess = vi.fn() as unknown as typeof spawn;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess,
      diagnostics: {
        runCommand: async () => diagnosticGate,
        readText: async () => {
          throw new Error("missing");
        },
      },
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    const start = runner.start(startRequest);
    const cancellation = runner.abort(startRequest.runId);
    await expect(runner.start(startRequest)).rejects.toBeInstanceOf(ExecutionSlotConflictError);
    releaseDiagnostics();
    await expect(start).rejects.toThrow();
    await expect(cancellation).resolves.toBe("aborted");
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(runner.currentRunId()).toBeNull();
  });

  it("publishes starting ownership before workdir setup so cancellation prevents spawn", async () => {
    const spawnProcess = vi.fn() as unknown as typeof spawn;
    const generated = generateK6Script(startRequest);
    const diagnostics = await collectLoadRunDiagnostics("k6", generated.executionPlan, {
      runCommand: async () => null,
      readText: async () => {
        throw new Error("missing");
      },
    });
    const supervisor = new K6ChildProcessSupervisor({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess,
      cancellationTimeoutMs: 40,
      apiClient: { sendMetrics: async () => undefined },
    });

    const starting = supervisor.start({
      request: startRequest,
      script: generated.contents,
      startedAt: new Date(timestamp),
      plannedRequests: generated.plannedRequests,
      executionPlan: generated.executionPlan,
      diagnostics,
    });
    expect(supervisor.lifecycleSnapshot()).toBe("starting");
    expect(supervisor.currentRunId()).toBe(startRequest.runId);

    await expect(supervisor.cancel(startRequest.runId)).resolves.toBe("aborted");
    await expect(starting).rejects.toBeInstanceOf(K6StartCancelledError);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(supervisor.currentRunId()).toBeNull();
    expect(supervisor.lifecycleSnapshot()).toBe("idle");
  });

  it("joins starting-state no-spawn disposition during supervisor shutdown", async () => {
    let releaseCleanup: () => void = () => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupStarted = false;
    const spawnProcess = vi.fn() as unknown as typeof spawn;
    const generated = generateK6Script(startRequest);
    const diagnostics = await collectLoadRunDiagnostics("k6", generated.executionPlan, {
      runCommand: async () => null,
      readText: async () => {
        throw new Error("missing");
      },
    });
    const supervisor = new K6ChildProcessSupervisor({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess,
      cancellationTimeoutMs: 40,
      apiClient: { sendMetrics: async () => undefined },
      removeWorkDir: async (workDir) => {
        cleanupStarted = true;
        await cleanupGate;
        await rm(workDir, { recursive: true, force: true });
      },
    });
    const starting = supervisor.start({
      request: startRequest,
      script: generated.contents,
      startedAt: new Date(timestamp),
      plannedRequests: generated.plannedRequests,
      executionPlan: generated.executionPlan,
      diagnostics,
    });
    const startResult = starting.catch((error: unknown) => error);
    let closeSettled = false;
    const closing = supervisor.close().then(() => {
      closeSettled = true;
    });

    await waitForCondition(() => cleanupStarted, "starting-state workdir disposition");
    expect(closeSettled).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
    releaseCleanup();

    await expect(startResult).resolves.toBeInstanceOf(K6StartCancelledError);
    await expect(closing).resolves.toBeUndefined();
    expect(supervisor.currentRunId()).toBeNull();
  });

  it("waits for a matching child to close and suppresses normal completion on cancellation", async () => {
    const k6Process = createK6ProcessFixture();
    const completions: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      cancellationTimeoutMs: 200,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          completions.push(report);
        },
      },
    });
    await runner.start(startRequest);
    const cancellation = runner.abort(startRequest.runId);
    const duplicateCancellation = runner.abort(startRequest.runId);
    expect(duplicateCancellation).toBe(cancellation);
    expect(k6Process.child.kill).toHaveBeenCalled();
    expect(runner.currentRunId()).toBe(startRequest.runId);
    await expect(runner.start(startRequest)).rejects.toBeInstanceOf(ExecutionSlotConflictError);
    k6Process.child.emit("close", null, "SIGTERM");
    await cancellation;
    await waitForCondition(() => runner.currentRunId() === null, "cancelled execution cleanup");
    expect(completions).toEqual([]);
    expect(k6Process.child.kill).toHaveBeenCalled();
  });

  it("keeps a confirmed cancellation fenced until shutdown can durably release its journal", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-cancel-release-"));
    class FailingCancellationReleaseStore extends FileExecutionStore {
      failCancellationRelease = true;

      override async completeCancellation(runId: string) {
        if (this.failCancellationRelease) throw new Error("cancellation journal unavailable");
        return super.completeCancellation(runId);
      }
    }
    const store = new FailingCancellationReleaseStore(directory);
    const fixture = createK6ProcessFixture();
    const completions: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      cancellationTimeoutMs: 40,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          completions.push(report);
        },
      },
    });
    try {
      await runner.start(startRequest);
      const cancellation = runner.abort(startRequest.runId);
      fixture.child.emit("close", null, "SIGTERM");
      await expect(cancellation).rejects.toThrow("cancellation journal unavailable");
      expect(runner.currentRunId()).toBe(startRequest.runId);
      await expect(
        runner.start({ ...startRequest, runId: "66666666-6666-4666-8666-666666666666" }),
      ).rejects.toBeInstanceOf(ExecutionSlotConflictError);
      await expect(runner.close()).rejects.toThrow("cancellation journal unavailable");

      store.failCancellationRelease = false;
      await expect(runner.close()).resolves.toBeUndefined();
      expect(await store.read()).toMatchObject({ state: "completed" });
      expect((await store.read())?.completion).toBeUndefined();
      expect(completions).toEqual([]);
      expect(fixture.child.kill).toHaveBeenCalledTimes(1);
      expect(runner.currentRunId()).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("finishes a fenced cancellation during shutdown after an unconfirmed child closes late", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-cancel-late-close-"));
    const store = new FileExecutionStore(directory);
    const fixture = createK6ProcessFixture();
    const completions: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      cancellationTimeoutMs: 1,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          completions.push(report);
        },
      },
    });
    try {
      await runner.start(startRequest);
      await expect(runner.abort(startRequest.runId)).rejects.toBeInstanceOf(
        TrafficTerminationUnconfirmedError,
      );
      fixture.child.emit("close", null, "SIGKILL");

      await expect(runner.close()).resolves.toBeUndefined();
      expect(await store.read()).toMatchObject({ state: "completed" });
      expect((await store.read())?.completion).toBeUndefined();
      expect(completions).toEqual([]);
      expect(fixture.child.kill).toHaveBeenCalledTimes(2);
      expect(runner.currentRunId()).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares termination and journal release when shutdown races cancellation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-cancel-close-race-"));
    let releaseJournal: () => void = () => undefined;
    const journalGate = new Promise<void>((resolve) => {
      releaseJournal = resolve;
    });
    class GatedCancellationReleaseStore extends FileExecutionStore {
      cancellationReleaseCount = 0;

      override async completeCancellation(runId: string) {
        this.cancellationReleaseCount += 1;
        await journalGate;
        return super.completeCancellation(runId);
      }
    }
    const store = new GatedCancellationReleaseStore(directory);
    const fixture = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      cancellationTimeoutMs: 40,
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    try {
      await runner.start(startRequest);
      const cancellation = runner.abort(startRequest.runId);
      const closing = runner.close();
      expect(fixture.child.kill).toHaveBeenCalledTimes(1);
      fixture.child.emit("close", null, "SIGTERM");
      await waitForCondition(
        () => store.cancellationReleaseCount === 1,
        "cancellation journal release",
      );
      expect(fixture.child.kill).toHaveBeenCalledTimes(1);
      releaseJournal();

      await expect(Promise.all([cancellation, closing])).resolves.toEqual(["aborted", undefined]);
      expect(store.cancellationReleaseCount).toBe(1);
      expect(fixture.child.kill).toHaveBeenCalledTimes(1);
      expect((await store.read())?.completion).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("confirms stopped traffic without waiting for an already-active metric send", async () => {
    const fixture = createK6ProcessFixture();
    let releaseMetrics: () => void = () => undefined;
    const metricGate = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    const sendMetrics = vi.fn(async () => metricGate);
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      metricBatchSize: 1,
      cancellationTimeoutMs: 80,
      apiClient: { sendMetrics, sendCompletion: async () => undefined },
    });
    await runner.start(startRequest);
    fixture.stdout.write(
      `${JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } })}\n`,
    );
    fixture.stdout.write(
      `${JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 1, time: completionTimestamp } })}\n`,
    );
    await waitForCondition(() => sendMetrics.mock.calls.length === 1, "active metric flush");
    const cancellation = runner.abort(startRequest.runId);
    fixture.child.emit("close", null, "SIGTERM");
    const cancellationResult = await Promise.race([
      cancellation,
      new Promise<"timed_out">((resolve) => {
        const timeout = setTimeout(() => resolve("timed_out"), 80);
        timeout.unref();
      }),
    ]);
    expect(cancellationResult).toBe("aborted");
    expect(sendMetrics).toHaveBeenCalledTimes(1);
    releaseMetrics();
    await waitForCondition(() => runner.currentRunId() === null, "cancelled metric cleanup");
  });

  it("joins forced-stop workdir disposition on shutdown without waiting for metric send", async () => {
    const fixture = createK6ProcessFixture();
    let stopRequests = 0;
    vi.mocked(fixture.child.kill).mockImplementation(() => {
      stopRequests += 1;
      Object.assign(fixture.child, { killed: true });
      if (stopRequests > 1) queueMicrotask(() => fixture.child.emit("close", 137));
      return true;
    });
    let releaseMetrics: () => void = () => undefined;
    const metricGate = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    const sendMetrics = vi.fn(async () => metricGate);
    let releaseCleanup: () => void = () => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupStarted = false;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      metricBatchSize: 1,
      cancellationTimeoutMs: 80,
      apiClient: { sendMetrics, sendCompletion: async () => undefined },
      removeWorkDir: async (workDir) => {
        cleanupStarted = true;
        await cleanupGate;
        await rm(workDir, { recursive: true, force: true });
      },
    });
    await runner.start(startRequest);
    fixture.stdout.write(
      `${JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } })}\n`,
    );
    fixture.stdout.write(
      `${JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 1, time: completionTimestamp } })}\n`,
    );
    await waitForCondition(() => sendMetrics.mock.calls.length === 1, "hung metric send");

    await expect(runner.abort(startRequest.runId)).resolves.toBe("aborted");
    let closeSettled = false;
    const closing = runner.close().then(() => {
      closeSettled = true;
    });
    await waitForCondition(() => cleanupStarted, "shutdown workdir disposition");
    expect(closeSettled).toBe(false);

    releaseCleanup();
    await expect(closing).resolves.toBeUndefined();
    expect(sendMetrics).toHaveBeenCalledTimes(1);
    releaseMetrics();
  });

  it("lets ordinary abort observe natural close without waiting for completion work", async () => {
    const fixture = createK6ProcessFixture();
    const completions: TrafficCompletionReport[] = [];
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let releaseDelivery: () => void = () => undefined;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      readSummaryFile: async () => {
        await summaryGate;
        return "{}";
      },
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          completions.push(report);
          await deliveryGate;
        },
      },
    });
    await runner.start(startRequest);
    fixture.child.emit("close", 0);
    const abortResult = await Promise.race([
      runner.abort(startRequest.runId),
      new Promise<"timed_out">((resolve) => {
        const timeout = setTimeout(() => resolve("timed_out"), 40);
        timeout.unref();
      }),
    ]);
    expect(abortResult).toBe("natural_completion");
    expect(completions).toHaveLength(0);
    releaseSummary();
    await waitForCompletionReport(completions, 1);
    expect(completions).toHaveLength(1);
    expect(fixture.child.kill).not.toHaveBeenCalled();
    releaseDelivery();
    await runner.close();
  });

  it("finishes natural result persistence and delivery before shutdown returns", async () => {
    const fixture = createK6ProcessFixture();
    const store = new InMemoryExecutionStore();
    let markSummaryReadStarted: () => void = () => undefined;
    const summaryReadStarted = new Promise<void>((resolve) => {
      markSummaryReadStarted = resolve;
    });
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let markDeliveryStarted: () => void = () => undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    let releaseDelivery: () => void = () => undefined;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let cleanupStarted = false;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      readSummaryFile: async () => {
        markSummaryReadStarted();
        await summaryGate;
        return "{}";
      },
      removeWorkDir: async (workDir) => {
        cleanupStarted = true;
        await rm(workDir, { recursive: true, force: true });
      },
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async () => {
          markDeliveryStarted();
          await deliveryGate;
        },
      },
    });
    await runner.start(startRequest);
    const workDir = path.dirname(getSingleSpawnCall(fixture).scriptPath);
    fixture.child.emit("close", 0);

    let closeSettled = false;
    const closing = runner.close().then(() => {
      closeSettled = true;
    });
    await summaryReadStarted;
    expect(closeSettled).toBe(false);
    expect(cleanupStarted).toBe(false);
    expect(await pathMissing(workDir)).toBe(false);

    releaseSummary();
    await deliveryStarted;
    await waitForCondition(() => pathMissing(workDir), "durable completion workdir cleanup");
    expect(await pathMissing(workDir)).toBe(true);
    expect(await store.read()).toMatchObject({
      state: "completion_pending",
      completion: { status: "succeeded" },
    });
    expect(closeSettled).toBe(false);

    releaseDelivery();
    await expect(closing).resolves.toBeUndefined();
    expect(await store.read()).toMatchObject({
      state: "completed",
      completion: { status: "succeeded" },
    });
    expect(fixture.child.kill).not.toHaveBeenCalled();
  });

  it("retains the execution fence when cancellation cannot confirm reap within its bound", async () => {
    const k6Process = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      cancellationTimeoutMs: 1,
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    await runner.start(startRequest);
    await expect(runner.abort(startRequest.runId)).rejects.toBeInstanceOf(
      TrafficTerminationUnconfirmedError,
    );
    expect(k6Process.child.kill).toHaveBeenCalled();
    expect(runner.currentRunId()).toBe(startRequest.runId);
    await expect(
      runner.start({ ...startRequest, runId: "66666666-6666-4666-8666-666666666666" }),
    ).rejects.toBeInstanceOf(ExecutionSlotConflictError);
  });

  it("shares termination when cancellation races executing-journal publication failure", async () => {
    const fixture = createK6ProcessFixture();
    let stopRequests = 0;
    vi.mocked(fixture.child.kill).mockImplementation(() => {
      stopRequests += 1;
      Object.assign(fixture.child, { killed: true });
      if (stopRequests > 1) queueMicrotask(() => fixture.child.emit("close", 137));
      return true;
    });
    let rejectExecuting: (_error: Error) => void = () => undefined;
    const executingUpdate = new Promise<never>((_resolve, reject) => {
      rejectExecuting = reject;
    });
    const accepted = { request: startRequest, state: "accepted" as const, acceptedAt: timestamp };
    const store = {
      accept: vi.fn(async () => ({ execution: accepted, created: true })),
      read: vi.fn(async () => accepted),
      update: vi.fn((value: { state: string }) =>
        value.state === "executing" ? executingUpdate : Promise.resolve(),
      ),
      completeCancellation: vi.fn(async () => true),
    } as unknown as FileExecutionStore;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      executionStore: store,
      spawnProcess: fixture.spawnProcess,
      cancellationTimeoutMs: 40,
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    const start = runner.start(startRequest);
    await waitForCondition(
      () => vi.mocked(fixture.spawnProcess).mock.calls.length === 1,
      "spawn publication",
    );
    const cancellation = runner.abort(startRequest.runId);
    await waitForCondition(() => stopRequests > 0, "bounded child stop");
    rejectExecuting(new Error("journal failed"));
    await expect(start).rejects.toThrow("journal failed");
    await expect(cancellation).resolves.toBe("aborted");
    await waitForCondition(() => runner.currentRunId() === null, "publication-race cleanup");
  });

  it("preserves natural completion when close wins during executing-journal publication", async () => {
    let releaseExecuting: () => void = () => undefined;
    const executingGate = new Promise<void>((resolve) => {
      releaseExecuting = resolve;
    });
    class GatedExecutingStore extends InMemoryExecutionStore {
      override async update(execution: DurableExecution): Promise<void> {
        if (execution.state === "executing") await executingGate;
        await super.update(execution);
      }
    }
    const fixture = createK6ProcessFixture();
    const reports: TrafficCompletionReport[] = [];
    const store = new GatedExecutingStore();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
    });

    const start = runner.start(startRequest);
    await waitForCondition(
      () => vi.mocked(fixture.spawnProcess).mock.calls.length === 1,
      "gated executing publication",
    );
    const workDir = path.dirname(getSingleSpawnCall(fixture).scriptPath);
    fixture.child.emit("close", 0);
    await expect(runner.abort(startRequest.runId)).resolves.toBe("natural_completion");
    expect(reports).toHaveLength(0);
    expect(await pathMissing(workDir)).toBe(false);

    releaseExecuting();
    await expect(start).resolves.toMatchObject({ plannedRequests: 400 });
    await waitForCompletionReport(reports, 1);
    await waitForCondition(() => pathMissing(workDir), "post-persistence supervisor cleanup");
    expect(reports).toHaveLength(1);
    expect(await store.read()).toMatchObject({
      state: "completed",
      completion: { status: "succeeded" },
    });
  });

  it("durably reports a synchronous spawn preparation failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-spawn-failure-"));
    const store = new FileExecutionStore(directory);
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
      spawnProcess: vi.fn(() => {
        throw new Error("synchronous spawn failure");
      }) as unknown as typeof spawn,
    });
    try {
      await expect(runner.start(startRequest)).rejects.toThrow("synchronous spawn failure");
      await waitForCondition(
        async () => (await store.read())?.state === "completed",
        "preparation completion acknowledgement",
      );
      expect(await store.read()).toMatchObject({
        state: "completed",
        completion: { status: "failed", errorMessage: "synchronous spawn failure" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers accepted state as a failed pending completion before delivery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-recovery-"));
    const store = new FileExecutionStore(directory);
    await store.accept(startRequest, new Date(timestamp));
    let stateDuringDelivery: string | undefined;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      completionDeliveryRetryIntervalMs: 60_000,
      logger: createSilentLogger("load-orchestrator"),
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async () => {
          stateDuringDelivery = (await store.read())?.state;
        },
      },
    });
    try {
      await runner.initialize();
      await waitForCondition(
        async () => (await store.read())?.state === "completed",
        "startup recovery acknowledgement",
      );
      expect(stateDuringDelivery).toBe("completion_pending");
      expect(await store.read()).toMatchObject({
        state: "completed",
        completion: {
          status: "failed",
          errorMessage: "load_orchestrator_restarted_before_k6_completion",
        },
      });
      await runner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares repeated and concurrent startup reconciliation", async () => {
    const store = new InMemoryExecutionStore();
    await store.accept(startRequest, new Date(timestamp));
    const sendCompletion = vi.fn(async () => undefined);
    const logger = createSilentLogger("load-orchestrator");
    const completionDelivery = new CompletionDeliveryCoordinator({
      executionStore: store,
      logger,
      apiClient: { sendCompletion },
    });
    const now = vi.fn(() => new Date(completionTimestamp));
    const runner = new ProductionSpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      completionDelivery,
      logger,
      now,
      apiClient: { sendMetrics: async () => undefined, sendCompletion },
    });

    const first = runner.initialize();
    const concurrent = runner.initialize();
    expect(concurrent).toBe(first);
    await Promise.all([first, concurrent]);
    await runner.initialize();

    expect(now).toHaveBeenCalledTimes(1);
    expect(sendCompletion).toHaveBeenCalledTimes(1);
    expect(await store.read()).toMatchObject({
      state: "completed",
      completion: {
        errorMessage: "load_orchestrator_restarted_before_k6_completion",
      },
    });
    await runner.close();
  });

  it("joins startup delivery before close without creating another attempt", async () => {
    const store = new InMemoryExecutionStore();
    await store.accept(startRequest, new Date(timestamp));
    let releaseDelivery: () => void = () => undefined;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let markDeliveryStarted: () => void = () => undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const sendCompletion = vi.fn(async () => {
      markDeliveryStarted();
      await deliveryGate;
    });
    const logger = createSilentLogger("load-orchestrator");
    const completionDelivery = new CompletionDeliveryCoordinator({
      executionStore: store,
      logger,
      apiClient: { sendCompletion },
      retryIntervalMs: 5,
    });
    const runner = new ProductionSpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      completionDelivery,
      logger,
      now: () => new Date(completionTimestamp),
      apiClient: { sendMetrics: async () => undefined, sendCompletion },
    });

    const initialization = runner.initialize();
    await deliveryStarted;
    let closed = false;
    const closing = runner.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(closed).toBe(false);
    expect(sendCompletion).toHaveBeenCalledTimes(1);

    releaseDelivery();
    await Promise.all([initialization, closing]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendCompletion).toHaveBeenCalledTimes(1);
    expect(await store.read()).toMatchObject({ state: "completed" });
    await expect(runner.initialize()).rejects.toThrow("shutting down");
  });

  it("retains pending recovery delivery after failure and completes on periodic retry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-retry-"));
    const store = new FileExecutionStore(directory);
    await store.accept(startRequest, new Date(timestamp));
    let attempts = 0;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      completionDeliveryRetryIntervalMs: 5,
      logger: createSilentLogger("load-orchestrator"),
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary malformed acknowledgement");
        },
      },
    });
    try {
      await runner.initialize();
      expect(await store.read()).toMatchObject({ state: "completion_pending" });
      await waitForCondition(
        async () => (await store.read())?.state === "completed",
        "pending completion retry acknowledgement",
      );
      expect(attempts).toBeGreaterThanOrEqual(2);
      await runner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes a temporary script, streams parsed metric batches, reports success, and cleans up", async () => {
    const k6Process = createK6ProcessFixture();
    const metricBatches: LoadMetricIngestRequest[] = [];
    const completionReports: TrafficCompletionReport[] = [];
    const apiClient: LoadApiClient = {
      sendMetrics: vi.fn(async (batch) => {
        metricBatches.push(batch);
      }),
      sendCompletion: vi.fn(async (report) => {
        completionReports.push(report);
      }),
    };
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient,
      logger: createSilentLogger("load-orchestrator"),
      now: createClock([timestamp, completionTimestamp]),
      spawnProcess: k6Process.spawnProcess,
    });

    const start = await runner.start(startRequest);
    const spawnCall = getSingleSpawnCall(k6Process);
    const workDir = path.dirname(spawnCall.scriptPath);
    const script = await readFile(spawnCall.scriptPath, "utf8");

    writeK6JsonLines(k6Process.stdout, [
      {
        type: "Point",
        metric: "checkout_attempts_started",
        data: { value: 1, time: timestamp },
      },
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_duration", data: { value: 42, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 0, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_reservation_accepted",
        data: { value: 1, time: timestamp },
      },
    ]);
    const encodedStderr = Buffer.from("prefix-€\r\n", "utf8");
    k6Process.stderr.write(encodedStderr.subarray(0, 8));
    k6Process.stderr.write(encodedStderr.subarray(8));
    await waitForReadline();
    k6Process.child.emit("close", 0);

    const report = await waitForCompletionReport(completionReports, 1);
    await waitForCondition(() => pathMissing(workDir), "k6 temp directory cleanup");

    expect(start).toEqual({ startedAt: new Date(timestamp), plannedRequests: 400 });
    expect(spawnCall.binary).toBe("k6");
    expect(spawnCall.args).toEqual([
      "run",
      "--quiet",
      "--no-usage-report",
      "--summary-export",
      path.join(workDir, "summary.json"),
      "--out",
      "json=-",
      spawnCall.scriptPath,
    ]);
    expect(spawnCall.options).toEqual({
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(script).toContain(
      'export const options = {"discardResponseBodies":true,"systemTags":["scenario"],"scenarios":{"checkout":',
    );
    expect(script).toContain(startRequest.runId);
    expect(apiClient.sendMetrics).toHaveBeenCalledTimes(1);
    expect(metricBatches).toEqual([
      {
        batchId: expect.any(String),
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        samples: [
          {
            metricName: "traffic.attempts_dispatched",
            value: 1,
            unit: "requests",
            timestamp,
          },
          {
            metricName: "traffic.request_arrival_rate",
            value: 1,
            unit: "requests_per_second",
            timestamp,
          },
          {
            metricName: "traffic.response_completion_rate",
            value: 1,
            unit: "requests_per_second",
            timestamp,
          },
          { metricName: "traffic.latency", value: 42, unit: "ms", timestamp },
          { metricName: "traffic.failure_rate", value: 0, unit: "ratio", timestamp },
        ],
        observedAt: expect.any(String),
      },
    ]);
    expect(apiClient.sendCompletion).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      runId: startRequest.runId,
      status: "succeeded",
      exitCode: 0,
      completedAt: completionTimestamp,
      correlationId: startRequest.correlationId,
      transportAttemptCounts: {
        plannedRequests: 400,
        startedRequests: 1,
        completedRequests: 1,
        interruptedRequests: 0,
        unstartedRequests: 399,
      },
      httpSummary: {
        failedRequests: 0,
        acceptedResponses: 1,
        unexpectedResponses: 0,
        failureRate: 0,
      },
      loadRunDiagnosticsSummary: {
        stderrLines: ["prefix-€"],
        stderrLineCountObserved: 1,
      },
      trafficDeliverySummary: {
        requestArrivalSummary: {
          firstAttemptStartedAt: "2026-06-20T12:00:00.000Z",
          peakArrivalRatePerSecond: 1,
          peakArrivalWindowSeconds: 1,
          dispatchDurationSeconds: 0,
          arrivalRateSeries: [{ windowStartedAt: timestamp, ratePerSecond: 1 }],
          arrivalWindowCountObserved: 1,
          arrivalWindowCountRetained: 1,
          arrivalSeriesLimit: 120,
        },
      },
    });
  });

  it("drains split and unterminated stdout and sends the final live window before completion", async () => {
    const k6Process = createK6ProcessFixture();
    const calls: string[] = [];
    const reports: TrafficCompletionReport[] = [];
    let releaseMetrics: () => void = () => undefined;
    const metricsGate = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      now: createClock([timestamp, completionTimestamp]),
      apiClient: {
        sendMetrics: async () => {
          calls.push("metrics");
          await metricsGate;
        },
        sendCompletion: async (report) => {
          calls.push("completion");
          reports.push(report);
        },
      },
    });

    await runner.start(startRequest);
    const finalLine = JSON.stringify({
      type: "Point",
      metric: "http_reqs",
      data: { value: 2, time: timestamp },
    });
    const splitAt = Math.floor(finalLine.length / 2);
    k6Process.stdout.write("not json\n");
    k6Process.stdout.write(finalLine.slice(0, splitAt));
    k6Process.stdout.end(finalLine.slice(splitAt));
    k6Process.child.emit("close", 0);

    await waitForCondition(() => calls.includes("metrics"), "final window metric send");
    expect(calls).toEqual(["metrics"]);
    expect(reports).toEqual([]);
    releaseMetrics();
    const report = await waitForCompletionReport(reports, 1);

    expect(calls).toEqual(["metrics", "completion"]);
    expect(report.transportAttemptCounts.startedRequests).toBe(2);
  });

  it("reports non-zero k6 exits as failed completions and cleans up", async () => {
    const k6Process = createK6ProcessFixture();
    const metricBatches: LoadMetricIngestRequest[] = [];
    const completionReports: TrafficCompletionReport[] = [];
    const apiClient: LoadApiClient = {
      sendMetrics: vi.fn(async (batch) => {
        metricBatches.push(batch);
      }),
      sendCompletion: vi.fn(async (report) => {
        completionReports.push(report);
      }),
    };
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient,
      logger: createSilentLogger("load-orchestrator"),
      now: createClock([timestamp, completionTimestamp]),
      spawnProcess: k6Process.spawnProcess,
    });

    await runner.start(startRequest);
    const spawnCall = getSingleSpawnCall(k6Process);
    const workDir = path.dirname(spawnCall.scriptPath);

    writeK6JsonLines(k6Process.stdout, [
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 1, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_unexpected_responses",
        data: { value: 1, time: timestamp },
      },
      { type: "Point", metric: "dropped_iterations", data: { value: 1, time: timestamp } },
    ]);
    await waitForReadline();
    k6Process.child.emit("close", 23);

    const report = await waitForCompletionReport(completionReports, 1);
    await waitForCondition(() => pathMissing(workDir), "k6 temp directory cleanup");

    expect(apiClient.sendMetrics).toHaveBeenCalledTimes(1);
    expect(metricBatches[0]?.samples.map((sample) => sample.metricName)).toEqual([
      "traffic.response_completion_rate",
      "traffic.failure_rate",
    ]);
    expect(apiClient.sendCompletion).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      runId: startRequest.runId,
      status: "failed",
      exitCode: 23,
      errorMessage: "k6 exited with code 23.",
      completedAt: completionTimestamp,
      transportAttemptCounts: {
        plannedRequests: 400,
        startedRequests: 1,
        completedRequests: 1,
        interruptedRequests: 0,
        unstartedRequests: 399,
      },
      httpSummary: {
        failedRequests: 1,
        unexpectedResponses: 1,
        failureRate: 1,
      },
      trafficDeliverySummary: {
        droppedIterations: 1,
        notes: ["k6_dropped_iterations_observed"],
      },
    });
  });

  it("reports spawn errors once even when close follows error and cleans up", async () => {
    const k6Process = createK6ProcessFixture();
    const completionReports: TrafficCompletionReport[] = [];
    const apiClient: LoadApiClient = {
      sendMetrics: vi.fn(async () => undefined),
      sendCompletion: vi.fn(async (report) => {
        completionReports.push(report);
      }),
    };
    const runner = new SpawnK6Runner({
      k6Binary: "/missing/k6",
      apiClient,
      logger: createSilentLogger("load-orchestrator"),
      now: createClock([timestamp, completionTimestamp]),
      spawnProcess: k6Process.spawnProcess,
    });

    await runner.start(startRequest);
    const spawnCall = getSingleSpawnCall(k6Process);
    const workDir = path.dirname(spawnCall.scriptPath);

    k6Process.child.emit("error", new Error("spawn /missing/k6 ENOENT"));
    k6Process.child.emit("close", -2);

    const report = await waitForCompletionReport(completionReports, 1);
    await waitForCondition(() => pathMissing(workDir), "k6 temp directory cleanup");
    await waitForReadline();

    expect(apiClient.sendMetrics).not.toHaveBeenCalled();
    expect(apiClient.sendCompletion).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      runId: startRequest.runId,
      status: "failed",
      errorMessage: "spawn /missing/k6 ENOENT",
      completedAt: completionTimestamp,
      transportAttemptCounts: {
        plannedRequests: 400,
        startedRequests: 0,
        completedRequests: 0,
        interruptedRequests: 0,
        unstartedRequests: 400,
      },
      httpSummary: {
        failedRequests: 0,
      },
    });
    expect(report).not.toHaveProperty("exitCode");
  });

  it("retains child ownership after error until close proves the process exited", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-owner-"));
    const k6Process = createK6ProcessFixture();
    const reports: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      executionStore: new FileExecutionStore(directory),
    });
    try {
      await runner.start(startRequest);
      await expect(runner.start(startRequest)).resolves.toMatchObject({ plannedRequests: 400 });
      expect(k6Process.spawnProcess).toHaveBeenCalledTimes(1);
      k6Process.child.emit("error", new Error("spawn error after child creation"));
      await waitForReadline();
      expect(reports).toHaveLength(0);
      await expect(
        runner.start({ ...startRequest, runId: "66666666-6666-4666-8666-666666666666" }),
      ).rejects.toThrow("still owns");
      k6Process.child.emit("close", 1);
      await waitForCompletionReport(reports, 1);
      await waitForCondition(
        async () => (await runner.statusSnapshot(startRequest.runId)).state === "completed",
        "durable child completion",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates and reaps a spawned child when executing-state publication fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-publication-failure-"));
    class FailExecutingUpdateOnceStore extends FileExecutionStore {
      private shouldFail = true;
      override async update(execution: Parameters<FileExecutionStore["update"]>[0]) {
        if (execution.state === "executing" && this.shouldFail) {
          this.shouldFail = false;
          throw new Error("executing publication unavailable");
        }
        return super.update(execution);
      }
    }
    const store = new FailExecutingUpdateOnceStore(directory);
    const first = createK6ProcessFixture();
    const second = createK6ProcessFixture();
    Object.assign(first.child, {
      kill: vi.fn(() => {
        Object.assign(first.child, { killed: true });
        queueMicrotask(() => first.child.emit("close", 143));
        return true;
      }),
    });
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as typeof spawn;
    const reports: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
    });
    const successor = {
      ...startRequest,
      runId: "66666666-6666-4666-8666-666666666666",
    };
    try {
      await expect(runner.start(startRequest)).rejects.toThrow("executing publication unavailable");
      expect(first.child.kill).toHaveBeenCalled();
      await waitForCompletionReport(reports, 1);
      await waitForCondition(
        async () => (await store.read())?.state === "completed",
        "publication-failure completion acknowledgement",
      );
      expect(await store.read()).toMatchObject({ state: "completed" });

      await expect(runner.start(successor)).resolves.toMatchObject({ plannedRequests: 400 });
      expect(spawnProcess).toHaveBeenCalledTimes(2);
      second.child.emit("close", 0);
      await waitForCondition(async () => {
        const execution = await store.read();
        return execution?.request.runId === successor.runId && execution.state === "completed";
      }, "successor execution completion");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("joins a concurrent replay to the live preparation without spawning twice", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-concurrent-prepare-"));
    let releaseAcceptance: () => void = () => undefined;
    const acceptanceGate = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    class GatedAcceptStore extends FileExecutionStore {
      override async accept(...args: Parameters<FileExecutionStore["accept"]>) {
        const accepted = await super.accept(...args);
        await acceptanceGate;
        return accepted;
      }
    }
    const k6Process = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: new GatedAcceptStore(directory),
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    try {
      const first = runner.start(startRequest);
      const replay = runner.start(startRequest);
      releaseAcceptance();
      await expect(Promise.all([first, replay])).resolves.toHaveLength(2);
      expect(k6Process.spawnProcess).toHaveBeenCalledTimes(1);
      k6Process.child.emit("close", 0);
      await waitForCondition(
        async () => (await new FileExecutionStore(directory).read())?.state === "completed",
        "concurrent preparation completion",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves failed preparation persistence visible for startup reconciliation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-prepare-replay-"));
    class FailingCompletionStore extends FileExecutionStore {
      failCompletionUpdates = true;
      override async publishCompletion(
        report: Parameters<FileExecutionStore["publishCompletion"]>[0],
      ) {
        if (this.failCompletionUpdates) throw new Error("completion journal unavailable");
        return super.publishCompletion(report);
      }
    }
    const store = new FailingCompletionStore(directory);
    const reports: TrafficCompletionReport[] = [];
    const spawnProcess = vi.fn(() => {
      throw new Error("synchronous preparation failure");
    }) as unknown as typeof spawn;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
    });
    try {
      await expect(runner.start(startRequest)).rejects.toThrow("completion journal unavailable");
      expect(await store.read()).toMatchObject({ state: "accepted" });
      await expect(runner.start(startRequest)).rejects.toThrow("completion journal unavailable");
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      expect(reports).toHaveLength(0);
      await expect(runner.close()).rejects.toThrow("completion journal unavailable");

      store.failCompletionUpdates = false;
      const restarted = new SpawnK6Runner({
        k6Binary: "k6",
        executionStore: store,
        logger: createSilentLogger("load-orchestrator"),
        spawnProcess,
        apiClient: {
          sendMetrics: async () => undefined,
          sendCompletion: async (report) => {
            reports.push(report);
          },
        },
      });
      await restarted.initialize();
      await waitForCompletionReport(reports, 1);
      await waitForCondition(
        async () => (await store.read())?.state === "completed",
        "restart-produced preparation completion",
      );
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      expect(reports).toHaveLength(1);
      expect(await store.read()).toMatchObject({
        state: "completed",
        completion: {
          status: "failed",
          errorMessage: "load_orchestrator_restarted_before_k6_completion",
        },
      });
      await expect(restarted.close()).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels live preparation without waiting for its pending acceptance call", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-prepare-shutdown-"));
    let releaseAcceptance: () => void = () => undefined;
    const acceptanceGate = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    class GatedAcceptStore extends FileExecutionStore {
      override async accept(...args: Parameters<FileExecutionStore["accept"]>) {
        const accepted = await super.accept(...args);
        await acceptanceGate;
        return accepted;
      }
    }
    const store = new GatedAcceptStore(directory);
    const reports: TrafficCompletionReport[] = [];
    const k6Process = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
    });
    try {
      const start = runner.start(startRequest);
      let closed = false;
      const closing = runner.close().then(() => {
        closed = true;
      });
      await waitForCondition(() => closed, "bounded preparation cancellation");
      expect(k6Process.spawnProcess).not.toHaveBeenCalled();
      releaseAcceptance();
      await expect(start).rejects.toThrow("cancelled during preparation");
      await expect(closing).resolves.toBeUndefined();
      expect(k6Process.spawnProcess).not.toHaveBeenCalled();
      expect(reports).toHaveLength(0);
      expect(await store.read()).toMatchObject({ state: "completed" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for an already-signaled child to close during shutdown", async () => {
    const k6Process = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      cancellationTimeoutMs: 40,
    });
    await runner.start(startRequest);
    k6Process.child.kill("SIGTERM");
    let closed = false;
    const closing = runner.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(closed).toBe(false);
    k6Process.child.emit("close", 1);
    await closing;
  });

  it("fails shutdown when child exit cannot be observed within the cancellation bound", async () => {
    const k6Process = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      cancellationTimeoutMs: 4,
    });
    await runner.start(startRequest);
    await expect(runner.close()).rejects.toThrow("Could not confirm");
    expect(k6Process.child.kill).toHaveBeenCalled();
  });

  it("acknowledges forced-stop reap within the bound and cleans up afterward", async () => {
    const k6Process = createK6ProcessFixture();
    let stopRequests = 0;
    const kill = vi.fn(() => {
      stopRequests += 1;
      Object.assign(k6Process.child, { killed: true });
      if (stopRequests > 1) queueMicrotask(() => k6Process.child.emit("close", 137));
      return true;
    });
    Object.assign(k6Process.child, { kill });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      cancellationTimeoutMs: 80,
    });
    await runner.start(startRequest);
    const workDir = path.dirname(getSingleSpawnCall(k6Process).scriptPath);
    const startedAt = performance.now();
    await expect(runner.abort(startRequest.runId)).resolves.toBe("aborted");
    expect(performance.now() - startedAt).toBeLessThan(80);
    await waitForCondition(() => runner.currentRunId() === null, "forced-stop cleanup");
    expect(await pathMissing(workDir)).toBe(true);
  });

  it("keeps persistence failure visible without an in-memory fallback or workdir cleanup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-store-recovery-"));
    class FailingStore extends FileExecutionStore {
      failUpdates = false;
      override async publishCompletion(
        report: Parameters<FileExecutionStore["publishCompletion"]>[0],
      ) {
        if (this.failUpdates) throw new Error("store unavailable");
        return super.publishCompletion(report);
      }
    }
    const store = new FailingStore(directory);
    const k6Process = createK6ProcessFixture();
    const sendCompletion = vi.fn(async () => undefined);
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      apiClient: { sendMetrics: async () => undefined, sendCompletion },
    });
    try {
      await runner.start(startRequest);
      const workDir = path.dirname(getSingleSpawnCall(k6Process).scriptPath);
      store.failUpdates = true;
      k6Process.child.emit("close", 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await expect(runner.close()).rejects.toThrow("store unavailable");
      expect(await store.read()).toMatchObject({ state: "executing" });
      expect(sendCompletion).not.toHaveBeenCalled();
      expect(await pathMissing(workDir)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries a timed-out completion with a fresh request signal", async () => {
    const k6Process = createK6ProcessFixture();
    const signals: AbortSignal[] = [];
    let accepted: () => void = () => undefined;
    const acceptedPromise = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.signal) signals.push(init.signal);
      if (signals.length === 1) return new Promise<Response>(() => undefined);
      accepted();
      return new Response(
        JSON.stringify({
          runId: startRequest.runId,
          acknowledged: true,
          correlationId: startRequest.correlationId,
        }),
        { status: 202 },
      );
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      apiClient: new HttpLoadApiClient({
        apiBaseUrl: "http://api.test",
        controlServiceToken: "test-token",
        requestTimeoutMs: 5,
        fetch: fetchMock,
      }),
      completionDeliveryRetryIntervalMs: 1,
    });

    await runner.start(startRequest);
    k6Process.child.emit("close", 0);
    await acceptedPromise;
    await runner.close();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(signals[1]).not.toBe(signals[0]);
  });

  it("stops resource sampling before normal completion serialization", async () => {
    const resource = await supervisedResourceSamplerFixture();
    resource.process.child.emit("close", 0);

    const result = await resource.execution.completion;

    expect(resource.stop).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      outcome: "completed",
      report: { loadRunDiagnosticsSummary: { generatorUtilisation: generatorUtilisationFixture } },
    });
    expect(resource.startSampler).toHaveBeenCalledWith({
      pid: 42,
      effectiveCpuCores: 1.5,
    });
    await resource.supervisor.release(startRequest.runId);

    const fallback = await supervisedResourceSamplerFixture({ cgroupCpuQuota: null });
    fallback.process.child.emit("close", 0);
    await fallback.execution.completion;
    expect(fallback.startSampler).toHaveBeenCalledWith({ pid: 42, effectiveCpuCores: 8 });
    await fallback.supervisor.release(startRequest.runId);

    const unknown = await supervisedResourceSamplerFixture({ cgroupCpuQuota: "unknown" });
    unknown.process.child.emit("close", 0);
    await unknown.execution.completion;
    expect(unknown.startSampler).toHaveBeenCalledWith({ pid: 42, effectiveCpuCores: null });
    await unknown.supervisor.release(startRequest.runId);
  });

  it.each([
    {
      name: "when cancellation is accepted",
      entry: "cancel" as const,
      expectImmediateStop: true,
      release: false,
    },
    {
      name: "on preparation failure",
      entry: "stopForPreparationFailure" as const,
      expectImmediateStop: false,
      release: true,
    },
  ])("stops resource sampling $name", async ({ entry, expectImmediateStop, release }) => {
    const resource = await supervisedResourceSamplerFixture();
    const cancellation = resource.supervisor[entry](startRequest.runId);
    if (expectImmediateStop) {
      expect(resource.stop).toHaveBeenCalledOnce();
    }
    resource.process.child.emit("close", null, "SIGTERM");

    await expect(cancellation).resolves.toBe("aborted");
    await expect(resource.execution.completion).resolves.toEqual({ outcome: "cancelled" });
    expect(resource.stop).toHaveBeenCalledOnce();
    if (release) {
      await resource.supervisor.release(startRequest.runId);
    }
  });

  it("stops resource sampling during supervisor close", async () => {
    const resource = await supervisedResourceSamplerFixture();
    vi.mocked(resource.process.child.kill).mockImplementationOnce(() => {
      queueMicrotask(() => resource.process.child.emit("close", null, "SIGTERM"));
      return true;
    });

    await expect(resource.supervisor.close()).resolves.toBeUndefined();
    expect(resource.stop).toHaveBeenCalledOnce();
  });

  it("stops resource sampling before unconfirmed termination is reported", async () => {
    const resource = await supervisedResourceSamplerFixture({ cancellationTimeoutMs: 1 });

    await expect(resource.supervisor.cancel(startRequest.runId)).rejects.toBeInstanceOf(
      TrafficTerminationUnconfirmedError,
    );
    expect(resource.stop).toHaveBeenCalledOnce();

    resource.process.child.emit("close", null, "SIGKILL");
    await expect(resource.execution.completion).resolves.toEqual({ outcome: "cancelled" });
  });

  it("keeps sampler start and stop failures advisory", async () => {
    const startFailure = await supervisedResourceSamplerFixture({
      startSampler: () => {
        throw new Error("sampler unavailable");
      },
    });
    startFailure.process.child.emit("close", 0);
    await expect(startFailure.execution.completion).resolves.toMatchObject({
      outcome: "completed",
      report: { loadRunDiagnosticsSummary: { generatorUtilisation: null } },
    });
    await startFailure.supervisor.release(startRequest.runId);

    const stopFailure = await supervisedResourceSamplerFixture({
      stop: () => {
        throw new Error("sample unavailable");
      },
    });
    stopFailure.process.child.emit("close", 0);
    await expect(stopFailure.execution.completion).resolves.toMatchObject({
      outcome: "completed",
      report: { loadRunDiagnosticsSummary: { generatorUtilisation: null } },
    });
    await stopFailure.supervisor.release(startRequest.runId);
  });
});

const generatorUtilisationFixture = {
  peakK6RssBytes: 100,
  peakCgroupMemoryBytes: 200,
  minimumHostMemAvailableBytes: 300,
  peakCpuUtilisationPercent: 75,
  meanCpuUtilisationPercent: 50,
  peakCgroupSwapBytes: 0,
  finalMemoryEventsHighCount: 0,
  finalMemoryEventsMaxCount: 0,
  finalMemoryEventsOomKillCount: 0,
  sampleCount: 2,
  effectiveIntervalMs: 1_000,
} as const;

async function supervisedResourceSamplerFixture(
  options: {
    cancellationTimeoutMs?: number;
    cgroupCpuQuota?: number | null | "unknown";
    startSampler?: () => { stop(): typeof generatorUtilisationFixture };
    stop?: () => typeof generatorUtilisationFixture;
  } = {},
) {
  const process = createK6ProcessFixture();
  Object.assign(process.child, { pid: 42 });
  const stop = vi.fn(options.stop ?? (() => generatorUtilisationFixture));
  const startSampler = vi.fn(options.startSampler ?? (() => ({ stop })));
  const generated = generateK6Script(startRequest);
  const cgroupCpuQuota =
    options.cgroupCpuQuota === null
      ? "max 100000"
      : options.cgroupCpuQuota === "unknown"
        ? null
        : `${(options.cgroupCpuQuota ?? 1.5) * 100_000} 100000`;
  const diagnostics = await collectLoadRunDiagnostics("k6", generated.executionPlan, {
    runCommand: async (command) => (command === "nproc" ? "8" : null),
    readText: diagnosticReader(
      cgroupCpuQuota === null ? {} : { "/sys/fs/cgroup/cpu.max": cgroupCpuQuota },
    ),
  });
  const supervisor = new K6ChildProcessSupervisor({
    k6Binary: "k6",
    logger: createSilentLogger("load-orchestrator"),
    spawnProcess: process.spawnProcess,
    cancellationTimeoutMs: options.cancellationTimeoutMs ?? 40,
    apiClient: { sendMetrics: async () => undefined },
    readSummaryFile: async () => "{}",
    startGeneratorResourceSampler: startSampler,
  });
  const execution = await supervisor.start({
    request: startRequest,
    script: generated.contents,
    startedAt: new Date(timestamp),
    plannedRequests: generated.plannedRequests,
    executionPlan: generated.executionPlan,
    diagnostics,
  });
  return { process, stop, startSampler, supervisor, execution };
}

function createK6ProcessFixture(): {
  child: ReturnType<typeof spawn>;
  stdout: PassThrough;
  stderr: PassThrough;
  spawnProcess: typeof spawn;
} {
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(function (this: ReturnType<typeof spawn>) {
    Object.assign(this, { killed: true });
    return true;
  });

  Object.assign(child, { stdout, stderr, killed: false, kill });
  child.on("close", () => {
    stdout.end();
    stderr.end();
  });

  return {
    child,
    stdout,
    stderr,
    spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
  };
}

function createClock(isoTimestamps: string[]): () => Date {
  let index = 0;
  return () => {
    const value = isoTimestamps[Math.min(index, isoTimestamps.length - 1)] ?? timestamp;
    index += 1;
    return new Date(value);
  };
}

function writeK6JsonLines(stdout: PassThrough, points: unknown[]): void {
  stdout.write(`${points.map((point) => JSON.stringify(point)).join("\n")}\n`);
}

function getSingleSpawnCall(k6Process: ReturnType<typeof createK6ProcessFixture>): {
  binary: string;
  args: string[];
  options: unknown;
  scriptPath: string;
} {
  const call = vi.mocked(k6Process.spawnProcess).mock.calls[0];
  if (!call) {
    throw new Error("Expected k6 process to be spawned.");
  }

  const binary = call[0];
  const args = call[1];
  if (typeof binary !== "string" || !Array.isArray(args)) {
    throw new Error("Expected k6 spawn call to use string binary and argument list.");
  }

  const scriptPath = args.at(-1);
  if (typeof scriptPath !== "string") {
    throw new Error("Expected k6 spawn call to include the generated script path.");
  }

  return { binary, args: [...args], options: call[2], scriptPath };
}

async function waitForCompletionReport(
  reports: TrafficCompletionReport[],
  count: number,
): Promise<TrafficCompletionReport> {
  await waitForCondition(
    () => reports.length >= count,
    `traffic completion report ${count} to be sent`,
  );

  const report = reports[count - 1];
  if (!report) {
    throw new Error(`Expected traffic completion report ${count}.`);
  }

  return report;
}

async function pathMissing(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return false;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return true;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function waitForReadline(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
