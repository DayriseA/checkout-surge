import type { ErpProfile } from "./erp-profile.js";
import type { DemoPresetVisibility } from "./lifecycle.js";
import type { AcceptedRunConfigSnapshot } from "./load.js";

/**
 * Exact expected business totals for an acceptance fixture. Counts are exact,
 * not eventual-success assertions. No timing or policy constant appears here:
 * engine constants are provisional until task 20 calibration and approval.
 */
export interface AdaptiveErpFixtureExpectedCounts {
  plannedEmittedAttempts: number;
  acceptedReservations: number;
  reservedUnits: number;
  soldOutResponses: number;
  duplicateReplayResponses: number;
  confirmedOrders: number;
  notificationsRecorded: number;
  terminalOrderFailures: number;
}

/**
 * A named deterministic acceptance scenario (task 01). `config` parses with
 * `acceptedRunConfigSnapshotSchema`; `profile` parses with `erpProfileSchema`.
 * The `surge-10k` reference reuses the existing seeded preset by slug and
 * intentionally carries no copied configuration. Fixtures never contain
 * production runtime resources (URLs, connection strings, or clients).
 */
export interface AdaptiveErpScenarioFixture {
  name: string;
  description: string;
  operatorScope: DemoPresetVisibility;
  presetSlug: string | null;
  config: AcceptedRunConfigSnapshot | null;
  profile: ErpProfile | null;
  expected: AdaptiveErpFixtureExpectedCounts;
}

function backpressureConfig(
  orderProcessConcurrency: number,
): AcceptedRunConfigSnapshot["backpressureConfig"] {
  return {
    queueName: "orders:process",
    physicalQueueName: "orders-process",
    orderProcessConcurrency,
    retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
    drainTimeoutSeconds: 300,
    pendingPersistenceRetryAfterSeconds: 30,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerResetTimeoutMs: 10_000,
  };
}

/**
 * The original incident (plan section 2): 25 requests/s for 60 seconds against
 * stock 888, ERP 10/s and 250 ms, worker concurrency 5, no injected error and
 * no outage. Accounting: 888 + 612 = 1,500 attempts; zero terminal failures.
 */
export function originalIncidentFixture(): AdaptiveErpScenarioFixture {
  return {
    name: "original-incident",
    description:
      "Original incident replay: constant 25 req/s for 60 s, stock 888, ERP 10/s at 250 ms, concurrency 5, no chaos.",
    operatorScope: "admin",
    presetSlug: null,
    config: {
      trafficConfig: {
        mode: "constant-arrival-rate",
        ratePerSecond: 25,
        durationSeconds: 60,
        startDelaySeconds: 0,
        quantityPerAttempt: 1,
      },
      inventoryConfig: { startingStock: 888, quantityPerCheckout: 1, reservationHoldMinutes: 15 },
      erpConfig: {
        latencyMs: 250,
        maxTps: 10,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 2000,
      },
      backpressureConfig: backpressureConfig(5),
    },
    profile: null,
    expected: {
      plannedEmittedAttempts: 1500,
      acceptedReservations: 888,
      reservedUnits: 888,
      soldOutResponses: 612,
      duplicateReplayResponses: 0,
      confirmedOrders: 888,
      notificationsRecorded: 888,
      terminalOrderFailures: 0,
    },
  };
}

/** ERP capacity far below offered load; the accepted backlog must drain without exhaustion failures. */
export function lowCapacityFixture(): AdaptiveErpScenarioFixture {
  return {
    name: "low-capacity-backlog",
    description:
      "Low ERP capacity: constant 10 req/s for 60 s, stock 300, ERP 2/s at 200 ms, concurrency 5, no chaos.",
    operatorScope: "admin",
    presetSlug: null,
    config: {
      trafficConfig: {
        mode: "constant-arrival-rate",
        ratePerSecond: 10,
        durationSeconds: 60,
        startDelaySeconds: 0,
        quantityPerAttempt: 1,
      },
      inventoryConfig: { startingStock: 300, quantityPerCheckout: 1, reservationHoldMinutes: 15 },
      erpConfig: {
        latencyMs: 200,
        maxTps: 2,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 2000,
      },
      backpressureConfig: backpressureConfig(5),
    },
    profile: null,
    expected: {
      plannedEmittedAttempts: 600,
      acceptedReservations: 300,
      reservedUnits: 300,
      soldOutResponses: 300,
      duplicateReplayResponses: 0,
      confirmedOrders: 300,
      notificationsRecorded: 300,
      terminalOrderFailures: 0,
    },
  };
}

/**
 * Finite outage segment followed by recovery to base; admin-scope profile only.
 * Dimensioning: service rate r = min(200, 5 / 1.0 s) = 5 confirmations/s, so
 * the 200 accepted orders need an ideal 40 s; the outage opens at 10 s with
 * 150 orders still outstanding and lifts at 40 s, exercising degradation and
 * the recovery tail.
 */
export function finiteOutageFixture(): AdaptiveErpScenarioFixture {
  return {
    name: "finite-outage",
    description:
      "Finite ERP outage: buyer spike of 200, stock 200, ERP 200/s at 1000 ms (5 confirmations/s at concurrency 5, ideal 40 s), outage from 10 s for 30 s, then recovery.",
    operatorScope: "admin",
    presetSlug: null,
    config: {
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 200,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 10,
        quantityPerAttempt: 1,
      },
      inventoryConfig: { startingStock: 200, quantityPerCheckout: 1, reservationHoldMinutes: 15 },
      erpConfig: {
        latencyMs: 1000,
        maxTps: 200,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 2000,
      },
      backpressureConfig: backpressureConfig(5),
    },
    profile: {
      identity: { profileId: "finite-outage-recovery", version: 1 },
      baseConfig: { latencyMs: 1000, maxTps: 200, errorRate: 0, forcedOutage: false },
      segments: [{ offsetSeconds: 10, durationSeconds: 30, override: { forcedOutage: true } }],
      recoveryToBase: true,
    },
    expected: {
      plannedEmittedAttempts: 200,
      acceptedReservations: 200,
      reservedUnits: 200,
      soldOutResponses: 0,
      duplicateReplayResponses: 0,
      confirmedOrders: 200,
      notificationsRecorded: 200,
      terminalOrderFailures: 0,
    },
  };
}

/**
 * Latency increase segment followed by recovery to base; admin-scope profile
 * only. Dimensioning: base service rate r = min(10, 5 / 0.25 s) = 10/s while
 * arrivals run at 20/s, so accepted work is continuously outstanding; the
 * raised 3000 ms latency exceeds the 2000 ms initial request deadline (seed
 * default `ERP_REQUEST_TIMEOUT_MS`), exercising the section 11 "latency beyond
 * the initial request deadline" case while the segment (15 s–45 s) overlaps
 * the backlog and recovery drains the rest at the base rate.
 */
export function latencyIncreaseFixture(): AdaptiveErpScenarioFixture {
  return {
    name: "latency-increase",
    description:
      "Latency increase: constant 20 req/s for 30 s (600 attempts), stock 600, ERP 10/s at 250 ms (10/s service vs 20/s arrivals), latency 3000 ms from 15 s for 30 s (beyond the 2000 ms initial deadline), then recovery.",
    operatorScope: "admin",
    presetSlug: null,
    config: {
      trafficConfig: {
        mode: "constant-arrival-rate",
        ratePerSecond: 20,
        durationSeconds: 30,
        startDelaySeconds: 0,
        quantityPerAttempt: 1,
      },
      inventoryConfig: { startingStock: 600, quantityPerCheckout: 1, reservationHoldMinutes: 15 },
      erpConfig: {
        latencyMs: 250,
        maxTps: 10,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 2000,
      },
      backpressureConfig: backpressureConfig(5),
    },
    profile: {
      identity: { profileId: "latency-increase-recovery", version: 1 },
      baseConfig: { latencyMs: 250, maxTps: 10, errorRate: 0, forcedOutage: false },
      segments: [{ offsetSeconds: 15, durationSeconds: 30, override: { latencyMs: 3000 } }],
      recoveryToBase: true,
    },
    expected: {
      plannedEmittedAttempts: 600,
      acceptedReservations: 600,
      reservedUnits: 600,
      soldOutResponses: 0,
      duplicateReplayResponses: 0,
      confirmedOrders: 600,
      notificationsRecorded: 600,
      terminalOrderFailures: 0,
    },
  };
}

/** Duplicate idempotent attempts: unique effects stay at one per buyer, not per HTTP attempt. */
export function duplicateAttemptsFixture(): AdaptiveErpScenarioFixture {
  return {
    name: "duplicate-attempts",
    description:
      "Duplicate attempts: 200 buyers each clicking twice, stock 200, ERP 200/s at 50 ms, concurrency 5; one confirmation per buyer.",
    operatorScope: "admin",
    presetSlug: null,
    config: {
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 200,
        duplicateEachBuyerAttempt: true,
        startDelaySeconds: 0,
        maxDurationSeconds: 11,
        quantityPerAttempt: 1,
      },
      inventoryConfig: { startingStock: 200, quantityPerCheckout: 1, reservationHoldMinutes: 15 },
      erpConfig: {
        latencyMs: 50,
        maxTps: 200,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 2000,
      },
      backpressureConfig: backpressureConfig(5),
    },
    profile: null,
    expected: {
      plannedEmittedAttempts: 400,
      acceptedReservations: 200,
      reservedUnits: 200,
      soldOutResponses: 0,
      duplicateReplayResponses: 200,
      confirmedOrders: 200,
      notificationsRecorded: 200,
      terminalOrderFailures: 0,
    },
  };
}

/**
 * Reference to the existing seeded `surge-10k` public preset. The preset's
 * configuration stays owned by its seed; this fixture carries only the slug
 * and the exact expected business totals (10,000 buyers, stock 1,000).
 */
export function surge10kPresetReferenceFixture(): AdaptiveErpScenarioFixture {
  return {
    name: "surge-10k-preset-reference",
    description:
      "Reference to the existing seeded public surge-10k preset: 10,000 buyers rush 1,000 units; configuration owned by the seed.",
    operatorScope: "public",
    presetSlug: "surge-10k",
    config: null,
    profile: null,
    expected: {
      plannedEmittedAttempts: 10_000,
      acceptedReservations: 1000,
      reservedUnits: 1000,
      soldOutResponses: 9000,
      duplicateReplayResponses: 0,
      confirmedOrders: 1000,
      notificationsRecorded: 1000,
      terminalOrderFailures: 0,
    },
  };
}

/** All named acceptance fixtures for the adaptive ERP acceptance matrix. */
export function acceptanceScenarioFixtures(): AdaptiveErpScenarioFixture[] {
  return [
    originalIncidentFixture(),
    lowCapacityFixture(),
    finiteOutageFixture(),
    latencyIncreaseFixture(),
    duplicateAttemptsFixture(),
    surge10kPresetReferenceFixture(),
  ];
}
