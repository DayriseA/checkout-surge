"use client";

import { useEffect, useState } from "react";
import { intlLocale, type Locale } from "../lib/i18n/locale";
import { useLocale } from "../lib/i18n/locale-context";

const relativeFormatters = {
  en: new Intl.RelativeTimeFormat(intlLocale("en"), { numeric: "auto" }),
  fr: new Intl.RelativeTimeFormat(intlLocale("fr"), { numeric: "auto" }),
};

export function formatRelativeTime(
  instant: string,
  nowMs = Date.now(),
  locale: Locale = "en",
): string | null {
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
  return relativeFormatters[locale].format(Math.round(differenceSeconds / divisor), unit);
}

export function RelativeTime({ instant }: { instant: string }) {
  const locale = useLocale();
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => setLabel(formatRelativeTime(instant, Date.now(), locale)), [instant, locale]);
  return label ? <span aria-hidden="true"> · {label}</span> : null;
}
