import assert from "node:assert/strict";
import test from "node:test";
import { originalIncidentFixture } from "../packages/contracts/dist/testing.js";
import {
  assertAcceptance,
  assertOutageEvidence,
  calibrationEvidence,
  summarizeErpHttp,
} from "./runtime-acceptance.mjs";

function settledIncident() {
  return {
    businessOutcomeSummary: {
      acceptedReservations: 888,
      soldOutRejections: 612,
      confirmedOrders: 888,
      notificationsRecorded: 888,
      failedOrders: 0,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      pendingPersistenceCount: 0,
    },
    transportAttemptCounts: {
      plannedRequests: 1500,
      startedRequests: 1500,
      completedRequests: 1500,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    httpSummary: {
      acceptedResponses: 888,
      soldOutResponses: 612,
      transportFailures: 0,
      unexpectedResponses: 0,
    },
    trafficDeliverySummary: { droppedIterations: 0 },
    terminalInventorySnapshot: { startingStock: 888, remainingStock: 0, reservedStock: 888 },
  };
}
const durable = {
  reservations: 888,
  confirmed: 888,
  ledger: 888,
  notifications: 888,
  outstanding: 0,
  unresolved: 0,
};

test("acceptance requires exact traffic, canonical effects and settled obligations", () => {
  const expected = originalIncidentFixture().expected;
  assert.doesNotThrow(() => assertAcceptance(settledIncident(), durable, expected));
  const missedArrival = settledIncident();
  missedArrival.transportAttemptCounts.startedRequests--;
  assert.throws(() => assertAcceptance(missedArrival, durable, expected), /startedRequests/);
  const partial = settledIncident();
  partial.trafficDeliverySummary.droppedIterations = 1;
  assert.throws(() => assertAcceptance(partial, durable, expected), /dropped iterations/);
  assert.throws(
    () => assertAcceptance(settledIncident(), { ...durable, ledger: 889 }, expected),
    /canonical external effects/,
  );
  assert.throws(
    () => assertAcceptance(settledIncident(), { ...durable, unresolved: 1 }, expected),
    /unresolved calls/,
  );
});

test("HTTP evidence distinguishes POST pressure, lookup and unobservable replay headers", () => {
  const post = { msg: "incoming request", req: { method: "POST", url: "/confirmations" } };
  const done = { msg: "Mock ERP confirmation request completed.", httpStatus: 200 };
  const result = summarizeErpHttp([
    post,
    post,
    { ...done, httpStatus: 429 },
    done,
    { msg: "incoming request", req: { method: "GET", url: "/confirmations/key" } },
  ]);
  assert.equal(result.posts, 2);
  assert.equal(result.lookups, 1);
  assert.equal(result.capacityResponses, 1);
  assert.equal(result.maximumInFlight, 2);
  assert.equal(result.unmatchedRequests, 0);
  assert.equal(result.replayResponses, null);
});

test("outage accepts retained uncertainty and backoff beyond the outage, but rejects rapid probes", () => {
  const at = (ms) => new Date(ms).toISOString();
  const report = {
    outage: {
      stopRequestedAt: at(0),
      circuitOpenObservedAt: at(1000),
      startRequestedAt: at(30000),
      restoredAt: at(31000),
    },
    workerHttp: { events: [{ time: 500, disposition: "uncertain_result" }] },
    erpHttp: { events: [{ time: 40000, method: "GET", path: "/confirmations/key" }] },
  };
  assert.doesNotThrow(() => assertOutageEvidence(report));
  assert.equal(report.outage.probeEvidence.events.length, 0);
  report.workerHttp.events.push(
    { time: 10000, disposition: "temporarily_unavailable" },
    { time: 12000, disposition: "temporarily_unavailable" },
  );
  assert.throws(() => assertOutageEvidence(report), /five seconds apart/);
});

test("calibration evidence reports job overhead, settlement delay and excess attempts", () => {
  const evidence = calibrationEvidence(
    {
      confirmed: 2,
      attempts: [{ status: "failed" }, { status: "succeeded" }, { status: "succeeded" }],
      lastNotificationAt: "2026-09-22T10:00:00.000Z",
      finalizedAt: "2026-09-22T10:00:04.500Z",
    },
    [
      [1000, 1300],
      [1000, 1500],
      [0, 0], // Killed worker: no completion timestamps.
    ],
    200,
  );
  assert.equal(evidence.jobs, 2);
  assert.equal(evidence.meanJobMs, 400);
  assert.equal(evidence.maxJobMs, 500);
  assert.equal(evidence.meanJobOverheadMs, 200);
  assert.equal(evidence.settlementDelaySeconds, 4.5);
  assert.equal(evidence.excessAttempts, 1);
  const unsettled = calibrationEvidence(
    { confirmed: 0, attempts: [], lastNotificationAt: null, finalizedAt: null },
    [],
    200,
  );
  assert.equal(unsettled.meanJobOverheadMs, null);
  assert.equal(unsettled.settlementDelaySeconds, null);
});
