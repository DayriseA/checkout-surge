"use client";

import type { SignalHeadlines } from "../lib/presentation/signal-headlines";
import { type GoldSignalChart, type GoldSignalKey, SignalSparkline } from "./gold-signals";
import { RevealAdvancedLink } from "./page-view";

const stripSignals: Array<{ chart: GoldSignalKey; targetId: string; title: string }> = [
  { chart: "arrival", targetId: "watch-signal-arrival", title: "Arrivals" },
  { chart: "inventory", targetId: "watch-signal-inventory", title: "Units left" },
  { chart: "backlog", targetId: "watch-signal-backlog", title: "Backlog" },
  { chart: "confirmation", targetId: "watch-signal-confirmation", title: "Confirmations" },
];

const fallbackTargetId = "watch-advanced-signals";

/**
 * The Basic Watch signal strip: the same four timelines the full Advanced charts plot, reduced
 * to sparklines with each headline value as caption and a text equivalent. Every tile is a
 * contextual link that switches this page to Advanced and focuses that signal's full chart.
 * When no chart evidence exists at all the full charts render their shared empty state, so the
 * tiles target the focusable Signals group instead of a chart that is not on the page. Missing
 * evidence renders the lifecycle-aware absence caption, never a flat zero line.
 */
export function WatchSignalStrip({
  charts,
  hasEvidence,
  headlines,
}: {
  charts: Record<GoldSignalKey, GoldSignalChart>;
  hasEvidence: boolean;
  headlines: SignalHeadlines;
}) {
  return (
    <div className="grid grid-cols-4 gap-3 max-[700px]:grid-cols-2" data-watch-signals="">
      {stripSignals.map(({ chart, targetId, title }) => (
        <RevealAdvancedLink
          className="block rounded-lg border border-border bg-surface-muted p-2 text-left"
          key={chart}
          targetId={hasEvidence ? targetId : fallbackTargetId}
        >
          <span className="block text-xs font-bold text-muted">{title}</span>
          <SignalSparkline
            ariaLabel={`${title} sparkline`}
            area={charts[chart].area}
            markers={[]}
            points={charts[chart].points}
            secondary={charts[chart].secondary}
            xMax={charts[chart].xMax}
          />
          <span className="mt-1 block text-xs font-semibold leading-5 text-muted-strong">
            {headlines[chart].value}
          </span>
          <span className="sr-only">{`${title} over the run: ${headlines[chart].value}`}</span>
        </RevealAdvancedLink>
      ))}
    </div>
  );
}
