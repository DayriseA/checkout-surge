import { randomUUID } from "node:crypto";

const defaultRequestTimeoutMs = 30_000;
const maximumDiagnosticLength = 1_000;

export class RuntimeResetAggregateError extends Error {
  constructor(result) {
    super("One or more runtime services could not be reset.");
    this.name = "RuntimeResetAggregateError";
    this.result = result;
  }
}

export async function resetRuntime(options = {}) {
  const environment = options.env ?? process.env;
  const controlServiceToken = (
    options.controlServiceToken ?? environment.CONTROL_SERVICE_TOKEN
  )?.trim();
  if (!controlServiceToken) throw new Error("CONTROL_SERVICE_TOKEN is required for runtime reset.");

  const correlationId = options.correlationId ?? randomUUID();
  if (correlationId.includes(controlServiceToken)) {
    throw new Error("The runtime reset correlation ID is invalid.");
  }
  const request = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
  const targets = [
    {
      service: "api",
      url: `${normalizeBaseUrl(options.apiBaseUrl ?? environment.API_BASE_URL ?? "http://localhost:4000")}/admin/demo/reset`,
    },
  ];

  const outcomes = [];
  for (const target of targets) {
    outcomes.push(
      await resetService({
        ...target,
        correlationId,
        controlServiceToken,
        request,
        timeoutMs,
      }),
    );
  }

  const result = { correlationId, services: outcomes };
  if (outcomes.some((outcome) => outcome.outcome === "failed")) {
    throw new RuntimeResetAggregateError(result);
  }
  return result;
}

async function resetService({
  service,
  url,
  correlationId,
  controlServiceToken,
  request,
  timeoutMs,
}) {
  const controller = new AbortController();
  let rejectTimeout;
  const timeoutFailure = new Promise((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectTimeout(new RuntimeResetRequestTimeout());
  }, timeoutMs);
  const responseOperation = (async () => {
    const response = await request(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "x-control-service-token": controlServiceToken,
        "x-correlation-id": correlationId,
      },
      signal: controller.signal,
    });
    return { response, text: await response.text() };
  })();
  // The explicit timeout race also bounds injected fetch/Response implementations
  // that do not reject their body read when AbortController fires.
  void responseOperation.catch(() => undefined);
  let response;
  let text;
  try {
    ({ response, text } = await Promise.race([responseOperation, timeoutFailure]));
  } catch (error) {
    const message = sanitizeBody(
      error instanceof RuntimeResetRequestTimeout ? "request_timeout" : "request_failed",
      controlServiceToken,
    );
    return {
      service,
      outcome: "failed",
      ...(message ? { message } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }

  const responseHeaderCorrelationId = sanitizeCorrelationId(
    response.headers.get("x-correlation-id"),
    controlServiceToken,
  );
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const responseCorrelationId =
    responseHeaderCorrelationId ??
    sanitizeCorrelationId(
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload.correlationId
        : undefined,
      controlServiceToken,
    );

  if (!response.ok) {
    return {
      service,
      outcome: "failed",
      status: response.status,
      ...(responseCorrelationId ? { responseCorrelationId } : {}),
      ...(text ? { message: sanitizeBody(text, controlServiceToken) } : {}),
    };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const message = sanitizeBody("invalid_json_response", controlServiceToken);
    return {
      service,
      outcome: "failed",
      status: response.status,
      ...(responseCorrelationId ? { responseCorrelationId } : {}),
      ...(message ? { message } : {}),
    };
  }
  return {
    service,
    outcome: "succeeded",
    status: response.status,
    ...(responseCorrelationId ? { responseCorrelationId } : {}),
  };
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function sanitizeCorrelationId(value, sensitiveValue) {
  if (typeof value !== "string" || !value) return undefined;
  return (
    removeSensitiveValue(stripControlCharacters(value, ""), sensitiveValue).slice(0, 200) ||
    undefined
  );
}

function sanitizeBody(value, sensitiveValue) {
  return removeSensitiveValue(stripControlCharacters(value, " "), sensitiveValue)
    .replace(
      /(["']?(?:x-control-service-token|authorization|token)["']?\s*:\s*)["'][^"']*["']/gi,
      "$1[redacted]",
    )
    .replace(
      /(["']?(?:x-control-service-token|authorization|token)["']?\s*[:=]\s*)[^\s,;}]+/gi,
      "$1[redacted]",
    )
    .slice(0, maximumDiagnosticLength);
}

function removeSensitiveValue(value, sensitiveValue) {
  return sensitiveValue ? value.split(sensitiveValue).join("") : value;
}

class RuntimeResetRequestTimeout extends Error {}

function stripControlCharacters(value, replacement) {
  let sanitized = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    sanitized += code <= 31 || code === 127 ? replacement : character;
  }
  return sanitized;
}
