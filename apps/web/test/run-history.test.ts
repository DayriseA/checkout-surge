import type { RunHistoryListResponse } from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHistoryList } from "../src/app/components/run-history-list.js";

describe("run history surface", () => {
  it("renders traffic delivery, business outcomes, and terminal inventory snapshots", () => {
    const markup = renderToStaticMarkup(
      createElement(RunHistoryList, { history: runHistoryFixture() }),
    );

    expect(markup).toContain("Preview 1k");
    expect(markup).toContain("55555555-5555-4555-8555-555555555555");
    expect(markup).toContain("traffic complete");
    expect(markup).toContain("Accepted reservations");
    expect(markup).toContain("Confirmed orders");
    expect(markup).toContain("Terminal inventory");
    expect(markup).toContain("Starting stock");
    expect(markup).toContain("redis snapshot captured");
  });

  it("renders a clear empty state before terminal summaries exist", () => {
    const markup = renderToStaticMarkup(
      createElement(RunHistoryList, {
        history: {
          summaries: [],
          page: 1,
          pageSize: 10,
          totalCount: 0,
          timestamp: "2026-06-20T00:00:10.000Z",
        },
      }),
    );

    expect(markup).toContain("No history yet");
    expect(markup).toContain("Terminal summaries appear here");
  });
});

function runHistoryFixture(): RunHistoryListResponse {
  return {
    summaries: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        runId: "55555555-5555-4555-8555-555555555555",
        presetName: "Preview 1k",
        status: "completed",
        startedAt: "2026-06-20T00:00:00.000Z",
        endedAt: "2026-06-20T00:00:10.000Z",
        httpSummary: {
          plannedRequests: 10,
          emittedRequests: 10,
          completedRequests: 10,
          failedRequests: 0,
          acceptedResponses: 6,
          soldOutResponses: 4,
          unexpectedResponses: 0,
          p95LatencyMs: 42,
          failureRate: 0,
        },
        trafficDeliverySummary: {
          plannedRequests: 10,
          emittedRequests: 10,
          droppedIterations: 0,
          trafficDeliveryStatus: "complete",
          notes: [],
        },
        businessOutcomeSummary: {
          acceptedReservations: 6,
          soldOutRejections: 4,
          queuedOrders: 0,
          processingOrders: 0,
          retryingOrders: 0,
          confirmedOrders: 5,
          failedOrders: 1,
          pendingPersistenceCount: 0,
          notificationsRecorded: 5,
        },
        terminalInventorySnapshot: {
          saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          startingStock: 10,
          remainingStock: 0,
          reservedStock: 10,
          acceptedReservations: 6,
          soldOutRejections: 4,
          pendingPersistenceCount: 0,
          capturedAt: "2026-06-20T00:00:10.000Z",
          source: "redis",
        },
        capturedAt: "2026-06-20T00:00:10.000Z",
      },
    ],
    page: 1,
    pageSize: 10,
    totalCount: 1,
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}
