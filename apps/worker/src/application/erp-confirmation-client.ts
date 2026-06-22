import {
  type ErpConfirmationResponse,
  erpConfirmationPath,
  erpConfirmationRequestSchema,
  erpConfirmationResponseSchema,
  type OrderProcessJob,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName } from "@checkout-surge/logger";
import type {
  OrderConfirmation,
  OrderProcessDeliveryMetadata,
} from "./order-process-job-handler.js";

export interface ErpAttemptRecord {
  job: OrderProcessJob;
  delivery: OrderProcessDeliveryMetadata;
  status: "succeeded" | "failed" | "timed_out";
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  latencyMs: number;
  startedAt: Date;
  finishedAt: Date;
}

export interface ErpAttemptPersistence {
  recordAttempt(record: ErpAttemptRecord): Promise<void>;
}

export class ErpConfirmationFailedError extends Error {
  override readonly name = "ErpConfirmationFailedError";

  constructor(readonly response: ErpConfirmationResponse) {
    super(response.errorMessage ?? "The ERP rejected the confirmation request.");
  }
}

export class ErpConfirmationInvalidResponseError extends Error {
  override readonly name = "ErpConfirmationInvalidResponseError";

  constructor(readonly httpStatus: number) {
    super("The ERP returned an invalid confirmation response.");
  }
}

export class ErpConfirmationRequestError extends Error {
  override readonly name = "ErpConfirmationRequestError";

  constructor(cause: unknown) {
    super("The ERP confirmation request failed before a valid response was received.", { cause });
  }
}

export class ErpConfirmationTimeoutError extends Error {
  override readonly name = "ErpConfirmationTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`The ERP confirmation request timed out after ${timeoutMs}ms.`);
  }
}

export interface HttpErpOrderConfirmationOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  attemptPersistence: ErpAttemptPersistence;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class HttpErpOrderConfirmation implements OrderConfirmation {
  private readonly confirmationUrl: URL;
  private readonly requestTimeoutMs: number;
  private readonly attemptPersistence: ErpAttemptPersistence;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(options: HttpErpOrderConfirmationOptions) {
    this.confirmationUrl = new URL(erpConfirmationPath, options.baseUrl);
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.attemptPersistence = options.attemptPersistence;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async confirm(job: OrderProcessJob, delivery: OrderProcessDeliveryMetadata): Promise<void> {
    const startedAt = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetch(this.confirmationUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [correlationIdHeaderName]: job.correlationId,
        },
        body: JSON.stringify(toConfirmationRequest(job)),
        signal: controller.signal,
      });
      const parsed = await parseConfirmationResponse(response);
      const finishedAt = this.now();
      const record = toAttemptRecord({
        job,
        delivery,
        response: parsed,
        fallbackHttpStatus: response.status,
        startedAt,
        finishedAt,
      });
      await this.attemptPersistence.recordAttempt(record);

      if (parsed.status === "failed") {
        throw new ErpConfirmationFailedError(parsed);
      }

      return;
    } catch (error) {
      if (isAbortError(error)) {
        const finishedAt = this.now();
        await this.attemptPersistence.recordAttempt({
          job,
          delivery,
          status: "timed_out",
          errorCode: "erp_request_timeout",
          errorMessage: `The ERP confirmation request timed out after ${this.requestTimeoutMs}ms.`,
          latencyMs: elapsedMs(startedAt, finishedAt),
          startedAt,
          finishedAt,
        });
        throw new ErpConfirmationTimeoutError(this.requestTimeoutMs);
      }

      if (error instanceof ErpConfirmationFailedError) {
        throw error;
      }

      if (error instanceof ErpConfirmationInvalidResponseError) {
        const finishedAt = this.now();
        await this.attemptPersistence.recordAttempt({
          job,
          delivery,
          status: "failed",
          httpStatus: error.httpStatus,
          errorCode: "erp_invalid_response",
          errorMessage: error.message,
          latencyMs: elapsedMs(startedAt, finishedAt),
          startedAt,
          finishedAt,
        });
        throw error;
      }

      const finishedAt = this.now();
      await this.attemptPersistence.recordAttempt({
        job,
        delivery,
        status: "failed",
        errorCode: "erp_request_failed",
        errorMessage: error instanceof Error ? error.message : "The ERP request failed.",
        latencyMs: elapsedMs(startedAt, finishedAt),
        startedAt,
        finishedAt,
      });
      throw new ErpConfirmationRequestError(error);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toConfirmationRequest(job: OrderProcessJob) {
  return erpConfirmationRequestSchema.parse({
    orderId: job.orderId,
    publicOrderId: job.publicOrderId,
    reservationId: job.reservationId,
    saleOfferId: job.saleOfferId,
    ...(job.runId ? { runId: job.runId } : {}),
    correlationId: job.correlationId,
    quantity: job.quantity,
  });
}

async function parseConfirmationResponse(response: Response): Promise<ErpConfirmationResponse> {
  const body = await response.json().catch(() => null);
  const parsed = erpConfirmationResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw new ErpConfirmationInvalidResponseError(response.status);
  }

  return parsed.data;
}

function toAttemptRecord(options: {
  job: OrderProcessJob;
  delivery: OrderProcessDeliveryMetadata;
  response: ErpConfirmationResponse;
  fallbackHttpStatus: number;
  startedAt: Date;
  finishedAt: Date;
}): ErpAttemptRecord {
  const status = options.response.status === "succeeded" ? "succeeded" : "failed";

  return {
    job: options.job,
    delivery: options.delivery,
    status,
    httpStatus: options.response.httpStatus ?? options.fallbackHttpStatus,
    ...(options.response.errorCode ? { errorCode: options.response.errorCode } : {}),
    ...(options.response.errorMessage ? { errorMessage: options.response.errorMessage } : {}),
    latencyMs: elapsedMs(options.startedAt, options.finishedAt),
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
  };
}

function elapsedMs(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
