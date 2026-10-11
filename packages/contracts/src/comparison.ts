import { z } from "zod";
import {
  demoRunSnapshotSchema,
  publicRunHistoryDetailResponseSchema,
  runExecutionModeSchema,
} from "./demo.js";
import { correlationIdSchema, isoTimestampSchema, uuidSchema } from "./primitives.js";

export const comparisonPresetSlug = "architecture-comparison" as const;
export const startComparisonPath = "/demo/comparisons/start" as const;
export const comparisonDetailPathTemplate = "/demo/comparisons/:comparisonId" as const;
export const comparisonStageRoles = [
  "redis_demo",
  "redis_without",
  "queue_demo",
  "queue_without",
] as const;
export function comparisonDetailPath(comparisonId: string): string {
  return `/demo/comparisons/${encodeURIComponent(comparisonId)}`;
}
export const startComparisonRequestSchema = z
  .object({ correlationId: correlationIdSchema.optional() })
  .strict();
export const comparisonDetailParamsSchema = z.object({ comparisonId: uuidSchema }).strict();
export const startComparisonResponseSchema = z
  .object({
    comparisonId: uuidSchema,
    run: demoRunSnapshotSchema,
    recovery: z.object({ establishedAt: isoTimestampSchema }).strict(),
    correlationId: correlationIdSchema,
    timestamp: isoTimestampSchema,
  })
  .strict()
  .refine((value) => value.run.comparisonId === value.comparisonId, {
    message: "The child must belong to its comparison.",
  });
const stageShape = {
  role: z.enum(comparisonStageRoles),
  runId: uuidSchema,
  executionMode: runExecutionModeSchema,
};
export const comparisonStageSchema = z.discriminatedUnion("availability", [
  z.object({ ...stageShape, availability: z.literal("not_run") }).strict(),
  z.object({ ...stageShape, availability: z.literal("unavailable") }).strict(),
  z
    .object({ ...stageShape, availability: z.literal("pending"), run: demoRunSnapshotSchema })
    .strict(),
  z
    .object({
      ...stageShape,
      availability: z.literal("available"),
      detail: publicRunHistoryDetailResponseSchema,
    })
    .strict(),
]);
export const comparisonDetailResponseSchema = z
  .object({
    comparisonId: uuidSchema,
    acceptedAt: isoTimestampSchema,
    autoResetAt: isoTimestampSchema,
    state: z.enum(["running", "cleanup_pending", "completed", "failed"]),
    currentStage: z.number().int().min(0).max(3),
    currentRunId: uuidSchema,
    terminalReason: z.string().nullable(),
    currentFailureReason: z.string().nullable(),
    terminalAt: isoTimestampSchema.nullable(),
    stages: z.tuple([
      comparisonStageSchema,
      comparisonStageSchema,
      comparisonStageSchema,
      comparisonStageSchema,
    ]),
    timestamp: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const modes = ["demo", "without_redis", "demo", "without_order_queue"];
    for (const [index, stage] of value.stages.entries()) {
      if (stage.role !== comparisonStageRoles[index] || stage.executionMode !== modes[index]) {
        context.addIssue({
          code: "custom",
          path: ["stages", index],
          message: "Comparison stages must retain their fixed roles and modes.",
        });
      }
      const run =
        stage.availability === "available"
          ? stage.detail.run
          : stage.availability === "pending"
            ? stage.run
            : null;
      if (
        run &&
        (run.runId !== stage.runId ||
          run.comparisonId !== value.comparisonId ||
          run.executionMode !== stage.executionMode)
      ) {
        context.addIssue({
          code: "custom",
          path: ["stages", index],
          message: "Child identity does not match its comparison stage.",
        });
      }
      if (stage.availability === "available" && stage.detail.summary.runId !== stage.runId) {
        context.addIssue({
          code: "custom",
          path: ["stages", index],
          message: "Child summary does not match its run.",
        });
      }
    }
    if (value.currentRunId !== value.stages[value.currentStage]?.runId) {
      context.addIssue({
        code: "custom",
        path: ["currentRunId"],
        message: "Current child must match the current stage.",
      });
    }
  });
export type ComparisonDetailResponse = z.infer<typeof comparisonDetailResponseSchema>;
export type ComparisonStage = z.infer<typeof comparisonStageSchema>;
