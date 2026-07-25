import { z } from "zod";
import {
  businessOutcomeSummarySchema,
  completionOutcomeSchema,
  consistencyLagSummarySchema,
  demoRunSnapshotSchema,
} from "./demo.js";
import { erpResilienceStatusSchema } from "./erp.js";
import { inventoryStatusSchema } from "./inventory.js";
import {
  correlationIdSchema,
  isoTimestampSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";
import { queueStatusSchema } from "./queue.js";
import { transportAttemptCountsSchema } from "./traffic-transport-counts.js";

export const dashboardEventsPath = "/dashboard/events" as const;
export const dashboardRecoveryPath = "/dashboard/recovery" as const;
export const dashboardProjectionSchemaName = "checkout-surge.dashboard-projection" as const;
export const dashboardProjectionSchemaVersion = 1 as const;

const metricSampleSchema = z
  .object({
    metricName: z.string().trim().min(1),
    value: z.number().finite(),
    unit: z.string().trim().min(1),
    timestamp: isoTimestampSchema,
  })
  .strict();

export function dashboardProjectionScopeId(
  input: { runId: string; saleOfferId: string } | null,
): string {
  if (input === null) return "idle";
  const runId = uuidSchema.parse(input.runId);
  const saleOfferId = uuidSchema.parse(input.saleOfferId);
  return `run/${runId}/sale-offer/${saleOfferId}`;
}

export const dashboardProjectionScopeSchema = z
  .object({
    runId: uuidSchema,
    saleOfferId: uuidSchema,
  })
  .strict();
export type DashboardProjectionScope = z.infer<typeof dashboardProjectionScopeSchema>;

export const dashboardProjectionDirtySignalSchema = z
  .object({
    type: z.literal("dashboard.projection.dirty"),
    correlationId: correlationIdSchema.optional(),
    scope: dashboardProjectionScopeSchema.optional(),
  })
  .strict();
export type DashboardProjectionDirtySignal = z.infer<typeof dashboardProjectionDirtySignalSchema>;

export const dashboardRecoveryQuerySchema = z
  .object({
    knownRunId: uuidSchema.optional(),
    knownSaleOfferId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if ((query.knownRunId === undefined) !== (query.knownSaleOfferId === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Known dashboard recovery scope requires both run and sale-offer IDs.",
      });
    }
  });

export const dashboardProjectionSchema = z
  .object({
    schema: z.literal(dashboardProjectionSchemaName),
    version: z.literal(dashboardProjectionSchemaVersion),
    correlationId: correlationIdSchema,
    scopeId: z.string().trim().min(1),
    scope: dashboardProjectionScopeSchema.nullable(),
    revision: positiveIntegerSchema.max(Number.MAX_SAFE_INTEGER),
    recoveredAt: isoTimestampSchema,
    currentRun: demoRunSnapshotSchema.nullable(),
    inventory: inventoryStatusSchema.nullable(),
    recentMetrics: z.array(metricSampleSchema).default([]),
    queue: queueStatusSchema.nullable(),
    erp: erpResilienceStatusSchema.nullable(),
    businessOutcome: businessOutcomeSummarySchema.nullable(),
    consistencyLag: consistencyLagSummarySchema.nullable(),
    recentCompletionOutcomes: z.array(completionOutcomeSchema).default([]),
    transportAttemptCounts: transportAttemptCountsSchema.nullable().default(null),
  })
  .strict()
  .superRefine((projection, context) => {
    if (projection.scopeId !== dashboardProjectionScopeId(projection.scope)) {
      context.addIssue({
        code: "custom",
        path: ["scopeId"],
        message: "Projection scope ID must use the canonical idle or run/sale-offer encoding.",
      });
    }
    if (projection.currentRun === null && projection.scope !== null) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Scope must be null when no current run is selected.",
      });
      return;
    }
    if (projection.currentRun !== null && projection.scope === null) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Scope must identify the selected current run.",
      });
      return;
    }
    if (projection.currentRun === null || projection.scope === null) {
      const runOwnedFields = [
        ["inventory", projection.inventory],
        ["recentMetrics", projection.recentMetrics.length === 0 ? null : projection.recentMetrics],
        ["businessOutcome", projection.businessOutcome],
        ["consistencyLag", projection.consistencyLag],
        [
          "recentCompletionOutcomes",
          projection.recentCompletionOutcomes.length === 0
            ? null
            : projection.recentCompletionOutcomes,
        ],
        ["transportAttemptCounts", projection.transportAttemptCounts],
      ] as const;
      for (const [field, value] of runOwnedFields) {
        if (value !== null) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `Idle projection cannot carry run-owned ${field}.`,
          });
        }
      }
      return;
    }
    if (projection.scope.runId !== projection.currentRun.runId) {
      context.addIssue({
        code: "custom",
        path: ["scope", "runId"],
        message: "Scope run ID must match the selected current run.",
      });
    }
    if (projection.scope.saleOfferId !== (projection.currentRun.saleOfferId ?? null)) {
      context.addIssue({
        code: "custom",
        path: ["scope", "saleOfferId"],
        message: "Scope sale offer ID must match the selected current run.",
      });
    }
    if (
      projection.inventory !== null &&
      projection.inventory.saleOfferId !== projection.scope.saleOfferId
    ) {
      context.addIssue({
        code: "custom",
        path: ["inventory", "saleOfferId"],
        message: "Projection inventory and scope sale offer IDs must agree.",
      });
    }
    for (const [index, outcome] of projection.recentCompletionOutcomes.entries()) {
      if (
        outcome.runId !== projection.scope.runId ||
        outcome.saleOfferId !== projection.scope.saleOfferId
      ) {
        context.addIssue({
          code: "custom",
          path: ["recentCompletionOutcomes", index],
          message: "Projection completion outcome and scope IDs must agree.",
        });
      }
    }
  });
export type DashboardProjection = z.infer<typeof dashboardProjectionSchema>;

export function isNewerDashboardProjectionForScope(
  current: Pick<DashboardProjection, "scopeId" | "revision">,
  candidate: Pick<DashboardProjection, "scopeId" | "revision">,
): boolean {
  return current.scopeId === candidate.scopeId && candidate.revision > current.revision;
}
