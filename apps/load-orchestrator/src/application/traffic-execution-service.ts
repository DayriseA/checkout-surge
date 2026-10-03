import { randomUUID } from "node:crypto";
import {
  type RunnerIdentity,
  type TrafficExecutionAbortRequest,
  type TrafficExecutionAbortResponse,
  type TrafficExecutionStartRequest,
  type TrafficExecutionStartResponse,
  trafficExecutionAbortResponseSchema,
  trafficExecutionStartResponseSchema,
} from "@checkout-surge/contracts";
import type { K6Runner } from "./k6-runner.js";

export const processBootId = randomUUID();
export const processBootStartedAt = Date.now();

export class TrafficExecutionService {
  private draining = false;
  private startsInFlight = 0;
  private startGeneration = 0;
  lastActivityAt = Date.now();
  constructor(
    private readonly runner: K6Runner,
    readonly identity: RunnerIdentity = { bootId: processBootId, version: "unknown" },
  ) {}

  get admissionGeneration(): number {
    return this.startGeneration;
  }

  hasExecution(): boolean {
    return this.startsInFlight > 0 || this.runner.currentRunId() !== null;
  }

  beginDrain(): void {
    this.draining = true;
  }
  currentRunId(): string | null {
    return this.runner.currentRunId();
  }

  async start(input: TrafficExecutionStartRequest): Promise<TrafficExecutionStartResponse> {
    if (input.expectedBootId !== this.identity.bootId)
      throw new RunnerBootMismatchError(this.identity.bootId);
    if (this.draining) throw new RunnerStoppingError();
    this.startGeneration++;
    this.startsInFlight++;
    try {
      const started = await this.runner.start(input);

      return trafficExecutionStartResponseSchema.parse({
        runId: input.runId,
        status: "active",
        startedAt: started.startedAt.toISOString(),
        correlationId: input.correlationId,
      });
    } finally {
      this.startsInFlight--;
      this.lastActivityAt = Date.now();
    }
  }

  async abortCurrent(
    input: TrafficExecutionAbortRequest & { correlationId: string },
  ): Promise<TrafficExecutionAbortResponse> {
    const currentRunId = this.runner.currentRunId();
    if (!currentRunId)
      return trafficExecutionAbortResponseSchema.parse({
        outcome: "no_current_run",
        ...(input.runId ? { requestedRunId: input.runId } : {}),
        observedAt: new Date().toISOString(),
        correlationId: input.correlationId,
      });
    if (input.runId && input.runId !== currentRunId)
      throw new TrafficAbortConflictError(currentRunId);
    const result = await this.runner.abort(currentRunId, {
      ...(input.reason ? { reason: input.reason } : {}),
      correlationId: input.correlationId,
    });
    if (result === "natural_completion") {
      return trafficExecutionAbortResponseSchema.parse({
        outcome: "no_current_run",
        ...(input.runId ? { requestedRunId: input.runId } : {}),
        observedAt: new Date().toISOString(),
        correlationId: input.correlationId,
      });
    }
    return trafficExecutionAbortResponseSchema.parse({
      outcome: "current_run_aborted",
      ...(input.runId ? { requestedRunId: input.runId } : {}),
      abortedRunId: currentRunId,
      observedAt: new Date().toISOString(),
      correlationId: input.correlationId,
    });
  }

  statusSnapshot(runId: string) {
    return this.runner.statusSnapshot(runId);
  }

  async initialize(): Promise<void> {
    await this.runner.initialize();
  }

  async close(): Promise<void> {
    await this.runner.close();
  }
}

export class TrafficAbortConflictError extends Error {
  constructor(readonly currentRunId: string) {
    super(`Traffic execution ${currentRunId} does not match the requested run.`);
  }
}

export class RunnerBootMismatchError extends Error {
  constructor(readonly bootId: string) {
    super("The expected runner boot ID does not match this process.");
  }
}
export class RunnerStoppingError extends Error {
  constructor() {
    super("The runner is shutting down and cannot accept traffic.");
  }
}
