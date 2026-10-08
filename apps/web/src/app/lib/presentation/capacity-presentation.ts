import {
  type CapacityAssessment,
  k6GracefulStopSeconds,
  k6RequestTimeoutSeconds,
  type TrafficConfig,
} from "@checkout-surge/contracts";
import { formatCount } from "./format";

type ConstantArrivalCapacity = Extract<CapacityAssessment, { mode: "constant-arrival-rate" }>;
type BuyerSpikeCapacity = Extract<CapacityAssessment, { mode: "buyer-spike" }>;

const refusalHeadlines = {
  at_the_limit:
    "This run is too close to the demo server's limit to be sure every buyer gets an answer in time.",
  expected_to_fail: "This run is too heavy for the demo's server.",
} as const;
const serverExplanation =
  "A single API process answers every buyer, and each unit sold is first written to the database, which is much slower.";
const largerRuns = "run the project locally or on larger infrastructure";
const secondsFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** The public refusal of a custom run that is not expected to complete. */
export function capacityRefusalCopy(capacity: CapacityAssessment): string[] {
  return [
    capacity.mode === "constant-arrival-rate"
      ? constantArrivalRefusal(capacity)
      : buyerSpikeRefusal(capacity),
  ];
}

/** The admin warning before confirming a run that is at the limit or expected to fail. */
export function capacityWarningCopy(capacity: CapacityAssessment): string[] {
  if (capacity.verdict === "expected_to_complete") return [];
  return capacity.mode === "constant-arrival-rate"
    ? constantArrivalWarning(capacity)
    : buyerSpikeWarning(capacity);
}

/**
 * The admin warning for explicit VUs pre-allocating fewer than the deployment would for the
 * rate: VUs added during the run come too late for the start's latency jump.
 */
export function explicitVusWarning(
  trafficConfig: TrafficConfig,
  automaticVus: number | null,
): string | null {
  if (trafficConfig.mode !== "constant-arrival-rate" || !trafficConfig.k6Vus) return null;
  if (automaticVus === null || trafficConfig.k6Vus.preAllocatedVus >= automaticVus) return null;
  return `These virtual users are fewer than this deployment would allocate for this rate (${formatCount(automaticVus)}); requests may never be sent.`;
}

function constantArrivalRefusal(capacity: ConstantArrivalCapacity): string {
  const maxRate = capacity.fit?.ratePerSecond ?? null;
  const maxStock = stockRemedy(capacity);
  const stockMention =
    maxStock === null ? "" : ` with ${counted(capacity.startingStock, "unit")} in stock`;
  const outcome =
    capacity.verdict === "at_the_limit"
      ? `the run would use ${Math.round((capacity.loadPerSecond / capacity.capacityPerSecond) * 100)}% of what the server can sustain`
      : "the server would fall behind and some buyers would not get their answer in time";
  const fits = present([
    maxRate === null
      ? null
      : `keeping this stock and duration, the rate can go up to ${counted(maxRate, "request")} per second`,
    maxStock === null
      ? null
      : `keeping this rate, the stock can go up to ${counted(maxStock, "unit")}`,
  ]);
  const levers = present([
    maxRate === null ? null : "the rate",
    maxStock === null ? null : "the stock",
  ]);
  return sentences(
    refusalHeadlines[capacity.verdict === "at_the_limit" ? "at_the_limit" : "expected_to_fail"],
    serverExplanation,
    `At ${counted(capacity.ratePerSecond, "request")} per second for ${counted(capacity.durationSeconds, "second")}${stockMention}, ${outcome}.`,
    fits.length === 0 ? null : capitalized(`${fits.join("; ")}.`),
    levers.length === 0
      ? capitalized(`${largerRuns}.`)
      : `Lower ${levers.join(" or ")}, or ${largerRuns}.`,
  );
}

function buyerSpikeRefusal(capacity: BuyerSpikeCapacity): string {
  const maxBuyers = capacity.fit?.buyerCount ?? null;
  const fewerBuyers = maxBuyers === null ? null : `the buyers to ${formatCount(maxBuyers)}`;
  let remedy: string | null;
  if (isRequestTimeoutBound(capacity)) {
    const maxStock = stockRemedy(capacity);
    const lower = present([
      fewerBuyers,
      maxStock === null ? null : `the stock to ${counted(maxStock, "unit")}`,
    ]);
    remedy = lower.length === 0 ? null : `Lower ${lower.join(" or ")}.`;
  } else {
    const minCutoff = capacity.fit?.maxDurationSeconds ?? null;
    const remedies = present([
      minCutoff === null ? null : `raise the safety cutoff to ${counted(minCutoff, "second")}`,
      fewerBuyers === null ? null : `lower ${fewerBuyers}`,
    ]).join(", or ");
    remedy = remedies === "" ? null : capitalized(`${remedies}.`);
  }
  const atTheLimit = capacity.verdict === "at_the_limit";
  return sentences(
    refusalHeadlines[atTheLimit ? "at_the_limit" : "expected_to_fail"],
    serverExplanation,
    `With ${counted(capacity.buyerCount, "buyer")} and ${counted(capacity.startingStock, "unit")}, this server needs about ${seconds(capacity.timeToServeSeconds)} to answer everyone, ${atTheLimit ? "too close to" : "more than"} ${spikeWindow(capacity)}.`,
    remedy,
  );
}

function constantArrivalWarning(capacity: ConstantArrivalCapacity): string[] {
  const load = Math.round(capacity.loadPerSecond);
  const maxRate = capacity.fit?.ratePerSecond ?? null;
  const maxStock = stockRemedy(capacity);
  const expected = expectedToComplete([
    maxRate === null ? null : `up to ${formatCount(maxRate)} per second`,
    maxStock === null ? null : `up to ${counted(maxStock, "unit")}`,
  ]);
  if (capacity.verdict === "at_the_limit")
    return [
      sentences(
        `Near this deployment's capacity: the run asks about ${formatCount(load)} answers per second, ${Math.round((load / capacity.capacityPerSecond) * 100)} % of the ${formatCount(capacity.capacityPerSecond)} one API process gives here.`,
        "It may complete, with little margin.",
        expected,
      ),
    ];
  const lines: string[] = [];
  if (capacity.loadPerSecond > capacity.capacityPerSecond)
    lines.push(
      `Beyond this deployment's capacity: about ${formatCount(load)} answers per second against ${formatCount(capacity.capacityPerSecond)}. Expect a failed delivery: requests never sent at the virtual-user limit, or answers arriving too late.`,
    );
  if (capacity.acceptedOrders > capacity.poolOrderLimit)
    lines.push(
      `The database pool can answer about ${formatCount(Math.floor(capacity.poolOrderLimit))} orders before the load generator stops listening, ${k6GracefulStopSeconds} seconds after its sending window closes; this run would sell ${formatCount(capacity.acceptedOrders)}. Their answers would arrive too late.`,
    );
  return withExpected(lines, expected);
}

function buyerSpikeWarning(capacity: BuyerSpikeCapacity): string[] {
  const timeoutBound = isRequestTimeoutBound(capacity);
  const minCutoff = timeoutBound ? null : (capacity.fit?.maxDurationSeconds ?? null);
  const maxBuyers = capacity.fit?.buyerCount ?? null;
  const maxStock = stockRemedy(capacity);
  const sizes = present([
    maxBuyers === null ? null : counted(maxBuyers, "buyer"),
    maxStock === null ? null : counted(maxStock, "unit"),
  ]);
  const expected = expectedToComplete([
    minCutoff === null ? null : `a safety cutoff of ${counted(minCutoff, "second")}`,
    sizes.length === 0 ? null : `up to ${sizes.join(" or ")}`,
  ]);
  const time = seconds(capacity.timeToServeSeconds);
  if (capacity.verdict === "at_the_limit")
    return [
      sentences(
        `Near this deployment's capacity: about ${time} to answer, ${Math.round((capacity.timeToServeSeconds / capacity.windowSeconds) * 100)} % of ${spikeWindow(capacity)}.`,
        "It may complete, with little margin.",
        expected,
      ),
    ];
  return [
    sentences(
      timeoutBound
        ? `About ${time} to answer, longer than the ${k6RequestTimeoutSeconds} seconds the load generator waits: late buyers would end in transport failure.`
        : `Beyond this deployment's capacity: about ${time} to answer, more than ${spikeWindow(capacity)}. Expect a failed delivery: answers arriving too late, or requests never sent before the cutoff.`,
      expected,
    ),
  ];
}

/** Past k6's request timeout, no safety cutoff helps: the generator gives up on the answer. */
function isRequestTimeoutBound(capacity: BuyerSpikeCapacity): boolean {
  return capacity.windowSeconds >= k6RequestTimeoutSeconds;
}

function spikeWindow(capacity: BuyerSpikeCapacity): string {
  return isRequestTimeoutBound(capacity)
    ? `the ${k6RequestTimeoutSeconds} seconds the load generator waits for an answer`
    : `the ${formatCount(capacity.windowSeconds)}-second safety cutoff`;
}

/** Less stock is a remedy only when the run fits with fewer units, still selling at least one. */
function stockRemedy(capacity: CapacityAssessment): number | null {
  const stock = capacity.fit?.startingStock ?? null;
  return stock !== null && stock > 0 ? stock : null;
}

function expectedToComplete(options: (string | null)[]): string | null {
  const remaining = present(options);
  return remaining.length === 0 ? null : `Expected to complete: ${remaining.join(", or ")}.`;
}

function withExpected(lines: string[], expected: string | null): string[] {
  if (expected === null) return lines;
  const last = lines.pop();
  return [...lines, last === undefined ? expected : `${last} ${expected}`];
}

function present(parts: (string | null)[]): string[] {
  return parts.filter((part) => part !== null);
}

function sentences(...parts: (string | null)[]): string {
  return present(parts).join(" ");
}

function counted(count: number, noun: string): string {
  return `${formatCount(count)} ${count === 1 ? noun : `${noun}s`}`;
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function seconds(value: number): string {
  const text = secondsFormatter.format(value);
  return `${text} ${text === "1" ? "second" : "seconds"}`;
}
