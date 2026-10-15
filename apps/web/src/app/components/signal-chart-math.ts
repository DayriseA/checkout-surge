import { getTranslation, type Locale } from "../lib/i18n/translate";

export type ChartPoint = { elapsedSeconds: number; value: number };

/**
 * The nearest sample, unless the cursor sits further from it than the series' own sample spacing:
 * a series that stopped early (arrival ends at the last attempt) then reads as having no sample.
 */
export function valueAt(points: ChartPoint[], seconds: number): number | null {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;
  const spacing =
    points.length > 1 ? (last.elapsedSeconds - first.elapsedSeconds) / (points.length - 1) : 0;
  let nearest = first;
  for (const point of points) {
    if (Math.abs(point.elapsedSeconds - seconds) < Math.abs(nearest.elapsedSeconds - seconds)) {
      nearest = point;
    }
  }
  if (points.length > 1 && Math.abs(nearest.elapsedSeconds - seconds) > spacing) return null;
  return nearest.value;
}

/** Round 1/2/5 steps giving roughly four to six ticks from zero to the axis maximum. */
export function axisTicks(xMax: number): number[] {
  if (xMax <= 0) return [0];
  const rough = xMax / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((multiple) => multiple * magnitude).find((s) => s >= rough) ?? rough;
  const count = Math.floor(xMax / step + 1e-9);
  return Array.from({ length: count + 1 }, (_, index) => Number((index * step).toPrecision(12)));
}

/** The text equivalent of one plotted line: where it starts, peaks, and ends. */
export function describeSeries(
  line: { label: string; points: ChartPoint[] },
  unit: string,
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  const first = line.points[0];
  const last = line.points.at(-1);
  if (!first || !last) return t("{label}: no samples retained.", { label: t(line.label) });
  const at = (point: ChartPoint) =>
    t("{value} {unit} at {time}", {
      value: formatNumber(point.value, locale),
      unit: t(unit),
      time: formatSeconds(point.elapsedSeconds, locale),
    });
  if (line.points.length === 1) {
    return t("{label}: {sample}.", { label: t(line.label), sample: at(first) });
  }
  const peak = line.points.reduce((best, point) => (point.value > best.value ? point : best));
  return t("{label}: starts at {first}, peaks at {peak}, ends at {last}.", {
    label: t(line.label),
    first: at(first),
    peak: at(peak),
    last: at(last),
  });
}

export function scale(value: number, maximum: number, range: number): number {
  if (maximum <= 0) return 0;
  return Math.max(0, Math.min(range, (value / maximum) * range));
}

/**
 * Chart-axis coordinates, not named measurements. They keep one fixed unit so ticks and readings
 * stay directly comparable; that is why this surface does not use the tiered duration policy.
 */
export function formatSeconds(value: number, locale: Locale = "en"): string {
  return `${new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: 2 }).format(value)}${locale === "fr" ? "\u00a0s" : "s"}`;
}

/** Signal magnitudes can be fractional (rates), so they keep two decimals with en-US grouping. */
export function formatNumber(value: number, locale: Locale = "en"): string {
  return new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    maximumFractionDigits: 2,
  }).format(value);
}
