import {
  type DashboardEvent,
  type DashboardRecoveryResponse,
  demoRunSnapshotSchema,
  type OrderConsistencyLagDashboardEvent,
  type OrderStatusDashboardEvent,
  type RunDashboardEvent,
} from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CompletionOutcomesPanel,
  ConsistencyLagPanel,
  ErpHealthPanel,
  InventoryDrainPanel,
  QueuePressurePanel,
  RecentOrderTransitionsPanel,
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

function orderStatusEventFixture(
  eventId: string,
  eventName: "order.processing" | "order.confirmed" | "order.failed",
  previousStatus: "queued" | "processing",
  status: "processing" | "confirmed" | "failed",
  overrides: Partial<OrderStatusDashboardEvent> = {},
): OrderStatusDashboardEvent {
  const run = runFixture();
  return {
    type: "order.status.updated",
    eventId,
    runId: run.runId,
    correlationId: "corr-order-live",
    occurredAt: "2026-06-20T00:00:20.000Z",
    orderId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    publicOrderId: "ord-live",
    saleOfferId: run.saleOfferId ?? "33333333-3333-4333-8333-333333333333",
    eventName,
    previousStatus,
    status,
    customerStatus: status,
    attemptNumber: 1,
    attemptsMade: 0,
    ...overrides,
  };
}

function lagEventFixture(
  eventId: string,
  observedAt: string,
  value: number,
): OrderConsistencyLagDashboardEvent {
  const observed = new Date(observedAt);
  return {
    type: "dashboard.metric.observed",
    eventId,
    confirmedTransitionEventId: uuidFor(9_999),
    runId: runFixture().runId,
    correlationId: "corr-order-live",
    occurredAt: observedAt,
    metricName: "order.consistency_lag",
    value,
    unit: "ms",
    observedAt,
    orderId: uuidFor(8_888),
    publicOrderId: "ord-live-lag",
    saleOfferId: runFixture().saleOfferId ?? uuidFor(8_887),
    startedAt: new Date(observed.getTime() - value).toISOString(),
    confirmedAt: observedAt,
  };
}

function uuidFor(value: number): string {
  return `${value.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

describe("Phase 6 dashboard behavior", () => {
  it("deduplicates and bounds scoped per-order events without allowing terminal regression", () => {
    const recovery = availableRecovery({ ...recoveryFixture(), currentRun: runFixture() });
    if (recovery.status !== "available") throw new Error("Expected available recovery fixture.");
    const confirmed = orderStatusEventFixture(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "order.confirmed",
      "processing",
      "confirmed",
    );
    const processing = orderStatusEventFixture(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "order.processing",
      "queued",
      "processing",
    );
    let state = createDashboardState(recovery);
    state = dashboardStateReducer(state, {
      type: "event-received",
      event: confirmed,
      discard: false,
    });
    state = dashboardStateReducer(state, {
      type: "event-received",
      event: confirmed,
      discard: false,
    });
    state = dashboardStateReducer(state, {
      type: "event-received",
      event: processing,
      discard: false,
    });

    expect(
      state.recentOrderStates.find((order) => order.orderId === confirmed.orderId)?.status,
    ).toBe("confirmed");
    expect(state.seenOrderEventIds).toEqual([confirmed.eventId, processing.eventId]);

    const refreshed = dashboardStateReducer(state, { type: "refresh-completed", recovery });
    expect(refreshed.seenOrderEventIds).toEqual([]);
    expect(refreshed.recentOrderLagSamples).toEqual([]);
    expect(refreshed.recentOrderStates).toEqual(
      expect.arrayContaining(
        recovery.data.recentCompletionOutcomes.map((outcome) =>
          expect.objectContaining({ orderId: outcome.orderId, status: outcome.orderStatus }),
        ),
      ),
    );
    expect(
      refreshed.recovery.status === "available" ? refreshed.recovery.data.consistencyLag : null,
    ).toEqual(recovery.data.consistencyLag);
  });

  it("retains a latest individual lag sample separately from aggregate p95", () => {
    const recovery = availableRecovery({ ...recoveryFixture(), currentRun: runFixture() });
    if (recovery.status !== "available") throw new Error("Expected available recovery fixture.");
    const status = orderStatusEventFixture(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "order.confirmed",
      "processing",
      "confirmed",
    );
    const lag = {
      type: "dashboard.metric.observed",
      eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      confirmedTransitionEventId: status.eventId,
      runId: runFixture().runId,
      correlationId: status.correlationId,
      occurredAt: status.occurredAt,
      metricName: "order.consistency_lag",
      value: 123,
      unit: "ms",
      observedAt: status.occurredAt,
      orderId: status.orderId,
      publicOrderId: status.publicOrderId,
      saleOfferId: status.saleOfferId,
      startedAt: "2026-06-20T00:00:19.877Z",
      confirmedAt: status.occurredAt,
    } as const satisfies DashboardEvent;
    const state = dashboardStateReducer(createDashboardState(recovery), {
      type: "event-received",
      event: lag,
      discard: false,
    });
    const markup = renderToStaticMarkup(
      createElement(ConsistencyLagPanel, {
        recovery,
        latestOrderLag: state.recentOrderLagSamples[0] ?? null,
      }),
    );

    expect(markup).toContain("Latest individual order");
    expect(markup).toContain("123ms");
    expect(markup).toContain("p95 confirmed");
    expect(
      renderToStaticMarkup(
        createElement(RecentOrderTransitionsPanel, { orders: state.recentOrderStates }),
      ),
    ).toContain("Reconciled workflow state with realtime updates");
  });

  it("uses exact recovered status timestamps and retains the newest 20 actual transitions", () => {
    const baseOutcome = recoveryFixture().recentCompletionOutcomes[0];
    if (!baseOutcome) throw new Error("Expected a completion outcome fixture.");
    if (baseOutcome.orderStatus !== "confirmed") {
      throw new Error("Expected a confirmed completion outcome fixture.");
    }
    const outcomes = Array.from({ length: 21 }, (_, offset) => {
      const sequence = 21 - offset;
      return {
        ...baseOutcome,
        orderId: uuidFor(5_000 + sequence),
        publicOrderId: `ord-recovered-${sequence}`,
        confirmedAt: `2026-06-20T00:00:${sequence.toString().padStart(2, "0")}.000Z`,
        notificationRecordedAt: `2026-06-20T00:01:${(21 - sequence).toString().padStart(2, "0")}.000Z`,
        latestEventAt: `2026-06-20T00:01:${(21 - sequence).toString().padStart(2, "0")}.000Z`,
      };
    });
    const recovery = availableRecovery({
      ...recoveryFixture(),
      currentRun: runFixture(),
      recoveredAt: "2026-06-20T00:00:00.000Z",
      recentCompletionOutcomes: outcomes,
    });
    const state = createDashboardState(recovery);

    expect(state.recentOrderStates).toHaveLength(20);
    expect(state.recentOrderStates.at(-1)).toMatchObject({
      orderId: outcomes[0]?.orderId,
      occurredAt: outcomes[0]?.confirmedAt,
    });
    expect(
      state.recentOrderStates.some((order) => order.orderId === outcomes.at(-1)?.orderId),
    ).toBe(false);
    expect(
      state.recentOrderStates.every((order) => order.occurredAt.startsWith("2026-06-20T00:00:")),
    ).toBe(true);
    expect(state.recentOrderStates.map((order) => order.occurredAt)).toEqual(
      [...state.recentOrderStates.map((order) => order.occurredAt)].sort(),
    );
  });

  it("reconciles each recovery lifecycle state from its status-specific durable timestamp", () => {
    const baseOutcome = recoveryFixture().recentCompletionOutcomes[0];
    if (!baseOutcome) throw new Error("Expected a completion outcome fixture.");
    const commonOutcome = {
      publicOrderId: baseOutcome.publicOrderId,
      saleOfferId: baseOutcome.saleOfferId,
      ...(baseOutcome.runId ? { runId: baseOutcome.runId } : {}),
      correlationId: baseOutcome.correlationId,
    };
    const outcomes: DashboardRecoveryResponse["recentCompletionOutcomes"] = [
      {
        ...commonOutcome,
        orderId: uuidFor(7_001),
        orderStatus: "queued",
        displayStatus: "queued",
        queuedAt: "2026-06-20T00:00:01.000Z",
        latestEventAt: "2026-06-20T00:01:01.000Z",
      },
      {
        ...commonOutcome,
        orderId: uuidFor(7_002),
        orderStatus: "processing",
        displayStatus: "processing",
        queuedAt: "2026-06-20T00:00:01.000Z",
        processingAt: "2026-06-20T00:00:02.000Z",
        latestEventAt: "2026-06-20T00:01:02.000Z",
      },
      {
        ...commonOutcome,
        orderId: uuidFor(7_003),
        orderStatus: "confirmed",
        displayStatus: "confirmed",
        queuedAt: "2026-06-20T00:00:01.000Z",
        processingAt: "2026-06-20T00:00:02.000Z",
        confirmedAt: "2026-06-20T00:00:03.000Z",
        latestEventAt: "2026-06-20T00:01:03.000Z",
      },
      {
        ...commonOutcome,
        orderId: uuidFor(7_004),
        orderStatus: "failed",
        displayStatus: "failed",
        queuedAt: "2026-06-20T00:00:01.000Z",
        processingAt: "2026-06-20T00:00:02.000Z",
        failedAt: "2026-06-20T00:00:04.000Z",
        latestEventAt: "2026-06-20T00:01:04.000Z",
      },
    ];

    const states = createDashboardState(
      availableRecovery({
        ...recoveryFixture(),
        recentCompletionOutcomes: outcomes,
      }),
    ).recentOrderStates;

    expect(Object.fromEntries(states.map((state) => [state.status, state.occurredAt]))).toEqual({
      queued: "2026-06-20T00:00:01.000Z",
      processing: "2026-06-20T00:00:02.000Z",
      confirmed: "2026-06-20T00:00:03.000Z",
      failed: "2026-06-20T00:00:04.000Z",
    });
  });

  it("rejects foreign run, sale, and pre-recovery per-order events while retaining distinct out-of-order orders", () => {
    const recovery = availableRecovery({ ...recoveryFixture(), currentRun: runFixture() });
    if (recovery.status !== "available") throw new Error("Expected available recovery fixture.");
    let state = createDashboardState(recovery);
    const rejected = [
      orderStatusEventFixture(uuidFor(1), "order.processing", "queued", "processing", {
        runId: uuidFor(91),
      }),
      orderStatusEventFixture(uuidFor(2), "order.processing", "queued", "processing", {
        saleOfferId: uuidFor(92),
      }),
      orderStatusEventFixture(uuidFor(3), "order.processing", "queued", "processing", {
        occurredAt: "2026-06-19T00:00:00.000Z",
      }),
    ];
    for (const event of rejected)
      state = dashboardStateReducer(state, { type: "event-received", event, discard: false });
    expect(state.seenOrderEventIds).toEqual([]);

    const newer = orderStatusEventFixture(uuidFor(4), "order.processing", "queued", "processing", {
      orderId: uuidFor(41),
      occurredAt: "2026-06-20T00:00:30.000Z",
    });
    const olderDistinct = orderStatusEventFixture(
      uuidFor(5),
      "order.processing",
      "queued",
      "processing",
      { orderId: uuidFor(42), occurredAt: "2026-06-20T00:00:20.000Z" },
    );
    state = dashboardStateReducer(state, { type: "event-received", event: newer, discard: false });
    state = dashboardStateReducer(state, {
      type: "event-received",
      event: olderDistinct,
      discard: false,
    });
    expect(
      state.recentOrderStates.filter((order) =>
        [newer.orderId, olderDistinct.orderId].includes(order.orderId),
      ),
    ).toHaveLength(2);
  });

  it("prevents both terminal states from regressing and enforces order/dedup bounds", () => {
    const recovery = availableRecovery({ ...recoveryFixture(), currentRun: runFixture() });
    let state = createDashboardState(recovery);
    for (let index = 1; index <= 105; index += 1) {
      const terminal = index % 2 === 0 ? "confirmed" : "failed";
      const event = orderStatusEventFixture(
        uuidFor(index),
        `order.${terminal}`,
        "processing",
        terminal,
        { orderId: uuidFor(1_000 + index), publicOrderId: `ord-${index}` },
      );
      state = dashboardStateReducer(state, { type: "event-received", event, discard: false });
      state = dashboardStateReducer(state, { type: "event-received", event, discard: false });
      state = dashboardStateReducer(state, {
        type: "event-received",
        event: orderStatusEventFixture(
          uuidFor(2_000 + index),
          "order.processing",
          "queued",
          "processing",
          { orderId: event.orderId },
        ),
        discard: false,
      });
    }
    expect(state.recentOrderStates).toHaveLength(20);
    expect(
      state.recentOrderStates.every(
        (order) => order.status === "confirmed" || order.status === "failed",
      ),
    ).toBe(true);
    expect(state.seenOrderEventIds).toHaveLength(100);
  });

  it("orders bounded lag samples by observed time with deterministic ties", () => {
    const recovery = availableRecovery({ ...recoveryFixture(), currentRun: runFixture() });
    let state = createDashboardState(recovery);
    for (let index = 0; index < 25; index += 1) {
      const observedAt = new Date(Date.UTC(2026, 5, 20, 0, 1, index)).toISOString();
      const event = lagEventFixture(uuidFor(3_000 + index), observedAt, index);
      state = dashboardStateReducer(state, { type: "event-received", event, discard: false });
    }
    const olderArrival = lagEventFixture(uuidFor(4_000), "2026-06-20T00:01:10.000Z", 70);
    const latest = lagEventFixture(uuidFor(4_001), "2026-06-20T00:02:00.000Z", 120);
    state = dashboardStateReducer(state, { type: "event-received", event: latest, discard: false });
    state = dashboardStateReducer(state, {
      type: "event-received",
      event: olderArrival,
      discard: false,
    });
    expect(state.recentOrderLagSamples).toHaveLength(20);
    expect(state.recentOrderLagSamples.at(-1)?.eventId).toBe(latest.eventId);
    expect(
      state.recentOrderLagSamples.findIndex((sample) => sample.eventId === uuidFor(3_010)),
    ).toBeLessThan(
      state.recentOrderLagSamples.findIndex((sample) => sample.eventId === olderArrival.eventId),
    );
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
          value: 12.5,
          unit: "requests_per_second",
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
      transportAccounting: {
        plannedRequests: 1_000,
        startedRequests: 900,
        completedRequests: 850,
        interruptedRequests: 50,
        unstartedRequests: 100,
      },
    });

    const traffic = renderToStaticMarkup(
      createElement(RequestSurgePanel, { recovery, liveEventCount: 3 }),
    );
    const inventory = renderToStaticMarkup(createElement(InventoryDrainPanel, { recovery }));
    const queue = renderToStaticMarkup(createElement(QueuePressurePanel, { recovery }));
    const erp = renderToStaticMarkup(createElement(ErpHealthPanel, { recovery }));

    expect(traffic).toContain("Observed HTTP request rate");
    expect(traffic).toContain("12.5 requests/s");
    expect(traffic).toContain("Window mean HTTP latency");
    expect(traffic).toContain("Window HTTP failure rate");
    expect(traffic).toContain("25%");
    expect(traffic).toContain("Shared 1-second producer event-time window");
    expect(traffic).toContain("Planned");
    expect(traffic).toContain("1,000");
    expect(traffic).toContain("Started");
    expect(traffic).toContain("900");
    expect(traffic).toContain("Responses completed");
    expect(traffic).toContain("850");
    expect(traffic).toContain("Interrupted");
    expect(traffic).toContain("50");
    expect(traffic).toContain("Unstarted");
    expect(traffic).toContain("100");
    expect(inventory).toContain("Inventory updated");
    expect(queue).toContain("Queue inspected");
    expect(queue).toContain("API refreshes worker drain, retry, and failure state");
    expect(erp).toContain("Failure threshold");
    expect(erp).toContain("Next probe");
    expect(erp).toContain("Breaker reported");
    expect(erp).toContain("API projection");
  });

  it("awaits an observed request rate instead of presenting a configured-style count as observed", () => {
    const recovery = availableRecovery({
      ...recoveryFixture(),
      recentMetrics: [
        {
          metricName: "traffic.scheduled_request_rate",
          value: 50,
          unit: "requests",
          timestamp: "2026-06-20T00:00:11.000Z",
        },
      ],
    });

    const traffic = renderToStaticMarkup(
      createElement(RequestSurgePanel, { recovery, liveEventCount: 0 }),
    );

    expect(traffic).toContain("Observed HTTP request rate");
    expect(traffic).toContain("Awaiting k6 metrics");
    expect(traffic).not.toContain("50 requests/s");
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
    const nextRun = applyDashboardEvent(recovery, runEventFixture("active", previousRun));

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

  it("applies independent inventory observations that share one coherent source timestamp", () => {
    const inventory = inventoryFixture(runFixture().saleOfferId, 12);
    const recovery = availableRecovery({
      ...recoveryFixture(),
      currentRun: runFixture(),
      inventory,
    });
    const observedAt = "2026-06-20T00:00:11.000Z";
    const remaining = inventoryEventFixture(inventory.saleOfferId, 8, observedAt);
    const soldOut = {
      type: "dashboard.metric.observed",
      metricName: "inventory.sold_out_rejection",
      value: 4,
      unit: "rejections",
      aggregation: "cumulative",
      saleOfferId: inventory.saleOfferId,
      runId: runFixture().runId,
      correlationId: "corr-web-live",
      occurredAt: observedAt,
      observedAt,
    } as const satisfies DashboardEvent;
    const state = reduceDashboardEvents(createDashboardState(recovery), [remaining, soldOut]);

    if (state.recovery.status !== "available") throw new Error("Expected available recovery.");
    expect(state.recovery.data.inventory).toMatchObject({
      remainingStock: 8,
      soldOutPressure: { rejectionCount: 4, latestObservedAt: observedAt },
    });
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
    delayedInventory.observedAt = "2026-06-20T00:00:11.000Z";
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

  it("resets idle recovered projections before installing a newly started run", () => {
    const recovery = availableRecovery(populatedRecovery(null));
    const event = runEventFixture("active", {
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
        correlationId: "corr-web-recovery",
        scope: {
          runId: event.run.runId,
          saleOfferId: event.run.saleOfferId ?? null,
        },
        currentRun: event.run,
        inventory: null,
        recentMetrics: [],
        queue: null,
        erp: null,
        businessOutcome: null,
        consistencyLag: null,
        transportAccounting: null,
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
    const event = runEventFixture("active", incomingRun);

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
      transportAccounting: null,
      recentCompletionOutcomes: [],
    });
    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, event)).toBe(true);
  });

  it("retains scope projections for same-run lifecycle updates", () => {
    const run = runFixture();
    const recoveryData = populatedRecovery(run);
    const recovery = availableRecovery(recoveryData);

    const next = applyDashboardEvent(recovery, runEventFixture("active", run));

    expect(next.status).toBe("available");
    if (next.status !== "available") throw new Error("Expected same-run recovery to be available.");
    expect(scopeDerivedProjections(next.data)).toEqual(scopeDerivedProjections(recoveryData));
    expect(
      shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, runEventFixture("active", run)),
    ).toBe(false);
  });

  it("rejects a same-run lifecycle event whose top-level run ID contradicts its payload", () => {
    const run = runFixture();
    const recovery = availableRecovery(populatedRecovery(run));
    const inconsistentEvent = {
      ...runEventFixture("active", run),
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
      ...runEventFixture("active", incomingRun),
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
      ...runEventFixture("active", oldRun),
      occurredAt: "2026-06-20T00:00:12.000Z",
    };

    expect(applyDashboardEvent(recovery, delayedEvent)).toBe(recovery);
    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, delayedEvent)).toBe(false);
  });

  it("uses authoritative recovery after terminal run events", () => {
    expect(shouldRequestAuthoritativeRecoveryAfterEvent(runEventFixture("completed"))).toBe(true);
    expect(shouldRequestAuthoritativeRecoveryAfterEvent(runEventFixture("failed"))).toBe(true);
    expect(shouldRequestAuthoritativeRecoveryAfterEvent(runEventFixture("active"))).toBe(false);
  });

  it("does not regress any finalized projection when live events arrive out of order", () => {
    const recovery = availableRecovery({ ...recoveryFixture(), currentRun: runFixture() });
    const newerInventory = inventoryEventFixture(runFixture().saleOfferId, 8, timestamp(20));
    newerInventory.observedAt = timestamp(20);
    const olderInventory = inventoryEventFixture(runFixture().saleOfferId, 9, timestamp(15));
    olderInventory.observedAt = timestamp(15);

    const state = reduceDashboardEvents(createDashboardState(recovery), [
      runEventAt("completed", timestamp(20), runFixture()),
      runEventAt("active", timestamp(15), runFixture()),
      newerInventory,
      olderInventory,
      queueEventFixture(2, timestamp(20)),
      queueEventFixture(9, timestamp(15)),
      businessOutcomeEventFixture({ occurredAt: timestamp(20), acceptedReservations: 20 }),
      businessOutcomeEventFixture({ occurredAt: timestamp(15), acceptedReservations: 15 }),
      trafficMetricEventFixture({ occurredAt: timestamp(20), value: 20 }),
      trafficMetricEventFixture({ occurredAt: timestamp(15), value: 15 }),
    ]);

    if (state.recovery.status !== "available") throw new Error("Expected available recovery.");
    expect(state.recovery.data.currentRun?.status).toBe("completed");
    expect(state.recovery.data.inventory).toBeNull();
    expect(state.recovery.data.queue).toBeNull();
    expect(state.recovery.data.businessOutcome?.acceptedReservations).toBe(20);
    expect(state.recovery.data.recentMetrics.at(-1)?.value).toBe(20);
  });

  it("uses independent traffic watermarks per metric name, including one shared timestamp", () => {
    const recovery = availableRecovery({ ...recoveryFixture(), currentRun: runFixture() });
    const state = reduceDashboardEvents(createDashboardState(recovery), [
      trafficMetricEventFixture({
        metricName: "traffic.scheduled_request_rate",
        occurredAt: timestamp(20),
        value: 50,
        unit: "requests_per_second",
      }),
      trafficMetricEventFixture({
        metricName: "traffic.latency",
        occurredAt: timestamp(20),
        value: 42,
        unit: "ms",
      }),
      trafficMetricEventFixture({
        metricName: "traffic.failure_rate",
        occurredAt: timestamp(20),
        value: 0.1,
        unit: "ratio",
      }),
      trafficMetricEventFixture({
        metricName: "traffic.latency",
        occurredAt: timestamp(20),
        value: 99,
        unit: "ms",
      }),
    ]);

    if (state.recovery.status !== "available") throw new Error("Expected available recovery.");
    expect(state.recovery.data.recentMetrics.slice(-3)).toEqual([
      expect.objectContaining({ metricName: "traffic.scheduled_request_rate", value: 50 }),
      expect.objectContaining({ metricName: "traffic.latency", value: 42 }),
      expect.objectContaining({ metricName: "traffic.failure_rate", value: 0.1 }),
    ]);
  });

  it("does not advance watermarks for discarded, foreign-scope, or source-older events", () => {
    const recovery = availableRecovery({
      ...recoveryFixture(),
      currentRun: runFixture(),
      inventory: { ...inventoryFixture(), lastUpdatedAt: timestamp(18) },
    });
    const sourceOlder = inventoryEventFixture(runFixture().saleOfferId, 99, timestamp(30));
    sourceOlder.observedAt = timestamp(17);
    const sourceNewer = inventoryEventFixture(runFixture().saleOfferId, 7, timestamp(20));
    sourceNewer.observedAt = timestamp(19);
    let state = dashboardStateReducer(createDashboardState(recovery), {
      type: "event-received",
      event: trafficMetricEventFixture({ occurredAt: timestamp(30), value: 30 }),
      discard: true,
    });
    state = reduceDashboardEvents(state, [
      trafficMetricEventFixture({
        runId: previousRunFixture().runId,
        occurredAt: timestamp(30),
        value: 30,
      }),
      trafficMetricEventFixture({ occurredAt: timestamp(20), value: 20 }),
      sourceOlder,
      sourceNewer,
    ]);

    if (state.recovery.status !== "available") throw new Error("Expected available recovery.");
    expect(state.recovery.data.recentMetrics.at(-1)?.value).toBe(20);
    expect(state.recovery.data.inventory?.remainingStock).toBe(7);
    expect(state.eventWatermarks.metricByName["traffic.latency"]).toBe(timestamp(20));
    expect(state.eventWatermarks.inventory).toBe(timestamp(19));
  });

  it("does not advance metric watermarks for missing or source-stale scalar projections", () => {
    const baseline = availableRecovery({
      ...recoveryFixture(),
      currentRun: runFixture(),
      inventory: { ...inventoryFixture(), lastUpdatedAt: timestamp(18) },
      queue: null,
    });
    let state = reduceDashboardEvents(createDashboardState(baseline), [
      queueEventFixture(3, timestamp(20)),
      inventoryEventFixture(runFixture().saleOfferId, 99, timestamp(17)),
    ]);

    expect(state.eventWatermarks.queue).toBe(timestamp(10));
    expect(state.eventWatermarks.inventory).toBe(timestamp(10));
    expect(state.eventWatermarks.metricByName["queue.depth"]).toBeUndefined();
    expect(state.eventWatermarks.metricByName["inventory.remaining"]).toBeUndefined();

    state = reduceDashboardEvents(state, [
      inventoryEventFixture(runFixture().saleOfferId, 7, timestamp(20)),
      inventorySoldOutEventFixture(runFixture().saleOfferId, 4, timestamp(19)),
    ]);
    expect(state.eventWatermarks.inventory).toBe(timestamp(20));
    expect(state.eventWatermarks.metricByName["inventory.remaining"]).toBe(timestamp(20));
    expect(state.eventWatermarks.metricByName["inventory.sold_out_rejection"]).toBeUndefined();
  });

  it("rebases watermarks when authoritative recovery completes", () => {
    const initial = availableRecovery({ ...recoveryFixture(), currentRun: runFixture() });
    let state = reduceDashboardEvents(createDashboardState(initial), [
      queueEventFixture(2, timestamp(30)),
    ]);
    const refreshed = availableRecovery({
      ...recoveryFixture(),
      currentRun: runFixture(),
      queue: queueFixture(4, timestamp(15)),
      recoveredAt: timestamp(15),
    });
    state = dashboardStateReducer(state, { type: "refresh-completed", recovery: refreshed });
    state = reduceDashboardEvents(state, [queueEventFixture(3, timestamp(20))]);

    if (state.recovery.status !== "available") throw new Error("Expected available recovery.");
    expect(state.recovery.data.queue?.depth).toBe(3);
    expect(state.eventWatermarks.queue).toBe(timestamp(20));
  });

  it("resets old projection watermarks when a new run establishes scope", () => {
    const initial = availableRecovery(populatedRecovery(runFixture()));
    let state = reduceDashboardEvents(createDashboardState(initial), [
      queueEventFixture(2, timestamp(50)),
    ]);
    const incomingRun = {
      ...previousRunFixture(),
      runId: "88888888-8888-4888-8888-888888888888",
      startedAt: timestamp(40),
    };
    state = reduceDashboardEvents(state, [
      runEventAt("active", timestamp(40), incomingRun),
      queueEventFixture(3, timestamp(41)),
    ]);

    if (state.recovery.status !== "available") throw new Error("Expected available recovery.");
    expect(state.recovery.data.currentRun?.runId).toBe(incomingRun.runId);
    expect(state.recovery.data.queue).toBeNull();
    expect(state.eventWatermarks.queue).toBe(timestamp(40));
  });

  it("retains independent projection watermarks across same-run lifecycle updates", () => {
    const recovery = availableRecovery({ ...recoveryFixture(), currentRun: runFixture() });
    const state = reduceDashboardEvents(createDashboardState(recovery), [
      queueEventFixture(2, timestamp(30)),
      runEventAt("completed", timestamp(40), runFixture()),
      queueEventFixture(9, timestamp(25)),
    ]);

    if (state.recovery.status !== "available") throw new Error("Expected available recovery.");
    expect(state.recovery.data.queue).toBeNull();
    expect(state.eventWatermarks.queue).toBe(timestamp(10));
    // The run-lifecycle watermark tracks the durable terminal transition time.
    expect(state.eventWatermarks.runLifecycle).toBe("2026-06-20T00:00:12.000Z");
  });

  it("applies independent projections older than a same-run lifecycle event", () => {
    const recovery = availableRecovery({ ...recoveryFixture(), currentRun: runFixture() });
    const inventory = inventoryEventFixture(runFixture().saleOfferId, 8, timestamp(20));
    inventory.observedAt = timestamp(20);
    const state = reduceDashboardEvents(createDashboardState(recovery), [
      runEventAt("completed", timestamp(40), runFixture()),
      inventory,
      businessOutcomeEventFixture({ occurredAt: timestamp(25), acceptedReservations: 25 }),
    ]);

    if (state.recovery.status !== "available") throw new Error("Expected available recovery.");
    expect(state.recovery.data.recoveredAt).toBe(timestamp(10));
    expect(state.recovery.data.currentRun?.status).toBe("completed");
    expect(state.recovery.data.inventory).toBeNull();
    expect(state.recovery.data.businessOutcome?.acceptedReservations).toBe(25);
    expect(state.eventWatermarks.inventory).toBe(timestamp(10));
    expect(state.eventWatermarks.businessOutcome).toBe(timestamp(25));
    // The run-lifecycle watermark tracks the durable terminal transition time.
    expect(state.eventWatermarks.runLifecycle).toBe("2026-06-20T00:00:12.000Z");
  });
});

describe("terminal overlap convergence", () => {
  const recoveryStartT1 = "2026-06-20T00:00:30.000Z";
  const finalizationAttemptT0 = "2026-06-20T00:00:20.000Z";

  function staleDrainingRecovery() {
    const drainingRun = runEventFixture("draining", runFixture()).run;
    return availableRecovery({
      ...recoveryFixture(),
      scope: { runId: drainingRun.runId, saleOfferId: drainingRun.saleOfferId ?? null },
      currentRun: drainingRun,
      recoveredAt: recoveryStartT1,
    });
  }

  it.each([
    "completed",
    "failed",
  ] as const)("requests one authoritative recovery for a matching %s event older than the recovery watermark", (terminalStatus) => {
    const recovery = staleDrainingRecovery();
    // The terminal transition committed after the t1 recovery read, but its
    // envelope kept the t0 finalization-attempt clock value (t0 < t1).
    const terminalEvent = runEventAt(terminalStatus, finalizationAttemptT0, runFixture());
    expect(Date.parse(terminalEvent.occurredAt)).toBeLessThan(Date.parse(recoveryStartT1));

    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, terminalEvent)).toBe(true);

    const next = applyDashboardEvent(recovery, terminalEvent);
    if (next.status !== "available") throw new Error("Expected available recovery.");
    expect(next.data.currentRun?.status).toBe(terminalStatus);
    expect(next.data.currentRun?.runId).toBe(runFixture().runId);
  });

  it("ignores a terminal event for another run without requesting recovery", () => {
    const recovery = staleDrainingRecovery();
    const foreignTerminal = runEventAt("completed", timestamp(50), previousRunFixture());

    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, foreignTerminal)).toBe(
      false,
    );
    expect(applyDashboardEvent(recovery, foreignTerminal)).toBe(recovery);
  });

  it("ignores a terminal event for the same run but another sale offer", () => {
    const recovery = staleDrainingRecovery();
    const foreignSaleTerminal = runEventAt("completed", timestamp(50), {
      ...runFixture(),
      saleOfferId: previousRunFixture().saleOfferId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    expect(foreignSaleTerminal.run.runId).toBe(runFixture().runId);
    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, foreignSaleTerminal)).toBe(
      false,
    );
    expect(applyDashboardEvent(recovery, foreignSaleTerminal)).toBe(recovery);
  });

  it("does not request recovery again for a duplicate terminal event once terminal", () => {
    const recovery = staleDrainingRecovery();
    const firstTerminal = runEventAt("completed", finalizationAttemptT0, runFixture());
    const applied = applyDashboardEvent(recovery, firstTerminal);
    if (applied.status !== "available") throw new Error("Expected available recovery.");

    const duplicate = runEventAt("completed", timestamp(50), runFixture());
    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(applied, duplicate)).toBe(false);
    expect(applyDashboardEvent(applied, duplicate)).toBe(applied);
  });

  it("does not switch between terminal states based on delivery order", () => {
    const recovery = staleDrainingRecovery();
    const completed = applyDashboardEvent(
      recovery,
      runEventAt("completed", finalizationAttemptT0, runFixture()),
    );

    const lateFailed = runEventAt("failed", timestamp(50), runFixture());
    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(completed, lateFailed)).toBe(false);
    const next = applyDashboardEvent(completed, lateFailed);
    if (next.status !== "available") throw new Error("Expected available recovery.");
    expect(next.data.currentRun?.status).toBe("completed");
  });

  it("does not request recovery for a terminal event while idle", () => {
    const recovery = availableRecovery(recoveryFixture());
    const terminalEvent = runEventAt("completed", timestamp(50), runFixture());

    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, terminalEvent)).toBe(false);
    expect(applyDashboardEvent(recovery, terminalEvent)).toBe(recovery);
  });

  it("rejects a terminal-to-draining regression even with a newer envelope timestamp", () => {
    const completedRun = runEventFixture("completed", runFixture()).run;
    const recovery = availableRecovery({
      ...recoveryFixture(),
      scope: { runId: completedRun.runId, saleOfferId: completedRun.saleOfferId ?? null },
      currentRun: completedRun,
      recoveredAt: recoveryStartT1,
    });
    const regressive = runEventAt("draining", timestamp(50), runFixture());

    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, regressive)).toBe(false);
    const next = applyDashboardEvent(recovery, regressive);
    expect(next).toBe(recovery);
    if (next.status !== "available") throw new Error("Expected available recovery.");
    expect(next.data.currentRun?.status).toBe("completed");
  });

  it("still rejects stale metric events older than the recovery watermark", () => {
    const recovery = staleDrainingRecovery();
    const staleMetric = trafficMetricEventFixture({
      runId: runFixture().runId,
      occurredAt: "2026-06-20T00:00:20.000Z",
      value: 99,
    });

    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(recovery, staleMetric)).toBe(false);
    const next = applyDashboardEvent(recovery, staleMetric);
    if (next.status !== "available") throw new Error("Expected available recovery.");
    expect(next.data.recentMetrics).toEqual([]);
  });
});

describe("idle new-run overlap convergence", () => {
  const startCapturedAtT0 = "2026-06-20T00:00:20.000Z";
  const idleRecoveryCompletedAtT1 = "2026-06-20T00:00:30.000Z";

  function overlappingRunEvent(): RunDashboardEvent {
    return runEventAt("active", startCapturedAtT0, {
      ...runFixture(),
      runId: "88888888-8888-4888-8888-888888888888",
      startedAt: startCapturedAtT0,
      trafficStartedAt: startCapturedAtT0,
    });
  }

  it("rejects direct application but requests recovery when the t0 start event arrives after the t1 idle recovery", () => {
    const idleRecovery = availableRecovery({
      ...recoveryFixture(),
      recoveredAt: idleRecoveryCompletedAtT1,
    });
    const eventDeliveredAtT2 = overlappingRunEvent();

    expect(Date.parse(eventDeliveredAtT2.occurredAt)).toBeLessThan(
      Date.parse(idleRecoveryCompletedAtT1),
    );
    const nextState = dashboardStateReducer(createDashboardState(idleRecovery), {
      type: "event-received",
      event: eventDeliveredAtT2,
      discard: false,
    });
    expect(nextState.recovery).toBe(idleRecovery);
    expect(
      shouldRequestAuthoritativeRecoveryAfterScopedEvent(idleRecovery, eventDeliveredAtT2),
    ).toBe(true);
  });

  it("does not request recovery for an incoherent overlapping run envelope", () => {
    const idleRecovery = availableRecovery({
      ...recoveryFixture(),
      recoveredAt: idleRecoveryCompletedAtT1,
    });
    const incoherentEvent = {
      ...overlappingRunEvent(),
      runId: previousRunFixture().runId,
    };

    expect(applyDashboardEvent(idleRecovery, incoherentEvent)).toBe(idleRecovery);
    expect(shouldRequestAuthoritativeRecoveryAfterScopedEvent(idleRecovery, incoherentEvent)).toBe(
      false,
    );
  });

  it("does not request recovery for a stale nonterminal event from an older run", () => {
    const currentRun = {
      ...runFixture(),
      startedAt: "2026-06-20T00:00:25.000Z",
      trafficStartedAt: "2026-06-20T00:00:25.000Z",
    };
    const currentRecovery = availableRecovery({
      ...recoveryFixture(),
      scope: { runId: currentRun.runId, saleOfferId: currentRun.saleOfferId ?? null },
      currentRun,
      recoveredAt: idleRecoveryCompletedAtT1,
    });
    const stalePriorRun = runEventAt("active", startCapturedAtT0, previousRunFixture());

    expect(applyDashboardEvent(currentRecovery, stalePriorRun)).toBe(currentRecovery);
    expect(
      shouldRequestAuthoritativeRecoveryAfterScopedEvent(currentRecovery, stalePriorRun),
    ).toBe(false);
  });
});

function reduceDashboardEvents(
  state: ReturnType<typeof createDashboardState>,
  events: DashboardEvent[],
): ReturnType<typeof createDashboardState> {
  return events.reduce(
    (current, event) =>
      dashboardStateReducer(current, { type: "event-received", event, discard: false }),
    state,
  );
}

function timestamp(seconds: number): string {
  return `2026-06-20T00:00:${String(seconds).padStart(2, "0")}.000Z`;
}

function runEventAt(
  status: "starting" | "active" | "draining" | "completed" | "failed",
  occurredAt: string,
  run: ReturnType<typeof runFixture>,
): RunDashboardEvent {
  const event = runEventFixture(status, run);
  return {
    ...event,
    occurredAt,
  };
}

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
    trafficStartedAt: "2026-06-20T00:00:00.000Z",
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
  status: "starting" | "active" | "draining" | "completed" | "failed",
  run: ReturnType<typeof runFixture> = runFixture(),
): RunDashboardEvent {
  const { trafficStartedAt, ...baseRun } = run;
  const trafficEndedAt = "2026-06-20T00:00:11.000Z";
  const finalizedAt = "2026-06-20T00:00:12.000Z";
  const lifecycle =
    status === "starting"
      ? { status, trafficStatus: "starting" as const }
      : status === "active"
        ? { status, trafficStatus: "active" as const, trafficStartedAt }
        : status === "draining"
          ? { status, trafficStatus: "succeeded" as const, trafficStartedAt, trafficEndedAt }
          : status === "completed"
            ? {
                status,
                trafficStatus: "succeeded" as const,
                trafficStartedAt,
                trafficEndedAt,
                finalizedAt,
              }
            : {
                status,
                trafficStatus: "succeeded" as const,
                trafficStartedAt,
                trafficEndedAt,
                finalizedAt,
                failureReason: "traffic_failed",
              };
  return {
    type: "load.run.updated",
    runId: run.runId,
    correlationId: "corr-web-live",
    run: demoRunSnapshotSchema.parse({ ...baseRun, ...lifecycle }),
    occurredAt: "2026-06-20T00:00:12.000Z",
  };
}

function populatedRecovery(
  currentRun: ReturnType<typeof runFixture> | null,
): DashboardRecoveryResponse {
  return {
    ...recoveryFixture(),
    scope: currentRun
      ? { runId: currentRun.runId, saleOfferId: currentRun.saleOfferId ?? null }
      : null,
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
    transportAccounting,
    recentCompletionOutcomes,
  } = recovery;
  return {
    inventory,
    recentMetrics,
    queue,
    erp,
    businessOutcome,
    consistencyLag,
    transportAccounting,
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
): Extract<DashboardEvent, { type: "business.outcome.snapshot" }> {
  return {
    type: "business.outcome.snapshot",
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
  options: {
    runId?: string;
    occurredAt?: string;
    value?: number;
    metricName?: "traffic.scheduled_request_rate" | "traffic.latency" | "traffic.failure_rate";
    unit?: "requests_per_second" | "ms" | "ratio";
  } = {},
): Extract<DashboardEvent, { type: "dashboard.metric.observed" }> {
  return {
    type: "dashboard.metric.observed",
    runId: options.runId ?? runFixture().runId,
    correlationId: "corr-web-live",
    metricName: options.metricName ?? "traffic.latency",
    value: options.value ?? 3,
    unit: options.unit ?? "ms",
    occurredAt: options.occurredAt ?? "2026-06-20T00:00:11.000Z",
    observedAt: options.occurredAt ?? "2026-06-20T00:00:11.000Z",
  } as Extract<DashboardEvent, { type: "dashboard.metric.observed" }>;
}

function inventoryEventFixture(
  saleOfferId: string,
  remainingStock: number,
  occurredAt: string,
): Extract<DashboardEvent, { type: "dashboard.metric.observed" }> & {
  metricName: "inventory.remaining";
} {
  return {
    type: "dashboard.metric.observed",
    correlationId: "corr-web-live",
    occurredAt,
    observedAt: occurredAt,
    metricName: "inventory.remaining",
    value: remainingStock,
    unit: "items",
    saleOfferId,
  };
}

function inventorySoldOutEventFixture(
  saleOfferId: string,
  rejectionCount: number,
  occurredAt: string,
): Extract<DashboardEvent, { type: "dashboard.metric.observed" }> & {
  metricName: "inventory.sold_out_rejection";
} {
  return {
    type: "dashboard.metric.observed",
    correlationId: "corr-web-live",
    occurredAt,
    observedAt: occurredAt,
    metricName: "inventory.sold_out_rejection",
    value: rejectionCount,
    unit: "rejections",
    aggregation: "cumulative",
    saleOfferId,
    runId: runFixture().runId,
  };
}

function queueEventFixture(
  depth: number,
  occurredAt: string,
): Extract<DashboardEvent, { type: "dashboard.metric.observed" }> & { metricName: "queue.depth" } {
  return {
    type: "dashboard.metric.observed",
    correlationId: "corr-web-live",
    occurredAt,
    observedAt: occurredAt,
    metricName: "queue.depth",
    value: depth,
    unit: "jobs",
    queueName: "orders:process",
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
    correlationId: "corr-web-recovery",
    scope: null,
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
    transportAccounting: null,
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
