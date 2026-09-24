"use client";

import type { SignalHeadlines } from "../lib/presentation/signal-headlines";
import { type GoldSignalChart, type GoldSignalKey, SignalSparkline } from "./gold-signals";

const stripSignals: Array<{ chart: GoldSignalKey; targetId: string; title: string }> = [
  { chart: "arrival", targetId: "watch-signal-arrival", title: "Arrivals" },
  { chart: "inventory", targetId: "watch-signal-inventory", title: "Units left" },
  { chart: "backlog", targetId: "watch-signal-backlog", title: "Backlog" },
  { chart: "confirmation", targetId: "watch-signal-confirmation", title: "Confirmations" },
];

const fallbackTargetId = "watch-advanced-signals";

/**
 * The compact Watch signal strip: the same four timelines the full charts plot, reduced
 * to sparklines with each headline value as caption and a text equivalent. Every tile is a
 * contextual button that reveals and focuses that signal's detailed section. When those sections
 * are not rendered (a finished run without chart evidence shows the full charts' shared empty
 * state), the tiles target the focusable Signals group instead. Missing
 * evidence renders the lifecycle-aware absence caption, never a flat zero line.
 */
export function WatchSignalStrip({
  charts,
  chartTargetsRendered,
  headlines,
  onReveal,
}: {
  charts: Record<GoldSignalKey, GoldSignalChart>;
  chartTargetsRendered: boolean;
  headlines: SignalHeadlines;
  onReveal: (targetId: string) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-2 max-[700px]:grid-cols-2" data-watch-signals="">
      {stripSignals.map(({ chart, targetId, title }) => (
        <button
          className="block cursor-pointer rounded-xl border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent [&_svg]:h-14"
          key={chart}
          onClick={() => onReveal(chartTargetsRendered ? targetId : fallbackTargetId)}
          type="button"
        >
          <span className="block text-xs font-medium text-muted">{title}</span>
          <SignalSparkline
            ariaLabel={`${title} sparkline`}
            area={charts[chart].area}
            points={charts[chart].points}
            secondary={charts[chart].secondary}
            xMax={charts[chart].xMax}
          />
          <span className="mt-1 block text-xs font-semibold leading-5 text-ink">
            {headlines[chart].summaryValue}
          </span>
          <span className="sr-only">{`${title} over the run: ${headlines[chart].summaryValue}`}</span>
        </button>
      ))}
    </div>
  );
}
