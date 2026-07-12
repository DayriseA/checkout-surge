import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type TrafficCompletionReport,
  type TrafficExecutionStartRequest,
  trafficCompletionReportSchema,
  trafficExecutionStartRequestSchema,
} from "@checkout-surge/contracts";
import { z } from "zod";

const durableExecutionSchema = z
  .object({
    request: trafficExecutionStartRequestSchema,
    state: z.enum(["accepted", "executing", "completion_pending", "completed"]),
    acceptedAt: z.string().datetime({ offset: true }),
    completion: trafficCompletionReportSchema.optional(),
  })
  .strict();

export type DurableExecution = z.infer<typeof durableExecutionSchema>;

/** Atomic single-slot journal. The orchestrator deliberately owns at most one execution. */
export class FileExecutionStore {
  private readonly filePath: string;
  private writeChain = Promise.resolve();
  private acceptChain = Promise.resolve();

  constructor(directory: string) {
    this.filePath = path.join(directory, "execution.json");
  }

  async read(): Promise<DurableExecution | null> {
    try {
      return durableExecutionSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async accept(
    request: TrafficExecutionStartRequest,
    acceptedAt: Date,
  ): Promise<{ execution: DurableExecution; created: boolean }> {
    const operation = this.acceptChain.then(() => this.acceptOnce(request, acceptedAt));
    this.acceptChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async acceptOnce(
    request: TrafficExecutionStartRequest,
    acceptedAt: Date,
  ): Promise<{ execution: DurableExecution; created: boolean }> {
    const current = await this.read();
    if (current && current.state !== "completed") {
      if (current.request.runId === request.runId) return { execution: current, created: false };
      throw new ExecutionConflictError(current.request.runId);
    }
    const execution: DurableExecution = {
      request: trafficExecutionStartRequestSchema.parse(request),
      state: "accepted",
      acceptedAt: acceptedAt.toISOString(),
    };
    await this.write(execution);
    return { execution, created: true };
  }

  async update(execution: DurableExecution): Promise<void> {
    await this.write(durableExecutionSchema.parse(execution));
  }

  private async write(execution: DurableExecution): Promise<void> {
    const operation = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(execution)}\n`, "utf8");
      const temporaryFile = await open(temporaryPath, "r");
      try {
        await temporaryFile.sync();
      } finally {
        await temporaryFile.close();
      }
      await rename(temporaryPath, this.filePath);
      const directory = await open(path.dirname(this.filePath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }
}

export class ExecutionConflictError extends Error {
  constructor(readonly currentRunId: string) {
    super(`Traffic execution ${currentRunId} already owns the execution slot.`);
    this.name = "ExecutionConflictError";
  }
}

export function withCompletion(
  execution: DurableExecution,
  completion: TrafficCompletionReport,
): DurableExecution {
  return { ...execution, state: "completion_pending", completion };
}
