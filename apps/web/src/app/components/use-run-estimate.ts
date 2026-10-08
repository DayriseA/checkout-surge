"use client";

import {
  type CapacityAssessment,
  type EstimateAdmissionRejectionDetails,
  type EstimatorResult,
  previewDemoRunRequestSchema,
  previewDemoRunResponseSchema,
  type StartDemoRunRequest,
} from "@checkout-surge/contracts";
import { useEffect, useState } from "react";
import { readProxyJson } from "../lib/client/proxy-json";
import { adminDemoRunEstimateProxyPath, demoRunEstimateProxyPath } from "../lib/control-paths";

export type RunEstimateState =
  | { status: "inactive" }
  | { status: "pending" }
  | { status: "unavailable" }
  | {
      status: "allowed";
      result: EstimatorResult;
      capacity: CapacityAssessment;
      automaticVus: number | null;
    }
  | { status: "rejected"; result: EstimatorResult | EstimateAdmissionRejectionDetails }
  /** Public custom runs only: the API admits them only when expected to complete. */
  | { status: "capacity_rejected"; capacity: CapacityAssessment };

type RejectedEstimateState = Extract<
  RunEstimateState,
  { status: "rejected" } | { status: "capacity_rejected" }
>;

export function useRunEstimate(
  request: StartDemoRunRequest | null,
  mode: "public" | "admin",
  enabled: boolean,
  sourceIdentity?: string,
) {
  const body = request ? JSON.stringify(request) : null;
  const key = JSON.stringify([mode, body, sourceIdentity]);
  const [completed, setCompleted] = useState<{ key: string; state: RunEstimateState } | null>(null);
  const [rejection, setRejection] = useState<{
    key: string;
    state: RejectedEstimateState;
  } | null>(null);

  useEffect(() => {
    setCompleted(null);
    setRejection(null);
    if (!enabled || !body) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (!previewDemoRunRequestSchema.safeParse(JSON.parse(body)).success) {
        setCompleted({ key, state: { status: "unavailable" } });
        return;
      }
      const read = await readProxyJson(
        mode === "admin" ? adminDemoRunEstimateProxyPath : demoRunEstimateProxyPath,
        previewDemoRunResponseSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        },
      );
      // Cancellation alone is insufficient: a transport can finish after abort.
      if (controller.signal.aborted) return;
      setCompleted({
        key,
        state:
          read.status !== "available"
            ? { status: "unavailable" }
            : read.data.result.decision !== "admitted"
              ? { status: "rejected", result: read.data.result }
              : mode === "public" && read.data.capacity.verdict !== "expected_to_complete"
                ? { status: "capacity_rejected", capacity: read.data.capacity }
                : { status: "allowed", ...read.data },
      });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [body, enabled, key, mode]);

  const state: RunEstimateState =
    !enabled || !body
      ? { status: "inactive" }
      : rejection?.key === key
        ? rejection.state
        : completed?.key === key
          ? completed.state
          : { status: "pending" };
  return {
    state,
    blocksStart:
      state.status === "pending" ||
      state.status === "rejected" ||
      state.status === "capacity_rejected",
    reject: (result: EstimateAdmissionRejectionDetails) =>
      setRejection({ key, state: { status: "rejected", result } }),
    rejectCapacity: (capacity: CapacityAssessment) =>
      setRejection({ key, state: { status: "capacity_rejected", capacity } }),
  };
}
