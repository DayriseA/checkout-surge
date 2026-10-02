import { randomUUID } from "node:crypto";
import {
  type ErpConfirmationRequest,
  type ErpConfirmationResponse,
  type ErpLookupIdentity,
  type ErpLookupResponse,
  erpConfirmationResponseSchema,
  erpLookupResponseSchema,
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

export interface ConfirmationLedgerEntry {
  identity: ErpLookupIdentity;
  response: Extract<ErpConfirmationResponse, { status: "succeeded" }>;
}

export interface ConfirmationLedger {
  find(idempotencyKey: string): Promise<ConfirmationLedgerEntry | null>;
  save(entry: ConfirmationLedgerEntry): Promise<{
    entry: ConfirmationLedgerEntry;
    inserted: boolean;
  }>;
}

export interface ConfirmationServiceOptions {
  decisionProvider?: ConfirmationDecisionProvider;
  generateConfirmationId?: () => string;
  ledger?: ConfirmationLedger;
  now?: () => Date;
}

export interface ConfirmationResult {
  response: ErpConfirmationResponse;
  replayed: boolean;
}

const successfulDecisionProvider: ConfirmationDecisionProvider = {
  decide: async () => ({ status: "succeeded" }),
};

export class ConfirmationService {
  private readonly decisionProvider: ConfirmationDecisionProvider;
  private readonly generateConfirmationId: () => string;
  private readonly ledger: ConfirmationLedger;
  private readonly now: () => Date;
  private readonly inFlight = new Map<
    string,
    { identity: ErpLookupIdentity; promise: Promise<ConfirmationResult> }
  >();

  constructor(options: ConfirmationServiceOptions = {}) {
    this.decisionProvider = options.decisionProvider ?? successfulDecisionProvider;
    this.generateConfirmationId = options.generateConfirmationId ?? randomUUID;
    this.ledger = options.ledger ?? new InMemoryConfirmationLedger();
    this.now = options.now ?? (() => new Date());
  }

  async confirm(request: ErpConfirmationRequest): Promise<ConfirmationResult> {
    const running = this.inFlight.get(request.idempotencyKey);
    if (running) {
      assertSameConfirmationIdentity(running.identity, request);
      const result = await running.promise;
      return {
        response: result.response,
        replayed: result.replayed || isTerminalResponse(result.response),
      };
    }

    const operation = this.confirmOrReplay(request);
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

  async lookup(idempotencyKey: string): Promise<ErpLookupResponse> {
    const existing = await this.ledger.find(idempotencyKey);
    return erpLookupResponseSchema.parse({
      lookup: existing
        ? {
            status: "succeeded",
            identity: existing.identity,
            result: existing.response,
          }
        : { status: "unknown", idempotencyKey },
      timestamp: this.now().toISOString(),
    });
  }

  private async confirmOrReplay(request: ErpConfirmationRequest): Promise<ConfirmationResult> {
    const existing = await this.ledger.find(request.idempotencyKey);
    if (existing) {
      assertSameConfirmationIdentity(existing.identity, request);
      return { response: existing.response, replayed: true };
    }

    const response = await this.produceConfirmation(request);
    if (!isTerminalResponse(response)) return { response, replayed: false };

    const saved = await this.ledger.save({
      identity: confirmationIdentity(request),
      response,
    });
    assertSameConfirmationIdentity(saved.entry.identity, request);
    return { response: saved.entry.response, replayed: !saved.inserted };
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
  private readonly confirmations = new Map<string, ConfirmationLedgerEntry>();

  async find(idempotencyKey: string): Promise<ConfirmationLedgerEntry | null> {
    return this.confirmations.get(idempotencyKey) ?? null;
  }

  async save(entry: ConfirmationLedgerEntry): Promise<{
    entry: ConfirmationLedgerEntry;
    inserted: boolean;
  }> {
    const existing = this.confirmations.get(entry.identity.idempotencyKey);
    if (existing) return { entry: existing, inserted: false };
    this.confirmations.set(entry.identity.idempotencyKey, entry);
    return { entry, inserted: true };
  }
}

function isTerminalResponse(
  response: ErpConfirmationResponse,
): response is Extract<ErpConfirmationResponse, { status: "succeeded" }> {
  return response.status === "succeeded";
}

function assertSameConfirmationIdentity(
  existing: ErpLookupIdentity,
  request: ErpConfirmationRequest,
): void {
  const received = confirmationIdentity(request);
  if (
    existing.orderId !== received.orderId ||
    existing.publicOrderId !== received.publicOrderId ||
    existing.reservationId !== received.reservationId ||
    existing.saleOfferId !== received.saleOfferId ||
    existing.runId !== received.runId ||
    existing.quantity !== received.quantity
  ) {
    throw new ConfirmationIdempotencyConflictError(request.idempotencyKey);
  }
}

function confirmationIdentity(request: ErpConfirmationRequest): ErpLookupIdentity {
  return {
    orderId: request.orderId.toLowerCase(),
    publicOrderId: request.publicOrderId,
    reservationId: request.reservationId.toLowerCase(),
    saleOfferId: request.saleOfferId.toLowerCase(),
    runId: request.runId.toLowerCase(),
    idempotencyKey: request.idempotencyKey,
    quantity: request.quantity,
  };
}
