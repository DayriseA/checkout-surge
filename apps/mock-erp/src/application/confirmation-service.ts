import { randomUUID } from "node:crypto";
import {
  type ErpConfirmationRequest,
  type ErpConfirmationResponse,
  erpConfirmationResponseSchema,
} from "@checkout-surge/contracts";

export class ConfirmationIdempotencyConflictError extends Error {
  override readonly name = "ConfirmationIdempotencyConflictError";

  constructor(readonly idempotencyKey: string) {
    super(`ERP idempotency key ${idempotencyKey} was reused with different immutable order data.`);
  }
}

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

interface ConfirmationIdentity {
  orderId: string;
  publicOrderId: string;
  reservationId: string;
  saleOfferId: string;
  runId: string | null;
  quantity: number;
}

const successfulDecisionProvider: ConfirmationDecisionProvider = {
  decide: async () => ({ status: "succeeded" }),
};

export class ConfirmationService {
  private readonly decisionProvider: ConfirmationDecisionProvider;
  private readonly generateConfirmationId: () => string;
  private readonly now: () => Date;
  private readonly ledger = new InMemoryConfirmationLedger();
  private readonly inFlight = new Map<
    string,
    { identity: ConfirmationIdentity; promise: Promise<ErpConfirmationResponse> }
  >();

  constructor(options: ConfirmationServiceOptions = {}) {
    this.decisionProvider = options.decisionProvider ?? successfulDecisionProvider;
    this.generateConfirmationId = options.generateConfirmationId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async confirm(request: ErpConfirmationRequest): Promise<ErpConfirmationResponse> {
    const running = this.inFlight.get(request.idempotencyKey);
    if (running) {
      assertSameConfirmationIdentity(running.identity, request);
      return running.promise;
    }
    const existingConfirmation = this.ledger.get(request);
    if (existingConfirmation) return existingConfirmation;
    const operation = this.confirmFirst(request);
    this.inFlight.set(request.idempotencyKey, {
      identity: confirmationIdentity(request),
      promise: operation,
    });
    try {
      return await operation;
    } finally {
      this.inFlight.delete(request.idempotencyKey);
    }
  }

  private async confirmFirst(request: ErpConfirmationRequest): Promise<ErpConfirmationResponse> {
    const response = await this.produceConfirmation(request);
    return response.status === "succeeded" ? this.ledger.remember(request, response) : response;
  }

  private async produceConfirmation(
    request: ErpConfirmationRequest,
  ): Promise<ErpConfirmationResponse> {
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

    return erpConfirmationResponseSchema.parse({
      status: "succeeded",
      confirmationId: this.generateConfirmationId(),
      httpStatus: 200,
      latencyMs,
      timestamp: completedAt.toISOString(),
    });
  }
}

export class InMemoryConfirmationLedger {
  private readonly confirmations = new Map<
    string,
    { identity: ConfirmationIdentity; response: ErpConfirmationResponse }
  >();

  get(request: ErpConfirmationRequest): ErpConfirmationResponse | null {
    const existing = this.confirmations.get(request.idempotencyKey);
    if (!existing) return null;
    assertSameConfirmationIdentity(existing.identity, request);
    return existing.response;
  }

  remember(
    request: ErpConfirmationRequest,
    response: ErpConfirmationResponse,
  ): ErpConfirmationResponse {
    const existing = this.confirmations.get(request.idempotencyKey);
    if (existing) {
      assertSameConfirmationIdentity(existing.identity, request);
      return existing.response;
    }
    this.confirmations.set(request.idempotencyKey, {
      identity: confirmationIdentity(request),
      response,
    });
    return response;
  }
}

function assertSameConfirmationIdentity(
  existing: ConfirmationIdentity,
  request: ErpConfirmationRequest,
): void {
  if (
    existing.orderId !== request.orderId ||
    existing.publicOrderId !== request.publicOrderId ||
    existing.reservationId !== request.reservationId ||
    existing.saleOfferId !== request.saleOfferId ||
    (existing.runId ?? null) !== (request.runId ?? null) ||
    existing.quantity !== request.quantity
  ) {
    throw new ConfirmationIdempotencyConflictError(request.idempotencyKey);
  }
}

function confirmationIdentity(request: ErpConfirmationRequest): ConfirmationIdentity {
  return {
    orderId: request.orderId,
    publicOrderId: request.publicOrderId,
    reservationId: request.reservationId,
    saleOfferId: request.saleOfferId,
    runId: request.runId ?? null,
    quantity: request.quantity,
  };
}
