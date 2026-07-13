import {
  type TrafficExecutionAbortRequest,
  type TrafficExecutionAbortResponse,
  type TrafficExecutionStartRequest,
  type TrafficExecutionStartResponse,
  trafficExecutionAbortResponseSchema,
  trafficExecutionStartResponseSchema,
} from "@checkout-surge/contracts";
import type { K6Runner } from "./k6-runner.js";

export class TrafficExecutionService {
  constructor(private readonly runner: K6Runner) {}

  async start(input: TrafficExecutionStartRequest): Promise<TrafficExecutionStartResponse> {
    const started = await this.runner.start(input);

    return trafficExecutionStartResponseSchema.parse({
      runId: input.runId,
      status: "active",
      startedAt: started.startedAt.toISOString(),
      correlationId: input.correlationId,
    });
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
