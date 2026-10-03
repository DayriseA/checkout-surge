import {
  controlServiceTokenHeaderName,
  healthReadyPath,
  type RunnerIdentity,
  type RunnerShutdownRequest,
  type RunnerShutdownResponse,
  runnerControlPath,
  runnerIdentitySchema,
  runnerShutdownPath,
  runnerShutdownResponseSchema,
  type TrafficExecutionAbortResponse,
  type TrafficExecutionStartRequest,
  type TrafficExecutionStartResponse,
  trafficExecutionAbortPath,
  trafficExecutionAbortRequestSchema,
  trafficExecutionAbortResponseSchema,
  trafficExecutionStartPath,
  trafficExecutionStartRequestSchema,
  trafficExecutionStartResponseSchema,
  trafficExecutionStatusPath,
  trafficExecutionStatusResponseSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName } from "@checkout-surge/logger";
import { ApiHttpError } from "../runtime/errors.js";

const defaultStartRequestTimeoutMs = 5_000;
const defaultAbortRequestTimeoutMs = 20_000;
// The runner readiness check probes the API and the k6 binary, each bounded at 2 to 3 seconds.
const runnerControlRequestTimeoutMs = 6_000;

export interface TrafficExecutionGateway {
  start(request: TrafficExecutionStartRequest): Promise<TrafficExecutionStartResponse>;
}

export interface TrafficAbortGateway {
  abortCurrent(input: {
    runId: string;
    reason: string;
    correlationId: string;
  }): Promise<Pick<TrafficExecutionAbortResponse, "outcome">>;
}

/** Runner control calls that do not start traffic. */
export interface RunnerControlGateway {
  isReady(): Promise<boolean>;
  readIdentity(): Promise<RunnerIdentity>;
  shutdown(request: RunnerShutdownRequest): Promise<RunnerShutdownResponse["outcome"]>;
}

export class HttpTrafficExecutionGateway
  implements TrafficExecutionGateway, TrafficAbortGateway, RunnerControlGateway
{
  constructor(
    private readonly options: {
      loadOrchestratorBaseUrl: string;
      controlServiceToken: string;
      requestTimeoutMs?: number;
      abortRequestTimeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {}

  async start(request: TrafficExecutionStartRequest): Promise<TrafficExecutionStartResponse> {
    const startRequest = trafficExecutionStartRequestSchema.parse(request);
    const requestTimeoutMs = this.options.requestTimeoutMs ?? defaultStartRequestTimeoutMs;
    let receivedResponse: Response | undefined;

    try {
      const result = await runBoundedTrafficRequest(
        requestTimeoutMs,
        () => new TrafficStartTimeoutError(),
        async (signal) => {
          receivedResponse = await this.fetch(
            trafficExecutionUrl(this.options.loadOrchestratorBaseUrl, trafficExecutionStartPath),
            {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                [correlationIdHeaderName]: startRequest.correlationId,
                [controlServiceTokenHeaderName]: this.options.controlServiceToken,
              },
              body: JSON.stringify(startRequest),
              signal,
            },
          );
          const payload = await receivedResponse.json().catch(() => null);
          if (!receivedResponse.ok) {
            return {
              outcome: "rejected",
              statusCode: receivedResponse.status,
              payload,
            } as const;
          }

          const confirmation = parseStartConfirmation(payload, startRequest);
          return { outcome: "accepted", confirmation } as const;
        },
      );

      if (result.outcome === "rejected") {
        if (isDefinitiveStartRejection(result.statusCode)) {
          throw new TrafficStartRejectedError(result.statusCode, result.payload);
        }
        throw new TrafficStartNonDefinitiveResponseError();
      }
      return result.confirmation;
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      if (
        receivedResponse &&
        !receivedResponse.ok &&
        isDefinitiveStartRejection(receivedResponse.status)
      ) {
        throw new TrafficStartRejectedError(receivedResponse.status, null);
      }

      const recovered = await this.recoverAmbiguousStart(startRequest, requestTimeoutMs).catch(
        () => null,
      );
      if (recovered) return recovered;
      throw new ApiHttpError({
        statusCode: 502,
        code: "load_orchestrator_start_ambiguous",
        message: "The load orchestrator start outcome could not be confirmed.",
      });
    }
  }

  async abortCurrent(input: {
    runId: string;
    reason: string;
    correlationId: string;
  }): Promise<TrafficExecutionAbortResponse> {
    const request = trafficExecutionAbortRequestSchema.parse(input);
    const abortTimeoutMs = this.options.abortRequestTimeoutMs ?? defaultAbortRequestTimeoutMs;
    let result: { response: Response; confirmation?: TrafficExecutionAbortResponse };

    try {
      result = await runBoundedTrafficRequest(
        abortTimeoutMs,
        () => new TrafficAbortTimeoutError(),
        async (signal) => {
          const response = await this.fetch(
            trafficExecutionUrl(this.options.loadOrchestratorBaseUrl, trafficExecutionAbortPath),
            {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                [correlationIdHeaderName]: request.correlationId ?? input.correlationId,
                [controlServiceTokenHeaderName]: this.options.controlServiceToken,
              },
              body: JSON.stringify(request),
              signal,
            },
          );
          if (!response.ok) return { response };
          try {
            return {
              response,
              confirmation: trafficExecutionAbortResponseSchema.parse(await response.json()),
            };
          } catch {
            throw new TrafficAbortInvalidResponseError();
          }
        },
      );
    } catch (error) {
      if (error instanceof TrafficAbortInvalidResponseError) {
        throw new ApiHttpError({
          statusCode: 502,
          code: "load_orchestrator_unavailable",
          message: "The load orchestrator returned an invalid abort confirmation.",
        });
      }
      throw new ApiHttpError({
        statusCode: 502,
        code: "load_orchestrator_abort_unconfirmed",
        message: "Traffic termination could not be confirmed.",
      });
    }

    if (!result.response.ok) {
      if (result.response.status === 409) {
        throw new ApiHttpError({
          statusCode: 409,
          code: "load_orchestrator_run_mismatch",
          message: "The load orchestrator is running a different demo run.",
        });
      }
      throw new ApiHttpError({
        statusCode: 502,
        code: "load_orchestrator_abort_unconfirmed",
        message: "Traffic termination could not be confirmed.",
      });
    }

    const confirmation = result.confirmation;
    if (
      !confirmation ||
      confirmation.requestedRunId !== input.runId ||
      confirmation.correlationId !== input.correlationId
    ) {
      throw new ApiHttpError({
        statusCode: 502,
        code: "load_orchestrator_unavailable",
        message: "The load orchestrator returned an invalid abort confirmation.",
      });
    }
    return confirmation;
  }

  async isReady(): Promise<boolean> {
    try {
      return await runBoundedTrafficRequest(
        runnerControlRequestTimeoutMs,
        () => new RunnerControlTimeoutError(),
        async (signal) =>
          (
            await this.fetch(
              trafficExecutionUrl(this.options.loadOrchestratorBaseUrl, healthReadyPath),
              { signal },
            )
          ).ok,
      );
    } catch {
      return false;
    }
  }

  readIdentity(): Promise<RunnerIdentity> {
    return runBoundedTrafficRequest(
      runnerControlRequestTimeoutMs,
      () => new RunnerControlTimeoutError(),
      async (signal) => {
        const response = await this.fetch(
          trafficExecutionUrl(this.options.loadOrchestratorBaseUrl, runnerControlPath),
          {
            headers: {
              accept: "application/json",
              [controlServiceTokenHeaderName]: this.options.controlServiceToken,
            },
            signal,
          },
        );
        if (!response.ok) throw new Error(`Runner control answered ${response.status}.`);
        return runnerIdentitySchema.parse(await response.json());
      },
    );
  }

  shutdown(request: RunnerShutdownRequest): Promise<RunnerShutdownResponse["outcome"]> {
    return runBoundedTrafficRequest(
      runnerControlRequestTimeoutMs,
      () => new RunnerControlTimeoutError(),
      async (signal) => {
        const response = await this.fetch(
          trafficExecutionUrl(this.options.loadOrchestratorBaseUrl, runnerShutdownPath),
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              [controlServiceTokenHeaderName]: this.options.controlServiceToken,
            },
            body: JSON.stringify(request),
            signal,
          },
        );
        if (!response.ok) throw new Error(`Runner shutdown answered ${response.status}.`);
        const answer = runnerShutdownResponseSchema.parse(await response.json());
        if (answer.runId !== request.runId || answer.bootId !== request.bootId) {
          throw new Error("Runner shutdown answer is bound to a different run or boot.");
        }
        return answer.outcome;
      },
    );
  }

  private async recoverAmbiguousStart(
    request: TrafficExecutionStartRequest,
    requestTimeoutMs: number,
  ): Promise<TrafficExecutionStartResponse | null> {
    return runBoundedTrafficRequest(
      requestTimeoutMs,
      () => new TrafficStatusTimeoutError(),
      async (signal) => {
        const statusPath = trafficExecutionStatusPath.replace(":runId", request.runId);
        const response = await this.fetch(
          trafficExecutionUrl(this.options.loadOrchestratorBaseUrl, statusPath),
          {
            headers: {
              accept: "application/json",
              [correlationIdHeaderName]: request.correlationId,
              [controlServiceTokenHeaderName]: this.options.controlServiceToken,
            },
            signal,
          },
        );
        if (!response.ok) return null;

        let status: ReturnType<typeof trafficExecutionStatusResponseSchema.parse>;
        try {
          status = trafficExecutionStatusResponseSchema.parse(await response.json());
        } catch {
          throw new TrafficStatusInvalidResponseError();
        }
        if (status.runId !== request.runId || status.correlationId !== request.correlationId) {
          throw new TrafficStatusInvalidResponseError();
        }
        // Another boot cannot hold this start: the expected runner process is gone.
        if (status.bootId !== request.expectedBootId) return null;
        if (status.state === "unknown" || !status.acceptedAt) return null;
        return trafficExecutionStartResponseSchema.parse({
          runId: request.runId,
          status: status.state === "accepted" ? "starting" : "active",
          startedAt: status.acceptedAt,
          correlationId: request.correlationId,
        });
      },
    );
  }

  private fetch(input: string, init: RequestInit): Promise<Response> {
    return (this.options.fetch ?? fetch)(input, init);
  }
}

function parseStartConfirmation(
  payload: unknown,
  request: TrafficExecutionStartRequest,
): TrafficExecutionStartResponse {
  let confirmation: TrafficExecutionStartResponse;
  try {
    confirmation = trafficExecutionStartResponseSchema.parse(payload);
  } catch {
    throw new TrafficStartInvalidResponseError();
  }
  if (
    confirmation.runId !== request.runId ||
    confirmation.correlationId !== request.correlationId
  ) {
    throw new TrafficStartInvalidResponseError();
  }
  return confirmation;
}

/** A definitive (4xx) start rejection: the load orchestrator started no traffic for this request. */
export class TrafficStartRejectedError extends ApiHttpError {
  constructor(statusCode: number, payload: unknown) {
    const details = {
      statusCode,
      payload: payload && typeof payload === "object" ? payload : {},
    };
    const runnerCode = runnerStartRejectionCode(payload);
    super(
      runnerCode
        ? {
            statusCode: 503,
            code: runnerCode,
            message:
              runnerCode === "runner_boot_mismatch"
                ? "The load generator restarted before the run could start."
                : "The load generator is shutting down.",
            details,
          }
        : {
            statusCode: 502,
            code: "load_orchestrator_unavailable",
            message: "The load orchestrator rejected the run start.",
            details,
          },
    );
  }
}

function runnerStartRejectionCode(
  payload: unknown,
): "runner_boot_mismatch" | "runner_stopping" | null {
  const code = payload && typeof payload === "object" && "code" in payload ? payload.code : null;
  return code === "runner_boot_mismatch" || code === "runner_stopping" ? code : null;
}

function isDefinitiveStartRejection(statusCode: number): boolean {
  return statusCode >= 400 && statusCode < 500;
}

async function runBoundedTrafficRequest<T>(
  timeoutMs: number,
  timeoutError: () => Error,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectTimeout: (reason: Error) => void = () => undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectTimeout(timeoutError());
  }, timeoutMs);
  const request = operation(controller.signal);
  void request.catch(() => undefined);

  try {
    return await Promise.race([request, timeoutFailure]);
  } finally {
    clearTimeout(timeout);
  }
}

function trafficExecutionUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

class TrafficStartTimeoutError extends Error {}
class TrafficStartInvalidResponseError extends Error {}
class TrafficStartNonDefinitiveResponseError extends Error {}
class TrafficStatusTimeoutError extends Error {}
class TrafficStatusInvalidResponseError extends Error {}
class TrafficAbortTimeoutError extends Error {}
class TrafficAbortInvalidResponseError extends Error {}
class RunnerControlTimeoutError extends Error {}
