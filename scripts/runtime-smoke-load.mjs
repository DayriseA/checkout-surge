#!/usr/bin/env node

import { createHmac, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  adminGeneratedRunTeardownPath,
  adminGeneratedRunTeardownResponseSchema,
  dashboardEventSchema,
  runHistoryListResponseSchema,
  startDemoRunResponseSchema,
  uuidSchema,
} from "../packages/contracts/dist/index.js";

export async function runRuntimeLoadSmoke(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const dashboardBaseUrl = envUrl(env, "WEB_BASE_URL", "http://localhost:8080");
  const apiBaseUrl = envUrl(env, "API_BASE_URL", "http://localhost:4000");
  const token = env.CONTROL_SERVICE_TOKEN?.trim();
  if (!token) throw new Error("CONTROL_SERVICE_TOKEN is required for runtime load smoke.");
  const rootCorrelationId = `runtime-smoke-load-${randomUUID()}`;

  await requireReadiness(`${apiBaseUrl}/health/ready`, fetchImpl);
  await resetDemo(apiBaseUrl, token, rootCorrelationId, fetchImpl);

  const results = [];
  for (const scenario of runtimeLoadSmokeScenarios()) {
    results.push(
      await runRuntimeLoadScenario({
        scenario,
        dashboardBaseUrl,
        apiBaseUrl,
        token,
        correlationId: `${rootCorrelationId}:${scenario.name}`,
        deadlineMs: derivedDeadlineMs(env, scenario.durationSeconds),
        env,
        fetchImpl,
      }),
    );
  }
  return { correlationId: rootCorrelationId, scenarios: results };
}

async function runRuntimeLoadScenario(input) {
  let runId;
  let saleOfferId;
  let primaryError;
  let cleanupError;
  let cleanupAllowed = false;
  const sseAbort = new AbortController();
  const sseOutcomePromise = collectDashboardEvents(
    `${input.dashboardBaseUrl}/dashboard/events`,
    input.fetchImpl,
    sseAbort.signal,
  ).then(
    (events) => ({ events }),
    (error) => ({ error }),
  );

  try {
    const started = await startRun({
      dashboardBaseUrl: input.dashboardBaseUrl,
      correlationId: input.correlationId,
      scenario: input.scenario,
      env: input.env,
      fetchImpl: input.fetchImpl,
    });
    runId = uuidSchema.parse(started.run.runId);
    saleOfferId = uuidSchema.parse(started.run.saleOfferId);
    if (started.correlationId !== input.correlationId) {
      throw new Error(
        `Run start correlation mismatch: expected ${input.correlationId}, received ${started.correlationId}.`,
      );
    }
    const terminal = await waitForTerminalSummary({
      dashboardBaseUrl: input.dashboardBaseUrl,
      apiBaseUrl: input.apiBaseUrl,
      runId,
      deadlineMs: input.deadlineMs,
      fetchImpl: input.fetchImpl,
    });
    cleanupAllowed = true;
    assertBusinessCompletion(terminal);
    assertScenarioAcceptance(terminal, input.scenario);
    const inventory = await requestJson(
      `${input.apiBaseUrl}/inventory/${saleOfferId}/status`,
      { method: "GET", headers: { accept: "application/json" } },
      input.fetchImpl,
    );
    if (!(inventory.reservedStock > 0))
      throw new Error("Live inventory did not show reservedStock > 0.");
    sseAbort.abort();
    const sseOutcome = await sseOutcomePromise;
    if (sseOutcome.error) throw sseOutcome.error;
    const events = sseOutcome.events;
    assertSseEvidence(events, runId, input.correlationId);
    console.log(
      `Runtime load smoke ${input.scenario.name} proof passed runId=${runId} correlationId=${input.correlationId}.`,
    );
  } catch (error) {
    primaryError = error;
    sseAbort.abort();
    await sseOutcomePromise;
    if (runId) {
      try {
        await prepareExactRunCleanup({
          dashboardBaseUrl: input.dashboardBaseUrl,
          apiBaseUrl: input.apiBaseUrl,
          token: input.token,
          correlationId: input.correlationId,
          runId,
          deadlineMs: input.deadlineMs,
          fetchImpl: input.fetchImpl,
        });
        cleanupAllowed = true;
      } catch (error) {
        cleanupError = error;
      }
    }
  } finally {
    if (runId && cleanupAllowed) {
      try {
        const cleanup = await teardownWithRetry({
          apiBaseUrl: input.apiBaseUrl,
          token: input.token,
          runId,
          saleOfferId,
          correlationId: input.correlationId,
          fetchImpl: input.fetchImpl,
        });
        console.log(
          `Runtime load smoke ${input.scenario.name} cleanup completed runId=${runId} correlationId=${cleanup.correlationId}.`,
        );
      } catch (error) {
        cleanupError = cleanupError
          ? new AggregateError(
              [cleanupError, error],
              "Cleanup preparation and teardown both failed.",
            )
          : error;
      }
    }
  }
  throwSmokeFailures(primaryError, cleanupError);
  return { name: input.scenario.name, runId, saleOfferId, correlationId: input.correlationId };
}

export function runtimeLoadSmokeScenarios() {
  return [
    {
      name: "steady",
      durationSeconds: 8,
      configOverride: {
        trafficConfig: {
          mode: "steady-arrival-rate",
          ratePerSecond: 2,
          durationSeconds: 8,
          startDelaySeconds: 0,
          quantityPerAttempt: 1,
          k6Vus: { preAllocatedVus: 1, maxVus: 4 },
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
          requestTimeoutMs: 2000,
        },
      },
    },
    {
      name: "accepted-burst",
      durationSeconds: 5,
      expectedAcceptedReservations: 32,
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
          requestTimeoutMs: 2000,
        },
      },
    },
  ];
}

export function assertScenarioAcceptance(summary, scenario) {
  if (
    scenario.expectedAcceptedReservations !== undefined &&
    summary.businessOutcomeSummary.acceptedReservations !== scenario.expectedAcceptedReservations
  ) {
    throw new Error(
      `Smoke ${scenario.name} accepted ${summary.businessOutcomeSummary.acceptedReservations} reservations; expected ${scenario.expectedAcceptedReservations}.`,
    );
  }
}

export function throwSmokeFailures(primaryError, cleanupError) {
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `Smoke assertion failed: ${message(primaryError)}; cleanup also failed: ${message(cleanupError)}`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

export function assertSseEvidence(events, runId, correlationId) {
  const mismatched = events.find(
    (event) =>
      event.runId === runId &&
      event.correlationId &&
      !isCorrelationLineage(event.correlationId, correlationId),
  );
  if (mismatched) {
    throw new Error(
      `SSE correlation mismatch for run ${runId}: received ${mismatched.correlationId}.`,
    );
  }
  const attributable = events.filter(
    (event) =>
      event.runId === runId &&
      (!event.correlationId || isCorrelationLineage(event.correlationId, correlationId)),
  );
  if (attributable.length === 0)
    throw new Error("SSE yielded no contract-valid event for this run.");
}

function isCorrelationLineage(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}:`);
}

export function parseSseDataFrames(text) {
  const events = [];
  for (const frame of text.replaceAll("\r\n", "\n").split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const parsed = dashboardEventSchema.safeParse(JSON.parse(data));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // Incomplete/invalid frames are not business evidence.
    }
  }
  return events;
}

export async function collectDashboardEvents(url, fetchImpl, signal) {
  const response = await fetchImpl(url, { headers: { accept: "text/event-stream" }, signal });
  if (!response.ok || !response.body)
    throw new Error(`Dashboard SSE failed with HTTP ${response.status}.`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    throw new Error("Dashboard SSE response did not use text/event-stream content type.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  try {
    while (events.length < 100) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const extracted = extractCompleteSseFrames(buffer);
      events.push(...extracted.events);
      buffer = extracted.remainder;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  return events;
}

export function extractCompleteSseFrames(buffer) {
  let end = 0;
  const separator = /\r?\n\r?\n/g;
  for (const match of buffer.matchAll(separator)) end = (match.index ?? 0) + match[0].length;
  return end === 0
    ? { events: [], remainder: buffer }
    : { events: parseSseDataFrames(buffer.slice(0, end)), remainder: buffer.slice(end) };
}

export async function teardownWithRetry(input) {
  let last;
  let payload;
  let receivedSuccessfulResponse = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
      );
      receivedSuccessfulResponse = true;
      break;
    } catch (error) {
      last = error;
      if (attempt < 3) await sleep(attempt * 500);
    }
  }
  if (receivedSuccessfulResponse) return validateTeardownResponse(payload, input);
  throw new Error(
    `Teardown failed after retries (correlationId=${input.correlationId}): ${message(last)}`,
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

export async function requireReadiness(url, fetchImpl, timeoutMs = 30_000) {
  await pollUntil(
    Date.now() + timeoutMs,
    async () => {
      const response = await fetchWithTimeout(url, { method: "GET" }, fetchImpl);
      return response.ok ? true : undefined;
    },
    "API readiness",
  );
}

async function resetDemo(baseUrl, token, correlationId, fetchImpl) {
  await requestJson(
    `${baseUrl}/admin/demo/reset`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "x-control-service-token": token,
        "x-correlation-id": correlationId,
      },
    },
    fetchImpl,
  );
}

async function startRun({ dashboardBaseUrl, correlationId, scenario, env, fetchImpl }) {
  const response = await requestJson(
    `${dashboardBaseUrl}/api/demo/runs/start`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: signedVisitorCookie(env),
      },
      body: JSON.stringify({
        presetSlug: "public-custom",
        correlationId,
        configOverride: scenario.configOverride,
      }),
    },
    fetchImpl,
  );
  return startDemoRunResponseSchema.parse(response);
}

export async function waitForTerminalSummary({
  dashboardBaseUrl,
  apiBaseUrl,
  runId,
  deadlineMs,
  fetchImpl,
  readObservation = readRunObservation,
}) {
  const deadline = Date.now() + deadlineMs;
  let last = { current: "unobserved", history: "unobserved" };
  let lastRequestError;
  while (Date.now() < deadline) {
    try {
      const observation = await readObservation({ dashboardBaseUrl, apiBaseUrl, runId, fetchImpl });
      last = describeRunObservation(observation, runId);
      const terminal = selectTerminalSummary(observation.recovery, observation.summaries, runId);
      if (terminal) return terminal;
      lastRequestError = undefined;
    } catch (error) {
      if (isTerminalObservationError(error)) throw error;
      lastRequestError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for terminal summary: ${JSON.stringify(last)}${lastRequestError ? `; lastRequestError=${message(lastRequestError)}` : ""}`,
  );
}

export function selectTerminalSummary(recovery, summaries, runId) {
  if (recovery.currentRun && recovery.currentRun.runId !== runId) {
    throw new Error(`Observed foreign current run ${recovery.currentRun.runId}.`);
  }
  const summary = summaries.find((candidate) => candidate.runId === runId);
  if (summary?.status === "failed") {
    throw new Error(`Run terminalized as failed: ${summary.failureReason ?? "unknown"}.`);
  }
  return summary?.status === "completed" ? summary : undefined;
}

export function assertBusinessCompletion(summary) {
  const transportAttemptCounts = summary.transportAttemptCounts;
  const delivery = summary.trafficDeliverySummary;
  const business = summary.businessOutcomeSummary;
  const failures = [];
  if (
    delivery.trafficDeliveryStatus === "failed" ||
    transportAttemptCounts.startedRequests <= 0 ||
    delivery.droppedIterations > transportAttemptCounts.plannedRequests
  )
    failures.push("traffic delivery");
  if (business.acceptedReservations <= 0 || business.confirmedOrders <= 0)
    failures.push("accepted/confirmed work");
  if (
    business.queuedOrders ||
    business.processingOrders ||
    business.retryingOrders ||
    business.pendingPersistenceCount
  )
    failures.push("async blockers");
  if (business.notificationsRecorded < business.confirmedOrders)
    failures.push("notification drain");
  if (failures.length)
    throw new Error(
      `Incomplete terminal business outcome: ${failures.join(", ")}; ${JSON.stringify({ transportAttemptCounts, delivery, business })}`,
    );
}

export async function prepareExactRunCleanup(input) {
  const deadline = Date.now() + input.deadlineMs;
  let resetRequested = false;
  let last = { current: "unobserved", history: "unobserved" };
  while (Date.now() < deadline) {
    const observation = await (input.readObservation ?? readRunObservation)(input);
    last = describeRunObservation(observation, input.runId);
    const summary = observation.summaries.find((candidate) => candidate.runId === input.runId);
    if (summary && ["completed", "failed"].includes(summary.status)) return last;
    const current = observation.recovery.currentRun;
    if (!current) return last;
    if (current.runId !== input.runId) {
      throw new Error(
        `Refusing cleanup preparation because foreign current run ${current.runId} is active.`,
      );
    }
    if (["completed", "failed"].includes(current.status)) return last;
    if (!resetRequested) {
      await (input.resetRun ?? resetDemo)(
        input.apiBaseUrl,
        input.token,
        input.correlationId,
        input.fetchImpl,
      );
      resetRequested = true;
    }
    await sleep(500);
  }
  throw new Error(
    `Could not prove exact-run terminality or absence before cleanup: ${JSON.stringify(last)}`,
  );
}

async function readRunObservation({ dashboardBaseUrl, apiBaseUrl, runId, fetchImpl }) {
  const recovery = await requestJson(
    `${dashboardBaseUrl}/api/dashboard/recovery`,
    { method: "GET", headers: { accept: "application/json" } },
    fetchImpl,
  );
  const history = runHistoryListResponseSchema.parse(
    await requestJson(
      `${apiBaseUrl}/demo/runs/history?page=1&pageSize=50`,
      { method: "GET", headers: { accept: "application/json" } },
      fetchImpl,
    ),
  );
  return { recovery, summaries: history.summaries, runId };
}

function describeRunObservation(observation, runId) {
  const summary = observation.summaries.find((candidate) => candidate.runId === runId);
  return {
    current: observation.recovery.currentRun
      ? {
          runId: observation.recovery.currentRun.runId,
          status: observation.recovery.currentRun.status,
          trafficStatus: observation.recovery.currentRun.trafficStatus,
        }
      : null,
    history: summary
      ? {
          status: summary.status,
          transportAttemptCounts: summary.transportAttemptCounts,
          trafficDeliverySummary: summary.trafficDeliverySummary,
          businessOutcomeSummary: summary.businessOutcomeSummary,
        }
      : null,
  };
}

function isTerminalObservationError(error) {
  return (
    error instanceof Error &&
    (error.message.startsWith("Observed foreign current run") ||
      error.message.startsWith("Run terminalized as failed"))
  );
}

async function requestJson(url, init, fetchImpl) {
  const response = await fetchWithTimeout(url, init, fetchImpl);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok)
    throw new Error(
      `${init.method ?? "GET"} ${url} failed HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  return payload;
}

async function fetchWithTimeout(url, init, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetchImpl(url, {
      cache: "no-store",
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function pollUntil(deadline, operation, label) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${message(lastError)}` : "."}`);
}

function derivedDeadlineMs(env, durationSeconds) {
  const drain = positiveInteger(env.DEMO_RUN_DRAIN_TIMEOUT_SECONDS, 300);
  const finalization = positiveInteger(env.DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS, 5);
  const derived = (durationSeconds + drain + finalization * 3 + 10) * 1000;
  return positiveInteger(env.RUNTIME_SMOKE_LOAD_RUN_TIMEOUT_MS, derived);
}

function signedVisitorCookie(env) {
  const id = "00000000-0000-4000-8000-000000000009";
  const secret = env.PUBLIC_CLIENT_COOKIE_SECRET?.trim();
  if (!secret) throw new Error("PUBLIC_CLIENT_COOKIE_SECRET is required for runtime load smoke.");
  return `checkout_surge_public_visitor=${encodeURIComponent(`${id}.${createHmac("sha256", secret).update(id).digest("base64url")}`)}`;
}
function envUrl(env, name, fallback) {
  return (env[name]?.trim() || fallback).replace(/\/+$/, "");
}
function positiveInteger(raw, fallback) {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0)
    throw new Error("Expected a positive integer runtime setting.");
  return value;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRuntimeLoadSmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
