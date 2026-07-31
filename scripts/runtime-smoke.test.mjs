import assert from "node:assert/strict";
import test from "node:test";
import {
  assertServiceReadiness,
  assertTerminalProjection,
  assertTerminalSummary,
  executeSmokeRun,
  extractCompleteSseFrames,
  observeDashboardStream,
  parseDashboardSseFrame,
  prepareExactRunCleanup,
  remainingDeadlineMs,
  runStage,
  teardownWithRetry,
  throwSmokeFailures,
  validateTeardownResponse,
  waitForTerminalSummary,
} from "./runtime-smoke.mjs";

const runId = "55555555-5555-4555-8555-555555555554";
const saleOfferId = "66666666-6666-4666-8666-666666666666";
const correlationId = "runtime-smoke-test";

test("readiness identifies the exact missing service check", async () => {
  const check = {
    name: "worker",
    envName: "WORKER_HEALTH_BASE_URL",
    fallbackUrl: "http://worker.test",
    path: "/health/ready",
    requiredChecks: ["database_reachable", "order_process_worker_running"],
  };
  await assert.rejects(
    assertServiceReadiness(check, {}, async () =>
      Response.json({
        status: "ok",
        checks: [{ name: "database_reachable", status: "ok" }],
      }),
    ),
    /order_process_worker_running=missing/,
  );
});

test("stage failures retain their named location", async () => {
  await assert.rejects(
    runStage(
      "sse/terminal_projection",
      () => undefined,
      async () => {
        throw new Error("missing frame");
      },
    ),
    /failed sse\/terminal_projection: missing frame/,
  );
});

test("SSE parsing buffers split projection frames", () => {
  const first = extractCompleteSseFrames(`data: ${JSON.stringify(activeProjection())}\r\n\r`);
  assert.deepEqual(first.frames, []);
  const second = extractCompleteSseFrames(`${first.remainder}\n`);
  assert.equal(second.frames.length, 1);
  assert.deepEqual(parseDashboardSseFrame(second.frames[0]).projection, activeProjection());
});

test("heartbeat parsing accepts only a contract-compatible timestamp", () => {
  assert.equal(parseDashboardSseFrame(": heartbeat 2026-07-23T00:00:01.000Z").heartbeat, true);
  assert.equal(parseDashboardSseFrame(": heartbeat eventually").heartbeat, false);
  assert.equal(parseDashboardSseFrame(": heartbeat").heartbeat, false);
});

test("same-origin observer requires complete connection, heartbeat, and projection frames", async () => {
  const encoder = new TextEncoder();
  const projection = activeProjection();
  const payload = encoder.encode(
    `retry: 10000\n: connected\n\n: heartbeat 2026-07-23T00:00:01.000Z\n\ndata: ${JSON.stringify(projection)}\n\n`,
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(payload.slice(0, payload.length - 7));
        controller.enqueue(payload.slice(payload.length - 7));
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
  const observer = observeDashboardStream({
    url: "http://dashboard.test/dashboard/events",
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.accept, "text/event-stream");
      assert.equal(init.cache, "no-store");
      return response;
    },
  });

  await observer.waitForConnection(100);
  await observer.waitForHeartbeat(100);
  assert.deepEqual(
    await observer.waitForProjection(
      (candidate) => candidate.scope?.runId === runId,
      100,
      "test projection",
    ),
    projection,
  );
  assert.deepEqual(await observer.waitForRunIdentity(correlationId, 100), {
    runId,
    saleOfferId,
  });
  await observer.close();
});

test("same-origin observer rejects a non-increasing scoped projection revision", async () => {
  const projection = activeProjection();
  const payload = new TextEncoder().encode(
    `: connected\n\ndata: ${JSON.stringify(projection)}\n\ndata: ${JSON.stringify(projection)}\n\n`,
  );
  const observer = observeDashboardStream({
    url: "http://dashboard.test/dashboard/events",
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(payload);
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });

  await assert.rejects(observer.waitForConnection(100), /revision did not increase/);
  await assert.rejects(observer.close(), /revision did not increase/);
});

test("same-origin observer aborts, cancels, and releases a pending reader during close", async () => {
  let abortSignal;
  let cancelCalled = false;
  let releaseCalled = false;
  let finishRead;
  const pendingRead = new Promise((resolve) => {
    finishRead = resolve;
  });
  const reader = {
    read: () => pendingRead,
    cancel: () => {
      cancelCalled = true;
      finishRead({ done: true });
      return Promise.resolve();
    },
    releaseLock: () => {
      releaseCalled = true;
    },
  };
  const observer = observeDashboardStream({
    url: "http://dashboard.test/dashboard/events",
    fetchImpl: async (_url, init) => {
      abortSignal = init.signal;
      return {
        ok: true,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: { getReader: () => reader },
      };
    },
    closeTimeoutMs: 100,
  });

  await new Promise((resolve) => setImmediate(resolve));
  await observer.close();
  assert.equal(abortSignal.aborted, true);
  assert.equal(cancelCalled, true);
  assert.equal(releaseCalled, true);
});

test("same-origin observer bounds cleanup when a pending reader ignores cancellation", async () => {
  const observer = observeDashboardStream({
    url: "http://dashboard.test/dashboard/events",
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: {
        getReader: () => ({
          read: () => new Promise(() => undefined),
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    }),
    closeTimeoutMs: 5,
  });

  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(observer.close(), /did not settle within 5ms after abort\/cancel/);
});

test("terminal evidence requires the full 32-buyer business, notification, and inventory drain", () => {
  const summary = terminalSummary();
  assert.doesNotThrow(() => assertTerminalSummary(summary));
  assert.throws(
    () =>
      assertTerminalSummary({
        ...summary,
        businessOutcomeSummary: {
          ...summary.businessOutcomeSummary,
          notificationsRecorded: 31,
        },
      }),
    /notification drain/,
  );

  const projection = terminalProjection();
  assert.doesNotThrow(() => assertTerminalProjection(projection));
  assert.throws(
    () =>
      assertTerminalProjection({
        ...projection,
        inventory: { ...projection.inventory, remainingStock: 1 },
      }),
    /terminal business, inventory, and notification evidence/,
  );
});

test("terminal history rejects contradictory buyer delivery and sold-out evidence", () => {
  const summary = terminalSummary();
  const mutations = [
    [
      "traffic mode",
      {
        ...summary,
        trafficDeliverySummary: {
          ...summary.trafficDeliverySummary,
          trafficMode: "constant-arrival-rate",
        },
      },
    ],
    [
      "planned buyers",
      {
        ...summary,
        trafficDeliverySummary: {
          ...summary.trafficDeliverySummary,
          plannedBuyers: 99,
        },
      },
    ],
    [
      "completed iterations",
      {
        ...summary,
        trafficDeliverySummary: {
          ...summary.trafficDeliverySummary,
          completedIterations: 1,
        },
      },
    ],
    [
      "business sold-out outcomes",
      {
        ...summary,
        businessOutcomeSummary: {
          ...summary.businessOutcomeSummary,
          soldOutRejections: 9,
        },
      },
    ],
    [
      "inventory sold-out outcomes",
      {
        ...summary,
        terminalInventorySnapshot: {
          ...summary.terminalInventorySnapshot,
          soldOutRejections: 11,
        },
      },
    ],
  ];

  for (const [name, mutation] of mutations) {
    assert.throws(
      () => assertTerminalSummary(mutation),
      /did not match the 32-buyer accepted burst/,
      name,
    );
  }
});

test("completed projection rejects contradictory transport, business, and inventory evidence", () => {
  const projection = terminalProjection();
  const mutations = [
    [
      "completed transport",
      {
        ...projection,
        transportAttemptCounts: {
          ...projection.transportAttemptCounts,
          completedRequests: 1,
        },
      },
    ],
    [
      "business sold-out outcomes",
      {
        ...projection,
        businessOutcome: {
          ...projection.businessOutcome,
          soldOutRejections: 9,
        },
      },
    ],
    [
      "business failures",
      {
        ...projection,
        businessOutcome: {
          ...projection.businessOutcome,
          failedOrders: 1,
        },
      },
    ],
    [
      "allocated stock",
      {
        ...projection,
        inventory: {
          ...projection.inventory,
          allocatedStock: 99,
        },
      },
    ],
    [
      "sold-out pressure",
      {
        ...projection,
        inventory: {
          ...projection.inventory,
          soldOutPressure: {
            rejectionCount: 11,
            latestObservedAt: "2026-07-23T00:00:05.000Z",
          },
        },
      },
    ],
  ];

  for (const [name, mutation] of mutations) {
    assert.throws(
      () => assertTerminalProjection(mutation),
      /Completed projection did not contain terminal business, inventory, and notification evidence/,
      name,
    );
  }
});

test("terminal polling surfaces a failed run immediately", async () => {
  await assert.rejects(
    waitForTerminalSummary({
      apiBaseUrl: "http://api.test",
      runId,
      deadlineAt: Date.now() + 10_000,
      fetchImpl: async () => {
        throw new Error("unused");
      },
      readHistory: async () => [{ runId, status: "failed", failureReason: "worker drain timeout" }],
    }),
    /terminalized as failed: worker drain timeout/,
  );
});

test("exact cleanup resets only the matching current run and refuses a foreign run", async () => {
  const observations = [
    {
      recovery: { currentRun: { runId, status: "active" } },
      summaries: [],
    },
    { recovery: { currentRun: null }, summaries: [] },
  ];
  let resetCalls = 0;
  await prepareExactRunCleanup({
    runId,
    deadlineAt: Date.now() + 2_000,
    readObservation: async () => observations.shift(),
    resetRun: async () => {
      resetCalls += 1;
    },
  });
  assert.equal(resetCalls, 1);

  await assert.rejects(
    prepareExactRunCleanup({
      runId,
      deadlineAt: Date.now() + 2_000,
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
        throw new Error("must not reset");
      },
    }),
    /foreign current run/,
  );
});

test("teardown retries only request failures and sends a bodyless exact DELETE", async () => {
  const calls = [];
  const response = await teardownWithRetry({
    apiBaseUrl: "http://api.test",
    token: "token",
    runId,
    saleOfferId,
    correlationId,
    pause: async () => undefined,
    fetchImpl: async (_url, init) => {
      calls.push(init);
      return calls.length === 1
        ? Response.json({ code: "retry" }, { status: 503 })
        : Response.json({
            outcome: "already_absent",
            runId,
            cleanedAt: "2026-07-23T00:00:00.000Z",
            correlationId,
          });
    },
  });

  assert.equal(response.outcome, "already_absent");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].headers["content-type"], undefined);
  assert.equal(calls[0].headers["x-correlation-id"], correlationId);
});

test("cleanup deadline and teardown-attempt diagnostics report their actual bounds", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    teardownWithRetry({
      apiBaseUrl: "http://api.test",
      token: "token",
      runId,
      correlationId,
      deadlineAt: 50,
      now: () => 50,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    }),
    /Exact-run cleanup deadline expired before exact-run teardown/,
  );
  assert.equal(fetchCalls, 0);

  const times = [0, 50];
  await assert.rejects(
    teardownWithRetry({
      apiBaseUrl: "http://api.test",
      token: "token",
      runId,
      correlationId,
      deadlineAt: 50,
      now: () => times.shift(),
      pause: async () => undefined,
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({ code: "retry" }, { status: 503 });
      },
    }),
    /Teardown failed after 1 attempt for run .*Exact-run cleanup deadline expired before exact-run teardown retry/,
  );
  assert.equal(fetchCalls, 1);
});

test("teardown does not retry an invalid successful identity response", async () => {
  let calls = 0;
  await assert.rejects(
    teardownWithRetry({
      apiBaseUrl: "http://api.test",
      token: "token",
      runId,
      correlationId,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({
          outcome: "already_absent",
          runId,
          cleanedAt: "2026-07-23T00:00:00.000Z",
          correlationId: "wrong-correlation",
        });
      },
    }),
    /echo the requested run and correlation IDs/,
  );
  assert.equal(calls, 1);
});

test("teardown validates run, correlation, and deleted sale-offer identity", () => {
  const deleted = {
    outcome: "deleted",
    runId,
    saleOfferId,
    cleanup: { redisKeysDeleted: 2, queueJobsDeleted: 3 },
    cleanedAt: "2026-07-23T00:00:00.000Z",
    correlationId,
  };
  assert.deepEqual(
    validateTeardownResponse(deleted, { runId, saleOfferId, correlationId }),
    deleted,
  );
  assert.throws(
    () =>
      validateTeardownResponse(
        { ...deleted, runId: "77777777-7777-4777-8777-777777777777" },
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

test("ambiguous start recovers matching SSE identity, closes the stream, and cleans that exact run", async () => {
  const order = [];
  let prepared;
  let deleted;
  await assert.rejects(
    executeSmokeRun({
      apiBaseUrl: "http://api.test",
      token: "token",
      correlationId,
      runTimeoutMs: 100,
      fetchImpl: async () => {
        throw new Error("unused");
      },
      write: () => undefined,
      stream: {
        waitForConnection: async () => undefined,
        waitForRunIdentity: async (candidate) => {
          assert.equal(candidate, correlationId);
          order.push("identity");
          return { runId, saleOfferId };
        },
        close: async () => {
          order.push("close");
        },
      },
      start: async () => {
        throw new Error("start response lost");
      },
      prepareCleanup: async (input) => {
        order.push("prepare");
        prepared = input;
      },
      teardown: async (input) => {
        order.push("delete");
        deleted = input;
      },
      now: () => 1_000,
    }),
    /failed load\/start: start response lost/,
  );

  assert.deepEqual(order, ["identity", "close", "prepare", "delete"]);
  assert.equal(prepared.runId, runId);
  assert.equal(prepared.deadlineAt, 31_000);
  assert.equal(deleted.runId, runId);
  assert.equal(deleted.saleOfferId, saleOfferId);
  assert.equal(deleted.correlationId, correlationId);
  assert.equal(deleted.deadlineAt, 31_000);
});

test("ambiguous start with no matching SSE identity never cleans a foreign run", async () => {
  let cleanupCalls = 0;
  await assert.rejects(
    executeSmokeRun({
      apiBaseUrl: "http://api.test",
      token: "token",
      correlationId,
      runTimeoutMs: 100,
      fetchImpl: async () => {
        throw new Error("unused");
      },
      write: () => undefined,
      stream: {
        waitForConnection: async () => undefined,
        waitForRunIdentity: async () => {
          throw new Error("only a foreign projection was observed");
        },
        close: async () => undefined,
      },
      start: async () => {
        throw new Error("start response lost");
      },
      prepareCleanup: async () => {
        cleanupCalls += 1;
      },
      teardown: async () => {
        cleanupCalls += 1;
      },
      now: () => 1_000,
    }),
    /start_identity_recovery: only a foreign projection was observed/,
  );
  assert.equal(cleanupCalls, 0);
});

test("lifecycle and terminal evidence consume one shared absolute run deadline", async () => {
  const nowValues = [1_000, 1_001, 1_002, 1_101, 1_200];
  const projectionTimeouts = [];
  let terminalDeadlineAt;
  await assert.rejects(
    executeSmokeRun({
      apiBaseUrl: "http://api.test",
      token: "token",
      correlationId,
      runTimeoutMs: 100,
      fetchImpl: async () => {
        throw new Error("unused");
      },
      write: () => undefined,
      stream: {
        waitForConnection: async () => undefined,
        waitForProjection: async (_predicate, timeoutMs) => {
          projectionTimeouts.push(timeoutMs);
          return activeProjection();
        },
        waitForHeartbeat: async () => undefined,
        close: async () => undefined,
      },
      start: async () => ({ run: { runId, saleOfferId } }),
      waitForTerminal: async (input) => {
        terminalDeadlineAt = input.deadlineAt;
        return terminalSummary();
      },
      prepareCleanup: async () => undefined,
      teardown: async () => undefined,
      now: () => nowValues.shift(),
    }),
    /Shared run deadline expired before terminal SSE projection/,
  );

  assert.deepEqual(projectionTimeouts, [98]);
  assert.equal(terminalDeadlineAt, 1_100);
  assert.throws(
    () => remainingDeadlineMs(1_100, "later evidence", 1_100),
    /Shared run deadline expired before later evidence/,
  );
});

test("cleanup failure is reported alongside the primary stage failure", () => {
  assert.throws(
    () =>
      throwSmokeFailures(
        new Error("failed load/terminal_history"),
        new Error("failed cleanup/delete_exact_run"),
      ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /terminal_history/);
      assert.match(error.message, /cleanup\/delete_exact_run/);
      return true;
    },
  );
});

function activeProjection() {
  return {
    schema: "checkout-surge.dashboard-projection",
    version: 1,
    correlationId,
    scopeId: `run/${runId}/sale-offer/${saleOfferId}`,
    revision: 1,
    scope: { runId, saleOfferId },
    recoveredAt: "2026-07-23T00:00:00.000Z",
    currentRun: {
      runId,
      presetId: "77777777-7777-4777-8777-777777777777",
      presetName: "Runtime smoke",
      operatorMode: "admin",
      status: "active",
      trafficStatus: "active",
      saleOfferId,
      configSnapshot: acceptedConfig(),
      startedAt: "2026-07-23T00:00:00.000Z",
      trafficStartedAt: "2026-07-23T00:00:00.000Z",
    },
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    recentCompletionOutcomes: [],
    transportAttemptCounts: null,
    httpSummary: null,
    requestArrivalSummary: null,
    runSignalTimelineSummary: null,
  };
}

function terminalProjection() {
  return {
    ...activeProjection(),
    revision: 4,
    currentRun: {
      ...activeProjection().currentRun,
      status: "completed",
      trafficStatus: "succeeded",
      trafficEndedAt: "2026-07-23T00:00:05.000Z",
      finalizedAt: "2026-07-23T00:00:06.000Z",
    },
    inventory: {
      saleOfferId,
      allocatedStock: 32,
      remainingStock: 0,
      reservedStock: 32,
      pendingPersistenceCount: 0,
      expiredReservationCount: 0,
      oldestPendingPersistenceAgeSeconds: 0,
      reservationThroughput: {
        windowSeconds: 1,
        successfulReservationCount: 32,
        peakRatePerSecond: 32,
        peakWindowSeconds: 1,
        unit: "reservations_per_second",
        measuredAt: "2026-07-23T00:00:05.000Z",
      },
      soldOutPressure: { rejectionCount: 0, latestObservedAt: null },
      lastUpdatedAt: "2026-07-23T00:00:05.000Z",
    },
    businessOutcome: terminalBusinessOutcome(),
    transportAttemptCounts: terminalTransport(),
  };
}

function terminalSummary() {
  return {
    status: "completed",
    transportAttemptCounts: terminalTransport(),
    trafficDeliverySummary: {
      trafficMode: "buyer-spike",
      plannedBuyers: 32,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: 32,
      notes: [],
      trafficDeliveryStatus: "complete",
    },
    businessOutcomeSummary: terminalBusinessOutcome(),
    terminalInventorySnapshot: {
      saleOfferId,
      startingStock: 32,
      remainingStock: 0,
      reservedStock: 32,
      acceptedReservations: 32,
      soldOutRejections: 0,
      pendingPersistenceCount: 0,
      capturedAt: "2026-07-23T00:00:06.000Z",
      source: "redis",
    },
  };
}

function terminalTransport() {
  return {
    plannedRequests: 32,
    startedRequests: 32,
    completedRequests: 32,
    interruptedRequests: 0,
    unstartedRequests: 0,
  };
}

function terminalBusinessOutcome() {
  return {
    acceptedReservations: 32,
    soldOutRejections: 0,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: 32,
    failedOrders: 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: 32,
  };
}

function acceptedConfig() {
  return {
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
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 5,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
      drainTimeoutSeconds: 300,
    },
  };
}
