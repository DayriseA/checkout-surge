import type {
  PublicRunHistoryDetailResponse,
  RunResult,
  TrafficDeliveryStatus,
  TransportAttemptCounts,
} from "@checkout-surge/contracts";
import type { CompletedBackendRead } from "../api";

/**
 * The small public summary/qualification subset retained from the visitor's own already-read
 * public run detail. `DashboardProjection` never carries the delivery summary, so this retained
 * detail is the only source of the saved-report delivery qualification on Watch. The transport
 * counts stay raw inputs; callers derive the observation with `deriveTransportObservation`.
 */
export interface AcceptedRunReportEvidence {
  result: RunResult;
  trafficDeliveryStatus: TrafficDeliveryStatus;
  transportAttemptCounts: TransportAttemptCounts;
  transportFailures: number;
}

export type AcceptedRunResult =
  | {
      status: "available";
      runId: string;
      presetName: string;
      endedAt: string;
      reportEvidence?: AcceptedRunReportEvidence;
    }
  | { status: "awaiting"; runId: string }
  | { status: "unavailable"; runId: string; retryAfterMs?: number };

export function acceptedRunResultFromRead(
  runId: string,
  read: CompletedBackendRead<PublicRunHistoryDetailResponse>,
): AcceptedRunResult {
  if (read.status === "available") {
    return read.data.summary.runId === runId && read.data.run.runId === runId
      ? {
          status: "available",
          runId,
          presetName: read.data.summary.presetName,
          endedAt: read.data.summary.endedAt,
          reportEvidence: {
            result: read.data.result,
            trafficDeliveryStatus: read.data.summary.trafficDeliverySummary.trafficDeliveryStatus,
            transportAttemptCounts: read.data.summary.transportAttemptCounts,
            transportFailures: read.data.summary.httpSummary.transportFailures,
          },
        }
      : { status: "unavailable", runId };
  }
  return read.httpStatus === 404
    ? { status: "awaiting", runId }
    : {
        status: "unavailable",
        runId,
        ...(read.retryAfterMs === undefined ? {} : { retryAfterMs: read.retryAfterMs }),
      };
}
