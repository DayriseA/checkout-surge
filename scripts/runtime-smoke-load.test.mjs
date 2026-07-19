import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBusinessCompletion,
  assertScenarioAcceptance,
  assertSseEvidence,
  collectDashboardEvents,
  extractCompleteSseFrames,
  parseSseDataFrames,
  prepareExactRunCleanup,
  requireReadiness,
  runtimeLoadSmokeScenarios,
  selectTerminalSummary,
  teardownWithRetry,
  throwSmokeFailures,
  validateTeardownResponse,
  waitForTerminalSummary,
} from "./runtime-smoke-load.mjs";

const runId = "55555555-5555-4555-8555-555555555554";
const saleOfferId = "66666666-6666-4666-8666-666666666666";
const correlationId = "corr-smoke";

test("retains steady smoke and adds a bounded accepted buyer burst", () => {
  const scenarios = runtimeLoadSmokeScenarios();
  assert.equal(scenarios.length, 2);
  assert.deepEqual(scenarios[0].configOverride.trafficConfig, {
    mode: "steady-arrival-rate",
    ratePerSecond: 2,
    durationSeconds: 8,
    startDelaySeconds: 0,
    quantityPerAttempt: 1,
    k6Vus: { preAllocatedVus: 1, maxVus: 4 },
  });
  assert.deepEqual(scenarios[1].configOverride.trafficConfig, {
    mode: "buyer-spike",
    buyerCount: 32,
    duplicateEachBuyerAttempt: false,
    startDelaySeconds: 0,
    maxDurationSeconds: 5,
    quantityPerAttempt: 1,
  });
  assert.equal(scenarios[1].configOverride.inventoryConfig.startingStock, 32);
  assert.equal(scenarios[1].expectedAcceptedReservations, 32);
  assert.doesNotThrow(() =>
    assertScenarioAcceptance(
      { businessOutcomeSummary: { acceptedReservations: 32 } },
      scenarios[1],
    ),
  );
  assert.throws(
    () =>
      assertScenarioAcceptance(
        { businessOutcomeSummary: { acceptedReservations: 31 } },
        scenarios[1],
      ),
    /accepted 31 reservations; expected 32/,
  );
});

function dashboardEvent(overrides = {}) {
  return {
    type: "dashboard.metric.observed",
    runId,
    correlationId,
    occurredAt: "2026-07-13T00:00:00.000Z",
    observedAt: "2026-07-13T00:00:00.000Z",
    metricName: "traffic.latency",
    value: 12,
    unit: "ms",
    ...overrides,
  };
}

test("parses complete data frames and ignores invalid or partial SSE", () => {
  const event = dashboardEvent();
  assert.deepEqual(parseSseDataFrames(`data: ${JSON.stringify(event)}\n\ndata: {"partial":`), [
    event,
  ]);
});

test("collects CRLF SSE frames split across chunks and requires the event-stream content type", async () => {
  const encoded = new TextEncoder().encode(`data: ${JSON.stringify(dashboardEvent())}\r\n\r\n`);
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.slice(0, encoded.length - 3));
        controller.enqueue(encoded.slice(encoded.length - 3));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
  assert.deepEqual(
    await collectDashboardEvents(
      "http://dashboard/events",
      async () => response,
      new AbortController().signal,
    ),
    [dashboardEvent()],
  );
  await assert.rejects(
    collectDashboardEvents(
      "http://dashboard/events",
      async () => new Response("ok", { headers: { "content-type": "text/plain" } }),
      new AbortController().signal,
    ),
    /did not use text\/event-stream/,
  );
});

test("keeps incomplete SSE data buffered and rejects a same-run correlation mismatch", () => {
  const first = extractCompleteSseFrames(`data: ${JSON.stringify(dashboardEvent())}\r\n\r`);
  assert.deepEqual(first.events, []);
  const second = extractCompleteSseFrames(`${first.remainder}\n`);
  assert.deepEqual(second.events, [dashboardEvent()]);
  assert.doesNotThrow(() =>
    assertSseEvidence(
      [dashboardEvent({ correlationId: `${correlationId}:k6:0` })],
      runId,
      correlationId,
    ),
  );
  assert.throws(
    () =>
      assertSseEvidence(
        [dashboardEvent(), dashboardEvent({ correlationId: "different-correlation" })],
        runId,
        correlationId,
      ),
    /SSE correlation mismatch/,
  );
});

test("readiness polling has a hard timeout", async () => {
  await assert.rejects(
    requireReadiness("http://api/health/ready", async () => new Response(null, { status: 503 }), 5),
    /Timed out waiting for API readiness/,
  );
});

test("handles current-run disappearance before history and rejects terminal failure", () => {
  assert.equal(selectTerminalSummary({ currentRun: null }, [], runId), undefined);
  const completed = { runId, status: "completed" };
  assert.equal(selectTerminalSummary({ currentRun: null }, [completed], runId), completed);
  assert.throws(
    () =>
      selectTerminalSummary(
        { currentRun: null },
        [{ runId, status: "failed", failureReason: "worker drain" }],
        runId,
      ),
    /terminalized as failed: worker drain/,
  );
});

test("teardown retries with a bodyless DELETE and preserves correlation", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init);
    return new Response(
      calls.length === 1
        ? JSON.stringify({ code: "retry" })
        : JSON.stringify({
            outcome: "already_absent",
            runId,
            cleanedAt: "2026-07-13T00:00:00.000Z",
            correlationId: "corr-smoke",
          }),
      { status: calls.length === 1 ? 500 : 200, headers: { "content-type": "application/json" } },
    );
  };
  await teardownWithRetry({
    apiBaseUrl: "http://api",
    token: "token",
    runId,
    correlationId: "corr-smoke",
    fetchImpl,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].headers["content-type"], undefined);
  assert.equal(calls[0].headers["x-correlation-id"], "corr-smoke");
});

test("does not retry a successful HTTP response with invalid teardown identity", async () => {
  let calls = 0;
  await assert.rejects(
    teardownWithRetry({
      apiBaseUrl: "http://api",
      token: "token",
      runId,
      correlationId,
      fetchImpl: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            outcome: "already_absent",
            runId,
            cleanedAt: "2026-07-13T00:00:00.000Z",
            correlationId: "wrong-correlation",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    }),
    /echo the requested run and correlation IDs/,
  );
  assert.equal(calls, 1);
});

test("validates teardown identity echoes and the deleted sale offer", () => {
  const deleted = {
    outcome: "deleted",
    runId,
    saleOfferId,
    cleanup: { redisKeysDeleted: 2, queueJobsDeleted: 3 },
    cleanedAt: "2026-07-13T00:00:00.000Z",
    correlationId,
  };
  assert.deepEqual(
    validateTeardownResponse(deleted, { runId, saleOfferId, correlationId }),
    deleted,
  );
  assert.throws(
    () =>
      validateTeardownResponse(
        { ...deleted, correlationId: "wrong" },
        { runId, saleOfferId, correlationId },
      ),
    /echo the requested run and correlation IDs/,
  );
  assert.throws(
    () =>
      validateTeardownResponse(
        { ...deleted, saleOfferId: "77777777-7777-4777-8777-777777777777" },
        { runId, saleOfferId, correlationId },
      ),
    /sale offer did not match/,
  );
});

test("terminal polling surfaces failure immediately and diagnoses timeout state", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    waitForTerminalSummary({
      dashboardBaseUrl: "http://dashboard",
      apiBaseUrl: "http://api",
      runId,
      deadlineMs: 60_000,
      fetchImpl: async () => {
        throw new Error("unused");
      },
      readObservation: async () => ({
        recovery: { currentRun: null },
        summaries: [{ runId, status: "failed", failureReason: "worker drain" }],
      }),
    }),
    /terminalized as failed: worker drain/,
  );
  assert.ok(Date.now() - startedAt < 1_000);

  await assert.rejects(
    waitForTerminalSummary({
      dashboardBaseUrl: "http://dashboard",
      apiBaseUrl: "http://api",
      runId,
      deadlineMs: 5,
      fetchImpl: async () => {
        throw new Error("unused");
      },
      readObservation: async () => ({
        recovery: { currentRun: { runId, status: "draining", trafficStatus: "completed" } },
        summaries: [
          {
            runId,
            status: "draining",
            trafficDeliverySummary: { startedRequests: 4 },
            businessOutcomeSummary: { queuedOrders: 1 },
          },
        ],
      }),
    }),
    (error) => {
      assert.match(error.message, /draining/);
      assert.match(error.message, /startedRequests/);
      assert.match(error.message, /queuedOrders/);
      return true;
    },
  );
});

test("cleanup resets only the exact nonterminal run and re-observes before teardown", async () => {
  const observations = [
    { recovery: { currentRun: { runId, status: "active" } }, summaries: [] },
    { recovery: { currentRun: null }, summaries: [] },
  ];
  let resetCalls = 0;
  await prepareExactRunCleanup({
    runId,
    deadlineMs: 2_000,
    readObservation: async () => observations.shift(),
    resetRun: async () => {
      resetCalls += 1;
    },
  });
  assert.equal(resetCalls, 1);
});

test("cleanup refuses a foreign current run without resetting it", async () => {
  let resetCalls = 0;
  await assert.rejects(
    prepareExactRunCleanup({
      runId,
      deadlineMs: 2_000,
      readObservation: async () => ({
        recovery: {
          currentRun: {
            runId: "77777777-7777-4777-8777-777777777777",
            status: "active",
          },
        },
        summaries: [],
      }),
      resetRun: async () => {
        resetCalls += 1;
      },
    }),
    /foreign current run/,
  );
  assert.equal(resetCalls, 0);
});

test("rejects incomplete business drain and terminal failed delivery", () => {
  assert.throws(
    () =>
      assertBusinessCompletion({
        trafficDeliverySummary: {
          trafficDeliveryStatus: "failed",
          plannedRequests: 4,
          startedRequests: 0,
          droppedIterations: 0,
        },
        businessOutcomeSummary: {
          acceptedReservations: 1,
          confirmedOrders: 0,
          queuedOrders: 1,
          processingOrders: 0,
          retryingOrders: 0,
          pendingPersistenceCount: 0,
          notificationsRecorded: 0,
        },
      }),
    /Incomplete terminal business outcome/,
  );
});

test("preserves the primary assertion when cleanup also fails", () => {
  const primary = new Error("business proof failed");
  const cleanup = new Error("cleanup failed correlationId=corr-smoke");
  assert.throws(
    () => throwSmokeFailures(primary, cleanup),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], primary);
      assert.match(error.message, /business proof failed/);
      assert.match(error.message, /corr-smoke/);
      return true;
    },
  );
});
