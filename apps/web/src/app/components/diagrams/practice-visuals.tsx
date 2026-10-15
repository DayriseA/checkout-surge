"use client";

import { useLocale, useTranslation } from "../../lib/i18n/locale-context";
import {
  flashSale,
  formatFigure,
  queueComparison,
  redisComparison,
} from "../../lib/presentation/measured-figures";
import { Bar, DiagramFigure } from "./primitives";

const dotCount = 100;
const dotsPerRow = 20;

/** 100 dots; the last `reachingDatabase` reach the database, the others stop in memory. */
function DotGrid({ reachingDatabase }: { reachingDatabase: number }) {
  return (
    <svg
      aria-hidden="true"
      className="h-auto w-full max-w-[28rem]"
      viewBox={`0 0 ${dotsPerRow * 10} ${(dotCount / dotsPerRow) * 10}`}
    >
      {Array.from({ length: dotCount }, (_, index) => (
        <circle
          cx={5 + (index % dotsPerRow) * 10}
          cy={5 + Math.floor(index / dotsPerRow) * 10}
          fill={
            index >= dotCount - reachingDatabase ? "var(--color-accent)" : "var(--color-signal)"
          }
          // biome-ignore lint/suspicious/noArrayIndexKey: A fixed decorative sequence.
          key={index}
          r="3.6"
        />
      ))}
    </svg>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  const t = useTranslation();

  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`size-2.5 rounded-full ${className}`} />
      {t(label)}
    </span>
  );
}

/** V5: who reaches the database, with and without the stock decided in memory. */
export function StockDecisionDots() {
  const locale = useLocale();

  const t = useTranslation();

  const buyersPerDot = flashSale.buyers / dotCount;
  const winnerDots = flashSale.units / buyersPerDot;
  const [withRedis, withoutRedis] = redisComparison.cold.runLabels;
  const rows = [
    {
      label: withRedis,
      reachingDatabase: winnerDots,
      summary: t("{memory} stop in memory with “sold out”; {database} reach the database", {
        memory: dotCount - winnerDots,
        database: winnerDots,
      }),
    },
    {
      label: withoutRedis,
      reachingDatabase: dotCount,
      summary: t("All {buyers} reach the database", { buyers: dotCount }),
    },
  ];
  return (
    <DiagramFigure
      caption={t(
        "The Redis comparison's {value0} buyers, one dot per {value1}. With Redis, the buyers turned away are answered from memory, and only the {value2} winners reach the database. With the stock in PostgreSQL, every buyer does, if only for a quick read.",
        {
          value0: formatFigure(flashSale.buyers, "count", locale),
          value1: buyersPerDot,
          value2: formatFigure(flashSale.units, "count", locale),
        },
      )}
    >
      <div className="grid gap-5">
        {rows.map((row) => (
          <div className="grid gap-2" key={t(row.label)}>
            <p className="m-0 text-sm leading-5">
              <strong className="text-ink">
                {t(row.label)}
                {t(": ").trimEnd()}
              </strong>{" "}
              <span className="text-muted-strong">{row.summary}</span>
            </p>
            <DotGrid reachingDatabase={row.reachingDatabase} />
          </div>
        ))}
        <p className="m-0 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-strong">
          <Legend className="bg-signal" label={t("Answered from memory")} />
          <Legend className="bg-accent" label={t("Reaches the database")} />
        </p>
      </div>
    </DiagramFigure>
  );
}

/** V6: who waits for the back office, with and without the order queue. */
export function WhoWaitsDiagram() {
  const locale = useLocale();

  const t = useTranslation();

  const { everyBuyerAnswered, slowestOrder, runLabels, ordersConfirmed } = queueComparison;
  const runs = [
    { label: runLabels[0], buyers: everyBuyerAnswered.first[0], backOffice: slowestOrder.first[0] },
    {
      label: runLabels[1],
      buyers: everyBuyerAnswered.second[0],
      backOffice: slowestOrder.second[0],
    },
  ];
  const scaleSeconds = Math.ceil(Math.max(...runs.map((run) => run.buyers)) / 10) * 10;
  return (
    <DiagramFigure
      caption={t(
        "Who waits for the back office, in the queue comparison (medians of measured runs). Same {value0} orders and the same back-office pace in both runs, so the back office takes as long either way. With the queue, buyers have their answer long before. Without it, winners wait for their turn at the back office.",
        { value0: formatFigure(ordersConfirmed, "count", locale) },
      )}
    >
      <div className="grid gap-5">
        {runs.map((run) => (
          <div className="grid gap-2" key={t(run.label)}>
            <p className="m-0 text-sm font-semibold text-ink">{t(run.label)}</p>
            <Lane
              barClassName="bg-accent"
              label={t("Every buyer has an answer within")}
              scaleSeconds={scaleSeconds}
              seconds={run.buyers}
            />
            <Lane
              barClassName="bg-signal"
              label={t("The back office confirms the slowest order after")}
              scaleSeconds={scaleSeconds}
              seconds={run.backOffice}
            />
          </div>
        ))}
        <p className="m-0 flex justify-between text-xs text-muted" aria-hidden="true">
          <span>{t("0 s")}</span>
          <span>
            {scaleSeconds}
            {t(" s")}
          </span>
        </p>
      </div>
    </DiagramFigure>
  );
}

function Lane({
  barClassName,
  label,
  scaleSeconds,
  seconds,
}: {
  barClassName: string;
  label: string;
  scaleSeconds: number;
  seconds: number;
}) {
  const locale = useLocale();

  const t = useTranslation();

  return (
    <div className="grid gap-0.5">
      <p className="m-0 text-xs text-muted-strong">
        {t(label)} <strong className="text-ink">{formatFigure(seconds, "seconds", locale)}</strong>
      </p>
      <Bar className={barClassName} share={seconds / scaleSeconds} />
    </div>
  );
}
