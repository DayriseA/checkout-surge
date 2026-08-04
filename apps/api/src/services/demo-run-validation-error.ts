import type { ErrorPayloadCode } from "@checkout-surge/contracts";

export class DemoRunValidationError extends Error {
  constructor(
    readonly code: ErrorPayloadCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "DemoRunValidationError";
  }
}
