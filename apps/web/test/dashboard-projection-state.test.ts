import {
  type DashboardProjection,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { describe, expect, it } from "vitest";
import {
  createDashboardProjectionState,
  dashboardProjectionStateReducer,
} from "../src/app/lib/dashboard-projection-state.js";

type ActiveRun = Extract<NonNullable<DashboardProjection["currentRun"]>, { status: "active" }>;
type CompletedRun = Extract<
  NonNullable<DashboardProjection["currentRun"]>,
  { status: "completed" }
>;

describe("dashboard projection state", () => {
  it("atomically replaces only with a higher same-scope revision", () => {
    const current = runProjection({ revision: 4 });
    let state = createDashboardProjectionState(available(current));

    state = receive(state, runProjection({ revision: 4, correlationId: "duplicate" }));
    expect(state.recovery).toEqual(available(current));
    state = receive(state, runProjection({ revision: 3, correlationId: "lower" }));
    expect(state.recovery).toEqual(available(current));

    const higher = runProjection({
      revision: 5,
      correlationId: "higher",
      recentMetrics: [
        {
          metricName: "traffic.scheduled_request_rate",
          value: 1_000,
          unit: "requests_per_second",
          timestamp: "2026-06-20T00:00:12.000Z",
        },
      ],
    });
    state = receive(state, higher);
    expect(state.recovery).toEqual(available(higher));
    expect(state.liveProjectionCount).toBe(1);
  });

  it("accepts the C1 idle recovery overlap only after the committed projection", () => {
    const idle = idleProjection({
      revision: 8,
      recoveredAt: "2026-06-20T00:00:30.000Z",
    });
    const committed = runProjection({
      revision: 1,
      recoveredAt: "2026-06-20T00:00:31.000Z",
      currentRun: activeRun({
        runId: "22222222-2222-4222-8222-222222222222",
        startedAt: "2026-06-20T00:00:20.000Z",
        trafficStartedAt: "2026-06-20T00:00:20.000Z",
      }),
    });

    const state = receive(createDashboardProjectionState(available(idle)), committed);

    expect(state.recovery).toEqual(available(committed));
  });

  it("switches from the current run to a newer nonterminal run as one whole projection", () => {
    const first = runProjection({
      revision: 12,
      currentRun: activeRun({ startedAt: "2026-06-20T00:00:20.000Z" }),
      recentMetrics: [
        {
          metricName: "traffic.latency",
          value: 50,
          unit: "ms",
          timestamp: "2026-06-20T00:00:21.000Z",
        },
      ],
    });
    const second = runProjection({
      revision: 1,
      currentRun: activeRun({
        runId: "22222222-2222-4222-8222-222222222222",
        saleOfferId: "55555555-5555-4555-8555-555555555555",
        startedAt: "2026-06-20T00:01:00.000Z",
        trafficStartedAt: "2026-06-20T00:01:00.000Z",
      }),
      recoveredAt: "2026-06-20T00:01:01.000Z",
      recentMetrics: [],
    });

    const state = receive(createDashboardProjectionState(available(first)), second);

    expect(state.recovery).toEqual(available(second));
    if (state.recovery.status !== "available") throw new Error("Expected available projection.");
    expect(state.recovery.data.recentMetrics).toEqual([]);
  });

  it("accepts authoritative idle after terminal and retains metadata that rejects the old run", () => {
    const terminal = runProjection({
      revision: 9,
      recoveredAt: "2026-06-20T00:00:40.000Z",
      currentRun: completedRun(),
    });
    const idle = idleProjection({
      revision: 20,
      recoveredAt: "2026-06-20T00:00:41.000Z",
    });
    let state = receive(createDashboardProjectionState(available(terminal)), idle);
    expect(state.recovery).toEqual(available(idle));

    state = receive(
      state,
      runProjection({
        revision: 10,
        recoveredAt: "2026-06-20T00:00:42.000Z",
        currentRun: activeRun(),
      }),
    );
    expect(state.recovery).toEqual(available(idle));
  });

  it("accepts a newer authoritative idle read after the current run is reset", () => {
    const current = runProjection({
      revision: 4,
      recoveredAt: "2026-06-20T00:00:30.000Z",
    });
    const idle = idleProjection({
      revision: 20,
      recoveredAt: "2026-06-20T00:00:31.000Z",
    });

    const state = receive(createDashboardProjectionState(available(current)), idle);

    expect(state.recovery).toEqual(available(idle));
  });

  it("rejects stale scopes and foreign terminal projections", () => {
    const current = runProjection({
      revision: 2,
      currentRun: activeRun({ startedAt: "2026-06-20T00:01:00.000Z" }),
    });
    let state = createDashboardProjectionState(available(current));

    state = receive(
      state,
      runProjection({
        revision: 99,
        currentRun: activeRun({
          runId: "22222222-2222-4222-8222-222222222222",
          startedAt: "2026-06-20T00:00:00.000Z",
          trafficStartedAt: "2026-06-20T00:00:00.000Z",
        }),
      }),
    );
    state = receive(
      state,
      runProjection({
        revision: 100,
        currentRun: completedRun({
          runId: "33333333-3333-4333-8333-333333333333",
          saleOfferId: "66666666-6666-4666-8666-666666666666",
          startedAt: "2026-06-20T00:02:00.000Z",
          trafficStartedAt: "2026-06-20T00:02:00.000Z",
          trafficEndedAt: "2026-06-20T00:02:10.000Z",
          finalizedAt: "2026-06-20T00:02:11.000Z",
        }),
      }),
    );

    expect(state.recovery).toEqual(available(current));
  });

  it("does not let a terminal stream frame establish scope while initial recovery is unavailable", () => {
    const unavailable = createDashboardProjectionState({
      status: "unavailable",
      reason: "Authoritative run state is loading.",
    });

    const state = receive(
      unavailable,
      runProjection({
        revision: 100,
        currentRun: completedRun(),
      }),
    );

    expect(state.recovery).toEqual({
      status: "unavailable",
      reason: "Authoritative run state is loading.",
    });
  });
});

function receive(
  state: ReturnType<typeof createDashboardProjectionState>,
  projection: DashboardProjection,
) {
  return dashboardProjectionStateReducer(state, {
    type: "live-projection-received",
    projection,
  });
}

function idleProjection(overrides: Partial<DashboardProjection> = {}): DashboardProjection {
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    scopeId: "idle",
    revision: 1,
    correlationId: "corr-idle",
    scope: null,
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    transportAttemptCounts: null,
    recentCompletionOutcomes: [],
    recoveredAt: "2026-06-20T00:00:10.000Z",
    ...overrides,
  };
}

function runProjection(overrides: Partial<DashboardProjection> = {}): DashboardProjection {
  const currentRun = overrides.currentRun ?? activeRun();
  if (!currentRun.saleOfferId) throw new Error("Run fixture requires a sale offer.");
  const scope = { runId: currentRun.runId, saleOfferId: currentRun.saleOfferId };
  return idleProjection({
    scopeId: dashboardProjectionScopeId(scope),
    scope,
    currentRun,
    ...overrides,
  });
}

function activeRun(overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    presetId: "77777777-7777-4777-8777-777777777777",
    presetName: "Preview 1k",
    operatorMode: "public",
    status: "active",
    trafficStatus: "active",
    saleOfferId: "44444444-4444-4444-8444-444444444444",
    startedAt: "2026-06-20T00:00:00.000Z",
    trafficStartedAt: "2026-06-20T00:00:00.000Z",
    configSnapshot: previewRunConfigSnapshotFixture(),
    ...overrides,
  };
}

function completedRun(overrides: Partial<CompletedRun> = {}): CompletedRun {
  return {
    ...activeRun(),
    status: "completed",
    trafficStatus: "succeeded",
    trafficEndedAt: "2026-06-20T00:00:30.000Z",
    finalizedAt: "2026-06-20T00:00:40.000Z",
    ...overrides,
  };
}

function available(data: DashboardProjection) {
  return { status: "available" as const, data, httpStatus: 200 };
}
