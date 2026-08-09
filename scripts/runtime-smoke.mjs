#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  adminGeneratedRunTeardownPath,
  adminGeneratedRunTeardownResponseSchema,
  dashboardProjectionSchema,
  isoTimestampSchema,
  runHistoryListResponseSchema,
  startDemoRunResponseSchema,
  uuidSchema,
} from "../packages/contracts/dist/index.js";

const requestTimeoutMs = 10_000;
const sseConnectionTimeoutMs = 5_000;
const sseHeartbeatTimeoutMs = 20_000;
const sseCloseTimeoutMs = 5_000;
const sseMaxBufferedChars = 64 * 1024;
const ambiguousStartIdentityTimeoutMs = 5_000;
const exactRunCleanupTimeoutMs = 30_000;
const smokeScenario = {
  name: "accepted-burst",
  durationSeconds: 5,
  buyerCount: 32,
  configOverride: {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 32,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 5,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 32,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 0,
      maxTps: 100,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2_000,
    },
  },
};

const readinessChecks = [
  {
    name: "api",
    envName: "API_BASE_URL",
    fallbackUrl: "http://localhost:4000",
    path: "/health/ready",
    requiredChecks: ["database_reachable", "redis_reachable", "order_process_queue_reachable"],
  },
  {
    name: "worker",
    envName: "WORKER_HEALTH_BASE_URL",
    fallbackUrl: "http://localhost:4300",
    path: "/health/ready",
    requiredChecks: [
      "database_reachable",
      "redis_reachable",
      "order_process_worker_running",
      "order_process_queue_reachable",
      "notification_record_worker_running",
      "notification_record_queue_reachable",
    ],
  },
  {
    name: "mock_erp",
    envName: "MOCK_ERP_BASE_URL",
    fallbackUrl: "http://localhost:4100",
    path: "/health/ready",
    requiredChecks: ["confirmation_endpoint_ready"],
  },
  {
    name: "load_orchestrator",
    envName: "LOAD_ORCHESTRATOR_BASE_URL",
    fallbackUrl: "http://localhost:4200",
    path: "/health/ready",
    requiredChecks: ["api_readiness_reachable", "k6_binary_executable"],
  },
];

export async function runRuntimeSmoke(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const write = options.write ?? console.log;
  const apiBaseUrl = envUrl(env, "API_BASE_URL", "http://localhost:4000");
  const dashboardBaseUrl = envUrl(env, "WEB_BASE_URL", "http://localhost:8080");
  const token = env.CONTROL_SERVICE_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "prerequisite/configuration: CONTROL_SERVICE_TOKEN is required by the protected reset, start, and cleanup requests.",
    );
  }

  for (const check of readinessChecks) {
    await runStage(`health/${check.name}`, write, () =>
      assertServiceReadiness(check, env, fetchImpl),
    );
  }
  await runStage("dashboard/reachability", write, () =>
    assertDashboardReachability(dashboardBaseUrl, fetchImpl),
  );
  await runStage("dashboard/recovery", write, () =>
    readDashboardProjection(`${dashboardBaseUrl}/api/dashboard/recovery`, fetchImpl),
  );

  const correlationId = `runtime-smoke-${randomUUID()}`;
  const runTimeoutMs = runtimeRunTimeoutMs(env, smokeScenario.durationSeconds);
  await runStage("reset/preflight", write, () =>
    resetDemo(apiBaseUrl, token, correlationId, fetchImpl),
  );

  const stream = observeDashboardStream({
    url: `${dashboardBaseUrl}/dashboard/events`,
    fetchImpl,
  });
  const result = await executeSmokeRun({
    apiBaseUrl,
    token,
    correlationId,
    runTimeoutMs,
    stream,
    write,
    fetchImpl,
  });

  write(
    `Runtime smoke passed: scenario=${smokeScenario.name} buyers=${smokeScenario.buyerCount} runId=${result.runId} correlationId=${correlationId}.`,
  );
  return { correlationId, ...result, scenario: smokeScenario.name };
}

export async function executeSmokeRun({
  apiBaseUrl,
  token,
  correlationId,
  runTimeoutMs,
  stream,
  write,
  fetchImpl,
  start = startRun,
  waitForTerminal = waitForTerminalSummary,
  prepareCleanup = prepareExactRunCleanup,
  teardown = teardownWithRetry,
  now = Date.now,
  cleanupTimeoutMs = exactRunCleanupTimeoutMs,
  startIdentityTimeoutMs = ambiguousStartIdentityTimeoutMs,
}) {
  let runId;
  let saleOfferId;
  let primaryError;
  let cleanupError;
  let startAttempted = false;
  let runDeadlineAt;

  try {
    await runStage("sse/connection", write, () => stream.waitForConnection(sseConnectionTimeoutMs));
    runDeadlineAt = now() + runTimeoutMs;

    const started = await runStage("load/start", write, () => {
      startAttempted = true;
      return start({
        apiBaseUrl,
        token,
        correlationId,
        fetchImpl,
        timeoutMs: Math.min(
          requestTimeoutMs,
          remainingDeadlineMs(runDeadlineAt, "load start", now()),
        ),
      });
    });
    runId = uuidSchema.parse(started.run.runId);
    saleOfferId = uuidSchema.parse(started.run.saleOfferId);

    await runStage("sse/run_lifecycle", write, () =>
      stream.waitForProjection(
        (projection) =>
          isRunProjection(projection, runId, saleOfferId, correlationId) &&
          ["starting", "active", "draining"].includes(projection.currentRun.status),
        remainingDeadlineMs(runDeadlineAt, "nonterminal SSE projection", now()),
        `a starting, active, or draining projection for run ${runId}`,
      ),
    );

    const terminal = await runStage("load/terminal_history", write, () =>
      waitForTerminal({
        apiBaseUrl,
        runId,
        deadlineAt: runDeadlineAt,
        fetchImpl,
        now,
      }),
    );
    await runStage("evidence/terminal_business_inventory_notification", write, () =>
      assertTerminalSummary(terminal, smokeScenario),
    );

    const terminalProjection = await runStage("sse/terminal_projection", write, () =>
      stream.waitForProjection(
        (projection) =>
          isRunProjection(projection, runId, saleOfferId, correlationId) &&
          projection.currentRun.status === "completed",
        remainingDeadlineMs(runDeadlineAt, "terminal SSE projection", now()),
        `the completed projection for run ${runId}`,
      ),
    );
    await runStage("evidence/terminal_projection", write, () =>
      assertTerminalProjection(terminalProjection, smokeScenario),
    );
    await runStage("sse/heartbeat", write, () => stream.waitForHeartbeat(sseHeartbeatTimeoutMs));
  } catch (error) {
    primaryError = error;
    if (startAttempted && !runId) {
      try {
        const identity = await stream.waitForRunIdentity(correlationId, startIdentityTimeoutMs);
        runId = identity.runId;
        saleOfferId = identity.saleOfferId;
      } catch (identityError) {
        primaryError = combineErrors(primaryError, identityError, "load/start_identity_recovery");
      }
    }
  } finally {
    try {
      await stream.close();
    } catch (error) {
      primaryError = combineErrors(primaryError, error, "sse/cleanup");
    }

    if (runId) {
      try {
        const cleanupDeadlineAt = now() + cleanupTimeoutMs;
        await runStage("cleanup/prepare_exact_run", write, () =>
          prepareCleanup({
            apiBaseUrl,
            token,
            correlationId,
            runId,
            deadlineAt: cleanupDeadlineAt,
            fetchImpl,
            now,
          }),
        );
        await runStage("cleanup/delete_exact_run", write, () =>
          teardown({
            apiBaseUrl,
            token,
            runId,
            saleOfferId,
            correlationId,
            deadlineAt: cleanupDeadlineAt,
            fetchImpl,
            now,
          }),
        );
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  throwSmokeFailures(primaryError, cleanupError);
  return { runId, saleOfferId };
}

export async function runStage(name, write, action) {
  try {
    const result = await action();
    write(`ok ${name}`);
    return result;
  } catch (error) {
    throw new Error(`failed ${name}: ${message(error)}`, { cause: error });
  }
}

export async function assertServiceReadiness(check, env, fetchImpl) {
  const baseUrl = envUrl(env, check.envName, check.fallbackUrl);
  const url = `${baseUrl}${check.path}`;
  const { response, body } = await readHttpResponse(
    url,
    { headers: { accept: "application/json" } },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  if (body?.status !== "ok") {
    throw new Error(`${url} reported status=${String(body?.status ?? "missing")}.`);
  }
  for (const requiredCheck of check.requiredChecks) {
    const nested = Array.isArray(body.checks)
      ? body.checks.find((entry) => entry.name === requiredCheck)
      : undefined;
    if (nested?.status !== "ok") {
      throw new Error(`${url} reported ${requiredCheck}=${String(nested?.status ?? "missing")}.`);
    }
  }
}

export async function assertDashboardReachability(dashboardBaseUrl, fetchImpl) {
  const healthUrl = `${dashboardBaseUrl}/health`;
  const { response: healthResponse, body: health } = await readHttpResponse(
    healthUrl,
    { headers: { accept: "application/json" } },
    fetchImpl,
  );
  if (!healthResponse.ok || health?.service !== "web" || health?.status !== "ok") {
    throw new Error(
      `${healthUrl} returned HTTP ${healthResponse.status} service=${String(health?.service)} status=${String(health?.status)}.`,
    );
  }

  const { response: rootResponse, body: root } = await readHttpResponse(
    `${dashboardBaseUrl}/`,
    { headers: { accept: "text/html" } },
    fetchImpl,
  );
  if (!rootResponse.ok || typeof root !== "string" || !root.includes("Checkout-Surge demo")) {
    throw new Error(
      `${dashboardBaseUrl}/ returned HTTP ${rootResponse.status} without the demo page marker.`,
    );
  }
}

export function observeDashboardStream({
  url,
  fetchImpl,
  maxBufferedChars = sseMaxBufferedChars,
  closeTimeoutMs = sseCloseTimeoutMs,
}) {
  const controller = new AbortController();
  const projections = [];
  const latestRevisionByScope = new Map();
  const waiters = new Set();
  let connected = false;
  let heartbeat = false;
  let streamError;
  let reader;

  const settleWaiters = () => {
    for (const waiter of [...waiters]) {
      if (streamError) {
        waiter.reject(streamError);
      } else if (waiter.predicate()) {
        waiter.resolve();
      } else {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiters.delete(waiter);
    }
  };

  const operation = (async () => {
    try {
      const response = await fetchImpl(url, {
        cache: "no-store",
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
      if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
        throw new Error(`${url} did not return text/event-stream.`);
      }
      if (!response.body) throw new Error(`${url} returned no readable response body.`);

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const extracted = extractCompleteSseFrames(buffer, maxBufferedChars);
        buffer = extracted.remainder;
        for (const frame of extracted.frames) {
          const parsed = parseDashboardSseFrame(frame);
          connected ||= parsed.connected;
          heartbeat ||= parsed.heartbeat;
          if (parsed.projection) {
            const previousRevision = latestRevisionByScope.get(parsed.projection.scopeId);
            if (previousRevision !== undefined && parsed.projection.revision <= previousRevision) {
              throw new Error(
                `Dashboard SSE projection revision did not increase for ${parsed.projection.scopeId}: ${previousRevision} -> ${parsed.projection.revision}.`,
              );
            }
            latestRevisionByScope.set(parsed.projection.scopeId, parsed.projection.revision);
            projections.push(parsed.projection);
          }
        }
        settleWaiters();
        if (buffer.length > maxBufferedChars) {
          throw new Error(`Incomplete SSE frame exceeded ${maxBufferedChars} characters.`);
        }
        if (done) throw new Error("Dashboard SSE ended before smoke cleanup.");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        streamError = error;
        settleWaiters();
      }
    }
  })();

  const waitFor = (predicate, timeoutMs, expectation) => {
    if (streamError) return Promise.reject(streamError);
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${expectation}.`));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  };

  return {
    waitForConnection: (timeoutMs) =>
      waitFor(() => connected, timeoutMs, "the complete ': connected' SSE control frame"),
    waitForHeartbeat: (timeoutMs) =>
      waitFor(() => heartbeat, timeoutMs, "a complete timestamped SSE heartbeat frame"),
    async waitForProjection(predicate, timeoutMs, expectation) {
      await waitFor(() => projections.some(predicate), timeoutMs, expectation);
      return projections.findLast(predicate);
    },
    async waitForRunIdentity(correlationId, timeoutMs) {
      const selectIdentity = () => {
        const projection = projections.findLast(
          (candidate) => projectionRunIdentity(candidate, correlationId) !== undefined,
        );
        return projection ? projectionRunIdentity(projection, correlationId) : undefined;
      };
      await waitFor(
        () => selectIdentity() !== undefined,
        timeoutMs,
        `a projection carrying the exact start correlation ${correlationId}`,
      );
      return selectIdentity();
    },
    async close() {
      controller.abort();
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("Dashboard SSE closed before its expected evidence arrived."));
      }
      waiters.clear();
      void Promise.resolve()
        .then(() => reader?.cancel())
        .catch(() => undefined);
      const settledOperation = operation.finally(() => {
        try {
          reader?.releaseLock();
        } catch {
          // A broken stream may retain a pending read past the bounded close deadline.
        }
      });
      await settleWithin(
        settledOperation,
        closeTimeoutMs,
        `Dashboard SSE did not settle within ${closeTimeoutMs}ms after abort/cancel.`,
      );
      if (streamError) throw streamError;
    },
  };
}

export function extractCompleteSseFrames(buffer, maxBufferedChars = sseMaxBufferedChars) {
  const frames = [];
  const separator = /\r?\n\r?\n/g;
  let start = 0;
  let match = separator.exec(buffer);
  while (match) {
    const frame = buffer.slice(start, match.index);
    if (frame.length > maxBufferedChars) {
      throw new Error(`Complete SSE frame exceeded ${maxBufferedChars} characters.`);
    }
    frames.push(frame);
    start = separator.lastIndex;
    match = separator.exec(buffer);
  }
  return { frames, remainder: buffer.slice(start) };
}

export function parseDashboardSseFrame(frame) {
  const lines = frame.replaceAll("\r\n", "\n").split("\n");
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  let projection;
  if (data) {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      throw new Error(`SSE data frame was not JSON: ${message(error)}`);
    }
    const result = dashboardProjectionSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `SSE data frame was not a complete DashboardProjection: ${result.error.issues[0]?.message ?? "invalid projection"}`,
      );
    }
    projection = result.data;
  }
  return {
    connected: lines.some((line) => line === ": connected"),
    heartbeat: lines.some((line) => {
      const timestamp = line.startsWith(": heartbeat ") ? line.slice(12) : undefined;
      return timestamp !== undefined && isoTimestampSchema.safeParse(timestamp).success;
    }),
    projection,
  };
}

export function assertTerminalSummary(summary, scenario = smokeScenario) {
  const transport = summary.transportAttemptCounts;
  const delivery = summary.trafficDeliverySummary;
  const business = summary.businessOutcomeSummary;
  const inventory = summary.terminalInventorySnapshot;
  const failures = [];

  if (
    transport.plannedRequests !== scenario.buyerCount ||
    transport.startedRequests !== scenario.buyerCount ||
    transport.completedRequests !== scenario.buyerCount ||
    transport.interruptedRequests !== 0 ||
    transport.unstartedRequests !== 0 ||
    delivery.trafficMode !== "buyer-spike" ||
    delivery.plannedBuyers !== scenario.buyerCount ||
    delivery.scheduledRatePerSecond !== null ||
    delivery.configuredDurationSeconds !== null ||
    delivery.preAllocatedVUs !== null ||
    delivery.maxVUs !== null ||
    delivery.completedIterations !== scenario.buyerCount ||
    delivery.trafficDeliveryStatus !== "complete" ||
    delivery.droppedIterations !== 0
  ) {
    failures.push("traffic delivery");
  }
  if (
    business.acceptedReservations !== scenario.buyerCount ||
    business.soldOutRejections !== 0 ||
    business.confirmedOrders !== scenario.buyerCount ||
    business.failedOrders !== 0 ||
    business.queuedOrders !== 0 ||
    business.processingOrders !== 0 ||
    business.retryingOrders !== 0 ||
    business.pendingPersistenceCount !== 0
  ) {
    failures.push("business drain");
  }
  if (business.notificationsRecorded !== scenario.buyerCount) {
    failures.push("notification drain");
  }
  if (
    !inventory ||
    inventory.startingStock !== scenario.buyerCount ||
    inventory.remainingStock !== 0 ||
    inventory.reservedStock !== scenario.buyerCount ||
    inventory.acceptedReservations !== scenario.buyerCount ||
    inventory.soldOutRejections !== 0 ||
    inventory.pendingPersistenceCount !== 0 ||
    inventory.source !== "redis"
  ) {
    failures.push("terminal inventory");
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.join(", ")} evidence did not match the ${scenario.buyerCount}-buyer accepted burst: ${JSON.stringify({ transport, delivery, business, inventory })}`,
    );
  }
}

export function assertTerminalProjection(projection, scenario = smokeScenario) {
  const transport = projection.transportAttemptCounts;
  const business = projection.businessOutcome;
  const inventory = projection.inventory;
  if (
    projection.currentRun?.status !== "completed" ||
    transport?.plannedRequests !== scenario.buyerCount ||
    transport.startedRequests !== scenario.buyerCount ||
    transport.completedRequests !== scenario.buyerCount ||
    transport.interruptedRequests !== 0 ||
    transport.unstartedRequests !== 0 ||
    business?.acceptedReservations !== scenario.buyerCount ||
    business.soldOutRejections !== 0 ||
    business.confirmedOrders !== scenario.buyerCount ||
    business.failedOrders !== 0 ||
    business.notificationsRecorded !== scenario.buyerCount ||
    business.queuedOrders !== 0 ||
    business.processingOrders !== 0 ||
    business.retryingOrders !== 0 ||
    business.pendingPersistenceCount !== 0 ||
    inventory?.allocatedStock !== scenario.buyerCount ||
    inventory?.remainingStock !== 0 ||
    inventory.reservedStock !== scenario.buyerCount ||
    inventory.pendingPersistenceCount !== 0 ||
    inventory.soldOutPressure?.rejectionCount !== 0
  ) {
    throw new Error(
      `Completed projection did not contain terminal business, inventory, and notification evidence: ${JSON.stringify(
        {
          status: projection.currentRun?.status,
          transport,
          business,
          inventory,
        },
      )}`,
    );
  }
}

export function throwSmokeFailures(primaryError, cleanupError) {
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `Runtime smoke failed: ${message(primaryError)}; exact-run cleanup also failed: ${message(cleanupError)}`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

async function startRun({ apiBaseUrl, token, correlationId, fetchImpl, timeoutMs }) {
  const payload = await requestJson(
    `${apiBaseUrl}/demo/runs/start`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-control-service-token": token,
        "x-demo-operator-mode": "admin",
      },
      body: JSON.stringify({
        presetSlug: "public-custom",
        correlationId,
        configOverride: smokeScenario.configOverride,
      }),
    },
    fetchImpl,
    timeoutMs,
  );
  const started = startDemoRunResponseSchema.parse(payload);
  if (started.correlationId !== correlationId) {
    throw new Error(
      `Start response correlation mismatch: expected ${correlationId}, received ${started.correlationId}.`,
    );
  }
  return started;
}

async function resetDemo(apiBaseUrl, token, correlationId, fetchImpl, timeoutMs) {
  await requestJson(
    `${apiBaseUrl}/admin/demo/reset`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "x-control-service-token": token,
        "x-correlation-id": correlationId,
      },
    },
    fetchImpl,
    timeoutMs,
  );
}

export async function waitForTerminalSummary({
  apiBaseUrl,
  runId,
  deadlineAt,
  fetchImpl,
  readHistory = readRunHistory,
  now = Date.now,
  pause = sleep,
}) {
  let lastStatus = "not_in_history";
  let lastError;
  while (now() < deadlineAt) {
    try {
      const summaries = await readHistory({
        apiBaseUrl,
        fetchImpl,
        timeoutMs: Math.min(
          requestTimeoutMs,
          remainingDeadlineMs(deadlineAt, "Run History evidence", now()),
        ),
      });
      const summary = summaries.find((candidate) => candidate.runId === runId);
      lastStatus = summary?.status ?? "not_in_history";
      if (summary?.status === "failed") {
        throw new Error(
          `Run ${runId} terminalized as failed: ${summary.failureReason ?? "unknown"}.`,
        );
      }
      if (summary?.status === "completed") return summary;
      lastError = undefined;
    } catch (error) {
      if (message(error).startsWith(`Run ${runId} terminalized as failed`)) throw error;
      lastError = error;
    }
    const remainingMs = deadlineAt - now();
    if (remainingMs > 0) await pause(Math.min(500, remainingMs));
  }
  throw new Error(
    `Shared run deadline expired while waiting for completed Run History evidence for ${runId}; lastStatus=${lastStatus}${lastError ? `; lastError=${message(lastError)}` : ""}.`,
  );
}

export async function prepareExactRunCleanup({
  apiBaseUrl,
  token,
  correlationId,
  runId,
  deadlineAt,
  fetchImpl,
  readObservation = readRunObservation,
  resetRun = resetDemo,
  now = Date.now,
  pause = sleep,
}) {
  let resetRequested = false;
  let last = { current: "unobserved", history: "unobserved" };
  while (now() < deadlineAt) {
    const observation = await readObservation({
      apiBaseUrl,
      runId,
      deadlineAt,
      fetchImpl,
      now,
    });
    last = describeRunObservation(observation, runId);
    const summary = observation.summaries.find((candidate) => candidate.runId === runId);
    if (summary && ["completed", "failed"].includes(summary.status)) return;
    const current = observation.recovery.currentRun;
    if (!current) return;
    if (current.runId !== runId) {
      throw new Error(`Refusing cleanup because foreign current run ${current.runId} is active.`);
    }
    if (!resetRequested) {
      await resetRun(
        apiBaseUrl,
        token,
        correlationId,
        fetchImpl,
        Math.min(
          requestTimeoutMs,
          remainingDeadlineMs(
            deadlineAt,
            "exact-run cleanup reset",
            now(),
            "Exact-run cleanup deadline",
          ),
        ),
      );
      resetRequested = true;
    }
    const remainingMs = deadlineAt - now();
    if (remainingMs > 0) await pause(Math.min(1_000, remainingMs));
  }
  throw new Error(
    `Could not prove exact-run terminality or absence before cleanup: ${JSON.stringify(last)}`,
  );
}

export async function teardownWithRetry(input) {
  let lastError;
  let payload;
  let receivedSuccessfulResponse = false;
  let attempts = 0;
  let deadlineError;
  const pause = input.pause ?? sleep;
  const now = input.now ?? Date.now;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let attemptTimeoutMs = requestTimeoutMs;
    if (input.deadlineAt) {
      try {
        attemptTimeoutMs = Math.min(
          requestTimeoutMs,
          remainingDeadlineMs(
            input.deadlineAt,
            "exact-run teardown",
            now(),
            "Exact-run cleanup deadline",
          ),
        );
      } catch (error) {
        if (attempts === 0) throw error;
        deadlineError = error;
        break;
      }
    }
    attempts += 1;
    try {
      payload = await requestJson(
        `${input.apiBaseUrl}${adminGeneratedRunTeardownPath(input.runId)}`,
        {
          method: "DELETE",
          headers: {
            accept: "application/json",
            "x-control-service-token": input.token,
            "x-correlation-id": input.correlationId,
          },
        },
        input.fetchImpl,
        attemptTimeoutMs,
      );
      receivedSuccessfulResponse = true;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        const retryDelayMs = attempt * 500;
        if (!input.deadlineAt) {
          await pause(retryDelayMs);
        } else {
          const remainingMs = input.deadlineAt - now();
          if (remainingMs <= 0) {
            deadlineError = new Error(
              "Exact-run cleanup deadline expired before exact-run teardown retry.",
            );
            break;
          }
          await pause(Math.min(retryDelayMs, remainingMs));
        }
      }
    }
  }
  if (receivedSuccessfulResponse) return validateTeardownResponse(payload, input);
  const failureDetail = deadlineError
    ? `${message(deadlineError)}; last request failure: ${message(lastError)}`
    : message(lastError);
  throw new Error(
    `Teardown failed after ${attempts} ${attempts === 1 ? "attempt" : "attempts"} for run ${input.runId}: ${failureDetail}`,
  );
}

export function validateTeardownResponse(payload, expected) {
  const response = adminGeneratedRunTeardownResponseSchema.parse(payload);
  if (response.runId !== expected.runId || response.correlationId !== expected.correlationId) {
    throw new Error("Teardown response did not echo the requested run and correlation IDs.");
  }
  if (
    response.outcome === "deleted" &&
    expected.saleOfferId &&
    response.saleOfferId !== expected.saleOfferId
  ) {
    throw new Error("Teardown response sale offer did not match the captured run offer.");
  }
  return response;
}

async function readRunObservation({ apiBaseUrl, runId, deadlineAt, fetchImpl, now = Date.now }) {
  const timeoutMs = deadlineAt
    ? Math.min(
        requestTimeoutMs,
        remainingDeadlineMs(
          deadlineAt,
          "exact-run cleanup observation",
          now(),
          "Exact-run cleanup deadline",
        ),
      )
    : requestTimeoutMs;
  const [recovery, summaries] = await Promise.all([
    readDashboardProjection(`${apiBaseUrl}/dashboard/recovery`, fetchImpl, timeoutMs),
    readRunHistory({ apiBaseUrl, fetchImpl, timeoutMs }),
  ]);
  return { recovery, summaries, runId };
}

async function readRunHistory({ apiBaseUrl, fetchImpl, timeoutMs }) {
  const history = runHistoryListResponseSchema.parse(
    await requestJson(
      `${apiBaseUrl}/demo/runs/history?page=1&pageSize=50`,
      { headers: { accept: "application/json" } },
      fetchImpl,
      timeoutMs,
    ),
  );
  return history.summaries;
}

async function readDashboardProjection(url, fetchImpl, timeoutMs) {
  return dashboardProjectionSchema.parse(
    await requestJson(url, { headers: { accept: "application/json" } }, fetchImpl, timeoutMs),
  );
}

function isRunProjection(projection, runId, saleOfferId, correlationId) {
  if (projection.scope?.runId !== runId || projection.scope.saleOfferId !== saleOfferId) {
    return false;
  }
  if (!isCorrelationLineage(projection.correlationId, correlationId)) {
    throw new Error(
      `Dashboard SSE correlation mismatch for run ${runId}: received ${projection.correlationId}.`,
    );
  }
  return projection.currentRun?.runId === runId;
}

function projectionRunIdentity(projection, correlationId) {
  if (!isCorrelationLineage(projection.correlationId, correlationId)) return undefined;
  const runId = projection.scope?.runId;
  const saleOfferId = projection.scope?.saleOfferId;
  if (
    !runId ||
    !saleOfferId ||
    projection.currentRun?.runId !== runId ||
    projection.currentRun.saleOfferId !== saleOfferId
  ) {
    return undefined;
  }
  return { runId, saleOfferId };
}

function isCorrelationLineage(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}:`);
}

function describeRunObservation(observation, runId) {
  const summary = observation.summaries.find((candidate) => candidate.runId === runId);
  return {
    current: observation.recovery.currentRun
      ? {
          runId: observation.recovery.currentRun.runId,
          status: observation.recovery.currentRun.status,
        }
      : null,
    history: summary?.status ?? null,
  };
}

async function requestJson(url, init, fetchImpl, timeoutMs = requestTimeoutMs) {
  const { response, body: payload } = await readHttpResponse(url, init, fetchImpl, timeoutMs);
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${url} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function readHttpResponse(url, init, fetchImpl, timeoutMs = requestTimeoutMs) {
  const response = await fetchImpl(url, {
    cache: "no-store",
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!text) return { response, body: null };
  try {
    return { response, body: JSON.parse(text) };
  } catch {
    return { response, body: text };
  }
}

function runtimeRunTimeoutMs(env, durationSeconds) {
  const override = env.RUNTIME_SMOKE_RUN_TIMEOUT_MS?.trim();
  if (override) return positiveInteger(override, "RUNTIME_SMOKE_RUN_TIMEOUT_MS");
  const drainSeconds = positiveInteger(
    env.DEMO_RUN_DRAIN_TIMEOUT_SECONDS ?? "300",
    "DEMO_RUN_DRAIN_TIMEOUT_SECONDS",
  );
  const finalizationSeconds = positiveInteger(
    env.DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS ?? "5",
    "DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS",
  );
  return (durationSeconds + drainSeconds + finalizationSeconds * 3 + 10) * 1_000;
}

function positiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function remainingDeadlineMs(
  deadlineAt,
  stage,
  now = Date.now(),
  deadlineLabel = "Shared run deadline",
) {
  const remainingMs = deadlineAt - now;
  if (remainingMs <= 0) {
    throw new Error(`${deadlineLabel} expired before ${stage}.`);
  }
  return remainingMs;
}

export async function settleWithin(operation, timeoutMs, timeoutMessage) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function envUrl(env, name, fallback) {
  return (env[name]?.trim() || fallback).replace(/\/+$/, "");
}

function combineErrors(primaryError, secondaryError, stage) {
  if (!primaryError) return new Error(`failed ${stage}: ${message(secondaryError)}`);
  return new AggregateError(
    [primaryError, secondaryError],
    `${message(primaryError)}; failed ${stage}: ${message(secondaryError)}`,
  );
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRuntimeSmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
