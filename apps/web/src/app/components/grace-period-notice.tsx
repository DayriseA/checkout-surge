"use client";

import {
  automaticRunResetGraceNoticeSeconds,
  type DemoRunSnapshot,
} from "@checkout-surge/contracts";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import { formatDurationMs } from "../lib/presentation/format";

/**
 * The server owns the reset deadline (`autoResetAt`); this component only displays it. The notice
 * stays hidden until 600 seconds after acceptance — no countdown before the grace period —
 * then warns that the run will be reset automatically to free the demo, with the time left. It
 * derives everything from the projection's current run plus one clock, so an SSE reconnect or page
 * reload reproduces the same notice without stored client state.
 */
export function GracePeriodNotice({
  run,
  now = defaultNow,
}: {
  run: DemoRunSnapshot;
  now?: (() => number) | undefined;
}) {
  const t = useTranslation();
  const locale = useLocale();
  if (run.status === "completed" || run.status === "failed") return null;
  const startedAtMs = Date.parse(run.startedAt);
  const resetAtMs = Date.parse(run.autoResetAt);
  const nowMs = now();
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(resetAtMs)) return null;
  if (nowMs - startedAtMs < automaticRunResetGraceNoticeSeconds * 1000) return null;
  const remainingMs = resetAtMs - nowMs;
  if (remainingMs <= 0) return null;
  const remaining = formatDurationMs(remainingMs, locale) ?? "under a second";
  return (
    <section
      aria-label={t("Grace period notice")}
      className="rounded-xl border border-warning-line bg-warning-soft px-4 py-3"
      data-grace-period-notice=""
      role="status"
    >
      <p className="m-0 text-sm font-semibold leading-6 text-ink">
        {t("This run is in its grace period. It will be reset automatically in ")}
        {remaining}
        {t(" to free the demo for the next run, and its run data will be discarded.")}
      </p>
    </section>
  );
}

function defaultNow(): number {
  return Date.now();
}
