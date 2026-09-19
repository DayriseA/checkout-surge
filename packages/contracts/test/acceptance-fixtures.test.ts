import { describe, expect, it } from "vitest";
import { acceptedRunConfigSnapshotSchema, erpProfileSchema } from "../src/index.js";
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
      "surge-10k-preset-reference",
    ]);
  });

  it("parses every fixture scenario configuration with the accepted snapshot schema", () => {
    for (const fixture of acceptanceScenarioFixtures()) {
      if (fixture.config === null) {
        expect(fixture.presetSlug).toBe("surge-10k");
        continue;
      }
      expect(() => acceptedRunConfigSnapshotSchema.parse(fixture.config)).not.toThrow();
    }
  });

  it("keeps profile fixtures admin-scoped and schema-valid", () => {
    for (const fixture of acceptanceScenarioFixtures()) {
      if (fixture.profile === null) continue;
      expect(fixture.operatorScope).toBe("admin");
      expect(() => erpProfileSchema.parse(fixture.profile)).not.toThrow();
    }
    expect(
      acceptanceScenarioFixtures()
        .filter((fixture) => fixture.profile !== null)
        .map((fixture) => fixture.name),
    ).toEqual(["finite-outage", "latency-increase"]);
  });

  it("starts each profile segment before the ideal service completion of accepted orders", () => {
    for (const fixture of acceptanceScenarioFixtures()) {
      if (fixture.profile === null || fixture.config === null) continue;
      const { latencyMs, maxTps } = fixture.config.erpConfig;
      const concurrency = fixture.config.backpressureConfig.orderProcessConcurrency;
      const serviceRate = Math.min(maxTps, concurrency / (latencyMs / 1000));
      const idealServiceSeconds = fixture.expected.acceptedReservations / serviceRate;
      expect(idealServiceSeconds).toBeGreaterThan(0);
      for (const segment of fixture.profile.segments) {
        expect(segment.offsetSeconds).toBeLessThan(idealServiceSeconds);
      }
    }
  });

  it("raises latency-increase latency beyond the initial request deadline", () => {
    const fixture = fixtureByName("latency-increase");
    const segment = fixture.profile?.segments[0];
    if (!segment || !fixture.config) throw new Error("latency-increase fixture is misconfigured");
    expect(segment.override.latencyMs).toBe(3000);
    expect(segment.override.latencyMs).toBeGreaterThan(fixture.config.erpConfig.requestTimeoutMs);
  });

  it("carries exact internally consistent business counts", () => {
    for (const fixture of acceptanceScenarioFixtures()) {
      const expected = fixture.expected;
      expect(expected.terminalOrderFailures).toBe(0);
      expect(expected.notificationsRecorded).toBe(expected.confirmedOrders);
      expect(expected.confirmedOrders).toBeLessThanOrEqual(expected.acceptedReservations);
      expect(expected.reservedUnits).toBe(
        expected.acceptedReservations * quantityPerCheckout(fixture),
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
      requestTimeoutMs: 2000,
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

  it("still parses the legacy accepted snapshot shape with retired engine fields", () => {
    const legacy = previewRunConfigSnapshotFixture();
    expect(legacy.backpressureConfig.retryPolicy).toEqual({
      maxAttempts: 4,
      initialBackoffMs: 500,
    });
    expect(legacy.backpressureConfig.drainTimeoutSeconds).toBe(300);
    expect(legacy.erpConfig.requestTimeoutMs).toBe(2000);
    expect(() => acceptedRunConfigSnapshotSchema.parse(legacy)).not.toThrow();
  });
});

function quantityPerCheckout(fixture: AdaptiveErpScenarioFixture): number {
  const quantity = fixture.config?.inventoryConfig.quantityPerCheckout ?? 1;
  return quantity;
}

function fixtureByName(name: string): AdaptiveErpScenarioFixture {
  const fixture = acceptanceScenarioFixtures().find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`Missing acceptance fixture: ${name}`);
  return fixture;
}
