import type { Metadata } from "next";
import Link from "next/link";
import { LinkRow, TextLink } from "./components/content-page";
import { neutralLinkButtonClassName, primaryButtonClassName } from "./components/control-styles";
import { Bar, FlowArrow, type StepTag, Tag } from "./components/diagrams/primitives";
import { PurchasePathDiagram } from "./components/diagrams/purchase-path";
import { getLocale } from "./lib/i18n/server";
import { getTranslation, type Locale } from "./lib/i18n/translate";
import {
  type ComparisonMeasurement,
  comparisonFiguresNote,
  flashSale,
  formatFigure,
  hostedMeasurements,
  type PairedFigure,
  queueComparison,
  redisComparison,
} from "./lib/presentation/measured-figures";
import { publicNarrative } from "./lib/presentation/public-vocabulary";
import { comparisonExplanationLinks, presetCardLink, siteLink, sitePages } from "./lib/site-links";

export async function generateMetadata(): Promise<Metadata> {
  const t = getTranslation(await getLocale());
  return {
    title: { absolute: t("Checkout-Surge: a live demo of the system behind a flash sale") },
  };
}
export const dynamic = "force-dynamic";

const headingClassName = "type-title m-0 text-2xl leading-tight text-ink";
const leadClassName = "m-0 mt-2 max-w-[68ch] leading-7 text-muted-strong";

/** The three failures of a flash sale, each beside the practice that prevents it. */
const practices: readonly {
  marker: string;
  problem: string;
  title: string;
  text: string;
  tag: StepTag;
  href: string;
}[] = [
  {
    marker: "①",
    problem:
      "Two buyers are both told they got the last unit, and every turned-away buyer keeps the database busy just to hear “sold out”.",
    title: "Stock decided in memory",
    text: "Each attempt is decided in memory, in one step, so no unit is sold twice, and turned-away buyers never reach the database.",
    tag: "compared",
    href: siteLink("howItWorks", "stockInMemory"),
  },
  {
    marker: "②",
    problem:
      "Winners stare at a spinner while a back office that confirms {pace} orders a second is pushed past its limit.",
    title: "“Yes” now, confirm later",
    text: "The order is saved and the buyer answered at once; a queue hands orders to the back office at its own pace.",
    tag: "compared",
    href: siteLink("howItWorks", "yesNow"),
  },
  {
    marker: "③",
    problem: "A double click, or a retry after a timeout, buys twice.",
    title: "Safe retries",
    text: "Every request carries a key, so a repeat gets the first answer again instead of acting again.",
    tag: "shown",
    href: siteLink("howItWorks", "safeRetries"),
  },
];

export default async function HomePage() {
  const locale = await getLocale();
  const t = getTranslation(locale);
  const buyers = formatFigure(flashSale.buyers, "count", locale);

  return (
    <>
      <header className="grid gap-8 pb-14 pt-8 max-[560px]:gap-6 max-[560px]:pb-10 max-[560px]:pt-4">
        <h1 className="type-title m-0 max-w-[30ch] text-[clamp(1.625rem,2.6vw,2.25rem)] leading-[1.15] text-ink">
          {t("Checkout-Surge is a live demo of the system behind a flash sale.")}
        </h1>
        <SurgeBand locale={locale} />
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-6 max-[900px]:grid-cols-1">
          <p className="m-0 max-w-[52ch] text-lg leading-7 text-muted-strong">
            {t(
              "Nobody gets a unit that does not exist, and the back office is never flooded. Start a simulated sale and watch it live.",
            )}
          </p>
          <div className="flex flex-wrap gap-3">
            <TryDemoLink locale={locale} />
            <Link className={`${neutralLinkButtonClassName} text-base`} href={sitePages.howItWorks}>
              {t("How it works")}
            </Link>
          </div>
        </div>
      </header>

      <section aria-labelledby="what-goes-wrong">
        <h2 className={headingClassName} id="what-goes-wrong">
          {t("What goes wrong, and the standard answer")}
        </h2>
        <p className={leadClassName}>
          {t("Three things go wrong when demand far exceeds stock. Each has an answer that is")}{" "}
          <TextLink href={sitePages.howItWorks}>{t("standard in the industry")}</TextLink>
          {t(", and the demo runs all three.")}
        </p>
        <ol className="m-0 mt-6 grid list-none gap-3 p-0">
          {practices.map((practice) => (
            <li
              className="grid grid-cols-[minmax(0,5fr)_auto_minmax(0,6fr)] items-center gap-x-5 gap-y-2 max-[900px]:grid-cols-1"
              key={t(practice.title)}
            >
              <p className="m-0 text-lg leading-7 text-ink">
                {t(practice.problem, { pace: flashSale.backOfficePerSecond })}
              </p>
              <FlowArrow />
              <Link
                className="grid content-start gap-2 rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent hover:bg-surface-muted"
                href={practice.href}
              >
                <span className="font-bold leading-5 text-ink">
                  <span className="mr-1.5">{practice.marker}</span>
                  {t(practice.title)}
                </span>
                <span className="text-sm leading-6 text-muted-strong">{t(practice.text)}</span>
                <Tag kind={practice.tag} />
              </Link>
            </li>
          ))}
        </ol>
        <p className="m-0 mt-5 flex flex-wrap items-center gap-2 text-sm leading-6 text-muted-strong">
          <span>
            {t("In front of all this, a")}{" "}
            <TextLink href={siteLink("howItWorks", "waitingRoom")}>{t("waiting room")}</TextLink>
            {t(
              " lets buyers in at a pace the checkout can absorb. The demo is the checkout behind it.",
            )}
          </span>
          <Tag kind="notModelled" />
        </p>
      </section>

      <section aria-labelledby="in-one-picture" className="mt-14">
        <h2 className={headingClassName} id="in-one-picture">
          {t("The demo's checkout, in one picture")}
        </h2>
        <p className={leadClassName}>{t("The markers are the three answers above.")}</p>
        <PurchasePathDiagram />
        <p className="m-0 mt-4 text-sm leading-6 text-muted-strong">
          {t("The software is real; the buyers, the back office and the emails are")}{" "}
          <TextLink href={siteLink("limits", "realAndSimulated")}>{t("simulated")}</TextLink>.
        </p>
      </section>

      <section
        aria-labelledby="what-each-choice-buys"
        className="mt-14 rounded-2xl border border-border bg-surface p-8 max-[900px]:p-6 max-[560px]:p-4"
      >
        <h2 className={headingClassName} id="what-each-choice-buys">
          {t("What each choice buys, measured")}
        </h2>
        <p className={leadClassName}>{t("Same workload, run twice, with one choice switched.")}</p>
        <div className="mt-6 grid grid-cols-2 gap-8 max-[900px]:grid-cols-1">
          <ChoiceCard
            locale={locale}
            explanationHref={comparisonExplanationLinks.order_queue}
            figure={queueComparison.everyBuyerAnswered}
            presetSlug="queue-comparison"
            reading={t(
              "Same {value0} orders confirmed, at the same back-office pace: the queue moves the wait from the buyer to the back office.",
              { value0: queueComparison.ordersConfirmed },
            )}
            runLabels={queueComparison.runLabels}
            title={t("With and without the order queue")}
          />
          <ChoiceCard
            locale={locale}
            explanationHref={comparisonExplanationLinks.redis}
            figure={redisComparison.cold.transactions}
            presetSlug="redis-comparison"
            reading={t(
              "Same {value0} units sold, and the same answers. With the stock in PostgreSQL, the database also does the turned-away crowd's work. Winners are not faster: at this scale, the database is not the bottleneck.",
              { value0: flashSale.units },
            )}
            runLabels={redisComparison.cold.runLabels}
            title={t("With and without Redis")}
          />
        </div>
        <p className="m-0 mt-6 text-sm leading-6 text-muted">{t(comparisonFiguresNote)}</p>
      </section>

      <div className="mt-14 grid grid-cols-2 gap-10 border-t border-border pt-8 max-[900px]:grid-cols-1">
        <section aria-labelledby="demo-scale">
          <h2 className={headingClassName} id="demo-scale">
            {t("A demo, at demo scale")}
          </h2>
          <ul className="mb-0 mt-3 grid gap-1 pl-5 leading-7 text-muted-strong">
            <li>
              {t("The whole system runs on one machine, for up to ")}
              {buyers}
              {t(" buyers arriving in about a second.")}
            </li>
            <li>{t("No payment step and no bot protection.")}</li>
            <li>{t("Its databases sit on the same machine as its code, not across a network.")}</li>
          </ul>
          <LinkRow links={[{ href: sitePages.limits, label: "Limits and known defects" }]} />
        </section>
        <section aria-labelledby="for-engineers">
          <h2 className={headingClassName} id="for-engineers">
            {t("For engineers")}
          </h2>
          <p className="m-0 mt-3 leading-7 text-muted-strong">
            {t(
              "Node.js, Fastify, Redis, PostgreSQL, BullMQ, k6, Next.js, on Fly.io. The demo sleeps when nobody uses it and wakes in about ",
            )}
            {hostedMeasurements.wakeSeconds}
            {t(" seconds.")}
          </p>
          <p className="m-0 mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <TextLink href={sitePages.underTheHood}>{t("Under the hood →")}</TextLink>
            <TextLink external href={publicNarrative.repositoryUrl}>
              {t("Repository ↗")}
            </TextLink>
          </p>
        </section>
      </div>

      <section
        aria-labelledby="try-demo-heading"
        className="mt-14 flex flex-wrap items-center justify-between gap-5 rounded-2xl bg-reservoir px-10 py-8 text-white max-[900px]:px-6 max-[560px]:px-4"
      >
        <div>
          <h2 className="type-title m-0 text-2xl text-white" id="try-demo-heading">
            {t("See it under load")}
          </h2>
          <p className="m-0 mt-1 leading-7 text-white/75">
            {t("Choose a simulation, start it, and watch the system handle a release of buyers.")}
          </p>
        </div>
        <TryDemoLink locale={locale} onDark />
      </section>
    </>
  );
}

/** One comparison's headline figure, its reading, and links to run it and to read about it. */
function ChoiceCard({
  locale = "en",
  explanationHref,
  figure,
  presetSlug,
  reading,
  runLabels,
  title,
}: {
  locale?: Locale;
  explanationHref: string;
  figure: PairedFigure;
  presetSlug: string;
  reading: string;
  runLabels: ComparisonMeasurement["runLabels"];
  title: string;
}) {
  const t = getTranslation(locale);

  return (
    <article className="grid grid-rows-[auto_auto_1fr_auto] gap-4">
      <h3 className="type-title m-0 text-lg leading-tight text-ink">{title}</h3>
      <HeadlineFigure locale={locale} figure={figure} runLabels={runLabels} />
      <p className="m-0 max-w-[48ch] text-sm leading-6 text-muted-strong">{reading}</p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Link className={neutralLinkButtonClassName} href={presetCardLink(presetSlug)}>
          {t("Run it")}
        </Link>
        <TextLink href={explanationHref}>{t("How to read it →")}</TextLink>
      </div>
    </article>
  );
}

/** The two runs' medians of one figure, side by side, as the home page's loudest numbers. */
function HeadlineFigure({
  locale = "en",
  figure,
  runLabels,
}: {
  locale?: Locale;
  figure: PairedFigure;
  runLabels: ComparisonMeasurement["runLabels"];
}) {
  const t = getTranslation(locale);

  const runs = [
    { spread: figure.first, barClassName: "bg-accent" },
    { spread: figure.second, barClassName: "bg-muted" },
  ] as const;
  const largest = Math.max(figure.first[0], figure.second[0]);
  return (
    <div>
      <p className="m-0 text-sm font-semibold leading-5 text-ink">{t(figure.label)}</p>
      <dl className="m-0 mt-3 grid grid-cols-2 gap-5 max-[560px]:grid-cols-1">
        {runs.map(({ spread, barClassName }, index) => (
          <div className="grid gap-2" key={t(runLabels[index as 0 | 1])}>
            <dt className="text-xs leading-4 text-muted-strong">{t(runLabels[index as 0 | 1])}</dt>
            <dd className="m-0 grid gap-2">
              <span className="type-display text-4xl leading-none text-ink">
                {formatFigure(spread[0], figure.format, locale)}
              </span>
              <Bar className={barClassName} share={spread[0] / largest} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The hero's signature and the whole thesis in one picture: a dense, uneven surge of arrivals
 * meets one gate and leaves as an evenly spaced line, the same shape as the brand mark. The three
 * figures sit on the part of the drawing they describe, and the gate rises between them. Below
 * 900 px the drawing shrinks to a strip above the figures. On load, the crowd drifts in towards
 * the gate, then the steady line steps out (keyframes in globals.css).
 */
function SurgeBand({ locale = "en" }: { locale?: Locale }) {
  const t = getTranslation(locale);
  const buyers = formatFigure(flashSale.buyers, "count", locale);

  return (
    <div className="grid gap-4">
      <div aria-hidden="true" className="flex h-12 items-center gap-3 min-[901px]:hidden">
        <Arrivals dotRadius={2} />
        <Gate className="h-full" />
        <SteadyLine />
      </div>
      <div className="grid grid-cols-[minmax(0,3fr)_0.75rem_minmax(0,2fr)] gap-x-5 gap-y-4 max-[900px]:grid-cols-1 max-[900px]:gap-y-3">
        <Figure
          locale={locale}
          label={t("buyers press “Buy” within about a second")}
          value={buyers}
        />
        <Gate className="row-span-2 self-stretch max-[900px]:hidden" />
        <div className="flex justify-between gap-6 max-[900px]:contents">
          <Figure
            locale={locale}
            label={t("units, and one checkout decides")}
            value={String(flashSale.units)}
          />
          <Figure
            locale={locale}
            alignEnd
            label={t("orders a second, the back office's pace")}
            value={String(flashSale.backOfficePerSecond)}
          />
        </div>
        <div aria-hidden="true" className="h-28 max-[900px]:hidden">
          <Arrivals dotRadius={4} />
        </div>
        <div aria-hidden="true" className="h-28 max-[900px]:hidden">
          <SteadyLine />
        </div>
      </div>
    </div>
  );
}

/** One figure of the flash sale, loud, over its caption. */
function Figure({
  locale = "en",
  alignEnd = false,
  label,
  value,
}: {
  locale?: Locale;
  alignEnd?: boolean;
  label: string;
  value: string;
}) {
  const t = getTranslation(locale);

  return (
    <p
      className={`m-0 grid gap-1 max-[900px]:flex max-[900px]:items-baseline max-[900px]:gap-3 ${
        alignEnd ? "min-[901px]:justify-items-end min-[901px]:text-right" : ""
      }`}
    >
      <strong className="type-display text-[clamp(2.25rem,4.5vw,4rem)] leading-none text-ink">
        {value}
      </strong>
      <span className="max-w-[22ch] text-sm leading-5 text-muted-strong">{t(label)}</span>
    </p>
  );
}

/** The load sequence's delays; the durations live with the keyframes in globals.css. */
const crowdArrivalSpreadMs = 600;
const steadyLineStartMs = 1100;
const steadyLineCadenceMs = 80;

const crowdColumns = 20;
const crowdRows = 5;
/** How steeply the crowd thickens: its density grows e⁴-fold (about 55×) towards the gate. */
const crowdPressure = 4;

/** A fixed pseudo-random value in [0, 1) for a seed, so every render draws the same crowd. */
function noise(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * The crowd's dots, in percent of the drawing: a jittered grid whose columns are squeezed
 * towards the gate, from a few stragglers on the left to a crush at the gate. A dot's arrival
 * delay grows with its distance across, so the crowd fills in towards the gate.
 */
const crowd = Array.from({ length: crowdColumns * crowdRows }, (_, index) => {
  const column = index % crowdColumns;
  const row = Math.floor(index / crowdColumns);
  const across = (column + 0.5 + 0.9 * (noise(index + 1) - 0.5)) / crowdColumns;
  const down = (row + 0.5 + 0.9 * (noise(index + 1001) - 0.5)) / crowdRows;
  // Where the share `across` of the dots ends, under a density that grows as e^(pressure × x).
  const x = Math.log1p(across * Math.expm1(crowdPressure)) / crowdPressure;
  return { left: 1 + 98 * x, top: 7 + 86 * down, delay: Math.round(crowdArrivalSpreadMs * x) };
});

/** The crowd: dots that thicken towards the gate, as in the brand mark. Fills its parent. */
function Arrivals({ dotRadius }: { dotRadius: number }) {
  return (
    <svg
      aria-hidden="true"
      className="block h-full w-full min-w-0 flex-[3] overflow-visible fill-ink opacity-55"
    >
      {crowd.map((dot, index) => (
        <circle
          className="surge-arrive"
          cx={`${dot.left.toFixed(1)}%`}
          cy={`${dot.top.toFixed(1)}%`}
          // biome-ignore lint/suspicious/noArrayIndexKey: A fixed decorative sequence.
          key={index}
          r={dotRadius}
          style={{ animationDelay: `${dot.delay}ms` }}
        />
      ))}
    </svg>
  );
}

function Gate({ className }: { className: string }) {
  return <span className={`block w-3 shrink-0 rounded-sm bg-signal ${className}`} />;
}

/** The steady line of confirmed orders leaving the gate. Fills its parent's height. */
function SteadyLine() {
  return (
    <div className="flex h-full flex-[2] items-center justify-between pl-1">
      {Array.from({ length: 12 }, (_, index) => (
        <span
          className="surge-step block size-2 rounded-full bg-ink max-[900px]:size-1.5"
          // biome-ignore lint/suspicious/noArrayIndexKey: A fixed decorative sequence.
          key={index}
          style={{ animationDelay: `${steadyLineStartMs + index * steadyLineCadenceMs}ms` }}
        />
      ))}
    </div>
  );
}

function TryDemoLink({ locale = "en", onDark = false }: { locale?: Locale; onDark?: boolean }) {
  const t = getTranslation(locale);

  return (
    <Link
      className={
        onDark
          ? "inline-flex min-h-11 items-center rounded-lg bg-signal px-5 py-2 text-base font-semibold text-ink transition-colors hover:bg-[#ffc94d] focus-visible:outline-signal"
          : `${primaryButtonClassName} px-5 text-base`
      }
      href={sitePages.demo}
    >
      {t("Try the demo")}
    </Link>
  );
}
