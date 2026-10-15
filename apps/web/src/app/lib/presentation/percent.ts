import type { Locale } from "../i18n/translate";

/** French typography separates the percent sign from its number with a narrow non-breaking space. */
export function withPercentSign(value: string | number, locale: Locale = "en"): string {
  return `${value}${locale === "fr" ? "\u202f%" : "%"}`;
}

export function ratioToPercent(ratio: number): number {
  return Number((ratio * 100).toFixed(10));
}

export function percentToRatio(percent: string | number): number {
  const value = Number(percent);
  return (Number.isFinite(value) ? value : 0) / 100;
}
