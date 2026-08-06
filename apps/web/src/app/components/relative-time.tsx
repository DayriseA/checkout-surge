"use client";

import { useEffect, useState } from "react";

const relativeFormatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

export function formatRelativeTime(instant: string, nowMs = Date.now()): string | null {
  const differenceSeconds = (Date.parse(instant) - nowMs) / 1_000;
  if (!Number.isFinite(differenceSeconds)) return null;

  const absoluteSeconds = Math.abs(differenceSeconds);
  const [divisor, unit]: [number, Intl.RelativeTimeFormatUnit] =
    absoluteSeconds < 60
      ? [1, "second"]
      : absoluteSeconds < 3_600
        ? [60, "minute"]
        : absoluteSeconds < 86_400
          ? [3_600, "hour"]
          : [86_400, "day"];
  return relativeFormatter.format(Math.round(differenceSeconds / divisor), unit);
}

export function RelativeTime({ instant }: { instant: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => setLabel(formatRelativeTime(instant)), [instant]);
  return label ? <span aria-hidden="true"> · {label}</span> : null;
}
