import type { PublicRunHistoryDetailResponse } from "@checkout-surge/contracts";
import type { CompletedBackendRead } from "../api";

export type AcceptedRunResult =
  | { status: "available"; runId: string; presetName: string; endedAt: string }
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
