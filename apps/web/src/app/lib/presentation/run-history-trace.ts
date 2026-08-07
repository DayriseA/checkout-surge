import type { AdminRunHistoryDetailResponse } from "@checkout-surge/contracts";

export interface RunHistoryTraceEntry {
  id: string;
  timestamp: string;
  source: "Order event" | "ERP attempt" | "Notification" | "Event";
  activity: string;
  publicOrderId?: string;
  details: Array<[string, string]>;
}

const sourceRank: Record<RunHistoryTraceEntry["source"], number> = {
  "Order event": 0,
  "ERP attempt": 1,
  Notification: 2,
  Event: 3,
};

export function buildRunHistoryTrace(
  detail: AdminRunHistoryDetailResponse,
): RunHistoryTraceEntry[] {
  return [
    ...detail.orders.records.map((order): RunHistoryTraceEntry => {
      const timestamp = order.failedAt ?? order.confirmedAt ?? order.processingAt ?? order.queuedAt;
      return {
        id: order.orderId,
        timestamp,
        source: "Order event",
        activity: `Order ${order.status}`,
        publicOrderId: order.publicOrderId,
        details: [
          ["Internal order", order.orderId],
          ["Public order", order.publicOrderId],
          ["Correlation", order.correlationId],
          ["Queued", order.queuedAt],
          ...(order.processingAt ? [["Processing", order.processingAt] as [string, string]] : []),
          ...(order.confirmedAt ? [["Confirmed", order.confirmedAt] as [string, string]] : []),
          ...(order.failedAt ? [["Failed", order.failedAt] as [string, string]] : []),
        ],
      };
    }),
    ...detail.erpAttempts.records.map(
      (attempt): RunHistoryTraceEntry => ({
        id: attempt.attemptId,
        timestamp: attempt.finishedAt,
        source: "ERP attempt",
        activity: `Attempt ${attempt.attemptNumber} ${attempt.status}`,
        publicOrderId: attempt.publicOrderId,
        details: [
          ["Attempt", attempt.attemptId],
          ["Internal order", attempt.orderId],
          ["Public order", attempt.publicOrderId],
          ["Correlation", attempt.correlationId],
          ["Started", attempt.startedAt],
          ["Finished", attempt.finishedAt],
        ],
      }),
    ),
    ...detail.notifications.records.map(
      (notification): RunHistoryTraceEntry => ({
        id: notification.notificationId,
        timestamp: notification.recordedAt,
        source: "Notification",
        activity: "Notification recorded",
        publicOrderId: notification.publicOrderId,
        details: [
          ["Notification", notification.notificationId],
          ["Internal order", notification.orderId],
          ["Public order", notification.publicOrderId],
          ["Correlation", notification.correlationId],
          ["Recorded", notification.recordedAt],
        ],
      }),
    ),
    ...detail.eventTimeline.records.map(
      (event): RunHistoryTraceEntry => ({
        id: event.eventId,
        timestamp: event.occurredAt,
        source: "Event",
        activity: event.eventName,
        ...(event.publicOrderId ? { publicOrderId: event.publicOrderId } : {}),
        details: [
          ["Event", event.eventId],
          ...(event.orderId ? [["Internal order", event.orderId] as [string, string]] : []),
          ...(event.publicOrderId
            ? [["Public order", event.publicOrderId] as [string, string]]
            : []),
          ["Correlation", event.correlationId],
          ["Occurred", event.occurredAt],
          ["Source", event.source],
        ],
      }),
    ),
  ].sort(
    (left, right) =>
      left.timestamp.localeCompare(right.timestamp) ||
      sourceRank[left.source] - sourceRank[right.source] ||
      left.id.localeCompare(right.id),
  );
}
