import type { CapacityAssessment } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import {
  capacityRefusalCopy,
  capacityWarningCopy,
  explicitVusWarning,
} from "../src/app/lib/presentation/capacity-presentation";

// Every fixture is what the API's model returns for the stated run, on the Fly or local values.
const assessments = {
  /** Fly, 2,500/s for 4 s, stock 1,000. */
  flyHeavyStock: {
    mode: "constant-arrival-rate",
    verdict: "expected_to_fail",
    ratePerSecond: 2_500,
    durationSeconds: 4,
    startingStock: 1_000,
    acceptedOrders: 1_000,
    loadPerSecond: 4_000,
    capacityPerSecond: 3_500,
    poolOrderLimit: 8_160,
    fit: { ratePerSecond: 1_300, startingStock: 200 },
  },
  /** Fly, 3,000/s for 4 s, stock 1,000: the rate alone is too high. */
  flyHeavyRate: {
    mode: "constant-arrival-rate",
    verdict: "expected_to_fail",
    ratePerSecond: 3_000,
    durationSeconds: 4,
    startingStock: 1_000,
    acceptedOrders: 1_000,
    loadPerSecond: 4_500,
    capacityPerSecond: 3_500,
    poolOrderLimit: 8_160,
    fit: { ratePerSecond: 1_300, startingStock: null },
  },
  /** Fly, 2,800/s for 10 s, stock 1: only selling nothing would fit. */
  flyLimitOneUnit: {
    mode: "constant-arrival-rate",
    verdict: "at_the_limit",
    ratePerSecond: 2_800,
    durationSeconds: 10,
    startingStock: 1,
    acceptedOrders: 1,
    loadPerSecond: 2_800.6,
    capacityPerSecond: 3_500,
    poolOrderLimit: 9_600,
    fit: { ratePerSecond: 2_799, startingStock: 0 },
  },
  /** Local, 2,386/s for 1 s, stock 2. */
  localLimitSingular: {
    mode: "constant-arrival-rate",
    verdict: "at_the_limit",
    ratePerSecond: 2_386,
    durationSeconds: 1,
    startingStock: 2,
    acceptedOrders: 2,
    loadPerSecond: 2_414,
    capacityPerSecond: 3_000,
    poolOrderLimit: 6_045,
    fit: { ratePerSecond: 2_372, startingStock: 1 },
  },
  /** Fly, 3,000/s for 3 s, sold out. */
  flyLimitSoldOut: {
    mode: "constant-arrival-rate",
    verdict: "at_the_limit",
    ratePerSecond: 3_000,
    durationSeconds: 3,
    startingStock: 0,
    acceptedOrders: 0,
    loadPerSecond: 3_000,
    capacityPerSecond: 3_500,
    poolOrderLimit: 7_920,
    fit: { ratePerSecond: 2_800, startingStock: null },
  },
  /** Local, 1,000/s for 10 s, stock 9,000: past both the API process and the pool. */
  localPool: {
    mode: "constant-arrival-rate",
    verdict: "expected_to_fail",
    ratePerSecond: 1_000,
    durationSeconds: 10,
    startingStock: 9_000,
    acceptedOrders: 9_000,
    loadPerSecond: 13_600,
    capacityPerSecond: 3_000,
    poolOrderLimit: 7_800,
    fit: { ratePerSecond: 160, startingStock: 1_000 },
  },
  /** Fly, 500/s for 20 s, stock 1,000. */
  flyComplete: {
    mode: "constant-arrival-rate",
    verdict: "expected_to_complete",
    ratePerSecond: 500,
    durationSeconds: 20,
    startingStock: 1_000,
    acceptedOrders: 1_000,
    loadPerSecond: 1_100,
    capacityPerSecond: 3_500,
    poolOrderLimit: 12_000,
  },
  /** Local, 10,000 buyers, stock 1,000, cutoff 10 s. */
  localSpikeCutoff: {
    mode: "buyer-spike",
    verdict: "expected_to_fail",
    buyerCount: 10_000,
    startingStock: 1_000,
    acceptedOrders: 1_000,
    timeToServeSeconds: 14.277699859747546,
    windowSeconds: 10,
    fit: { buyerCount: 2_780, startingStock: null, maxDurationSeconds: 18 },
  },
  /** Fly, 10,000 buyers, stock 1, cutoff 4 s. */
  flySpikeLimitOneUnit: {
    mode: "buyer-spike",
    verdict: "at_the_limit",
    buyerCount: 10_000,
    startingStock: 1,
    acceptedOrders: 1,
    timeToServeSeconds: 3.8499358974358975,
    windowSeconds: 4,
    fit: { buyerCount: 8_310, startingStock: null, maxDurationSeconds: 5 },
  },
  /** Local, 10,000 buyers, stock 10,000, cutoff 120 s. */
  localSpikeTimeout: {
    mode: "buyer-spike",
    verdict: "expected_to_fail",
    buyerCount: 10_000,
    startingStock: 10_000,
    acceptedOrders: 10_000,
    timeToServeSeconds: 64.51612903225806,
    windowSeconds: 60,
    fit: { buyerCount: 7_440, startingStock: 7_041, maxDurationSeconds: null },
  },
  /** Local, 60,000 buyers, stock 1,000, cutoff 120 s. */
  localSpikeTimeoutLimit: {
    mode: "buyer-spike",
    verdict: "at_the_limit",
    buyerCount: 60_000,
    startingStock: 1_000,
    acceptedOrders: 1_000,
    timeToServeSeconds: 57.75596072931276,
    windowSeconds: 60,
    fit: { buyerCount: 48_780, startingStock: null, maxDurationSeconds: null },
  },
} satisfies Record<string, CapacityAssessment>;

const server =
  "A single API process answers every buyer, and each unit sold is first written to the database, which is much slower.";
const heavy = `This run is too heavy for the demo's server. ${server}`;
const close = `This run is too close to the demo server's limit to be sure every buyer gets an answer in time. ${server}`;

describe("public capacity refusal", () => {
  it("names the largest rate and stock for a constant-arrival run expected to fail", () => {
    expect(capacityRefusalCopy(assessments.flyHeavyStock)).toEqual([
      `${heavy} At 2,500 requests per second for 4 seconds with 1,000 units in stock, the server would fall behind and some buyers would not get their answer in time. Keeping this stock and duration, the rate can go up to 1,300 requests per second; keeping this rate, the stock can go up to 200 units. Lower the rate or the stock, or run the project locally or on larger infrastructure.`,
    ]);
  });

  it("leaves the stock out when less stock cannot help", () => {
    expect(capacityRefusalCopy(assessments.flyHeavyRate)).toEqual([
      `${heavy} At 3,000 requests per second for 4 seconds, the server would fall behind and some buyers would not get their answer in time. Keeping this stock and duration, the rate can go up to 1,300 requests per second. Lower the rate, or run the project locally or on larger infrastructure.`,
    ]);
    // Selling nothing is no suggestion either.
    expect(capacityRefusalCopy(assessments.flyLimitOneUnit)).toEqual([
      `${close} At 2,800 requests per second for 10 seconds, the run would use 80% of what the server can sustain. Keeping this stock and duration, the rate can go up to 2,799 requests per second. Lower the rate, or run the project locally or on larger infrastructure.`,
    ]);
  });

  it("states the share of the server a run at the limit would use, with singular values", () => {
    expect(capacityRefusalCopy(assessments.localLimitSingular)).toEqual([
      `${close} At 2,386 requests per second for 1 second with 2 units in stock, the run would use 80% of what the server can sustain. Keeping this stock and duration, the rate can go up to 2,372 requests per second; keeping this rate, the stock can go up to 1 unit. Lower the rate or the stock, or run the project locally or on larger infrastructure.`,
    ]);
  });

  it("compares a buyer spike with its safety cutoff", () => {
    expect(capacityRefusalCopy(assessments.localSpikeCutoff)).toEqual([
      `${heavy} With 10,000 buyers and 1,000 units, this server needs about 14.3 seconds to answer everyone, more than the 10-second safety cutoff. Raise the safety cutoff to 18 seconds, or lower the buyers to 2,780.`,
    ]);
    expect(capacityRefusalCopy(assessments.flySpikeLimitOneUnit)).toEqual([
      `${close} With 10,000 buyers and 1 unit, this server needs about 3.8 seconds to answer everyone, too close to the 4-second safety cutoff. Raise the safety cutoff to 5 seconds, or lower the buyers to 8,310.`,
    ]);
  });

  it("suggests fewer buyers or less stock past the load generator's request timeout", () => {
    expect(capacityRefusalCopy(assessments.localSpikeTimeout)).toEqual([
      `${heavy} With 10,000 buyers and 10,000 units, this server needs about 64.5 seconds to answer everyone, more than the 60 seconds the load generator waits for an answer. Lower the buyers to 7,440 or the stock to 7,041 units.`,
    ]);
    expect(capacityRefusalCopy(assessments.localSpikeTimeoutLimit)).toEqual([
      `${close} With 60,000 buyers and 1,000 units, this server needs about 57.8 seconds to answer everyone, too close to the 60 seconds the load generator waits for an answer. Lower the buyers to 48,780.`,
    ]);
  });
});

describe("admin capacity warning", () => {
  it("stays silent for a run expected to complete", () => {
    expect(capacityWarningCopy(assessments.flyComplete)).toEqual([]);
  });

  it("flags a constant-arrival run at the limit", () => {
    expect(capacityWarningCopy(assessments.flyLimitSoldOut)).toEqual([
      "Near this deployment's capacity: the run asks about 3,000 answers per second, 86 % of the 3,500 one API process gives here. It may complete, with little margin. Expected to complete: up to 2,800 per second.",
    ]);
  });

  it("flags a constant-arrival run expected to fail, and the database pool when it is a limit", () => {
    expect(capacityWarningCopy(assessments.flyHeavyStock)).toEqual([
      "Beyond this deployment's capacity: about 4,000 answers per second against 3,500. Expect a failed delivery: requests never sent at the virtual-user limit, or answers arriving too late. Expected to complete: up to 1,300 per second, or up to 200 units.",
    ]);
    expect(capacityWarningCopy(assessments.localPool)).toEqual([
      "Beyond this deployment's capacity: about 13,600 answers per second against 3,000. Expect a failed delivery: requests never sent at the virtual-user limit, or answers arriving too late.",
      "The database pool can answer about 7,800 orders before the load generator stops listening, 30 seconds after its sending window closes; this run would sell 9,000. Their answers would arrive too late. Expected to complete: up to 160 per second, or up to 1,000 units.",
    ]);
  });

  it("flags a buyer spike past the load generator's request timeout", () => {
    expect(capacityWarningCopy(assessments.localSpikeTimeout)).toEqual([
      "About 64.5 seconds to answer, longer than the 60 seconds the load generator waits: late buyers would end in transport failure. Expected to complete: up to 7,440 buyers or 7,041 units.",
    ]);
  });

  it("flags explicit VUs that pre-allocate fewer than the deployment would for the rate", () => {
    const traffic = (k6Vus?: { preAllocatedVus: number; maxVus: number }) => ({
      mode: "constant-arrival-rate" as const,
      ratePerSecond: 500,
      durationSeconds: 10,
      startDelaySeconds: 0,
      quantityPerAttempt: 1,
      ...(k6Vus ? { k6Vus } : {}),
    });
    expect(explicitVusWarning(traffic({ preAllocatedVus: 20, maxVus: 40 }), 1_500)).toBe(
      "These virtual users are fewer than this deployment would allocate for this rate (1,500); requests may never be sent.",
    );
    expect(
      explicitVusWarning(traffic({ preAllocatedVus: 1_500, maxVus: 1_500 }), 1_500),
    ).toBeNull();
    expect(explicitVusWarning(traffic(), 1_500)).toBeNull();
  });

  it("flags a buyer spike bound by its safety cutoff", () => {
    expect(capacityWarningCopy(assessments.localSpikeCutoff)).toEqual([
      "Beyond this deployment's capacity: about 14.3 seconds to answer, more than the 10-second safety cutoff. Expect a failed delivery: answers arriving too late, or requests never sent before the cutoff. Expected to complete: a safety cutoff of 18 seconds, or up to 2,780 buyers.",
    ]);
  });
});
