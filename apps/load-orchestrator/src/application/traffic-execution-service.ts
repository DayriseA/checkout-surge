import {
  type TrafficExecutionStartRequest,
  type TrafficExecutionStartResponse,
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
