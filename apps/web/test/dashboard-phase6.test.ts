import type {
  DashboardEvent,
  DashboardRecoveryResponse,
  RunDashboardEvent,
} from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CompletionOutcomesPanel,
  ConsistencyLagPanel,
  ErpHealthPanel,
  InventoryDrainPanel,
  LoadRunControlsPanel,
  QueuePressurePanel,
  RequestSurgePanel,
  RunOutcomesPanel,
} from "../src/app/components/dashboard-panels.js";
import type { BackendRead } from "../src/app/lib/api.js";
import {
  applyDashboardEvent,
  createDashboardState,
  dashboardStateReducer,
  shouldRequestAuthoritativeRecoveryAfterEvent,
  shouldRequestAuthoritativeRecoveryAfterScopedEvent,
} from "../src/app/lib/dashboard-state.js";

describe("Phase 6 dashboard behavior", () => {
  it("renders enabled run controls when Phase 7 start handling is available", () => {
    const markup = renderToStaticMarkup(
      createElement(LoadRunControlsPanel, {
        recovery: availableRecovery(recoveryFixture()),
        onStartPreset: async () => ({
          status: "available" as const,
          data: {
            run: runFixture(),
            recovery: { establishedAt: "2026-06-20T00:00:10.000Z" },
            correlationId: "corr-web-start",
            timestamp: "2026-06-20T00:00:10.000Z",
          },
          httpStatus: 202,
        }),
      }),
    );

    expect(markup).toContain("ready");
    expect(markup).toContain("Ready to start bounded public traffic.");
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain("preview-1k");
    expect(markup).toContain("public-custom");
  });

  it("renders current-run start gating when recovery reports an active run", () => {
    const markup = renderToStaticMarkup(
      createElement(LoadRunControlsPanel, {
        recovery: availableRecovery({
          ...recoveryFixture(),
          currentRun: {
            runId: "11111111-1111-4111-8111-111111111111",
            presetId: "22222222-2222-4222-8222-222222222222",
            presetName: "Surge 5k",
            operatorMode: "public",
            status: "active",
            trafficStatus: "active",
            configSnapshot: {
              trafficConfig: {},
              inventoryConfig: {},
              erpConfig: {},
              backpressureConfig: {},
            },
            saleOfferId: "33333333-3333-4333-8333-333333333333",
            startedAt: "2026-06-20T00:00:00.000Z",
          },
        } as DashboardRecoveryResponse),
      }),
    );

    expect(markup).toContain("active");
    expect(markup).toContain("A run is already starting, active, or draining.");
  });

  it("renders consistency-lag and run outcome projections for operator review", () => {
    const recovery = availableRecovery(recoveryFixture());
    const lagMarkup = renderToStaticMarkup(createElement(ConsistencyLagPanel, { recovery }));
    const outcomeMarkup = renderToStaticMarkup(createElement(RunOutcomesPanel, { recovery }));
    const completionMarkup = renderToStaticMarkup(
      createElement(CompletionOutcomesPanel, { recovery }),
    );

    expect(lagMarkup).toContain("Fast reservation vs final confirmation");
    expect(lagMarkup).toContain("350ms");
    expect(lagMarkup).toContain("Pending");
    expect(outcomeMarkup).toContain("Reservation and confirmation summary");
    expect(outcomeMarkup).toContain("Accepted");
    expect(outcomeMarkup).toContain("Confirmed");
    expect(outcomeMarkup).toContain("Failed");
    expect(completionMarkup).toContain("Recent order workflow results");
    expect(completionMarkup).toContain("notification recorded");
    expect(completionMarkup).toContain("ord_recent");
  });

  it("presents all raw traffic gold samples equally and exposes producer freshness", () => {
    const recovery = availableRecovery({
      ...recoveryFixture(),
      inventory: inventoryFixture(),
      queue: queueFixture(2, "2026-06-20T00:00:11.000Z"),
      recentMetrics: [
        {
          metricName: "traffic.scheduled_request_rate",
          value: 1,
          unit: "requests",
          timestamp: "2026-06-20T00:00:11.000Z",
        },
        {
          metricName: "traffic.latency",
          value: 42,
          unit: "ms",
          timestamp: "2026-06-20T00:00:11.000Z",
        },
        {
          metricName: "traffic.failure_rate",
          value: 0.25,
          unit: "ratio",
          timestamp: "2026-06-20T00:00:11.000Z",
        },
      ],
      erp: erpFixture(),
    });

    const traffic = renderToStaticMarkup(
      createElement(RequestSurgePanel, { recovery, liveEventCount: 3 }),
    );
    const inventory = renderToStaticMarkup(createElement(InventoryDrainPanel, { recovery }));
    const queue = renderToStaticMarkup(createElement(QueuePressurePanel, { recovery }));
    const erp = renderToStaticMarkup(createElement(ErpHealthPanel, { recovery }));

    expect(traffic).toContain("k6 request counter sample");
    expect(traffic).toContain("Latest k6 latency sample");
    expect(traffic).toContain("Latest k6 failure indicator");
    expect(traffic).toContain("25%");
    expect(traffic).toContain("no common observed window or percentile is claimed");
    expect(inventory).toContain("Inventory updated");
    expect(queue).toContain("Queue inspected");
    expect(queue).toContain("API refreshes worker drain, retry, and failure state");
    expect(erp).toContain("Failure threshold");
    expect(erp).toContain("Next probe");
    expect(erp).toContain("Breaker reported");
    expect(erp).toContain("API projection");
  });

  it("applies live business-outcome events over the recovery baseline", () => {
    const event = businessOutcomeEventFixture();

    const next = applyDashboardEvent(availableRecovery(recoveryFixture()), event);

    expect(next.status).toBe("available");
    if (next.status !== "available") {
      throw new Error("Expected available recovery after applying a live event.");
    }
    expect(next.data.businessOutcome).toEqual(event.outcome);
    expect(next.data.consistencyLag).toEqual(event.consistencyLag);
  });

  it("ignores previous-run business, metric, and run events after newer recovery", () => {
    const recoveryData = {
      ...recoveryFixture(),
      currentRun: runFixture(),
      recentMetrics: [
        {
          metricName: "queue.depth",
          value: 1,
          unit: "jobs",
          timestamp: "2026-06-20T00:00:10.000Z",
        },
      ],
    };
    const recovery = availableRecovery(recoveryData);
    const previousRun = previousRunFixture();

    const nextBusiness = applyDashboardEvent(
      recovery,
      businessOutcomeEventFixture({
        runId: previousRun.runId,
        saleOfferId: previousRun.saleOfferId,
        acceptedReservations: 99,
      }),
    );
    const nextMetric = applyDashboardEvent(
      recovery,
      trafficMetricEventFixture({
        runId: previousRun.runId,
        value: 99,
      }),
    );
    const nextRun = applyDashboardEvent(recovery, runEventFixture("run.updated", previousRun));

    expect(nextBusiness.status).toBe("available");
    expect(nextMetric.status).toBe("available");
    expect(nextRun.status).toBe("available");
    if (
      nextBusiness.status !== "available" ||
      nextMetric.status !== "available" ||
      nextRun.status !== "available"
    ) {
      throw new Error("Expected available recovery after applying ignored live events.");
    }
    expect(nextBusiness.data.businessOutcome).toEqual(recoveryData.businessOutcome);
    expect(nextMetric.data.recentMetrics).toEqual(recoveryData.recentMetrics);
    expect(nextRun.data.currentRun).toEqual(recoveryData.currentRun);
  });

  it("ignores same-run events older than the recovered baseline", () => {
    const recovery = availableRecovery({
      ...recoveryFixture(),
      currentRun: runFixture(),
      recentMetrics: [],
    });

    const next = applyDashboardEvent(
      recovery,
      trafficMetricEventFixture({
        runId: runFixture().runId,
        occurredAt: "2026-06-20T00:00:09.000Z",
        value: 99,
      }),
    );

    expect(next.status).toBe("available");
    if (next.status !== "available") {
      throw new Error("Expected available recovery after applying an ignored stale event.");
    }
    expect(next.data.recentMetrics).toEqual([]);
  });

  it("applies fresh same-run events over the recovery baseline", () => {
    const recovery = availableRecovery({
      ...recoveryFixture(),
      currentRun: runFixture(),
      recentMetrics: [],
    });
    const event = trafficMetricEventFixture({
      runId: runFixture().runId,
      value: 7,
    });

    const next = applyDashboardEvent(recovery, event);

    expect(next.status).toBe("available");
    if (next.status !== "available") {
      throw new Error("Expected available recovery after applying a fresh same-run event.");
    }
    expect(next.data.recentMetrics).toEqual([
      {
        metricName: event.metricName,
        value: event.value,
        unit: event.unit,
        timestamp: event.occurredAt,
      },
    ]);
  });

  it("ignores mismatched inventory events and stale queue events", () => {
    const recoveryData = {
      ...recoveryFixture(),
      currentRun: runFixture(),
      inventory: inventoryFixture(runFixture().saleOfferId, 12),
      queue: queueFixture(4, "2026-06-20T00:00:10.000Z"),
    };
    const recovery = availableRecovery(recoveryData);

    const nextInventory = applyDashboardEvent(
      recovery,
      inventoryEventFixture(previousRunFixture().saleOfferId, 99, "2026-06-20T00:00:11.000Z"),
    );
    const nextQueue = applyDashboardEvent(
      recovery,
      queueEventFixture(99, "2026-06-20T00:00:09.000Z"),
    );

    expect(nextInventory.status).toBe("available");
    expect(nextQueue.status).toBe("available");
    if (nextInventory.status !== "available" || nextQueue.status !== "available") {
      throw new Error("Expected available recovery after applying ignored stale events.");
    }
    expect(nextInventory.data.inventory).toEqual(recoveryData.inventory);
    expect(nextQueue.data.queue).toEqual(recoveryData.queue);
  });

  it("does not let a delayed snapshot read regress a newer source snapshot", () => {
    const recovery = availableRecovery({
      ...recoveryFixture(),
      currentRun: runFixture(),
      inventory: { ...inventoryFixture(), lastUpdatedAt: "2026-06-20T00:00:12.000Z" },
      queue: queueFixture(2, "2026-06-20T00:00:12.000Z"),
    });
    const delayedInventory = inventoryEventFixture(
      runFixture().saleOfferId,
      99,
      "2026-06-20T00:00:13.000Z",
    );
    delayedInventory.inventory.lastUpdatedAt = "2026-06-20T00:00:11.000Z";
    const delayedQueue = queueEventFixture(99, "2026-06-20T00:00:11.000Z");
    delayedQueue.occurredAt = "2026-06-20T00:00:13.000Z";

    const afterInventory = applyDashboardEvent(recovery, delayedInventory);
    const afterQueue = applyDashboardEvent(recovery, delayedQueue);

    if (afterInventory.status !== "available" || afterQueue.status !== "available") {
      throw new Error("Expected available recovery after delayed snapshots.");
    }
    expect(afterInventory.data.inventory?.remainingStock).not.toBe(99);
    expect(afterQueue.data.queue?.depth).toBe(2);
  });

  it("resets idle catalog projections before installing a newly started run", () => {
    const recovery = availableRecovery(populatedRecovery(null));
    const event = runEventFixture("run.started", {
      ...runFixture(),
      startedAt: "2026-06-20T00:00:11.000Z",
    });

    const nextState = dashboardStateReducer(createDashboardState(recovery), {
      type: "event-received",
      event,
      discard: false,
    });

    expect(nextState.recovery).toEqual(
      availableRecovery({
        currentRun: event.run,
        inventory: null,
        recentMetrics: [],
        queue: null,
        erp: null,
        businessOutcome: null,
        consistencyLag: null,
        recentCompletionOutcomes: [],
        recoveredAt: event.occurredAt,
      }),
    );
  });

  it("resets run A projections when a newer run B update establishes a missed transition", () => {
    const currentRun = runFixture();
    const incomingRun = {
      ...previousRunFixture(),
      runId: "88888888-8888-4888-8888-888888888888",
      presetName: "Newer run",
      startedAt: "2026-06-20T00:01:00.000Z",
    };
    const recovery = availableRecovery(populatedRecovery(currentRun));
    const event = runEventFixture("run.updated", incomingRun);

    const next = applyDashboardEvent(recovery, event);

    expect(next.status).toBe("available");
    if (next.status !== "available") throw new Error("Expected the new run scope to be available.");
    expect(next.data.currentRun).toEqual(event.run);
    expect(scopeDerivedProjections(next.data)).toEqual({
      inventory: null,
      recentMetrics: [],
      queue: null,
      erp: null,
      businessOutcome: null,
      consistencyLag: null,
      recentCompletionOutcomes: [],
    });
    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, event)).toBe(true);
  });

  it("retains scope projections for same-run lifecycle updates", () => {
    const run = runFixture();
    const recoveryData = populatedRecovery(run);
    const recovery = availableRecovery(recoveryData);

    const next = applyDashboardEvent(recovery, runEventFixture("run.updated", run));

    expect(next.status).toBe("available");
    if (next.status !== "available") throw new Error("Expected same-run recovery to be available.");
    expect(scopeDerivedProjections(next.data)).toEqual(scopeDerivedProjections(recoveryData));
    expect(
      shouldRequestAuthoritativeRecoveryAfterScopedEvent(
        recovery,
        runEventFixture("run.updated", run),
      ),
    ).toBe(false);
  });

  it("rejects a same-run lifecycle event whose top-level run ID contradicts its payload", () => {
    const run = runFixture();
    const recovery = availableRecovery(populatedRecovery(run));
    const inconsistentEvent = {
      ...runEventFixture("run.updated", run),
      runId: previousRunFixture().runId,
    };

    expect(applyDashboardEvent(recovery, inconsistentEvent)).toBe(recovery);
    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, inconsistentEvent)).toBe(
      false,
    );
  });

  it("rejects a newer-run transition whose top-level run ID contradicts its payload", () => {
    const recovery = availableRecovery(populatedRecovery(runFixture()));
    const incomingRun = {
      ...previousRunFixture(),
      runId: "88888888-8888-4888-8888-888888888888",
      startedAt: "2026-06-20T00:01:00.000Z",
    };
    const inconsistentEvent = {
      ...runEventFixture("run.updated", incomingRun),
      runId: "77777777-7777-4777-8777-777777777777",
    };

    expect(applyDashboardEvent(recovery, inconsistentEvent)).toBe(recovery);
    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, inconsistentEvent)).toBe(
      false,
    );
  });

  it("does not revive an older run into an idle recovery scope", () => {
    const recovery = availableRecovery(recoveryFixture());
    const oldRun = {
      ...previousRunFixture(),
      startedAt: "2026-06-19T23:59:00.000Z",
    };
    const delayedEvent = {
      ...runEventFixture("run.updated", oldRun),
      occurredAt: "2026-06-20T00:00:12.000Z",
    };

    expect(applyDashboardEvent(recovery, delayedEvent)).toBe(recovery);
    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, delayedEvent)).toBe(false);
  });

  it("uses authoritative recovery after terminal run events", () => {
    expect(shouldRequestAuthoritativeRecoveryAfterEvent(runEventFixture("run.completed"))).toBe(
      true,
    );
    expect(shouldRequestAuthoritativeRecoveryAfterEvent(runEventFixture("run.failed"))).toBe(true);
    expect(shouldRequestAuthoritativeRecoveryAfterEvent(runEventFixture("run.updated"))).toBe(
      false,
    );
  });
});

function availableRecovery(
  data: DashboardRecoveryResponse,
): BackendRead<DashboardRecoveryResponse> {
  return { status: "available", data, httpStatus: 200 };
}

function runFixture() {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    presetId: "22222222-2222-4222-8222-222222222222",
    presetName: "Preview 1k",
    operatorMode: "public" as const,
    status: "active" as const,
    trafficStatus: "active" as const,
    configSnapshot: {
      trafficConfig: {
        mode: "buyer-spike" as const,
        buyerCount: 1000,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 2,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 250,
        quantityPerCheckout: 1,
        reservationHoldMinutes: 15,
      },
      erpConfig: {
        latencyMs: 80,
        maxTps: 250,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 2000,
      },
      backpressureConfig: {
        queueName: "orders:process" as const,
        physicalQueueName: "orders-process" as const,
        orderProcessConcurrency: 5,
        retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
        drainTimeoutSeconds: 300,
        pendingPersistenceRetryAfterSeconds: 30,
        circuitBreakerFailureThreshold: 5,
        circuitBreakerResetTimeoutMs: 10_000,
      },
    },
    saleOfferId: "33333333-3333-4333-8333-333333333333",
    startedAt: "2026-06-20T00:00:00.000Z",
  };
}

function previousRunFixture(): ReturnType<typeof runFixture> {
  return {
    ...runFixture(),
    runId: "99999999-9999-4999-8999-999999999999",
    presetName: "Previous run",
    saleOfferId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
}

function runEventFixture(
  type: "run.started" | "run.updated" | "run.completed" | "run.failed",
  run: ReturnType<typeof runFixture> = runFixture(),
): RunDashboardEvent {
  return {
    type,
    eventId: "44444444-4444-4444-8444-444444444444",
    runId: run.runId,
    correlationId: "corr-web-live",
    run: {
      ...run,
      status: type === "run.completed" ? "completed" : type === "run.failed" ? "failed" : "active",
      trafficStatus: type === "run.completed" || type === "run.failed" ? "succeeded" : "active",
      ...(type === "run.completed" || type === "run.failed"
        ? { finalizedAt: "2026-06-20T00:00:12.000Z" }
        : {}),
      ...(type === "run.failed" ? { failureReason: "traffic_failed" } : {}),
    },
    occurredAt: "2026-06-20T00:00:12.000Z",
  };
}

function populatedRecovery(
  currentRun: ReturnType<typeof runFixture> | null,
): DashboardRecoveryResponse {
  return {
    ...recoveryFixture(),
    currentRun,
    inventory: inventoryFixture(currentRun?.saleOfferId),
    recentMetrics: [
      {
        metricName: "queue.depth",
        value: 4,
        unit: "jobs",
        timestamp: "2026-06-20T00:00:10.000Z",
      },
    ],
    queue: queueFixture(4, "2026-06-20T00:00:10.000Z"),
    erp: erpFixture(),
  };
}

function scopeDerivedProjections(recovery: DashboardRecoveryResponse) {
  const {
    inventory,
    recentMetrics,
    queue,
    erp,
    businessOutcome,
    consistencyLag,
    recentCompletionOutcomes,
  } = recovery;
  return {
    inventory,
    recentMetrics,
    queue,
    erp,
    businessOutcome,
    consistencyLag,
    recentCompletionOutcomes,
  };
}

function businessOutcomeEventFixture(
  options: {
    runId?: string;
    saleOfferId?: string;
    occurredAt?: string;
    acceptedReservations?: number;
  } = {},
): Extract<DashboardEvent, { type: "business.outcome.updated" }> {
  return {
    type: "business.outcome.updated",
    eventId: "44444444-4444-4444-8444-444444444444",
    saleOfferId: options.saleOfferId ?? "33333333-3333-4333-8333-333333333333",
    ...(options.runId ? { runId: options.runId } : {}),
    correlationId: "corr-web-live",
    occurredAt: options.occurredAt ?? "2026-06-20T00:00:11.000Z",
    outcome: {
      acceptedReservations: options.acceptedReservations ?? 9,
      soldOutRejections: 3,
      queuedOrders: 2,
      processingOrders: 1,
      retryingOrders: 1,
      confirmedOrders: 4,
      failedOrders: 1,
      pendingPersistenceCount: 0,
      notificationsRecorded: 0,
    },
    consistencyLag: {
      confirmedOrderCount: 4,
      pendingConfirmationCount: 4,
      averageLagMs: 275,
      p95LagMs: 425,
      maxLagMs: 500,
      oldestPendingAgeSeconds: 7,
      measuredAt: options.occurredAt ?? "2026-06-20T00:00:11.000Z",
    },
  };
}

function trafficMetricEventFixture(
  options: { runId?: string; occurredAt?: string; value?: number } = {},
): Extract<DashboardEvent, { type: "traffic.metric" }> {
  return {
    type: "traffic.metric",
    eventId: "55555555-5555-4555-8555-555555555555",
    ...(options.runId ? { runId: options.runId } : {}),
    correlationId: "corr-web-live",
    metricName: "queue.depth",
    value: options.value ?? 3,
    unit: "jobs",
    occurredAt: options.occurredAt ?? "2026-06-20T00:00:11.000Z",
  };
}

function inventoryEventFixture(
  saleOfferId: string,
  remainingStock: number,
  occurredAt: string,
): Extract<DashboardEvent, { type: "inventory.updated" }> {
  return {
    type: "inventory.updated",
    eventId: "66666666-6666-4666-8666-666666666666",
    correlationId: "corr-web-live",
    occurredAt,
    inventory: inventoryFixture(saleOfferId, remainingStock),
  };
}

function queueEventFixture(
  depth: number,
  occurredAt: string,
): Extract<DashboardEvent, { type: "queue.updated" }> {
  return {
    type: "queue.updated",
    eventId: "77777777-7777-4777-8777-777777777777",
    correlationId: "corr-web-live",
    occurredAt,
    queue: queueFixture(depth, occurredAt),
  };
}

function inventoryFixture(
  saleOfferId: string = "33333333-3333-4333-8333-333333333333",
  remainingStock = 12,
) {
  return {
    saleOfferId,
    allocatedStock: 100,
    remainingStock,
    reservedStock: 100 - remainingStock,
    pendingPersistenceCount: 0,
    expiredReservationCount: 0,
    oldestPendingPersistenceAgeSeconds: 0,
    reservationThroughput: {
      windowSeconds: 60,
      successfulReservationCount: 0,
      rate: 0,
      unit: "reservations_per_second" as const,
      measuredAt: "2026-06-20T00:00:10.000Z",
    },
    soldOutPressure: {
      rejectionCount: 0,
      latestObservedAt: null,
    },
    lastUpdatedAt: "2026-06-20T00:00:10.000Z",
  };
}

function queueFixture(depth: number, updatedAt: string) {
  return {
    name: "orders:process" as const,
    connectivity: "reachable" as const,
    depth,
    counts: {
      waiting: depth,
      prioritized: 0,
      paused: 0,
      delayed: 0,
      active: 0,
      failed: 0,
    },
    oldestWaitingAgeSeconds: null,
    retryPressure: {
      inspectedJobCount: depth,
      inspectionLimit: 100,
      retryingJobCount: 0,
      retryAttemptCount: 0,
      inspectionTruncated: false,
    },
    failedJobs: {
      totalCount: 0,
      recent: [],
      inspectionLimit: 20,
      inspectionTruncated: false,
    },
    updatedAt,
  };
}

function erpFixture(): NonNullable<DashboardRecoveryResponse["erp"]> {
  return {
    status: "degraded",
    reason: "recent_erp_failures",
    circuit: {
      state: "open",
      consecutiveFailureCount: 5,
      failureThreshold: 5,
      resetTimeoutMs: 10_000,
      openedAt: "2026-06-20T00:00:09.000Z",
      nextAttemptAt: "2026-06-20T00:00:19.000Z",
      halfOpenProbeInFlight: false,
      updatedAt: "2026-06-20T00:00:10.000Z",
    },
    retryPressure: {
      retryingJobCount: 1,
      retryAttemptCount: 2,
      inspectedJobCount: 2,
      inspectionLimit: 100,
      inspectionTruncated: false,
    },
    latestAttempt: null,
    recentAttemptWindowSeconds: 60,
    recentAttemptCount: 3,
    recentFailureCount: 2,
    recentTimeoutCount: 1,
    confirmationDelay: {
      processingOrderCount: 1,
      oldestProcessingAgeSeconds: 2,
      recentConfirmedCount: 1,
      averageConfirmationDelayMs: 80,
    },
    updatedAt: "2026-06-20T00:00:11.000Z",
  };
}

function recoveryFixture(): DashboardRecoveryResponse {
  return {
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: {
      acceptedReservations: 6,
      soldOutRejections: 2,
      queuedOrders: 1,
      processingOrders: 1,
      retryingOrders: 1,
      confirmedOrders: 2,
      failedOrders: 1,
      pendingPersistenceCount: 0,
      notificationsRecorded: 0,
    },
    consistencyLag: {
      confirmedOrderCount: 2,
      pendingConfirmationCount: 3,
      averageLagMs: 225,
      p95LagMs: 350,
      maxLagMs: 375,
      oldestPendingAgeSeconds: 8.5,
      measuredAt: "2026-06-20T00:00:10.000Z",
    },
    recentCompletionOutcomes: [
      {
        orderId: "11111111-1111-4111-8111-111111111111",
        publicOrderId: "ord_recent",
        saleOfferId: "33333333-3333-4333-8333-333333333333",
        correlationId: "corr-web-recent",
        orderStatus: "confirmed",
        displayStatus: "notification_recorded",
        queuedAt: "2026-06-20T00:00:01.000Z",
        processingAt: "2026-06-20T00:00:02.000Z",
        confirmedAt: "2026-06-20T00:00:03.000Z",
        notificationRecordedAt: "2026-06-20T00:00:04.000Z",
        latestErpAttemptStatus: "succeeded",
        latestEventAt: "2026-06-20T00:00:04.000Z",
      },
    ],
    recoveredAt: "2026-06-20T00:00:10.000Z",
  };
}
