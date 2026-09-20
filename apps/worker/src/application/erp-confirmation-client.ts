import {
  type ErpCallReference,
  type ErpConfirmationResponse,
  erpConfirmationPath,
  erpConfirmationRequestSchema,
  erpConfirmationResponseSchema,
  type OrderProcessJob,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName } from "@checkout-surge/logger";
import {
  hasRemainingAttempts,
  type OrderConfirmation,
  type OrderProcessDeliveryMetadata,
} from "./order-process-job-handler.js";
import { type RunConfigReader, toErpRequestConfig } from "./run-config.js";

export interface ErpAttemptRecord {
  job: OrderProcessJob;
  delivery: OrderProcessDeliveryMetadata;
  /** Durable identity of the actual ERP call this attempt result belongs to. */
  call?: ErpCallReference;
  status: "succeeded" | "failed" | "timed_out";
  terminal: boolean;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  latencyMs: number;
  startedAt: Date;
  finishedAt: Date;
  response?: ErpConfirmationResponse;
}

export interface ReusableErpConfirmationAttempt {
  orderId: string;
  attemptNumber: number;
  httpStatus?: number;
  finishedAt: Date;
}

export interface ErpAttemptPersistence {
  findSuccessfulAttempt(job: OrderProcessJob): Promise<ReusableErpConfirmationAttempt | null>;
  /**
   * Records the durable identity of one actual confirmation POST before the
   * HTTP request is sent (D04/D05), so a crash cannot erase the existence of
   * an uncertain attempt.
   */
  recordDispatchIntent(input: {
    job: OrderProcessJob;
    idempotencyKey: string;
    dispatchedAt: Date;
    expectedProcessingGeneration: number;
  }): Promise<ErpCallReference>;
  recordAttempt(record: ErpAttemptRecord): Promise<boolean>;
}

export class ErpConfirmationFailedError extends Error {
  override readonly name = "ErpConfirmationFailedError";

  constructor(
    readonly response: ErpConfirmationResponse,
    readonly attemptRecorded = true,
  ) {
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

  constructor(
    readonly timeoutMs: number,
    readonly attemptRecorded = true,
  ) {
    super(`The ERP confirmation request timed out after ${timeoutMs}ms.`);
  }
}

export class ErpAttemptPersistenceError extends Error {
  override readonly name: string = "ErpAttemptPersistenceError";

  constructor(cause: unknown, message = "The ERP attempt result could not be persisted.") {
    super(message, { cause });
  }
}

export class ErpAcceptedConfirmationPersistenceError extends ErpAttemptPersistenceError {
  override readonly name = "ErpAcceptedConfirmationPersistenceError";

  constructor(
    cause: unknown,
    readonly record: ErpAttemptRecord,
  ) {
    super(
      cause,
      "The ERP accepted the confirmation, but the successful attempt result could not be persisted.",
    );
  }
}

export function isErpAttemptPersistenceError(error: unknown): error is ErpAttemptPersistenceError {
  return error instanceof ErpAttemptPersistenceError;
}

export function isAcceptedErpConfirmationPersistenceError(
  error: unknown,
): error is ErpAcceptedConfirmationPersistenceError {
  return error instanceof ErpAcceptedConfirmationPersistenceError;
}

export function isTemporaryErpConfirmationError(error: unknown): boolean {
  if (
    isErpAttemptPersistenceError(error) ||
    error instanceof ErpConfirmationTimeoutError ||
    error instanceof ErpConfirmationRequestError ||
    error instanceof ErpConfirmationInvalidResponseError
  ) {
    return true;
  }

  if (!(error instanceof ErpConfirmationFailedError)) {
    return false;
  }

  const httpStatus = error.response.httpStatus;
  return httpStatus === undefined || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
}

export function isTemporaryErpDependencyError(error: unknown): boolean {
  if (isErpAttemptPersistenceError(error)) {
    return false;
  }

  return isTemporaryErpConfirmationError(error);
}

export interface HttpErpOrderConfirmationOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  attemptPersistence: ErpAttemptPersistence;
  fetch?: typeof fetch;
  now?: () => Date;
  runConfigReader?: RunConfigReader;
}

export class HttpErpOrderConfirmation implements OrderConfirmation {
  private readonly confirmationUrl: URL;
  private readonly requestTimeoutMs: number;
  private readonly attemptPersistence: ErpAttemptPersistence;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly runConfigReader: RunConfigReader | undefined;

  constructor(options: HttpErpOrderConfirmationOptions) {
    this.confirmationUrl = new URL(erpConfirmationPath, options.baseUrl);
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.attemptPersistence = options.attemptPersistence;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.runConfigReader = options.runConfigReader;
  }

  async confirm(
    job: OrderProcessJob,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<ErpConfirmationResponse | undefined> {
    const reusableAttempt = await this.findSuccessfulAttempt(job);
    if (reusableAttempt) {
      return;
    }

    const runConfig = job.runId ? await this.runConfigReader?.read(job.runId) : null;
    const requestTimeoutMs = runConfig?.erpConfig.requestTimeoutMs ?? this.requestTimeoutMs;
    const startedAt = this.now();
    // Dispatch intent precedes the HTTP request: the durable per-call identity
    // exists even if this process dies before a response arrives.
    const call = await this.recordDispatchIntent({
      job,
      idempotencyKey: toConfirmationIdempotencyKey(job),
      dispatchedAt: startedAt,
      expectedProcessingGeneration: requireProcessingGeneration(delivery),
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await this.fetch(this.confirmationUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [correlationIdHeaderName]: job.correlationId,
        },
        body: JSON.stringify(toConfirmationRequest(job, runConfig)),
        signal: controller.signal,
      });
      const parsed = await parseConfirmationResponse(response);
      const finishedAt = this.now();
      const record = toAttemptRecord({
        job,
        delivery,
        call,
        response: parsed,
        fallbackHttpStatus: response.status,
        startedAt,
        finishedAt,
      });
      if (parsed.status === "succeeded") {
        Object.defineProperty(record, "response", { value: parsed, enumerable: false });
      }
      const attemptRecorded = await this.recordAttempt(record);

      if (parsed.status !== "succeeded") {
        throw new ErpConfirmationFailedError(parsed, attemptRecorded);
      }

      return parsed;
    } catch (error) {
      if (isAbortError(error)) {
        const finishedAt = this.now();
        const attemptRecorded = await this.recordAttempt({
          job,
          delivery,
          call,
          status: "timed_out",
          terminal: !hasRemainingAttempts(delivery),
          errorCode: "erp_request_timeout",
          errorMessage: `The ERP confirmation request timed out after ${requestTimeoutMs}ms.`,
          latencyMs: elapsedMs(startedAt, finishedAt),
          startedAt,
          finishedAt,
        });
        throw new ErpConfirmationTimeoutError(requestTimeoutMs, attemptRecorded);
      }

      if (
        error instanceof ErpConfirmationFailedError ||
        error instanceof ErpAttemptPersistenceError
      ) {
        throw error;
      }

      if (error instanceof ErpConfirmationInvalidResponseError) {
        const finishedAt = this.now();
        const attemptRecorded = await this.recordAttempt({
          job,
          delivery,
          call,
          status: "failed",
          terminal: !hasRemainingAttempts(delivery),
          httpStatus: error.httpStatus,
          errorCode: "erp_invalid_response",
          errorMessage: error.message,
          latencyMs: elapsedMs(startedAt, finishedAt),
          startedAt,
          finishedAt,
        });
        Object.defineProperty(error, "attemptRecorded", { value: attemptRecorded });
        throw error;
      }

      const finishedAt = this.now();
      const attemptRecorded = await this.recordAttempt({
        job,
        delivery,
        call,
        status: "failed",
        terminal: !hasRemainingAttempts(delivery),
        errorCode: "erp_request_failed",
        errorMessage: error instanceof Error ? error.message : "The ERP request failed.",
        latencyMs: elapsedMs(startedAt, finishedAt),
        startedAt,
        finishedAt,
      });
      const requestError = new ErpConfirmationRequestError(error);
      Object.defineProperty(requestError, "attemptRecorded", { value: attemptRecorded });
      throw requestError;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async recordDispatchIntent(input: {
    job: OrderProcessJob;
    idempotencyKey: string;
    dispatchedAt: Date;
    expectedProcessingGeneration: number;
  }): Promise<ErpCallReference> {
    try {
      return await this.attemptPersistence.recordDispatchIntent(input);
    } catch (error) {
      throw new ErpAttemptPersistenceError(
        error,
        "The ERP dispatch intent could not be persisted before the confirmation request.",
      );
    }
  }

  private async recordAttempt(record: ErpAttemptRecord): Promise<boolean> {
    try {
      return await this.attemptPersistence.recordAttempt(record);
    } catch (error) {
      if (record.status === "succeeded") {
        throw new ErpAcceptedConfirmationPersistenceError(error, record);
      }
      throw new ErpAttemptPersistenceError(error);
    }
  }

  private async findSuccessfulAttempt(
    job: OrderProcessJob,
  ): Promise<ReusableErpConfirmationAttempt | null> {
    try {
      return await this.attemptPersistence.findSuccessfulAttempt(job);
    } catch (error) {
      throw new ErpAttemptPersistenceError(error);
    }
  }
}

function requireProcessingGeneration(delivery: OrderProcessDeliveryMetadata): number {
  if (delivery.processingGeneration === undefined) {
    throw new ErpAttemptPersistenceError(
      new Error("The delivery has no processing generation."),
      "The ERP dispatch intent could not be persisted before the confirmation request.",
    );
  }
  return delivery.processingGeneration;
}

function toConfirmationRequest(
  job: OrderProcessJob,
  runConfig: Awaited<ReturnType<RunConfigReader["read"]>> | null | undefined,
) {
  return erpConfirmationRequestSchema.parse({
    orderId: job.orderId,
    publicOrderId: job.publicOrderId,
    reservationId: job.reservationId,
    saleOfferId: job.saleOfferId,
    ...(job.runId ? { runId: job.runId } : {}),
    idempotencyKey: toConfirmationIdempotencyKey(job),
    ...(runConfig ? { erpConfig: toErpRequestConfig(runConfig) } : {}),
    correlationId: job.correlationId,
    quantity: job.quantity,
  });
}

function toConfirmationIdempotencyKey(job: OrderProcessJob): string {
  return `erp-confirmation:${job.orderId}`;
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
  call: ErpCallReference;
  response: ErpConfirmationResponse;
  fallbackHttpStatus: number;
  startedAt: Date;
  finishedAt: Date;
}): ErpAttemptRecord {
  const status = options.response.status === "succeeded" ? "succeeded" : "failed";
  const terminal =
    status === "succeeded" ||
    !isTemporaryErpConfirmationError(new ErpConfirmationFailedError(options.response)) ||
    !hasRemainingAttempts(options.delivery);

  return {
    job: options.job,
    delivery: options.delivery,
    call: options.call,
    status,
    terminal,
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
