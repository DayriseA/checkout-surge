import {
  type ErpCallReference,
  type ErpConfirmationResponse,
  type ErpLookupResponse,
  type ErpOutcomeDisposition,
  erpConfirmationLookupPath,
  erpConfirmationPath,
  erpConfirmationRequestSchema,
  erpConfirmationResponseSchema,
  erpLookupResponseSchema,
  erpPermanentRejectionCodeSchema,
  erpReplayedResponseHeaderName,
  erpReplayedResponseHeaderValue,
  type OrderProcessJob,
  recognizedErpErrorCodeDispositions,
} from "@checkout-surge/contracts";
import { type CheckoutSurgeLogger, correlationIdHeaderName } from "@checkout-surge/logger";
import type { OrderProcessDeliveryMetadata } from "./order-process-job-handler.js";
import { type RunConfigReader, toErpRequestConfig } from "./run-config.js";

export type ErpOperationKind = "dispatched_confirmation" | "status_lookup" | "non_call_deferral";

export interface ErpHealthLearningResult {
  erpHealthLearningEligible: boolean;
  response?: ErpConfirmationResponse;
}

export interface ErpAttemptRecord {
  job: OrderProcessJob;
  delivery: OrderProcessDeliveryMetadata;
  call?: ErpCallReference;
  operation?: Exclude<ErpOperationKind, "non_call_deferral">;
  replayed?: boolean;
  disposition?: ErpOutcomeDisposition;
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
  recordDispatchIntent(input: {
    job: OrderProcessJob;
    idempotencyKey: string;
    dispatchedAt: Date;
    expectedProcessingGeneration: number;
    supersedesErpCallId?: string;
  }): Promise<ErpCallReference>;
  recordAttempt(record: ErpAttemptRecord): Promise<boolean>;
  findUnresolvedCall?(orderId: string): Promise<ErpCallReference | null>;
}

export type ErpConfirmationOutcome = {
  disposition: ErpOutcomeDisposition;
  operation: "dispatched_confirmation";
  call: ErpCallReference;
  startedAt: Date;
  finishedAt: Date;
  latencyMs: number;
  replayed: boolean;
  response?: ErpConfirmationResponse;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  retryAfterMs?: number;
  interventionScope?: "order" | "scope";
  cause?: unknown;
};

export type ErpLookupOutcome =
  | {
      disposition: "succeeded";
      operation: "status_lookup";
      lookup: ErpLookupResponse;
      startedAt: Date;
      finishedAt: Date;
      latencyMs: number;
    }
  | {
      disposition: "temporarily_unavailable" | "intervention_required";
      operation: "status_lookup";
      startedAt: Date;
      finishedAt: Date;
      latencyMs: number;
      httpStatus?: number;
      errorCode?: string;
      errorMessage?: string;
      interventionScope?: "scope" | "order";
      cause?: unknown;
    };

export class ErpConfirmationFailedError extends Error {
  override readonly name = "ErpConfirmationFailedError";
  constructor(
    readonly response: ErpConfirmationResponse,
    readonly attemptRecorded = true,
    readonly outcome?: ErpConfirmationOutcome,
  ) {
    super(response.errorMessage ?? "The ERP rejected the confirmation request.");
  }
}

export class ErpConfirmationInvalidResponseError extends Error {
  override readonly name = "ErpConfirmationInvalidResponseError";
  constructor(
    readonly httpStatus: number,
    readonly attemptRecorded = true,
    readonly outcome?: ErpConfirmationOutcome,
  ) {
    super("The ERP returned an invalid confirmation response.");
  }
}

export class ErpConfirmationRequestError extends Error {
  override readonly name = "ErpConfirmationRequestError";
  constructor(
    cause: unknown,
    readonly attemptRecorded = true,
    readonly outcome?: ErpConfirmationOutcome,
  ) {
    super("The ERP confirmation request failed before a valid response was received.", { cause });
  }
}

export class ErpConfirmationTimeoutError extends Error {
  override readonly name = "ErpConfirmationTimeoutError";
  constructor(
    readonly timeoutMs: number,
    readonly attemptRecorded = true,
    readonly outcome?: ErpConfirmationOutcome,
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

export function isTemporaryErpDependencyError(error: unknown): boolean {
  if (isErpAttemptPersistenceError(error)) return false;
  if (
    error instanceof ErpConfirmationFailedError ||
    error instanceof ErpConfirmationInvalidResponseError ||
    error instanceof ErpConfirmationRequestError ||
    error instanceof ErpConfirmationTimeoutError
  ) {
    return (
      error.outcome?.disposition === "temporarily_unavailable" ||
      error.outcome?.disposition === "uncertain_result"
    );
  }
  return false;
}

export interface HttpErpOrderConfirmationOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  retryAfterPolicy: { fallbackDelayMs: number; maximumDelayMs: number };
  attemptPersistence: ErpAttemptPersistence;
  fetch?: typeof fetch;
  now?: () => Date;
  runConfigReader?: RunConfigReader;
  logger?: Pick<CheckoutSurgeLogger, "warn">;
}

export class HttpErpOrderConfirmation {
  private readonly confirmationUrl: URL;
  private readonly lookupUrl: URL;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: HttpErpOrderConfirmationOptions) {
    this.confirmationUrl = new URL(erpConfirmationPath, options.baseUrl);
    this.lookupUrl = new URL(erpConfirmationLookupPath, options.baseUrl);
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async dispatch(
    job: OrderProcessJob,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<ErpConfirmationOutcome> {
    const runConfig = job.runId ? await this.options.runConfigReader?.read(job.runId) : null;
    const timeoutMs = runConfig?.erpConfig.requestTimeoutMs ?? this.options.requestTimeoutMs;
    const startedAt = this.now();
    const call = await this.recordDispatchIntent({
      job,
      idempotencyKey: toConfirmationIdempotencyKey(job),
      dispatchedAt: startedAt,
      expectedProcessingGeneration: requireProcessingGeneration(delivery),
      ...(delivery.supersedesErpCallId
        ? { supersedesErpCallId: delivery.supersedesErpCallId }
        : {}),
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
      const body = await readResponseJson(response);
      const finishedAt = this.now();
      const outcome = classifyConfirmationResponse({
        response,
        body,
        call,
        startedAt,
        finishedAt,
        ...optional(
          "retryAfterMs",
          this.retryAfterMs(response.headers.get("retry-after"), finishedAt),
        ),
      });
      const record = toAttemptRecord(job, delivery, outcome);
      if (outcome.response?.status === "succeeded") {
        Object.defineProperty(record, "response", { value: outcome.response, enumerable: false });
      }
      await this.recordAttempt(record);
      return outcome;
    } catch (error) {
      if (isKnownClientError(error)) throw error;
      const finishedAt = this.now();
      const timedOut = isAbortError(error);
      const outcome: ErpConfirmationOutcome = {
        disposition: timedOut ? "uncertain_result" : "temporarily_unavailable",
        operation: "dispatched_confirmation",
        call,
        startedAt,
        finishedAt,
        latencyMs: elapsedMs(startedAt, finishedAt),
        replayed: false,
        errorCode: timedOut ? "erp_request_timeout" : "erp_request_failed",
        errorMessage: timedOut
          ? `The ERP confirmation request timed out after ${timeoutMs}ms.`
          : error instanceof Error
            ? error.message
            : "The ERP request failed.",
        cause: error,
      };
      await this.recordAttempt(toAttemptRecord(job, delivery, outcome));
      return outcome;
    } finally {
      clearTimeout(timeout);
    }
  }

  async lookup(idempotencyKey: string, correlationId: string): Promise<ErpLookupOutcome> {
    const startedAt = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      const url = new URL(this.lookupUrl);
      url.pathname = erpConfirmationLookupPath.replace(
        ":idempotencyKey",
        encodeURIComponent(idempotencyKey),
      );
      const response = await this.fetch(url, {
        headers: { [correlationIdHeaderName]: correlationId },
        signal: controller.signal,
      });
      const body = await readResponseJson(response);
      const finishedAt = this.now();
      const parsed = erpLookupResponseSchema.safeParse(body);
      if (response.ok && parsed.success) {
        return {
          disposition: "succeeded",
          operation: "status_lookup",
          lookup: parsed.data,
          startedAt,
          finishedAt,
          latencyMs: elapsedMs(startedAt, finishedAt),
        };
      }
      const scopeIntervention = response.status === 401 || response.status === 403;
      const availability = erpConfirmationResponseSchema.safeParse(body);
      const recognizedAvailability =
        availability.success &&
        availability.data.status === "failed" &&
        availability.data.httpStatus === response.status &&
        recognizedStatusMatches(availability.data.errorCode, response.status) &&
        recognizedErpErrorCodeDispositions[
          availability.data.errorCode as keyof typeof recognizedErpErrorCodeDispositions
        ] === "temporarily_unavailable";
      return {
        disposition: recognizedAvailability ? "temporarily_unavailable" : "intervention_required",
        operation: "status_lookup",
        startedAt,
        finishedAt,
        latencyMs: elapsedMs(startedAt, finishedAt),
        httpStatus: response.status,
        errorCode: readErrorCode(body) ?? "erp_invalid_lookup_response",
        errorMessage: "The ERP returned an invalid status lookup response.",
        interventionScope: scopeIntervention ? "scope" : "order",
      };
    } catch (error) {
      const finishedAt = this.now();
      return {
        disposition: "temporarily_unavailable",
        operation: "status_lookup",
        startedAt,
        finishedAt,
        latencyMs: elapsedMs(startedAt, finishedAt),
        errorCode: isAbortError(error) ? "erp_lookup_timeout" : "erp_lookup_failed",
        errorMessage: error instanceof Error ? error.message : "The ERP lookup failed.",
        cause: error,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  findSuccessfulAttempt(job: OrderProcessJob): Promise<ReusableErpConfirmationAttempt | null> {
    return this.readSuccessfulAttempt(job);
  }

  recordLookupResult(record: ErpAttemptRecord): Promise<boolean> {
    return this.recordAttempt(record);
  }

  findUnresolvedCall(orderId: string): Promise<ErpCallReference | null> {
    return this.options.attemptPersistence.findUnresolvedCall?.(orderId) ?? Promise.resolve(null);
  }

  private retryAfterMs(value: string | null, now: Date): number | undefined {
    if (value === null) return undefined;
    const parsed = parseRetryAfter(value, now);
    const requested = parsed ?? this.options.retryAfterPolicy.fallbackDelayMs;
    if (requested <= this.options.retryAfterPolicy.maximumDelayMs) return requested;
    this.options.logger?.warn(
      {
        retryAfter: value,
        requestedDelayMs: requested,
        maximumDelayMs: this.options.retryAfterPolicy.maximumDelayMs,
      },
      "ERP Retry-After exceeded the policy maximum and was capped.",
    );
    return this.options.retryAfterPolicy.maximumDelayMs;
  }

  private async recordDispatchIntent(input: {
    job: OrderProcessJob;
    idempotencyKey: string;
    dispatchedAt: Date;
    expectedProcessingGeneration: number;
    supersedesErpCallId?: string;
  }): Promise<ErpCallReference> {
    try {
      return await this.options.attemptPersistence.recordDispatchIntent(input);
    } catch (error) {
      throw new ErpAttemptPersistenceError(
        error,
        "The ERP dispatch intent could not be persisted before the confirmation request.",
      );
    }
  }

  private async recordAttempt(record: ErpAttemptRecord): Promise<boolean> {
    try {
      return await this.options.attemptPersistence.recordAttempt(record);
    } catch (error) {
      if (error instanceof Error && error.name === "ErpAttemptContradictionError") {
        throw new ErpConfirmationInvalidResponseError(record.httpStatus ?? 500, false, {
          disposition: "intervention_required",
          operation: "dispatched_confirmation",
          call: record.call as ErpCallReference,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          latencyMs: record.latencyMs,
          replayed: record.replayed ?? false,
          errorCode: "erp_attempt_contradiction",
          errorMessage: error.message,
          interventionScope: "order",
          cause: error,
        });
      }
      if (record.status === "succeeded") {
        throw new ErpAcceptedConfirmationPersistenceError(error, record);
      }
      throw new ErpAttemptPersistenceError(error);
    }
  }

  private async readSuccessfulAttempt(
    job: OrderProcessJob,
  ): Promise<ReusableErpConfirmationAttempt | null> {
    try {
      return await this.options.attemptPersistence.findSuccessfulAttempt(job);
    } catch (error) {
      throw new ErpAttemptPersistenceError(error);
    }
  }
}

function classifyConfirmationResponse(input: {
  response: Response;
  body: unknown;
  call: ErpCallReference;
  startedAt: Date;
  finishedAt: Date;
  retryAfterMs?: number;
}): ErpConfirmationOutcome {
  const parsed = erpConfirmationResponseSchema.safeParse(input.body);
  const errorCode = parsed.success ? parsed.data.errorCode : readErrorCode(input.body);
  const common = {
    operation: "dispatched_confirmation" as const,
    call: input.call,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    latencyMs: elapsedMs(input.startedAt, input.finishedAt),
    replayed:
      input.response.headers.get(erpReplayedResponseHeaderName) === erpReplayedResponseHeaderValue,
    httpStatus: input.response.status,
    ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
  };
  if (parsed.success && parsed.data.httpStatus === input.response.status) {
    if (parsed.data.status === "succeeded") {
      return { ...common, disposition: "succeeded", response: parsed.data };
    }
    const failed = parsed.data;
    if (erpPermanentRejectionCodeSchema.safeParse(failed.errorCode).success) {
      return {
        ...common,
        disposition: "permanent_rejection",
        response: failed,
        errorCode: failed.errorCode,
      };
    }
    const disposition =
      recognizedErpErrorCodeDispositions[
        failed.errorCode as keyof typeof recognizedErpErrorCodeDispositions
      ];
    if (disposition && recognizedStatusMatches(failed.errorCode, input.response.status)) {
      return {
        ...common,
        disposition,
        response: failed,
        errorCode: failed.errorCode,
        errorMessage: failed.errorMessage,
        ...(disposition === "intervention_required" ? { interventionScope: "order" as const } : {}),
      };
    }
  }
  if (input.response.status === 409 && errorCode === "erp_idempotency_conflict") {
    return {
      ...common,
      disposition: "intervention_required",
      errorCode,
      ...optional("errorMessage", readErrorMessage(input.body)),
      interventionScope: "order",
    };
  }
  if (input.response.status === 401 || input.response.status === 403) {
    return {
      ...common,
      disposition: "intervention_required",
      errorCode: errorCode ?? `erp_http_${input.response.status}`,
      ...optional("errorMessage", readErrorMessage(input.body)),
      interventionScope: "scope",
    };
  }
  return {
    ...common,
    disposition: "intervention_required",
    errorCode: errorCode ?? "erp_invalid_response",
    errorMessage: readErrorMessage(input.body) ?? "The ERP returned an invalid response.",
    interventionScope: "order",
  };
}

function toAttemptRecord(
  job: OrderProcessJob,
  delivery: OrderProcessDeliveryMetadata,
  outcome: ErpConfirmationOutcome,
): ErpAttemptRecord {
  return {
    job,
    delivery,
    call: outcome.call,
    operation: outcome.operation,
    replayed: outcome.replayed,
    disposition: outcome.disposition,
    status:
      outcome.disposition === "succeeded"
        ? "succeeded"
        : outcome.disposition === "uncertain_result"
          ? "timed_out"
          : "failed",
    terminal: outcome.disposition === "succeeded" || outcome.disposition === "permanent_rejection",
    ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
    latencyMs: outcome.latencyMs,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    ...(outcome.response ? { response: outcome.response } : {}),
  };
}

function recognizedStatusMatches(code: string, status: number): boolean {
  if (code === "erp_capacity_exceeded") return status === 429;
  if (code === "erp_forced_outage" || code === "erp_injected_error") return status === 503;
  if (code === "erp_idempotency_conflict") return status === 409;
  return false;
}

export function parseRetryAfter(value: string, now: Date): number | null {
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/.test(
      value,
    )
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) || new Date(timestamp).toUTCString() !== value
    ? null
    : Math.max(0, timestamp - now.getTime());
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function readErrorCode(body: unknown): string | undefined {
  return isRecord(body) && typeof body.code === "string"
    ? body.code
    : isRecord(body) && typeof body.errorCode === "string"
      ? body.errorCode
      : undefined;
}

function readErrorMessage(body: unknown): string | undefined {
  return isRecord(body) && typeof body.message === "string"
    ? body.message
    : isRecord(body) && typeof body.errorMessage === "string"
      ? body.errorMessage
      : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optional<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [K in Key]?: Value } {
  return value === undefined ? {} : ({ [key]: value } as { [K in Key]: Value });
}

function isKnownClientError(error: unknown): boolean {
  return (
    error instanceof ErpAttemptPersistenceError ||
    error instanceof ErpConfirmationInvalidResponseError
  );
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

export function toConfirmationIdempotencyKey(job: OrderProcessJob): string {
  return `erp-confirmation:${job.orderId}`;
}

function elapsedMs(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
