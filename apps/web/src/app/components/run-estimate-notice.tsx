"use client";

import type { TrafficConfig } from "@checkout-surge/contracts";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import {
  capacityRefusalCopy,
  capacityWarningCopy,
  explicitVusWarning,
} from "../lib/presentation/capacity-presentation";
import { estimateRejectionCopy } from "../lib/presentation/estimate-presentation";
import type { RunEstimateState } from "./use-run-estimate";

export function RunEstimateNotice({
  state,
  mode,
}: {
  state: RunEstimateState;
  mode: "public" | "admin";
}) {
  const t = useTranslation();
  const locale = useLocale();
  if (state.status === "unavailable")
    return (
      <NoticeLines
        lines={[
          t("Preview unavailable. You can try starting; the server will check admission again."),
        ]}
      />
    );
  if (state.status === "rejected")
    return <NoticeLines lines={estimateRejectionCopy(state.result, mode, locale)} />;
  if (state.status === "capacity_rejected")
    return <NoticeLines lines={capacityRefusalCopy(state.capacity, locale)} />;
  return null;
}

/**
 * Admin runs are never refused by the capacity model: a run not expected to complete, or one
 * with explicit VUs below the deployment's allocation, is flagged before confirmation.
 */
export function RunCapacityWarning({
  state,
  trafficConfig,
}: {
  state: RunEstimateState;
  trafficConfig: TrafficConfig;
}) {
  const locale = useLocale();
  if (state.status !== "allowed") return null;
  const vusWarning = explicitVusWarning(trafficConfig, state.automaticVus, locale);
  const lines = [
    ...capacityWarningCopy(state.capacity, locale),
    ...(vusWarning === null ? [] : [vusWarning]),
  ];
  return lines.length > 0 ? <NoticeLines lines={lines} /> : null;
}

function NoticeLines({ lines }: { lines: string[] }) {
  return (
    <div role="status" aria-live="polite" className="my-2 text-sm text-muted-strong">
      {[...new Set(lines)].map((line) => (
        <p className="m-0" key={line}>
          {line}
        </p>
      ))}
    </div>
  );
}
