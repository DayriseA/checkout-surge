import { z } from "zod";

export const isoTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .describe("ISO 8601 timestamp with an explicit timezone offset.");

export const correlationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const idempotencyKeySchema = z.string().trim().min(1).max(200);

export const uuidSchema = z.string().uuid();

export const positiveIntegerMinimum = 1;
export const nonnegativeNumberMinimum = 0;
export const percentageMinimum = 0;
export const percentageMaximum = 1;

export const positiveIntegerSchema = z.number().int().min(positiveIntegerMinimum);

export const nonnegativeIntegerSchema = z.number().int().min(nonnegativeNumberMinimum);

export const nonnegativeNumberSchema = z.number().min(nonnegativeNumberMinimum);

export const percentageSchema = z.number().min(percentageMinimum).max(percentageMaximum);

export const jsonObjectSchema = z.record(z.string(), z.unknown());

export type JsonObject = z.infer<typeof jsonObjectSchema>;
