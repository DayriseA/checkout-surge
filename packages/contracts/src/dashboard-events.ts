import { z } from "zod";
import {
  businessOutcomeSummarySchema,
  consistencyLagSummarySchema,
  demoRunSnapshotSchema,
} from "./demo.js";
import { orderEventNameSchema, orderStatusSchema } from "./lifecycle.js";
import { correlationIdSchema, isoTimestampSchema, uuidSchema } from "./primitives.js";
import { orderProcessQueueName } from "./queue.js";

export const dashboardEventsPath = "/dashboard/events" as const;
export const dashboardRecoveryPath = "/dashboard/recovery" as const;
export const dashboardEventsRedisChannel = "dashboard-events" as const;

/**
 * `business.outcome.snapshot` is a deliberate Surge extension to the four shared
 * domain-first categories. It remains a cumulative full replacement while the
 * authoritative recovery endpoint and terminal projection use that shape.
 */
export const dashboardEventTypeValues = [
  "load.run.updated",
  "dashboard.metric.observed",
  "order.status.updated",
  "business.event.recorded",
  "business.outcome.snapshot",
] as const;
export const dashboardEventTypeSchema = z.enum(dashboardEventTypeValues);
export type DashboardEventType = z.infer<typeof dashboardEventTypeSchema>;

const advisoryEventBaseSchema = z
  .object({
    runId: uuidSchema.optional(),
    correlationId: correlationIdSchema.optional(),
    occurredAt: isoTimestampSchema,
  })
  .strict();

export const runDashboardEventSchema = advisoryEventBaseSchema
  .extend({
    type: z.literal("load.run.updated"),
    runId: uuidSchema,
    run: demoRunSnapshotSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.runId !== event.run.runId) {
      context.addIssue({ code: "custom", message: "Run envelope and snapshot IDs must agree." });
    }
  });
export type RunDashboardEvent = z.infer<typeof runDashboardEventSchema>;

const metricBaseShape = {
  type: z.literal("dashboard.metric.observed"),
  correlationId: correlationIdSchema.optional(),
  occurredAt: isoTimestampSchema,
  observedAt: isoTimestampSchema,
};

const trafficScheduledRequestRateMetricSchema = z
  .object({
    ...metricBaseShape,
    metricName: z.literal("traffic.scheduled_request_rate"),
    value: z.number().finite().nonnegative(),
    unit: z.literal("requests_per_second"),
    runId: uuidSchema,
  })
  .strict();

const trafficLatencyMetricSchema = z
  .object({
    ...metricBaseShape,
    metricName: z.literal("traffic.latency"),
    value: z.number().finite().nonnegative(),
    unit: z.literal("ms"),
    runId: uuidSchema,
  })
  .strict();

const trafficFailureRateMetricSchema = z
  .object({
    ...metricBaseShape,
    metricName: z.literal("traffic.failure_rate"),
    value: z.number().finite().min(0).max(1),
    unit: z.literal("ratio"),
    runId: uuidSchema,
  })
  .strict();

const queueDepthMetricSchema = z
  .object({
    ...metricBaseShape,
    metricName: z.literal("queue.depth"),
    value: z.number().int().nonnegative(),
    unit: z.literal("jobs"),
    queueName: z.literal(orderProcessQueueName),
    runId: uuidSchema.optional(),
  })
  .strict();

const inventoryRemainingMetricSchema = z
  .object({
    ...metricBaseShape,
    metricName: z.literal("inventory.remaining"),
    value: z.number().int().nonnegative(),
    unit: z.literal("items"),
    saleOfferId: uuidSchema,
    runId: uuidSchema.optional(),
  })
  .strict();

const inventorySoldOutRejectionMetricSchema = z
  .object({
    ...metricBaseShape,
    metricName: z.literal("inventory.sold_out_rejection"),
    value: z.number().int().nonnegative(),
    unit: z.literal("rejections"),
    aggregation: z.literal("cumulative"),
    saleOfferId: uuidSchema,
    runId: uuidSchema.optional(),
  })
  .strict();

const orderRealtimeIdentityShape = {
  eventId: uuidSchema,
  orderId: uuidSchema,
  publicOrderId: z.string().trim().min(1),
  saleOfferId: uuidSchema,
  runId: uuidSchema.optional(),
  correlationId: correlationIdSchema,
};

export const orderConsistencyLagDashboardEventSchema = z
  .object({
    ...metricBaseShape,
    ...orderRealtimeIdentityShape,
    metricName: z.literal("order.consistency_lag"),
    confirmedTransitionEventId: uuidSchema,
    value: z.number().finite().int().nonnegative(),
    unit: z.literal("ms"),
    startedAt: isoTimestampSchema,
    confirmedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.occurredAt !== event.confirmedAt || event.observedAt !== event.confirmedAt) {
      context.addIssue({ code: "custom", message: "Lag timestamps must equal confirmedAt." });
    }
    if (event.eventId === event.confirmedTransitionEventId) {
      context.addIssue({
        code: "custom",
        message: "Lag and transition event IDs must be distinct.",
      });
    }
    const rawLagMs = Date.parse(event.confirmedAt) - Date.parse(event.startedAt);
    if (Number.isFinite(rawLagMs) && event.value !== Math.max(0, rawLagMs)) {
      context.addIssue({
        code: "custom",
        message: "Lag value must equal the clamped confirmedAt-startedAt duration.",
      });
    }
  });
export type OrderConsistencyLagDashboardEvent = z.infer<
  typeof orderConsistencyLagDashboardEventSchema
>;

export const dashboardMetricObservedEventSchema = z.discriminatedUnion("metricName", [
  trafficScheduledRequestRateMetricSchema,
  trafficLatencyMetricSchema,
  trafficFailureRateMetricSchema,
  queueDepthMetricSchema,
  inventoryRemainingMetricSchema,
  inventorySoldOutRejectionMetricSchema,
  orderConsistencyLagDashboardEventSchema,
]);
export type DashboardMetricObservedEvent = z.infer<typeof dashboardMetricObservedEventSchema>;
/** @deprecated Use DashboardMetricObservedEvent. */
export type TrafficMetricDashboardEvent = DashboardMetricObservedEvent;

export const businessOutcomeDashboardEventSchema = advisoryEventBaseSchema
  .extend({
    type: z.literal("business.outcome.snapshot"),
    saleOfferId: uuidSchema,
    outcome: businessOutcomeSummarySchema,
    consistencyLag: consistencyLagSummarySchema,
  })
  .strict();
export type BusinessOutcomeDashboardEvent = z.infer<typeof businessOutcomeDashboardEventSchema>;

export const orderStatusDashboardEventSchema = z
  .object({
    ...orderRealtimeIdentityShape,
    type: z.literal("order.status.updated"),
    occurredAt: isoTimestampSchema,
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
      context.addIssue({
        code: "custom",
        message: "Order event name and status transition disagree.",
      });
    }
  });
export type OrderStatusDashboardEvent = z.infer<typeof orderStatusDashboardEventSchema>;

export const businessEventRecordedDashboardEventSchema = z
  .object({
    type: z.literal("business.event.recorded"),
    eventId: uuidSchema,
    eventName: orderEventNameSchema,
    occurredAt: isoTimestampSchema,
    correlationId: correlationIdSchema,
    runId: uuidSchema.optional(),
    saleOfferId: uuidSchema.optional(),
    orderId: uuidSchema.optional(),
    publicOrderId: z.string().trim().min(1).optional(),
  })
  .strict();
export type BusinessEventRecordedDashboardEvent = z.infer<
  typeof businessEventRecordedDashboardEventSchema
>;

export const dashboardEventSchema = z.discriminatedUnion("type", [
  runDashboardEventSchema,
  dashboardMetricObservedEventSchema,
  orderStatusDashboardEventSchema,
  businessEventRecordedDashboardEventSchema,
  businessOutcomeDashboardEventSchema,
]);
export type DashboardEvent = z.infer<typeof dashboardEventSchema>;

// Retained export names keep source imports stable while the wire vocabulary changes atomically.
export const trafficMetricDashboardEventSchema = dashboardMetricObservedEventSchema;
