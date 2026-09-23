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
 * `acceptedRunConfigSnapshotSchema`. Fixtures never contain production runtime resources (URLs,
 * connection strings, or clients).
 */
export interface AdaptiveErpScenarioFixture {
  name: string;
  description: string;
  operatorScope: DemoPresetVisibility;
  presetSlug: string | null;
  config: AcceptedRunConfigSnapshot | null;
  expected: AdaptiveErpFixtureExpectedCounts;
}

function backpressureConfig(
  orderProcessConcurrency: number,
): AcceptedRunConfigSnapshot["backpressureConfig"] {
  return {
    queueName: "orders:process",
    physicalQueueName: "orders-process",
    orderProcessConcurrency,
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
      inventoryConfig: { startingStock: 888 },
      erpConfig: {
        latencyMs: 250,
        maxTps: 10,
        errorRate: 0,
        forcedOutage: false,
      },
      backpressureConfig: backpressureConfig(5),
    },
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
      inventoryConfig: { startingStock: 300 },
      erpConfig: {
        latencyMs: 200,
        maxTps: 2,
        errorRate: 0,
        forcedOutage: false,
      },
      backpressureConfig: backpressureConfig(5),
    },
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
 * Finite outage window applied by stopping and restarting the mock-erp service;
 * accepted run snapshots override global chaos controls. Admin scope only.
 * Dimensioning: service rate
 * r = min(200, 5 / 1.0 s) = 5 confirmations/s, so the 200 accepted orders need
 * an ideal 40 s; the outage opens at 10 s with 150 orders still outstanding
 * and lifts at 40 s, exercising degradation and the recovery tail.
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
      inventoryConfig: { startingStock: 200 },
      erpConfig: {
        latencyMs: 1000,
        maxTps: 200,
        errorRate: 0,
        forcedOutage: false,
      },
      backpressureConfig: backpressureConfig(5),
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
 * Baseline for the latency acceptance case; admin scope only. Accepted run
 * snapshots override global chaos controls, so changing /chaos cannot produce
 * the historical 15 s–45 s latency segment during a run. Runtime verification
 * derives a separate stable 3000 ms snapshot from this baseline to exceed the
 * adaptive policy's 2000 ms initial deadline for the whole run. This exported
 * fixture's configuration and exact 600-order accounting remain unchanged.
 * No dynamic ERP profile or production injection mechanism is introduced.
 */
export function latencyIncreaseFixture(): AdaptiveErpScenarioFixture {
  return {
    name: "latency-increase",
    description:
      "Latency increase: constant 20 req/s for 30 s (600 attempts), stock 600, ERP 10/s at 250 ms (10/s service vs 20/s arrivals), latency 3000 ms from 15 s for 30 s (beyond the adaptive policy's 2000 ms initial request deadline), then recovery.",
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
      inventoryConfig: { startingStock: 600 },
      erpConfig: {
        latencyMs: 250,
        maxTps: 10,
        errorRate: 0,
        forcedOutage: false,
      },
      backpressureConfig: backpressureConfig(5),
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
      inventoryConfig: { startingStock: 200 },
      erpConfig: {
        latencyMs: 50,
        maxTps: 200,
        errorRate: 0,
        forcedOutage: false,
      },
      backpressureConfig: backpressureConfig(5),
    },
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
 * The previous surge-10k configuration, frozen for calibration with all
 * concurrency slots busy.
 */
export function concurrencySaturationReferenceFixture(): AdaptiveErpScenarioFixture {
  return {
    name: "concurrency-saturation-reference",
    description:
      "The previous surge-10k configuration, frozen for calibration: 10,000 buyers, stock 1,000, ERP 250/s at 150 ms, concurrency 10.",
    operatorScope: "admin",
    presetSlug: null,
    config: {
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 10_000,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 120,
        quantityPerAttempt: 1,
      },
      inventoryConfig: { startingStock: 1000 },
      erpConfig: { latencyMs: 150, maxTps: 250, errorRate: 0, forcedOutage: false },
      backpressureConfig: backpressureConfig(10),
    },
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
    concurrencySaturationReferenceFixture(),
  ];
}
