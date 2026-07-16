import { z } from "zod";
import {
  correlationIdSchema,
  isoTimestampSchema,
  nonnegativeIntegerSchema,
  nonnegativeNumberSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";

export const orderProcessQueueName = "orders:process" as const;
export const orderProcessBullMqQueueName = "orders-process" as const;
export const orderProcessJobName = "order.process" as const;
export const notificationRecordQueueName = "notifications:record" as const;
export const notificationRecordBullMqQueueName = "notifications-record" as const;
export const notificationRecordJobName = "notification.record" as const;

export const simulatedNotificationChannelValues = ["email", "sms"] as const;
export const simulatedNotificationChannelSchema = z.enum(simulatedNotificationChannelValues);
export type SimulatedNotificationChannel = z.infer<typeof simulatedNotificationChannelSchema>;

export const simulatedNotificationStatusValues = ["recorded"] as const;
export const simulatedNotificationStatusSchema = z.enum(simulatedNotificationStatusValues);
export type SimulatedNotificationStatus = z.infer<typeof simulatedNotificationStatusSchema>;

export const orderProcessJobSchema = z
  .object({
    orderId: uuidSchema,
    publicOrderId: z.string().trim().min(1),
    reservationId: uuidSchema,
    saleOfferId: uuidSchema,
    correlationId: correlationIdSchema,
    runId: uuidSchema.optional(),
    quantity: positiveIntegerSchema,
    queuedAt: isoTimestampSchema,
  })
  .strict();
export type OrderProcessJob = z.infer<typeof orderProcessJobSchema>;

export const notificationRecordJobSchema = z
  .object({
    orderId: uuidSchema,
    saleOfferId: uuidSchema,
    correlationId: correlationIdSchema,
    runId: uuidSchema.optional(),
    channel: simulatedNotificationChannelSchema,
    recipientPlaceholder: z.string().trim().min(1),
    confirmedAt: isoTimestampSchema,
  })
  .strict();
export type NotificationRecordJob = z.infer<typeof notificationRecordJobSchema>;

export const queueFailedJobSummarySchema = z
  .object({
    jobId: z.string().trim().min(1),
    jobName: z.string().trim().min(1),
    attemptsMade: nonnegativeIntegerSchema,
    failedReason: z.string().trim().min(1),
    failedAt: isoTimestampSchema.nullable(),
  })
  .strict();
export type QueueFailedJobSummary = z.infer<typeof queueFailedJobSummarySchema>;

export const queueStatusSchema = z
  .object({
    name: z.literal(orderProcessQueueName),
    connectivity: z.literal("reachable"),
    depth: nonnegativeIntegerSchema,
    counts: z
      .object({
        waiting: nonnegativeIntegerSchema,
        prioritized: nonnegativeIntegerSchema,
        paused: nonnegativeIntegerSchema,
        delayed: nonnegativeIntegerSchema,
        active: nonnegativeIntegerSchema,
        failed: nonnegativeIntegerSchema,
      })
      .strict(),
    oldestWaitingAgeSeconds: nonnegativeNumberSchema.nullable(),
    retryPressure: z
      .object({
        inspectedJobCount: nonnegativeIntegerSchema,
        inspectionLimit: positiveIntegerSchema,
        retryingJobCount: nonnegativeIntegerSchema,
        retryAttemptCount: nonnegativeIntegerSchema,
        inspectionTruncated: z.boolean(),
      })
      .strict(),
    failedJobs: z
      .object({
        totalCount: nonnegativeIntegerSchema,
        recent: z.array(queueFailedJobSummarySchema),
        inspectionLimit: positiveIntegerSchema,
        inspectionTruncated: z.boolean(),
      })
      .strict(),
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type QueueStatus = z.infer<typeof queueStatusSchema>;
