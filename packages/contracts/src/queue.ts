import { z } from "zod";
import {
  correlationIdSchema,
  isoTimestampSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";

export const orderProcessQueueName = "orders:process" as const;
export const orderProcessBullMqQueueName = "orders-process" as const;
export const orderProcessJobName = "order.process" as const;

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
