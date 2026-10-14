import { getTranslation, type Locale } from "../i18n/translate";
import { formatCount } from "./format";

export function formatRunCount(
  value: number,
  fallback = "not recorded",
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  return `${formatCount(value, locale) ?? t(fallback)} ${t(value === 1 ? "run" : "runs")}`;
}
