import { z } from "zod";
import {
  businessOutcomeSummarySchema,
  consistencyLagSummarySchema,
  demoRunSnapshotSchema,
} from "./demo.js";
import { inventoryStatusSchema } from "./inventory.js";
import { metricNameSchema, orderEventNameSchema, orderStatusSchema } from "./lifecycle.js";
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
  "order.status.updated",
  "order.consistency_lag.observed",
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
    saleOfferId: uuidSchema,
    outcome: businessOutcomeSummarySchema,
    consistencyLag: consistencyLagSummarySchema,
  })
  .strict();
export type BusinessOutcomeDashboardEvent = z.infer<typeof businessOutcomeDashboardEventSchema>;

const orderRealtimeIdentitySchema = z
  .object({
    orderId: uuidSchema,
    publicOrderId: z.string().trim().min(1),
    saleOfferId: uuidSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const orderStatusDashboardEventSchema = dashboardEventBaseSchema
  .merge(orderRealtimeIdentitySchema)
  .extend({
    type: z.literal("order.status.updated"),
    eventName: orderEventNameSchema.extract([
      "order.processing",
      "order.confirmed",
      "order.failed",
    ]),
    previousStatus: orderStatusSchema.extract(["queued", "processing"]),
    status: orderStatusSchema.extract(["processing", "confirmed", "failed"]),
    attemptNumber: z.number().int().positive(),
    attemptsMade: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((event, context) => {
    const expected = {
      "order.processing": { previousStatus: "queued", status: "processing" },
      "order.confirmed": { previousStatus: "processing", status: "confirmed" },
      "order.failed": { previousStatus: "processing", status: "failed" },
    }[event.eventName];
    if (event.previousStatus !== expected.previousStatus || event.status !== expected.status) {
      context.addIssue({ code: "custom", message: "Order event name and status transition disagree." });
    }
  });
export type OrderStatusDashboardEvent = z.infer<typeof orderStatusDashboardEventSchema>;

export const orderConsistencyLagDashboardEventSchema = dashboardEventBaseSchema
  .merge(orderRealtimeIdentitySchema)
  .extend({
    type: z.literal("order.consistency_lag.observed"),
    confirmedTransitionEventId: uuidSchema,
    metricName: z.literal("order.consistency_lag"),
    value: z.number().finite().int().nonnegative(),
    unit: z.literal("ms"),
    observedAt: isoTimestampSchema,
    startedAt: isoTimestampSchema,
    confirmedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.occurredAt !== event.confirmedAt || event.observedAt !== event.confirmedAt) {
      context.addIssue({ code: "custom", message: "Lag timestamps must equal confirmedAt." });
    }
    if (event.eventId === event.confirmedTransitionEventId) {
      context.addIssue({ code: "custom", message: "Lag and transition event IDs must be distinct." });
    }
    const rawLagMs = Date.parse(event.confirmedAt) - Date.parse(event.startedAt);
    if (Number.isFinite(rawLagMs) && event.value !== Math.max(0, rawLagMs)) {
      context.addIssue({ code: "custom", message: "Lag value must equal the clamped confirmedAt-startedAt duration." });
    }
  });
export type OrderConsistencyLagDashboardEvent = z.infer<
  typeof orderConsistencyLagDashboardEventSchema
>;

export const dashboardEventSchema = z.discriminatedUnion("type", [
  runDashboardEventSchema,
  inventoryDashboardEventSchema,
  queueDashboardEventSchema,
  trafficMetricDashboardEventSchema,
  businessOutcomeDashboardEventSchema,
  orderStatusDashboardEventSchema,
  orderConsistencyLagDashboardEventSchema,
]);
export type DashboardEvent = z.infer<typeof dashboardEventSchema>;
