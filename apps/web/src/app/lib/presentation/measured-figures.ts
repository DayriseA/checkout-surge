/**
 * Every figure the content pages quote, in one place. They are measurements of the hosted demo
 * or of its proof copy (same Machines and sizes), quoted as text and never read from the API.
 * Refresh them after a measurement that supersedes them.
 */

/** The Surge 10k preset that the pages use as their example of a flash sale. */
export const flashSale = { buyers: 10_000, units: 500, backOfficePerSecond: 20 } as const;

/** Measured on the hosted demo, a few runs each. */
export const hostedMeasurements = {
  soldOutRate: "3,500",
  acceptedRate: "240",
  spikeRate: "2,600",
  surge10kP95: "between about 8 and 14 seconds",
  wakeSeconds: 15,
} as const;

/** The hosted Machines' sizes, as configured under `infra/fly/` (core `guest`, runner `RUNNER_*`). */
export const hostingSizes = {
  core: "6 dedicated vCPUs and 12 GB",
  runner: "8 dedicated vCPUs and 16 GB",
} as const;

export type FigureFormat = "seconds" | "count" | "pace";

/** A figure across the measured pairs: the median, then the lowest and highest value. */
export type Spread = readonly [median: number, min: number, max: number];

/** One figure of a comparison, for its first run (the demo as built) and its second run. */
export interface PairedFigure {
  label: string;
  format: FigureFormat;
  first: Spread;
  second: Spread;
}

export interface ComparisonMeasurement {
  /** How the pairs were measured, in one sentence. */
  method: string;
  /** The two runs, in their fixed order. */
  runLabels: readonly [string, string];
}

const queueRuns = ["With the order queue", "Without the order queue"] as const;
const redisRuns = ["With Redis", "Stock and order queue in PostgreSQL"] as const;

interface QueueFigures extends ComparisonMeasurement {
  ordersConfirmed: number;
  everyBuyerAnswered: PairedFigure;
  winnersP95: PairedFigure;
  winnersAverage: PairedFigure;
  erpPace: PairedFigure;
  slowestOrder: PairedFigure;
}

/** Queue comparison: 4 pairs after a warm-up pair (the warm-up pair fell in the same ranges). */
export const queueComparison: QueueFigures = {
  method: "Median of 4 measured pairs on a copy of this demo, after a warm-up pair (October 2026).",
  runLabels: queueRuns,
  ordersConfirmed: 500,
  everyBuyerAnswered: {
    label: "Every buyer had an answer within",
    format: "seconds",
    first: [4.83, 4.7, 5.07],
    second: [27.34, 26.99, 28.49],
  },
  winnersP95: {
    label: "Winners' time to an answer, 95th percentile",
    format: "seconds",
    first: [3.23, 2.95, 3.37],
    second: [26.07, 25.78, 26.93],
  },
  winnersAverage: {
    label: "Winners' time to an answer, average",
    format: "seconds",
    first: [2.02, 1.75, 2.14],
    second: [14.15, 13.75, 14.54],
  },
  erpPace: {
    label: "Back office's pace (limit 20 per second)",
    format: "pace",
    first: [18.1, 18.0, 18.3],
    second: [18.3, 17.6, 18.5],
  },
  slowestOrder: {
    label: "Slowest order, from secured to confirmed",
    format: "seconds",
    first: [27.1, 27.0, 27.3],
    second: [27.0, 25.8, 28.1],
  },
};

interface RedisFigures extends ComparisonMeasurement {
  transactions: PairedFigure;
  timeInQueries: PairedFigure;
  postgresCpu: PairedFigure;
  turnedAwayWait: PairedFigure;
  winnersWait: PairedFigure;
  everyBuyerAnswered: PairedFigure;
}

const redisLabels = {
  transactions: "Database transactions while selling",
  timeInQueries: "Time in database queries, waits for the stock row included",
  postgresCpu: "Database CPU time",
  turnedAwayWait: "Turned-away buyers' time to an answer, average",
  winnersWait: "Winners' time to an answer, average",
  everyBuyerAnswered: "Every buyer had an answer within",
} as const;

function redisFigures(
  method: string,
  values: Record<keyof typeof redisLabels, [Spread, Spread]>,
): RedisFigures {
  const figure = (key: keyof typeof redisLabels): PairedFigure => ({
    label: redisLabels[key],
    format: key === "transactions" ? "count" : "seconds",
    first: values[key][0],
    second: values[key][1],
  });
  return {
    method,
    runLabels: redisRuns,
    transactions: figure("transactions"),
    timeInQueries: figure("timeInQueries"),
    postgresCpu: figure("postgresCpu"),
    turnedAwayWait: figure("turnedAwayWait"),
    winnersWait: figure("winnersWait"),
    everyBuyerAnswered: figure("everyBuyerAnswered"),
  };
}

/**
 * Redis comparison, 4 pairs each. The pages quote the cold pairs, each the first comparison after
 * the demo woke up, as a visitor's first comparison usually is: they show the smaller gap.
 */
export const redisComparison = {
  cold: redisFigures(
    "Median of 4 measured pairs on a copy of this demo, each the first comparison after it woke up (October 2026).",
    {
      transactions: [
        [4541, 4380, 4735],
        [11913, 11189, 12692],
      ],
      timeInQueries: [
        [7.2, 7.0, 7.7],
        [36.6, 32.3, 47.7],
      ],
      postgresCpu: [
        [10.7, 10.3, 11.0],
        [20.9, 17.1, 26.5],
      ],
      turnedAwayWait: [
        [6.3, 6.3, 6.4],
        [8.7, 7.4, 11.9],
      ],
      winnersWait: [
        [2.6, 2.5, 2.9],
        [2.5, 2.4, 3.2],
      ],
      everyBuyerAnswered: [
        [9.3, 8.9, 9.4],
        [11.5, 9.8, 14.0],
      ],
    },
  ),
  warm: redisFigures(
    "Median of 4 measured pairs on a copy of this demo, each right after a cold pair (October 2026).",
    {
      transactions: [
        [3987, 3421, 4274],
        [11979, 11518, 12602],
      ],
      timeInQueries: [
        [4.2, 3.7, 4.9],
        [29.1, 27.0, 30.2],
      ],
      postgresCpu: [
        [7.9, 7.1, 8.2],
        [12.9, 11.8, 14.3],
      ],
      turnedAwayWait: [
        [4.2, 4.1, 4.6],
        [5.5, 5.2, 5.8],
      ],
      winnersWait: [
        [2.3, 2.1, 2.7],
        [2.3, 2.2, 2.5],
      ],
      everyBuyerAnswered: [
        [6.5, 6.2, 6.8],
        [7.4, 6.9, 7.7],
      ],
    },
  ),
} as const;

/** The method label of the home page's figures, which quote both comparisons' first figures. */
export const comparisonFiguresNote =
  "Medians of 4 measured pairs per comparison on a copy of this demo (October 2026); each Redis pair was the first comparison after the demo woke up. Your run will differ a little.";

/** The PostgreSQL order queue's drain against BullMQ's, over whole Redis comparison runs. */
export const postgresQueueDrain = { postgres: 15.5, bullmq: 17.7 } as const;

const countFormat = new Intl.NumberFormat("en-US");
const decimalFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatFigure(value: number, format: FigureFormat): string {
  switch (format) {
    case "count":
      return countFormat.format(value);
    case "seconds":
      return `${decimalFormat.format(value)} s`;
    case "pace":
      return `${decimalFormat.format(value)} per second`;
  }
}

/** "4.7–5.1 s": the lowest and highest value across the measured pairs. */
export function formatRange([, min, max]: Spread, format: FigureFormat): string {
  const unitless = format === "count" ? countFormat.format(min) : decimalFormat.format(min);
  return `${unitless}–${formatFigure(max, format)}`;
}
