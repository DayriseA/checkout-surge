import { describe, expect, it } from "vitest";
import {
  acceptedRunConfigSnapshotSchema,
  acceptedRunConfigWriteSchema,
  historicalAcceptedRunConfigSnapshotSchema,
  largestAllowedErpLatencyMs,
  publicRuntimePolicyMutableWriteSchema,
} from "../src/index.js";
import {
  type AdaptiveErpScenarioFixture,
  acceptanceScenarioFixtures,
  previewRunConfigSnapshotFixture,
} from "../src/testing.js";

describe("adaptive ERP acceptance fixtures", () => {
  it("exposes the six named deterministic fixtures", () => {
    expect(acceptanceScenarioFixtures().map((fixture) => fixture.name)).toEqual([
      "original-incident",
      "low-capacity-backlog",
      "finite-outage",
      "latency-increase",
      "duplicate-attempts",
      "concurrency-saturation-reference",
    ]);
  });

  it("parses every fixture scenario configuration with the accepted snapshot schema", () => {
    for (const fixture of acceptanceScenarioFixtures()) {
      expect(fixture.config).not.toBeNull();
      expect(fixture.presetSlug).toBeNull();
      expect(() => acceptedRunConfigWriteSchema.parse(fixture.config)).not.toThrow();
    }
  });

  it("carries exact internally consistent business counts", () => {
    for (const fixture of acceptanceScenarioFixtures()) {
      const expected = fixture.expected;
      expect(expected.terminalOrderFailures).toBe(0);
      expect(expected.notificationsRecorded).toBe(expected.confirmedOrders);
      expect(expected.confirmedOrders).toBeLessThanOrEqual(expected.acceptedReservations);
      expect(expected.reservedUnits).toBe(
        expected.acceptedReservations * quantityPerAttempt(fixture),
      );
      expect(
        expected.acceptedReservations +
          expected.soldOutResponses +
          expected.duplicateReplayResponses,
      ).toBe(expected.plannedEmittedAttempts);
    }
  });

  it("reproduces the incident's exact accounting", () => {
    const incident = fixtureByName("original-incident");
    expect(incident.expected).toEqual({
      plannedEmittedAttempts: 1500,
      acceptedReservations: 888,
      reservedUnits: 888,
      soldOutResponses: 612,
      duplicateReplayResponses: 0,
      confirmedOrders: 888,
      notificationsRecorded: 888,
      terminalOrderFailures: 0,
    });
    expect(incident.config?.erpConfig).toEqual({
      latencyMs: 250,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
    });
    expect(incident.config?.backpressureConfig.orderProcessConcurrency).toBe(5);
  });

  it("keeps duplicate-attempt effects unique per buyer instead of per HTTP attempt", () => {
    const duplicateFixture = fixtureByName("duplicate-attempts");
    expect(duplicateFixture.config?.trafficConfig).toMatchObject({
      mode: "buyer-spike",
      buyerCount: 200,
      duplicateEachBuyerAttempt: true,
    });
    expect(duplicateFixture.expected.acceptedReservations).toBe(200);
    expect(duplicateFixture.expected.duplicateReplayResponses).toBe(200);
  });

  it("keeps production runtime resources out of fixtures", () => {
    for (const fixture of acceptanceScenarioFixtures()) {
      const serialized = JSON.stringify(fixture);
      expect(serialized).not.toMatch(/https?:\/\//);
      expect(serialized).not.toMatch(/postgres:|redis:|amqp:/);
    }
  });

  it("rejects retired engine knobs on new input and keeps historical snapshots readable", () => {
    const legacy = {
      ...previewRunConfigSnapshotFixture(),
      erpConfig: {
        ...previewRunConfigSnapshotFixture().erpConfig,
        requestTimeoutMs: 2000,
      },
      backpressureConfig: {
        ...previewRunConfigSnapshotFixture().backpressureConfig,
        retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
        drainTimeoutSeconds: 300,
        circuitBreakerFailureThreshold: 5,
        circuitBreakerResetTimeoutMs: 10_000,
      },
    };
    expect(() => acceptedRunConfigWriteSchema.parse(legacy)).toThrow();
    expect(() => acceptedRunConfigSnapshotSchema.parse(legacy)).toThrow();

    const historical = historicalAcceptedRunConfigSnapshotSchema.parse(legacy);
    expect(historical).toEqual(previewRunConfigSnapshotFixture());
    expect(historical.erpConfig).not.toHaveProperty("requestTimeoutMs");
    expect(historical.backpressureConfig).not.toHaveProperty("retryPolicy");
    expect(historical.backpressureConfig).not.toHaveProperty("drainTimeoutSeconds");
    expect(historical.backpressureConfig).not.toHaveProperty("circuitBreakerFailureThreshold");
    expect(historical.backpressureConfig).not.toHaveProperty("circuitBreakerResetTimeoutMs");
  });

  it("bounds new latency inputs without tightening historical snapshot reads", () => {
    const legacy = previewRunConfigSnapshotFixture();
    legacy.erpConfig.latencyMs = largestAllowedErpLatencyMs + 1;
    expect(() => acceptedRunConfigSnapshotSchema.parse(legacy)).not.toThrow();
    expect(() => acceptedRunConfigWriteSchema.parse(legacy)).toThrow();

    const defaults = previewRunConfigSnapshotFixture();
    const policy = {
      isPublicRunBudgetEnforced: true,
      publicRunBudget: { windowSeconds: 300, perVisitorMaxStarts: 2, globalMaxStarts: 6 },
      publicCustomDefaults: defaults,
      publicCustomLimits: {
        maxTotalRequests: 100,
        maxBuyers: 100,
        maxRequestsPerSecond: 100,
        maxTrafficDurationSeconds: 100,
        maxTrafficStartDelaySeconds: 10,
        maxPreAllocatedVus: 10,
        maxVus: 10,
        maxStartingStock: 100,
        maxErpLatencyMs: largestAllowedErpLatencyMs + 1,
        minErpMaxTps: 1,
        maxErpMaxTps: 10,
        maxErpErrorRate: 0.25,
        allowForcedOutage: false,
        allowedTrafficModes: ["buyer-spike"],
      },
    };
    expect(() => publicRuntimePolicyMutableWriteSchema.parse(policy)).toThrow();
  });
});

function quantityPerAttempt(fixture: AdaptiveErpScenarioFixture): number {
  const traffic = fixture.config?.trafficConfig;
  return traffic?.quantityPerAttempt ?? 1;
}

function fixtureByName(name: string): AdaptiveErpScenarioFixture {
  const fixture = acceptanceScenarioFixtures().find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`Missing acceptance fixture: ${name}`);
  return fixture;
}
