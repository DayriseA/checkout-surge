"use client";

import type { DashboardProjection } from "@checkout-surge/contracts";
import { useEffect, useState } from "react";
import type { BackendRead } from "../lib/api";
import { RunnerRelocationNotice } from "./runner-relocation-notice";

/** Most starts end well within this; past it, the panel reassures the visitor. */
const slowStartNoticeDelayMs = 12_000;

/**
 * Shown while a submitted start waits for the API, mostly for the load generator to start. It
 * claims no progress it cannot see: the request is either still pending or this panel is gone.
 * Mount it only while the start is pending, so its timer starts with the start.
 */
export function RunStartWaitingPanel({
  recovery,
  className = "",
}: {
  recovery: BackendRead<DashboardProjection>;
  className?: string;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), slowStartNoticeDelayMs);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      aria-label="Run start"
      className={`grid gap-2 overflow-hidden rounded-xl border border-border bg-surface p-4 text-left text-sm leading-6 text-muted-strong ${className}`}
      role="status"
    >
      <p className="m-0 flex items-center gap-2 font-semibold text-ink">
        <span aria-hidden="true" className="loading-pulse text-info" />
        Starting the load generator
      </p>
      <p className="m-0">
        This usually takes a few seconds. The live view opens as soon as the run starts.
      </p>
      {slow ? (
        <p className="m-0">
          This start is taking longer than usual, but it is still in progress. There is no need to
          start again.
        </p>
      ) : null}
      <RunnerRelocationNotice announce={false} recovery={recovery} />
      <div aria-hidden="true" className="loading-bar" />
    </div>
  );
}
