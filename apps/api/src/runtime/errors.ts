import {
  type ErrorPayload,
  type ErrorPayloadCode,
  errorPayloadSchema,
  type JsonObject,
} from "@checkout-surge/contracts";

export class ApiHttpError extends Error {
  readonly statusCode: number;
  readonly code: ErrorPayloadCode;
  readonly details: JsonObject | undefined;

  constructor(options: {
    statusCode: number;
    code: ErrorPayloadCode;
    message: string;
    details?: JsonObject;
  }) {
    super(options.message);
    this.name = "ApiHttpError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.details = options.details;
  }
}

export function createErrorPayload(options: {
  code: ErrorPayloadCode;
  message: string;
  correlationId: string;
  details?: JsonObject;
  now?: Date;
}): ErrorPayload {
  const payload = {
    code: options.code,
    message: options.message,
    correlationId: options.correlationId,
    timestamp: (options.now ?? new Date()).toISOString(),
    ...(options.details ? { details: options.details } : {}),
  };

  return errorPayloadSchema.parse(payload);
}
