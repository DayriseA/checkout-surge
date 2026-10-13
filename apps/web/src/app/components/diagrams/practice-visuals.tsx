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
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`size-2.5 rounded-full ${className}`} />
      {label}
    </span>
  );
}

/** V5: who reaches the database, with and without the stock decided in memory. */
export function StockDecisionDots() {
  const buyersPerDot = flashSale.buyers / dotCount;
  const winnerDots = flashSale.units / buyersPerDot;
  const [withRedis, withoutRedis] = redisComparison.cold.runLabels;
  const rows = [
    {
      label: withRedis,
      reachingDatabase: winnerDots,
      summary: `${dotCount - winnerDots} stop in memory with “sold out”; ${winnerDots} reach the database`,
    },
    {
      label: withoutRedis,
      reachingDatabase: dotCount,
      summary: `All ${dotCount} reach the database`,
    },
  ];
  return (
    <DiagramFigure
      caption={`The Redis comparison's ${formatFigure(flashSale.buyers, "count")} buyers, one dot per ${buyersPerDot}. With Redis, the buyers turned away are answered from memory, and only the ${formatFigure(flashSale.units, "count")} winners reach the database. With the stock in PostgreSQL, every buyer does, if only for a quick read.`}
    >
      <div className="grid gap-5">
        {rows.map((row) => (
          <div className="grid gap-2" key={row.label}>
            <p className="m-0 text-sm leading-5">
              <strong className="text-ink">{row.label}:</strong>{" "}
              <span className="text-muted-strong">{row.summary}</span>
            </p>
            <DotGrid reachingDatabase={row.reachingDatabase} />
          </div>
        ))}
        <p className="m-0 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-strong">
          <Legend className="bg-signal" label="Answered from memory" />
          <Legend className="bg-accent" label="Reaches the database" />
        </p>
      </div>
    </DiagramFigure>
  );
}

/** V6: who waits for the back office, with and without the order queue. */
export function WhoWaitsDiagram() {
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
      caption={`Who waits for the back office, in the queue comparison (medians of measured runs). Same ${formatFigure(ordersConfirmed, "count")} orders and the same back-office pace in both runs, so the back office takes as long either way. With the queue, buyers have their answer long before. Without it, winners wait for their turn at the back office.`}
    >
      <div className="grid gap-5">
        {runs.map((run) => (
          <div className="grid gap-2" key={run.label}>
            <p className="m-0 text-sm font-semibold text-ink">{run.label}</p>
            <Lane
              barClassName="bg-accent"
              label="Every buyer has an answer within"
              scaleSeconds={scaleSeconds}
              seconds={run.buyers}
            />
            <Lane
              barClassName="bg-signal"
              label="The back office confirms the slowest order after"
              scaleSeconds={scaleSeconds}
              seconds={run.backOffice}
            />
          </div>
        ))}
        <p className="m-0 flex justify-between text-xs text-muted" aria-hidden="true">
          <span>0 s</span>
          <span>{scaleSeconds} s</span>
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
  return (
    <div className="grid gap-0.5">
      <p className="m-0 text-xs text-muted-strong">
        {label} <strong className="text-ink">{formatFigure(seconds, "seconds")}</strong>
      </p>
      <Bar className={barClassName} share={seconds / scaleSeconds} />
    </div>
  );
}
