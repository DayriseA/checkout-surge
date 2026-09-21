import { isDeepStrictEqual } from "node:util";
import type {
  TrafficCompletionReport,
  TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { LoadApiHttpError } from "../src/application/api-client.js";
import {
  CompletionDeliveryCoordinator,
  CompletionPersistenceError,
} from "../src/application/completion-delivery-coordinator.js";
import {
  type CompletionPublishOutcome,
  type CompletionRejection,
  type DurableExecution,
  ExecutionConflictError,
  type ExecutionStore,
  withCompletion,
} from "../src/application/execution-store.js";
import { K6RunAccumulator } from "../src/application/k6-output-parser.js";
import { generateK6Script } from "../src/application/k6-script.js";

const acceptedAt = new Date("2026-07-23T09:00:00.000Z");
const request: TrafficExecutionStartRequest = {
  runId: "55555555-5555-4555-8555-555555555555",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  apiBaseUrl: "http://localhost:4000",
  correlationId: "corr-completion-delivery",
  configSnapshot: {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 2,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 5,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 2,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 10,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 1,
      pendingPersistenceRetryAfterSeconds: 1,
    },
  },
};

class MemoryExecutionStore implements ExecutionStore {
  execution: DurableExecution | null = null;
  private mutationChain = Promise.resolve();

  async read(): Promise<DurableExecution | null> {
    return this.execution;
  }

  async accept(input: TrafficExecutionStartRequest, at: Date) {
    return this.mutate(async () => {
      if (
        this.execution?.state === "completion_rejected" &&
        this.execution.request.runId === input.runId
      ) {
        return { execution: this.execution, created: false };
      }
      if (
        this.execution &&
        this.execution.state !== "completed" &&
        this.execution.state !== "completion_rejected"
      ) {
        if (this.execution.request.runId === input.runId) {
          return { execution: this.execution, created: false };
        }
        throw new ExecutionConflictError(this.execution.request.runId);
      }
      this.execution = {
        request: input,
        state: "accepted",
        acceptedAt: at.toISOString(),
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
        return isDeepStrictEqual(this.execution.completion, report)
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
        !isDeepStrictEqual(this.execution.completion, report)
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
        !isDeepStrictEqual(this.execution.completion, report)
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

describe("CompletionDeliveryCoordinator", () => {
  it("persists before sending and marks completed only after acknowledgement", async () => {
    const store = new MemoryExecutionStore();
    await store.accept(request, acceptedAt);
    let stateDuringSend: DurableExecution["state"] | undefined;
    const coordinator = new CompletionDeliveryCoordinator({
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      apiClient: {
        sendCompletion: async () => {
          stateDuringSend = (await store.read())?.state;
        },
      },
    });

    await coordinator.start();
    await coordinator.persist(completionReport());
    await waitForState(store, "completed");

    expect(stateDuringSend).toBe("completion_pending");
    expect(store.execution).toMatchObject({ state: "completed" });
    await coordinator.close();
  });

  it("serializes normal and duplicate wakeups behind one active delivery", async () => {
    const store = new MemoryExecutionStore();
    const accepted = (await store.accept(request, acceptedAt)).execution;
    const report = completionReport();
    await store.update(withCompletion(accepted, report));
    let releaseSend: () => void = () => undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendCompletion = vi.fn(async () => sendGate);
    const coordinator = new CompletionDeliveryCoordinator({
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      apiClient: { sendCompletion },
      retryIntervalMs: 1,
    });

    const startupDelivery = coordinator.start();
    await waitForAttempts(sendCompletion, 1);
    await coordinator.persist(report);
    void coordinator.start();
    expect(sendCompletion).toHaveBeenCalledTimes(1);

    releaseSend();
    await startupDelivery;
    await waitForState(store, "completed");
    expect(sendCompletion).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it("retries the same durable report after a transient failure", async () => {
    const store = new MemoryExecutionStore();
    await store.accept(request, acceptedAt);
    const reports: TrafficCompletionReport[] = [];
    const coordinator = new CompletionDeliveryCoordinator({
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      retryIntervalMs: 1,
      apiClient: {
        sendCompletion: async (report) => {
          reports.push(report);
          if (reports.length === 1) {
            throw new LoadApiHttpError("API load ingestion failed with HTTP 503.", 503);
          }
        },
      },
    });

    await coordinator.start();
    await coordinator.persist(completionReport());
    await waitForState(store, "completed");

    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual(reports[0]);
    await coordinator.close();
  });

  it.each([408, 429])("keeps retrying completion delivery after HTTP %i", async (status) => {
    const store = new MemoryExecutionStore();
    await store.accept(request, acceptedAt);
    const sendCompletion = vi.fn(async () => {
      if (sendCompletion.mock.calls.length === 1) {
        throw new LoadApiHttpError(`API load ingestion failed with HTTP ${status}.`, status);
      }
    });
    const coordinator = new CompletionDeliveryCoordinator({
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      retryIntervalMs: 1,
      apiClient: { sendCompletion },
    });

    await coordinator.start();
    await coordinator.persist(completionReport());
    await waitForState(store, "completed");

    expect(sendCompletion).toHaveBeenCalledTimes(2);
    await coordinator.close();
  });

  it("parks a permanently rejected report, stops retrying, and releases the slot", async () => {
    const store = new MemoryExecutionStore();
    await store.accept(request, acceptedAt);
    const sendCompletion = vi.fn(async () => {
      throw new LoadApiHttpError("API load ingestion failed with HTTP 409.", 409);
    });
    const logger = createSilentLogger("load-orchestrator");
    const logError = vi.spyOn(logger, "error");
    const coordinator = new CompletionDeliveryCoordinator({
      executionStore: store,
      logger,
      retryIntervalMs: 1,
      apiClient: { sendCompletion },
    });

    await coordinator.start();
    await coordinator.persist(completionReport());
    await waitForState(store, "completion_rejected");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sendCompletion).toHaveBeenCalledOnce();
    expect(store.execution).toMatchObject({
      state: "completion_rejected",
      completion: completionReport(),
      rejection: {
        reason: "API load ingestion failed with HTTP 409.",
        httpStatus: 409,
        rejectedAt: expect.any(String),
      },
    });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        rejection: expect.objectContaining({ httpStatus: 409 }),
      }),
      expect.stringContaining("permanently abandoned"),
    );
    await expect(coordinator.close()).resolves.toBeUndefined();

    const successor = {
      ...request,
      runId: "66666666-6666-4666-8666-666666666666",
    };
    await expect(store.accept(successor, new Date())).resolves.toMatchObject({ created: true });
  });

  it("does not overwrite successor state when acknowledgement becomes stale", async () => {
    const successorRequest = {
      ...request,
      runId: "66666666-6666-4666-8666-666666666666",
    };
    class SuccessorOnAcknowledgementStore extends MemoryExecutionStore {
      override async acknowledgeCompletion(report: TrafficCompletionReport): Promise<boolean> {
        this.execution = {
          request: successorRequest,
          state: "accepted",
          acceptedAt: "2026-07-23T09:01:00.000Z",
        };
        return super.acknowledgeCompletion(report);
      }
    }
    const store = new SuccessorOnAcknowledgementStore();
    const accepted = (await store.accept(request, acceptedAt)).execution;
    await store.update(withCompletion(accepted, completionReport()));
    const sendCompletion = vi.fn(async () => undefined);
    const coordinator = new CompletionDeliveryCoordinator({
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      retryIntervalMs: 100,
      apiClient: { sendCompletion },
    });

    await coordinator.start();
    await coordinator.close();

    expect(sendCompletion).toHaveBeenCalledTimes(1);
    expect(store.execution).toEqual({
      request: successorRequest,
      state: "accepted",
      acceptedAt: "2026-07-23T09:01:00.000Z",
    });
  });

  it("atomically selects one concurrent completion and rejects conflicting evidence", async () => {
    const store = new MemoryExecutionStore();
    await store.accept(request, acceptedAt);
    const first = completionReport();
    const conflicting: TrafficCompletionReport = {
      ...first,
      status: "failed",
      errorMessage: "conflicting terminal evidence",
    };
    const coordinator = new CompletionDeliveryCoordinator({
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      apiClient: { sendCompletion: async () => undefined },
    });

    const results = await Promise.allSettled([
      coordinator.persist(first),
      coordinator.persist(conflicting),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.any(CompletionPersistenceError),
    });
    expect(store.execution).toMatchObject({
      state: "completion_pending",
      completion: first,
    });
    await coordinator.close();
  });

  it("stops scheduled redelivery without starting a shutdown competitor", async () => {
    const store = new MemoryExecutionStore();
    const accepted = (await store.accept(request, acceptedAt)).execution;
    await store.update(withCompletion(accepted, completionReport()));
    const sendCompletion = vi.fn(async () => {
      throw new Error("API unavailable");
    });
    const coordinator = new CompletionDeliveryCoordinator({
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      retryIntervalMs: 10,
      apiClient: { sendCompletion },
    });

    await coordinator.start();
    await waitForAttempts(sendCompletion, 2);
    await coordinator.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendCompletion).toHaveBeenCalledTimes(2);
    expect(store.execution).toMatchObject({ state: "completion_pending" });
  });
});

function completionReport(): TrafficCompletionReport {
  const generated = generateK6Script(request);
  return new K6RunAccumulator({
    runId: request.runId,
    correlationId: request.correlationId,
    plannedRequests: generated.plannedRequests,
    startedAt: acceptedAt,
    executionPlan: generated.executionPlan,
  }).completionReport({
    status: "succeeded",
    completedAt: new Date("2026-07-23T09:00:05.000Z"),
  });
}

async function waitForState(
  store: MemoryExecutionStore,
  expected: DurableExecution["state"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await store.read())?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for execution state ${expected}.`);
}

async function waitForAttempts(mock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mock.mock.calls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${count} delivery attempts.`);
}
