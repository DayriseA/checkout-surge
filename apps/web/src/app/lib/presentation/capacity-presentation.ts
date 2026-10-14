import {
  type CapacityAssessment,
  k6GracefulStopSeconds,
  k6RequestTimeoutSeconds,
  type TrafficConfig,
} from "@checkout-surge/contracts";
import { getTranslation, type Locale } from "../i18n/translate";
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

/** The public refusal of a custom run that is not expected to complete. */
export function capacityRefusalCopy(capacity: CapacityAssessment, locale: Locale = "en"): string[] {
  return [
    capacity.mode === "constant-arrival-rate"
      ? constantArrivalRefusal(capacity, locale)
      : buyerSpikeRefusal(capacity, locale),
  ];
}

/** The admin warning before confirming a run that is at the limit or expected to fail. */
export function capacityWarningCopy(capacity: CapacityAssessment, locale: Locale = "en"): string[] {
  if (capacity.verdict === "expected_to_complete") return [];
  return capacity.mode === "constant-arrival-rate"
    ? constantArrivalWarning(capacity, locale)
    : buyerSpikeWarning(capacity, locale);
}

/**
 * The admin warning for explicit VUs pre-allocating fewer than the deployment would for the
 * rate: VUs added during the run come too late for the start's latency jump.
 */
export function explicitVusWarning(
  trafficConfig: TrafficConfig,
  automaticVus: number | null,
  locale: Locale = "en",
): string | null {
  const t = getTranslation(locale);
  if (trafficConfig.mode !== "constant-arrival-rate" || !trafficConfig.k6Vus) return null;
  if (automaticVus === null || trafficConfig.k6Vus.preAllocatedVus >= automaticVus) return null;
  return t(
    "These virtual users are fewer than this deployment would allocate for this rate ({v0}); requests may never be sent.",
    { v0: String(formatCount(automaticVus, locale)) },
  );
}

function constantArrivalRefusal(capacity: ConstantArrivalCapacity, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  const maxRate = capacity.fit?.ratePerSecond ?? null;
  const maxStock = stockRemedy(capacity);
  const stockMention =
    maxStock === null
      ? ""
      : t(" with {v0} in stock", { v0: String(counted(capacity.startingStock, "unit", locale)) });
  const outcome =
    capacity.verdict === "at_the_limit"
      ? t("the run would use {v0}% of what the server can sustain", {
          v0: String(Math.round((capacity.loadPerSecond / capacity.capacityPerSecond) * 100)),
        })
      : t("the server would fall behind and some buyers would not get their answer in time");
  const fits = present([
    maxRate === null
      ? null
      : t("keeping this stock and duration, the rate can go up to {v0} per second", {
          v0: String(counted(maxRate, "request", locale)),
        }),
    maxStock === null
      ? null
      : t("keeping this rate, the stock can go up to {v0}", {
          v0: String(counted(maxStock, "unit", locale)),
        }),
  ]);
  const levers = present([
    maxRate === null ? null : t("the rate"),
    maxStock === null ? null : t("the stock"),
  ]);
  return sentences(
    t(refusalHeadlines[capacity.verdict === "at_the_limit" ? "at_the_limit" : "expected_to_fail"]),
    t(serverExplanation),
    t("At {v0} per second for {v1}{v2}, {v3}.", {
      v0: String(counted(capacity.ratePerSecond, "request", locale)),
      v1: String(counted(capacity.durationSeconds, "second", locale)),
      v2: String(stockMention),
      v3: String(outcome),
    }),
    fits.length === 0 ? null : capitalized(`${fits.join("; ")}.`),
    levers.length === 0
      ? capitalized(`${t(largerRuns)}.`)
      : t("Lower {v0}, or {v1}.", {
          v0: String(levers.join(t(" or "))),
          v1: String(t(largerRuns)),
        }),
  );
}

function buyerSpikeRefusal(capacity: BuyerSpikeCapacity, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  const maxBuyers = capacity.fit?.buyerCount ?? null;
  const fewerBuyers =
    maxBuyers === null
      ? null
      : t("the buyers to {v0}", { v0: String(formatCount(maxBuyers, locale)) });
  let remedy: string | null;
  if (isRequestTimeoutBound(capacity)) {
    const maxStock = stockRemedy(capacity);
    const lower = present([
      fewerBuyers,
      maxStock === null
        ? null
        : t("the stock to {v0}", { v0: String(counted(maxStock, "unit", locale)) }),
    ]);
    remedy = lower.length === 0 ? null : t("Lower {v0}.", { v0: String(lower.join(t(" or "))) });
  } else {
    const minCutoff = capacity.fit?.maxDurationSeconds ?? null;
    const remedies = present([
      minCutoff === null
        ? null
        : t("raise the safety cutoff to {v0}", {
            v0: String(counted(minCutoff, "second", locale)),
          }),
      fewerBuyers === null ? null : t("lower {v0}", { v0: String(fewerBuyers) }),
    ]).join(t(", or "));
    remedy = remedies === "" ? null : capitalized(`${remedies}.`);
  }
  const atTheLimit = capacity.verdict === "at_the_limit";
  return sentences(
    t(refusalHeadlines[atTheLimit ? "at_the_limit" : "expected_to_fail"]),
    t(serverExplanation),
    t("With {v0} and {v1}, this server needs about {v2} to answer everyone, {v3} {v4}.", {
      v0: String(counted(capacity.buyerCount, "buyer", locale)),
      v1: String(counted(capacity.startingStock, "unit", locale)),
      v2: String(seconds(capacity.timeToServeSeconds, locale)),
      v3: String(atTheLimit ? t("too close to") : t("more than")),
      v4: String(spikeWindow(capacity, locale)),
    }),
    remedy,
  );
}

function constantArrivalWarning(
  capacity: ConstantArrivalCapacity,
  locale: Locale = "en",
): string[] {
  const t = getTranslation(locale);
  const load = Math.round(capacity.loadPerSecond);
  const maxRate = capacity.fit?.ratePerSecond ?? null;
  const maxStock = stockRemedy(capacity);
  const expected = expectedToComplete(
    [
      maxRate === null
        ? null
        : t("up to {v0} per second", { v0: String(formatCount(maxRate, locale)) }),
      maxStock === null ? null : t("up to {v0}", { v0: String(counted(maxStock, "unit", locale)) }),
    ],
    locale,
  );
  if (capacity.verdict === "at_the_limit")
    return [
      sentences(
        t(
          "Near this deployment's capacity: the run asks about {v0} answers per second, {v1} % of the {v2} one API process gives here.",
          {
            v0: String(formatCount(load, locale)),
            v1: String(Math.round((load / capacity.capacityPerSecond) * 100)),
            v2: String(formatCount(capacity.capacityPerSecond, locale)),
          },
        ),
        t("It may complete, with little margin."),
        expected,
      ),
    ];
  const lines: string[] = [];
  if (capacity.loadPerSecond > capacity.capacityPerSecond)
    lines.push(
      t(
        "Beyond this deployment's capacity: about {v0} answers per second against {v1}. Expect a failed delivery: requests never sent at the virtual-user limit, or answers arriving too late.",
        {
          v0: String(formatCount(load, locale)),
          v1: String(formatCount(capacity.capacityPerSecond, locale)),
        },
      ),
    );
  if (capacity.acceptedOrders > capacity.poolOrderLimit)
    lines.push(
      t(
        "The database pool can answer about {v0} orders before the load generator stops listening, {v1} seconds after its sending window closes; this run would sell {v2}. Their answers would arrive too late.",
        {
          v0: String(formatCount(Math.floor(capacity.poolOrderLimit), locale)),
          v1: String(k6GracefulStopSeconds),
          v2: String(formatCount(capacity.acceptedOrders, locale)),
        },
      ),
    );
  return withExpected(lines, expected);
}

function buyerSpikeWarning(capacity: BuyerSpikeCapacity, locale: Locale = "en"): string[] {
  const t = getTranslation(locale);
  const timeoutBound = isRequestTimeoutBound(capacity);
  const minCutoff = timeoutBound ? null : (capacity.fit?.maxDurationSeconds ?? null);
  const maxBuyers = capacity.fit?.buyerCount ?? null;
  const maxStock = stockRemedy(capacity);
  const sizes = present([
    maxBuyers === null ? null : counted(maxBuyers, "buyer", locale),
    maxStock === null ? null : counted(maxStock, "unit", locale),
  ]);
  const expected = expectedToComplete(
    [
      minCutoff === null
        ? null
        : t("a safety cutoff of {v0}", { v0: String(counted(minCutoff, "second", locale)) }),
      sizes.length === 0 ? null : t("up to {v0}", { v0: String(sizes.join(t(" or "))) }),
    ],
    locale,
  );
  const time = seconds(capacity.timeToServeSeconds, locale);
  if (capacity.verdict === "at_the_limit")
    return [
      sentences(
        t("Near this deployment's capacity: about {v0} to answer, {v1} % of {v2}.", {
          v0: String(time),
          v1: String(Math.round((capacity.timeToServeSeconds / capacity.windowSeconds) * 100)),
          v2: String(spikeWindow(capacity, locale)),
        }),
        t("It may complete, with little margin."),
        expected,
      ),
    ];
  return [
    sentences(
      timeoutBound
        ? t(
            "About {v0} to answer, longer than the {v1} seconds the load generator waits: late buyers would end in transport failure.",
            { v0: String(time), v1: String(k6RequestTimeoutSeconds) },
          )
        : t(
            "Beyond this deployment's capacity: about {v0} to answer, more than {v1}. Expect a failed delivery: answers arriving too late, or requests never sent before the cutoff.",
            { v0: String(time), v1: String(spikeWindow(capacity, locale)) },
          ),
      expected,
    ),
  ];
}

/** Past k6's request timeout, no safety cutoff helps: the generator gives up on the answer. */
function isRequestTimeoutBound(capacity: BuyerSpikeCapacity): boolean {
  return capacity.windowSeconds >= k6RequestTimeoutSeconds;
}

function spikeWindow(capacity: BuyerSpikeCapacity, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return isRequestTimeoutBound(capacity)
    ? t("the {v0} seconds the load generator waits for an answer", {
        v0: String(k6RequestTimeoutSeconds),
      })
    : t("the {v0}-second safety cutoff", {
        v0: String(formatCount(capacity.windowSeconds, locale)),
      });
}

/** Less stock is a remedy only when the run fits with fewer units, still selling at least one. */
function stockRemedy(capacity: CapacityAssessment): number | null {
  const stock = capacity.fit?.startingStock ?? null;
  return stock !== null && stock > 0 ? stock : null;
}

function expectedToComplete(options: (string | null)[], locale: Locale = "en"): string | null {
  const t = getTranslation(locale);
  const remaining = present(options);
  return remaining.length === 0
    ? null
    : t("Expected to complete: {v0}.", { v0: String(remaining.join(t(", or "))) });
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

function counted(count: number, noun: string, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return `${formatCount(count, locale)} ${t(count === 1 ? noun : `${noun}s`)}`;
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function seconds(value: number, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  const text = new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    maximumFractionDigits: 1,
  }).format(value);
  return `${text} ${t(text === "1" ? "second" : "seconds")}`;
}
