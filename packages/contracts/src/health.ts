import { z } from "zod";
import { isoTimestampSchema, nonnegativeNumberSchema } from "./primitives.js";

export const healthReadyPath = "/health/ready" as const;

export const serviceNameValues = ["api", "worker", "mock-erp", "load-orchestrator", "web"] as const;
export const serviceNameSchema = z.enum(serviceNameValues);
export type ServiceName = z.infer<typeof serviceNameSchema>;

export const healthStatusValues = ["ok", "degraded", "unavailable"] as const;
export const healthStatusSchema = z.enum(healthStatusValues);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const readinessCheckSchema = z
  .object({
    name: z.string().trim().min(1),
    status: healthStatusSchema,
    message: z.string().trim().min(1).optional(),
  })
  .strict();
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

export const healthResponseSchema = z
  .object({
    service: serviceNameSchema,
    status: healthStatusSchema,
    timestamp: isoTimestampSchema,
    uptimeSeconds: nonnegativeNumberSchema,
    checks: z.array(readinessCheckSchema).default([]),
  })
  .strict();
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const livenessResponseSchema = healthResponseSchema.pick({
  service: true,
  status: true,
  timestamp: true,
  uptimeSeconds: true,
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;
