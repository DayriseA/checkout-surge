import { z } from "zod";
import { businessOutcomeSummarySchema, demoRunSnapshotSchema } from "./demo.js";
import { inventoryStatusSchema } from "./inventory.js";
import { metricNameSchema } from "./lifecycle.js";
import { correlationIdSchema, isoTimestampSchema, uuidSchema } from "./primitives.js";
import { queueStatusSchema } from "./queue.js";

export const dashboardEventsPath = "/dashboard/events" as const;
export const dashboardRecoveryPath = "/dashboard/recovery" as const;
export const dashboardEventsRedisChannel = "dashboard-events" as const;

export const dashboardEventTypeValues = [
  "run.started",
  "run.updated",
  "run.completed",
  "run.failed",
  "inventory.updated",
  "queue.updated",
  "traffic.metric",
  "business.outcome.updated",
] as const;
export const dashboardEventTypeSchema = z.enum(dashboardEventTypeValues);
export type DashboardEventType = z.infer<typeof dashboardEventTypeSchema>;

const dashboardEventBaseSchema = z
  .object({
    eventId: uuidSchema,
    runId: uuidSchema.optional(),
    correlationId: correlationIdSchema.optional(),
    occurredAt: isoTimestampSchema,
  })
  .strict();

export const runDashboardEventSchema = dashboardEventBaseSchema
  .extend({
    type: z.union([
      z.literal("run.started"),
      z.literal("run.updated"),
      z.literal("run.completed"),
      z.literal("run.failed"),
    ]),
    run: demoRunSnapshotSchema,
  })
  .strict();
export type RunDashboardEvent = z.infer<typeof runDashboardEventSchema>;

export const inventoryDashboardEventSchema = dashboardEventBaseSchema
  .extend({
    type: z.literal("inventory.updated"),
    inventory: inventoryStatusSchema,
  })
  .strict();
export type InventoryDashboardEvent = z.infer<typeof inventoryDashboardEventSchema>;

export const queueDashboardEventSchema = dashboardEventBaseSchema
  .extend({
    type: z.literal("queue.updated"),
    queue: queueStatusSchema,
  })
  .strict();
export type QueueDashboardEvent = z.infer<typeof queueDashboardEventSchema>;

export const trafficMetricDashboardEventSchema = dashboardEventBaseSchema
  .extend({
    type: z.literal("traffic.metric"),
    metricName: metricNameSchema,
    value: z.number().finite(),
    unit: z.string().trim().min(1),
  })
  .strict();
export type TrafficMetricDashboardEvent = z.infer<typeof trafficMetricDashboardEventSchema>;

export const businessOutcomeDashboardEventSchema = dashboardEventBaseSchema
  .extend({
    type: z.literal("business.outcome.updated"),
    outcome: businessOutcomeSummarySchema,
  })
  .strict();
export type BusinessOutcomeDashboardEvent = z.infer<typeof businessOutcomeDashboardEventSchema>;

export const dashboardEventSchema = z.discriminatedUnion("type", [
  runDashboardEventSchema,
  inventoryDashboardEventSchema,
  queueDashboardEventSchema,
  trafficMetricDashboardEventSchema,
  businessOutcomeDashboardEventSchema,
]);
export type DashboardEvent = z.infer<typeof dashboardEventSchema>;
