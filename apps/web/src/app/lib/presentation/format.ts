/**
 * The single presentation boundary for user-facing instants, durations, and counts.
 *
 * Application policy (see `docs/cross_service_conventions.md`):
 * - Timezone: labelled UTC everywhere, 24-hour clock. Server rendering and client hydration
 *   therefore cannot disagree about a wall clock reading.
 * - Locale: `en-US` grouping through the one shared `Intl.NumberFormat` instance below.
 * - Units: durations are always plain milliseconds. The `Ms` suffix is the unit contract.
 *
 * Missing or unusable input returns `null` rather than a string, so each caller chooses a
 * field-specific missing-state label instead of collapsing missing into zero.
 */

const groupedCountFormatter = new Intl.NumberFormat("en-US");
const windowWidthFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const millisecondsPerSecond = 1_000;
const secondsPerMinute = 60;
const minutesPerHour = 60;
/** At or above this many seconds a bare seconds reading stops being easy to read. */
const minuteTierThresholdSeconds = 120;
/**
 * At one hour the next unit takes over. The seconds tier runs to 119 s rather than 59 s because a
 * two-digit seconds reading stays legible; a three-digit minutes reading ("6,000 min") does not.
 */
const hourTierThresholdSeconds = secondsPerMinute * minutesPerHour;
const utcSuffix = "UTC";

export interface FormatInstantOptions {
  /**
   * `full` renders `2026-08-03 14:32:05 UTC`.
   * `timeOnly` renders `14:32:05 UTC` and is only correct where adjacent context already
   * fixes the calendar date (for example a series of samples inside one dated run).
   */
  variant?: "full" | "timeOnly";
}

/**
 * Formats an ISO 8601 instant as labelled UTC.
 *
 * The calendar and clock parts are assembled from the UTC accessors rather than
 * `Intl.DateTimeFormat` so the output cannot vary with the host timezone or the ICU data
 * bundled with a given runtime. That determinism is the reason this policy exists.
 */
export function formatInstantUtc(
  value: string | null | undefined,
  options: FormatInstantOptions = {},
): string | null {
  if (typeof value !== "string") return null;
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) return null;

  const instant = new Date(epochMs);
  const clock = `${padTwo(instant.getUTCHours())}:${padTwo(instant.getUTCMinutes())}:${padTwo(
    instant.getUTCSeconds(),
  )}`;

  if (options.variant === "timeOnly") {
    return `${clock} ${utcSuffix}`;
  }

  const calendarDate = `${instant.getUTCFullYear().toString().padStart(4, "0")}-${padTwo(
    instant.getUTCMonth() + 1,
  )}-${padTwo(instant.getUTCDate())}`;

  return `${calendarDate} ${clock} ${utcSuffix}`;
}

/**
 * Formats an elapsed interval given in milliseconds at human precision.
 *
 * - below one second: whole milliseconds (`847 ms`)
 * - at or above one second: seconds with at most one decimal, trailing `.0` dropped
 *   (`28.4 s`, `12 s`)
 * - at or above two minutes: minutes and seconds (`2 min 8 s`)
 * - at or above one hour: hours and minutes (`1 h 0 min`, `100 h 0 min`)
 *
 * Rounding is half-up and happens before the tier is chosen, so `999.5` reads `1 s`.
 * This formatter says how long something took; it never says which boundaries were measured.
 * Callers keep the measurement name next to the value.
 */
export function formatDurationMs(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;

  // `Math.round` preserves negative zero, and `Intl.NumberFormat` renders that as `-0`.
  const wholeMilliseconds = withoutNegativeZero(Math.round(value));
  if (wholeMilliseconds < millisecondsPerSecond) {
    return `${groupedCountFormatter.format(wholeMilliseconds)} ms`;
  }

  const seconds = wholeMilliseconds / millisecondsPerSecond;
  const secondsToOneDecimal = Math.round(seconds * 10) / 10;
  if (secondsToOneDecimal < minuteTierThresholdSeconds) {
    return `${groupedCountFormatter.format(secondsToOneDecimal)} s`;
  }

  const wholeSeconds = Math.round(seconds);
  if (wholeSeconds < hourTierThresholdSeconds) {
    const minutes = Math.floor(wholeSeconds / secondsPerMinute);
    const remainderSeconds = wholeSeconds % secondsPerMinute;

    return `${minutes} min ${remainderSeconds} s`;
  }

  const wholeMinutes = Math.round(wholeSeconds / secondsPerMinute);
  const hours = Math.floor(wholeMinutes / minutesPerHour);
  const remainderMinutes = wholeMinutes % minutesPerHour;

  return `${groupedCountFormatter.format(hours)} h ${remainderMinutes} min`;
}

/**
 * Formats a count or other numeric summary with the shared grouping policy.
 * Admin hard caps use this too, so a cap of 100000 reads `100,000` like every other count.
 *
 * A fractional input stays fractional. That is deliberate rather than an oversight of the name:
 * the reservation-timing histogram bucket edges are declared in fractional milliseconds
 * (`0.25, 0.5, 0.75, 1, 2, 5, …`) and `transport-observation.tsx` renders those edges through
 * this formatter as `≤ 0.25ms`. Rounding here to whole numbers would turn that bound into
 * `≤ 0ms` on public run-history surfaces. Anything that needs a fixed decimal rule — a rate, a
 * ratio, a percentage — must state its own `maximumFractionDigits` instead of inheriting this
 * formatter's default.
 */
export function formatCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  return groupedCountFormatter.format(withoutNegativeZero(value));
}

/**
 * Formats the numeric part of a configured observation-window width, in seconds.
 *
 * A window width is a declared parameter, not an elapsed measurement: widths are read against
 * one another ("trailing 60s" versus "trailing 300s") and must stay in one fixed unit, so they
 * are a sanctioned exemption from the tiered duration policy. Callers append the unit in the
 * grammatical form their sentence needs (`60s` as a value, `60-second` as an adjective), which
 * is the only difference between the two surfaces that render window widths.
 */
export function formatWindowSeconds(seconds: number): string {
  return windowWidthFormatter.format(seconds);
}

/**
 * The adjective form of a window width (`60-second windows`), as opposed to the bare value form
 * `formatWindowSeconds` returns (`60s`). It lives here rather than being concatenated at each call
 * site so the three surfaces that describe a window this way cannot drift apart.
 */
export function formatWindowSecondsAdjective(seconds: number): string {
  return `${formatWindowSeconds(seconds)}-second`;
}

function padTwo(value: number): string {
  return value.toString().padStart(2, "0");
}

/** `-0` is a zero reading. Only its rendering ("-0") would suggest otherwise. */
function withoutNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
