import { randomUUID } from "node:crypto";
import {
  type ErpConfirmationRequest,
  type ErpConfirmationResponse,
  erpConfirmationResponseSchema,
} from "@checkout-surge/contracts";

export type ConfirmationDecision =
  | { status: "succeeded" }
  | {
      status: "failed";
      httpStatus: number;
      errorCode: string;
      errorMessage: string;
    };

export interface ConfirmationDecisionProvider {
  decide(request: ErpConfirmationRequest): Promise<ConfirmationDecision>;
}

export interface ConfirmationServiceOptions {
  decisionProvider?: ConfirmationDecisionProvider;
  generateConfirmationId?: () => string;
  now?: () => Date;
}

const successfulDecisionProvider: ConfirmationDecisionProvider = {
  decide: async () => ({ status: "succeeded" }),
};

export class ConfirmationService {
  private readonly decisionProvider: ConfirmationDecisionProvider;
  private readonly generateConfirmationId: () => string;
  private readonly now: () => Date;
  private readonly successfulConfirmationsByIdempotencyKey = new Map<
    string,
    ErpConfirmationResponse
  >();

  constructor(options: ConfirmationServiceOptions = {}) {
    this.decisionProvider = options.decisionProvider ?? successfulDecisionProvider;
    this.generateConfirmationId = options.generateConfirmationId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async confirm(request: ErpConfirmationRequest): Promise<ErpConfirmationResponse> {
    const existingConfirmation = this.successfulConfirmationsByIdempotencyKey.get(
      request.idempotencyKey,
    );
    if (existingConfirmation) {
      return existingConfirmation;
    }

    const startedAt = this.now();
    const decision = await this.decisionProvider.decide(request);
    const completedAt = this.now();
    const latencyMs = Math.max(0, completedAt.getTime() - startedAt.getTime());

    if (decision.status === "failed") {
      return erpConfirmationResponseSchema.parse({
        status: "failed",
        httpStatus: decision.httpStatus,
        errorCode: decision.errorCode,
        errorMessage: decision.errorMessage,
        latencyMs,
        timestamp: completedAt.toISOString(),
      });
    }

    const response = erpConfirmationResponseSchema.parse({
      status: "succeeded",
      confirmationId: this.generateConfirmationId(),
      httpStatus: 200,
      latencyMs,
      timestamp: completedAt.toISOString(),
    });
    this.successfulConfirmationsByIdempotencyKey.set(request.idempotencyKey, response);
    return response;
  }
}
