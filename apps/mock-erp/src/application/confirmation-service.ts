import { randomUUID } from "node:crypto";
import {
  type ErpConfirmationRequest,
  type ErpConfirmationResponse,
  erpConfirmationResponseSchema,
} from "@checkout-surge/contracts";
import { jsonDeepEqual } from "@checkout-surge/db";

export interface ConfirmationLedger {
  get(request: ErpConfirmationRequest): Promise<ErpConfirmationResponse | null>;
  remember(
    request: ErpConfirmationRequest,
    response: ErpConfirmationResponse,
  ): Promise<ErpConfirmationResponse>;
  perform?(
    request: ErpConfirmationRequest,
    produce: () => Promise<ErpConfirmationResponse>,
  ): Promise<ErpConfirmationResponse>;
}

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
  ledger?: ConfirmationLedger;
}

const successfulDecisionProvider: ConfirmationDecisionProvider = {
  decide: async () => ({ status: "succeeded" }),
};

export class ConfirmationService {
  private readonly decisionProvider: ConfirmationDecisionProvider;
  private readonly generateConfirmationId: () => string;
  private readonly now: () => Date;
  private readonly ledger: ConfirmationLedger;
  private readonly inFlight = new Map<
    string,
    { request: ErpConfirmationRequest; promise: Promise<ErpConfirmationResponse> }
  >();

  constructor(options: ConfirmationServiceOptions = {}) {
    this.decisionProvider = options.decisionProvider ?? successfulDecisionProvider;
    this.generateConfirmationId = options.generateConfirmationId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.ledger = options.ledger ?? new InMemoryConfirmationLedger();
  }

  async confirm(request: ErpConfirmationRequest): Promise<ErpConfirmationResponse> {
    const running = this.inFlight.get(request.idempotencyKey);
    if (running) {
      assertFingerprint(confirmationFingerprint(running.request), request);
      return running.promise;
    }
    const existingConfirmation = await this.ledger.get(request);
    if (existingConfirmation) return existingConfirmation;
    const concurrent = this.inFlight.get(request.idempotencyKey);
    if (concurrent) {
      assertFingerprint(confirmationFingerprint(concurrent.request), request);
      return concurrent.promise;
    }
    const operation = this.confirmFirst(request);
    this.inFlight.set(request.idempotencyKey, { request, promise: operation });
    try {
      return await operation;
    } finally {
      this.inFlight.delete(request.idempotencyKey);
    }
  }

  private async confirmFirst(request: ErpConfirmationRequest): Promise<ErpConfirmationResponse> {
    if (this.ledger.perform) {
      return this.ledger.perform(request, () => this.produceConfirmation(request));
    }
    const existingConfirmation = await this.ledger.get(request);
    if (existingConfirmation) return existingConfirmation;

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

export class InMemoryConfirmationLedger implements ConfirmationLedger {
  private readonly confirmations = new Map<
    string,
    { fingerprint: Record<string, unknown>; response: ErpConfirmationResponse }
  >();
  async get(request: ErpConfirmationRequest): Promise<ErpConfirmationResponse | null> {
    const existing = this.confirmations.get(request.idempotencyKey);
    if (!existing) return null;
    assertFingerprint(existing.fingerprint, request);
    return existing.response;
  }
  async remember(
    request: ErpConfirmationRequest,
    response: ErpConfirmationResponse,
  ): Promise<ErpConfirmationResponse> {
    const existing = this.confirmations.get(request.idempotencyKey);
    if (existing) {
      assertFingerprint(existing.fingerprint, request);
      return existing.response;
    }
    this.confirmations.set(request.idempotencyKey, {
      fingerprint: confirmationFingerprint(request),
      response,
    });
    return response;
  }

  async perform(
    request: ErpConfirmationRequest,
    produce: () => Promise<ErpConfirmationResponse>,
  ): Promise<ErpConfirmationResponse> {
    const existing = await this.get(request);
    if (existing) return existing;
    const response = await produce();
    return response.status === "succeeded" ? this.remember(request, response) : response;
  }
}

export function confirmationFingerprint(request: ErpConfirmationRequest): Record<string, unknown> {
  return {
    orderId: request.orderId,
    publicOrderId: request.publicOrderId,
    reservationId: request.reservationId,
    saleOfferId: request.saleOfferId,
    runId: request.runId ?? null,
    quantity: request.quantity,
  };
}

export function assertFingerprint(value: unknown, request: ErpConfirmationRequest): void {
  const expected = confirmationFingerprint(request);
  if (!jsonDeepEqual(value, expected)) {
    throw new ConfirmationIdempotencyConflictError(request.idempotencyKey);
  }
}
