import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  historicalTrafficExecutionStartRequestSchema,
  materializedTrafficCompletionReportSchema,
  materializedTrafficExecutionStartRequestSchema,
  type TrafficCompletionReport,
  type TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import { z } from "zod";

// The journal read boundary accepts and ignores retired engine knobs in
// snapshots persisted before the retirement (D13); writers keep the strict
// materialized schema so rewritten journals use the current format.
const durableExecutionBaseSchema = z.object({
  request: historicalTrafficExecutionStartRequestSchema,
  acceptedAt: z.string().datetime({ offset: true }),
});

const completionRejectionSchema = z
  .object({
    reason: z.string().min(1),
    httpStatus: z.number().int().min(400).max(499),
    rejectedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const durableExecutionSchema = z.discriminatedUnion("state", [
  durableExecutionBaseSchema
    .extend({
      state: z.literal("accepted"),
      completion: z.undefined().optional(),
    })
    .strict(),
  durableExecutionBaseSchema
    .extend({
      state: z.literal("executing"),
      completion: z.undefined().optional(),
    })
    .strict(),
  durableExecutionBaseSchema
    .extend({
      state: z.literal("completion_pending"),
      completion: materializedTrafficCompletionReportSchema,
    })
    .strict(),
  durableExecutionBaseSchema
    .extend({
      state: z.literal("completed"),
      completion: materializedTrafficCompletionReportSchema.optional(),
    })
    .strict(),
  durableExecutionBaseSchema
    .extend({
      state: z.literal("completion_rejected"),
      completion: materializedTrafficCompletionReportSchema,
      rejection: completionRejectionSchema,
    })
    .strict(),
]);

export type DurableExecution = z.infer<typeof durableExecutionSchema>;
export type CompletionRejection = z.infer<typeof completionRejectionSchema>;
export type CompletionPublishOutcome =
  | "published"
  | "already_published"
  | "execution_mismatch"
  | "completion_conflict";

export interface ExecutionStore {
  read(): Promise<DurableExecution | null>;
  accept(
    request: TrafficExecutionStartRequest,
    acceptedAt: Date,
  ): Promise<{ execution: DurableExecution; created: boolean }>;
  update(execution: DurableExecution): Promise<void>;
  publishCompletion(completion: TrafficCompletionReport): Promise<CompletionPublishOutcome>;
  acknowledgeCompletion(completion: TrafficCompletionReport): Promise<boolean>;
  rejectCompletion(
    completion: TrafficCompletionReport,
    rejection: CompletionRejection,
  ): Promise<boolean>;
  completeCancellation(runId: string): Promise<boolean>;
}

/** Atomic single-slot journal. The orchestrator deliberately owns at most one execution. */
export class FileExecutionStore implements ExecutionStore {
  private readonly filePath: string;
  private mutationChain = Promise.resolve();

  constructor(directory: string) {
    this.filePath = path.join(directory, "execution.json");
  }

  async read(): Promise<DurableExecution | null> {
    try {
      return durableExecutionSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ExecutionJournalReadError(this.filePath, error);
    }
  }

  async accept(
    request: TrafficExecutionStartRequest,
    acceptedAt: Date,
  ): Promise<{ execution: DurableExecution; created: boolean }> {
    return this.serializeMutation(() => this.acceptOnce(request, acceptedAt));
  }

  private async acceptOnce(
    request: TrafficExecutionStartRequest,
    acceptedAt: Date,
  ): Promise<{ execution: DurableExecution; created: boolean }> {
    const current = await this.read();
    if (current?.state === "completion_rejected" && current.request.runId === request.runId) {
      return { execution: current, created: false };
    }
    if (current && current.state !== "completed" && current.state !== "completion_rejected") {
      if (current.request.runId === request.runId) return { execution: current, created: false };
      throw new ExecutionConflictError(current.request.runId);
    }
    const execution: DurableExecution = {
      request: materializedTrafficExecutionStartRequestSchema.parse(request),
      state: "accepted",
      acceptedAt: acceptedAt.toISOString(),
    };
    await this.write(execution);
    return { execution, created: true };
  }

  async update(execution: DurableExecution): Promise<void> {
    const parsed = durableExecutionSchema.parse(execution);
    await this.serializeMutation(() => this.write(parsed));
  }

  async publishCompletion(completion: TrafficCompletionReport): Promise<CompletionPublishOutcome> {
    const parsedCompletion = materializedTrafficCompletionReportSchema.parse(completion);
    return this.serializeMutation(async () => {
      const current = await this.read();
      if (!current || current.request.runId !== parsedCompletion.runId) {
        return "execution_mismatch";
      }
      if (current.completion) {
        return sameCompletion(current.completion, parsedCompletion)
          ? "already_published"
          : "completion_conflict";
      }
      if (current.state === "completed") return "completion_conflict";
      await this.write(withCompletion(current, parsedCompletion));
      return "published";
    });
  }

  async acknowledgeCompletion(completion: TrafficCompletionReport): Promise<boolean> {
    const parsedCompletion = materializedTrafficCompletionReportSchema.parse(completion);
    return this.serializeMutation(async () => {
      const current = await this.read();
      if (
        current?.state !== "completion_pending" ||
        current.request.runId !== parsedCompletion.runId ||
        !sameCompletion(current.completion, parsedCompletion)
      ) {
        return false;
      }
      await this.write({ ...current, state: "completed" });
      return true;
    });
  }

  async rejectCompletion(
    completion: TrafficCompletionReport,
    rejection: CompletionRejection,
  ): Promise<boolean> {
    const parsedCompletion = materializedTrafficCompletionReportSchema.parse(completion);
    const parsedRejection = completionRejectionSchema.parse(rejection);
    return this.serializeMutation(async () => {
      const current = await this.read();
      if (
        current?.state !== "completion_pending" ||
        current.request.runId !== parsedCompletion.runId ||
        !sameCompletion(current.completion, parsedCompletion)
      ) {
        return false;
      }
      await this.write({
        ...current,
        state: "completion_rejected",
        rejection: parsedRejection,
      });
      return true;
    });
  }

  async completeCancellation(runId: string): Promise<boolean> {
    return this.serializeMutation(async () => {
      const current = await this.read();
      if (
        current?.request.runId !== runId ||
        (current.state !== "accepted" && current.state !== "executing")
      ) {
        return false;
      }
      await this.write({ ...current, state: "completed" });
      return true;
    });
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation);
    this.mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async write(execution: DurableExecution): Promise<void> {
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
  }
}

export class ExecutionJournalReadError extends Error {
  constructor(
    readonly journalPath: string,
    cause: unknown,
  ) {
    const detail =
      cause instanceof z.ZodError
        ? cause.issues
            .map((issue) => `${issue.path.join(".") || "journal"}: ${issue.message}`)
            .join("; ")
        : cause instanceof Error
          ? cause.message
          : String(cause);
    super(`Could not read durable execution journal ${journalPath}: ${detail}`, { cause });
    this.name = "ExecutionJournalReadError";
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
  return {
    ...execution,
    state: "completion_pending",
    completion: materializedTrafficCompletionReportSchema.parse(completion),
  };
}

function sameCompletion(left: TrafficCompletionReport, right: TrafficCompletionReport): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
