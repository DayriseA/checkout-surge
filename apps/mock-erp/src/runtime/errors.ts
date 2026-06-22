import { errorPayloadSchema } from "@checkout-surge/contracts";

export function createMockErpErrorPayload(options: {
  code: string;
  message: string;
  correlationId: string;
  details?: Record<string, unknown>;
  now?: Date;
}) {
  return errorPayloadSchema.parse({
    code: options.code,
    message: options.message,
    correlationId: options.correlationId,
    timestamp: (options.now ?? new Date()).toISOString(),
    ...(options.details ? { details: options.details } : {}),
  });
}
