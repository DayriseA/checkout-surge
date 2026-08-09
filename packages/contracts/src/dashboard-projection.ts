import { z } from "zod";
import {
  businessOutcomeSummarySchema,
  consistencyLagSummarySchema,
  demoRunSnapshotSchema,
} from "./demo.js";
import { runErpOutcomeSummarySchema, sharedErpProtectionStatusSchema } from "./erp.js";
import { inventoryStatusSchema } from "./inventory.js";
import { requestArrivalSummarySchema, trafficHttpSummarySchema } from "./load.js";
import {
  correlationIdSchema,
  isoTimestampSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";
import { queueStatusSchema } from "./queue.js";
import { runSignalTimelineSummarySchema } from "./run-signals.js";
import { transportAttemptCountsSchema } from "./traffic-transport-counts.js";

export const dashboardEventsPath = "/dashboard/events" as const;
export const dashboardRecoveryPath = "/dashboard/recovery" as const;
export const dashboardProjectionSchemaName = "checkout-surge.dashboard-projection" as const;
export const dashboardProjectionSchemaVersion = 2 as const;
/** Slowest expected cadence while dashboard work remains in flight. */
export const dashboardLiveUpdateExpectedIntervalMs = 2_000;

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

export const sharedRuntimeStatusSchema = z
  .object({
    queue: queueStatusSchema,
    erpProtection: sharedErpProtectionStatusSchema,
  })
  .strict();
export type SharedRuntimeStatus = z.infer<typeof sharedRuntimeStatusSchema>;

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
    erp: runErpOutcomeSummarySchema.nullable(),
    systemStatus: sharedRuntimeStatusSchema.nullable(),
    businessOutcome: businessOutcomeSummarySchema.nullable(),
    consistencyLag: consistencyLagSummarySchema.nullable(),
    transportAttemptCounts: transportAttemptCountsSchema.nullable().default(null),
    httpSummary: trafficHttpSummarySchema.nullable().default(null),
    requestArrivalSummary: requestArrivalSummarySchema.nullable().default(null),
    runSignalTimelineSummary: runSignalTimelineSummarySchema.nullable().default(null),
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
        ["erp", projection.erp],
        ["businessOutcome", projection.businessOutcome],
        ["consistencyLag", projection.consistencyLag],
        ["transportAttemptCounts", projection.transportAttemptCounts],
        ["httpSummary", projection.httpSummary ?? null],
        ["requestArrivalSummary", projection.requestArrivalSummary ?? null],
        ["runSignalTimelineSummary", projection.runSignalTimelineSummary ?? null],
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
    if (projection.erp !== null && projection.erp.runId !== projection.scope.runId) {
      context.addIssue({
        code: "custom",
        path: ["erp", "runId"],
        message: "Projection ERP outcome and scope run IDs must agree.",
      });
    }
    if (
      projection.erp?.latestAttempt &&
      projection.erp.latestAttempt.runId !== projection.scope.runId
    ) {
      context.addIssue({
        code: "custom",
        path: ["erp", "latestAttempt", "runId"],
        message: "Projection latest ERP attempt and scope run IDs must agree.",
      });
    }
  });
export type DashboardProjection = z.infer<typeof dashboardProjectionSchema>;
