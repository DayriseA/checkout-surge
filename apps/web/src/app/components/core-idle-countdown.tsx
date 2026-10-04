"use client";

import { type CoreIdleStatus, coreIdleStatusSchema } from "@checkout-surge/contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { CompletedBackendRead } from "../lib/backend-read";
import { readProxyJson } from "../lib/client/proxy-json";
import { coreActivityProxyPath, coreIdleStatusProxyPath } from "../lib/control-paths";
import { buttonClassName } from "./control-styles";

const statusPollIntervalMs = 30_000;
const alertSeconds = 120;

type CountdownView =
  | { kind: "hidden" }
  | { kind: "paused" }
  | { kind: "run_in_progress" }
  | { kind: "awake"; sleepsAtMs: number };

/**
 * The API owns the idle deadline; this widget only displays it, so every visitor sees the same
 * countdown. It stays hidden where the core never sleeps (local topology). Once the core was seen
 * awake, a failed status read means it went to sleep: the page shows "Demo paused".
 */
export function CoreIdleCountdown() {
  const [view, setView] = useState<CountdownView>({ kind: "hidden" });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [stayAwakePending, setStayAwakePending] = useState(false);
  const seenEnabledRef = useRef(false);

  const applyRead = useCallback((read: CompletedBackendRead<CoreIdleStatus>) => {
    const next = viewFromRead(read, seenEnabledRef.current, Date.now());
    if (next.kind === "awake" || next.kind === "run_in_progress") seenEnabledRef.current = true;
    setNowMs(Date.now());
    setView(next);
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const read = await readProxyJson(coreIdleStatusProxyPath, coreIdleStatusSchema);
      if (!active) return;
      const isDisabled = read.status === "available" && read.data.state === "disabled";
      applyRead(read);
      if (!isDisabled) timer = setTimeout(poll, statusPollIntervalMs);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [applyRead]);

  useEffect(() => {
    if (view.kind !== "awake") return;
    const interval = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [view.kind]);

  async function stayAwake() {
    setStayAwakePending(true);
    try {
      applyRead(
        await readProxyJson(coreActivityProxyPath, coreIdleStatusSchema, { method: "POST" }),
      );
    } finally {
      setStayAwakePending(false);
    }
  }

  if (view.kind === "hidden") return null;
  if (view.kind === "paused") {
    return (
      <CountdownBar tone="paused">
        <p className="m-0">
          <strong>Demo paused.</strong> The system went to sleep after a period without activity.
        </p>
        {/* A full page load, so the gate can serve its start page. */}
        <a className={buttonClassName} href="/">
          Back to the start page
        </a>
      </CountdownBar>
    );
  }
  if (view.kind === "run_in_progress") {
    return (
      <CountdownBar tone="normal">
        <p className="m-0">Run in progress, the system stays awake.</p>
      </CountdownBar>
    );
  }
  const remainingSeconds = Math.max(0, Math.ceil((view.sleepsAtMs - nowMs) / 1_000));
  const alerting = remainingSeconds <= alertSeconds;
  return (
    <CountdownBar tone={alerting ? "alert" : "normal"}>
      <p className="m-0">
        {alerting ? <strong>Going to sleep soon. </strong> : null}
        The system is awake and will sleep after{" "}
        <strong className="tabular-nums">{formatCountdown(remainingSeconds)}</strong> without
        activity.
      </p>
      <button
        className={buttonClassName}
        disabled={stayAwakePending}
        onClick={() => void stayAwake()}
        type="button"
      >
        Stay awake
      </button>
    </CountdownBar>
  );
}

function viewFromRead(
  read: CompletedBackendRead<CoreIdleStatus>,
  seenEnabled: boolean,
  nowMs: number,
): CountdownView {
  if (read.status === "unavailable") return seenEnabled ? { kind: "paused" } : { kind: "hidden" };
  const status = read.data;
  if (status.state === "disabled") return { kind: "hidden" };
  if (status.state === "run_in_progress") return { kind: "run_in_progress" };
  return { kind: "awake", sleepsAtMs: nowMs + status.sleepsInSeconds * 1_000 };
}

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const toneClassNames = {
  normal: "border-border bg-surface",
  alert: "border-warning-line bg-warning-soft",
  paused: "border-info bg-info-soft",
} as const;

function CountdownBar({
  tone,
  children,
}: {
  tone: keyof typeof toneClassNames;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[1280px] px-6 pt-4 max-[560px]:px-4">
      <section
        aria-label="Demo availability"
        aria-live="polite"
        className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border px-4 py-2 text-sm leading-6 text-ink ${toneClassNames[tone]}`}
        data-core-idle={tone}
      >
        {children}
      </section>
    </div>
  );
}
