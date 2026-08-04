import { formatDurationMs } from "./format";

/**
 * Overall run duration, derived once and consumed by both the history list and the history
 * detail so the same run cannot report two different elapsed times.
 *
 * Authoritative boundary (chosen from the timestamps the public contracts actually carry):
 * - start: `startedAt`, the run acceptance timestamp recorded when the demo run row is created.
 * - end: the terminal finalization timestamp. On a run history summary that is `endedAt`, which
 *   the API writes from the run's `finalizedAt` when the terminal transition is claimed; on a
 *   public run detail the same instant is exposed as `run.finalizedAt`.
 *
 * The pair spans the whole lifecycle, including drain and finalization, which is what "how long
 * did this run take" means. It is deliberately NOT the traffic window
 * (`trafficStartedAt`/`trafficEndedAt`), which answers a narrower question, and never the
 * configured maximum dispatch time, which is a guard rather than an observation.
 *
 * A run whose lifecycle boundaries are not both recorded has no duration. It is never rendered
 * as zero, and it is never back-filled from another interval.
 *
 * Structural note: `no-recorded-end` is unreachable from today's two consumers, because `endedAt`
 * is a required field on both `demoRunSummaryShapeSchema` (`packages/contracts/src/entities.ts`)
 * and `publicRunHistorySummarySchema` (`packages/contracts/src/demo.ts`). The rule that a failed or
 * interrupted run receives no fabricated duration is therefore currently guaranteed by those
 * schemas rather than by this module. The branch and its test are kept deliberately: if either
 * schema is ever relaxed to admit a run without a terminal timestamp, this is the code that has to
 * catch it, and a zero would otherwise appear on a public surface.
 */
export type RunDurationState =
  | "measured"
  | "no-recorded-start"
  | "no-recorded-end"
  | "unusable-boundary";

export interface RunLifecycleBoundary {
  startedAt?: string | null | undefined;
  endedAt?: string | null | undefined;
}

export interface OverallRunDuration {
  /**
   * Which boundary rule applied. Kept alongside the text because the rule, not the reading, is
   * what a caller must be able to branch on and what the lifecycle tests assert.
   */
  state: RunDurationState;
  /** Ready-to-render text. Missing boundaries name the reason instead of showing a zero. */
  text: string;
}

const absenceText: Record<Exclude<RunDurationState, "measured">, string> = {
  "no-recorded-start": "— no recorded start",
  "no-recorded-end": "— no recorded end",
  "unusable-boundary": "— unusable lifecycle boundary",
};

export function deriveOverallRunDuration(boundary: RunLifecycleBoundary): OverallRunDuration {
  const startedMs = parseInstant(boundary.startedAt);
  const endedMs = parseInstant(boundary.endedAt);

  if (startedMs === null) return absent("no-recorded-start");
  if (endedMs === null) return absent("no-recorded-end");

  const durationMs = endedMs - startedMs;
  const text = durationMs < 0 ? null : formatDurationMs(durationMs);
  if (text === null) return absent("unusable-boundary");

  return { state: "measured", text };
}

function parseInstant(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const epochMs = Date.parse(value);

  return Number.isFinite(epochMs) ? epochMs : null;
}

function absent(state: Exclude<RunDurationState, "measured">): OverallRunDuration {
  return { state, text: absenceText[state] };
}
