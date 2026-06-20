import { z } from "zod";
import { correlationIdSchema, isoTimestampSchema, jsonObjectSchema } from "./primitives.js";

export const errorPayloadSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    details: jsonObjectSchema.optional(),
    correlationId: correlationIdSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();

export type ErrorPayload = z.infer<typeof errorPayloadSchema>;
