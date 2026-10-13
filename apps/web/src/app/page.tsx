import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { LinkRow, TextLink } from "./components/content-page";
import { neutralLinkButtonClassName, primaryButtonClassName } from "./components/control-styles";
import { MeasuredPair } from "./components/diagrams/measured-pair";
import { type StepTag, Tag } from "./components/diagrams/primitives";
import { PurchasePathDiagram } from "./components/diagrams/purchase-path";
import {
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

export const metadata: Metadata = {
  title: { absolute: "Checkout-Surge: a live demo of the system behind a flash sale" },
};
export const dynamic = "force-dynamic";

const cardClassName =
  "rounded-2xl border border-border bg-surface p-8 max-[900px]:p-6 max-[560px]:p-4";
const headingClassName = "type-title m-0 text-2xl leading-tight text-ink";

const practices: readonly {
  marker: string;
  title: string;
  text: string;
  tag: StepTag;
  href: string;
}[] = [
  {
    marker: "①",
    title: "Stock decided in memory",
    text: "Never sells a unit twice, and keeps turned-away buyers off the database.",
    tag: "compared",
    href: siteLink("howItWorks", "stockInMemory"),
  },
  {
    marker: "②",
    title: "“Yes” now, confirm later",
    text: "Buyers hear back in seconds; the back office works at its own pace.",
    tag: "compared",
    href: siteLink("howItWorks", "yesNow"),
  },
  {
    marker: "③",
    title: "Safe retries",
    text: "A double click or a retry never buys twice.",
    tag: "shown",
    href: siteLink("howItWorks", "safeRetries"),
  },
  {
    marker: "",
    title: "Waiting room",
    text: "Lets buyers in at a pace the checkout can absorb.",
    tag: "notModelled",
    href: siteLink("howItWorks", "waitingRoom"),
  },
];

export default function HomePage() {
  return (
    <>
      <header className="grid gap-8 pb-10 pt-6 max-[560px]:pb-8 max-[560px]:pt-2">
        <SurgeBand />
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-10 gap-y-6 max-[900px]:grid-cols-1">
          <div>
            <h1 className="type-display m-0 text-[clamp(2.75rem,7.5vw,5.75rem)] leading-[0.92] text-ink">
              Checkout-Surge
            </h1>
            <p className="m-0 mt-5 max-w-[48ch] text-xl leading-8 text-ink max-[560px]:text-lg max-[560px]:leading-7">
              A live demo of the system behind a flash sale:{" "}
              {formatFigure(flashSale.buyers, "count")} buyers rush for {flashSale.units} units,
              nobody gets a unit that does not exist, and a slow back office is never flooded.
            </p>
            <p className="m-0 mt-3 leading-6 text-muted">
              Start a simulated sale and watch it live.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <TryDemoLink />
            <Link className={`${neutralLinkButtonClassName} text-base`} href={sitePages.howItWorks}>
              How it works
            </Link>
          </div>
        </div>
      </header>

      <section aria-labelledby="in-one-picture" className={cardClassName}>
        <h2 className={headingClassName} id="in-one-picture">
          How it works, in one picture
        </h2>
        <p className="m-0 mt-2 max-w-[68ch] leading-7 text-muted-strong">
          It uses{" "}
          <TextLink href={sitePages.howItWorks}>
            design choices that are standard in the industry
          </TextLink>{" "}
          for this kind of sale.
        </p>
        <PurchasePathDiagram />
        <ul className="m-0 mt-4 grid list-none grid-cols-4 gap-3 p-0 max-[1100px]:grid-cols-2 max-[560px]:grid-cols-1">
          {practices.map((practice) => (
            <li className="flex" key={practice.title}>
              <Link
                className="grid flex-1 content-start gap-2 rounded-xl border border-border p-4 transition-colors hover:border-accent hover:bg-surface-muted"
                href={practice.href}
              >
                <span className="font-bold leading-5 text-ink">
                  {practice.marker ? <span className="mr-1.5">{practice.marker}</span> : null}
                  {practice.title}
                </span>
                <span className="text-sm leading-6 text-muted-strong">{practice.text}</span>
                <Tag kind={practice.tag} />
              </Link>
            </li>
          ))}
        </ul>
        <p className="m-0 mt-4 text-sm leading-6 text-muted-strong">
          The software is real; the buyers, the back office and the emails are{" "}
          <TextLink href={siteLink("limits", "realAndSimulated")}>simulated</TextLink>.
        </p>
      </section>

      <section aria-labelledby="what-each-choice-buys" className={`mt-6 ${cardClassName}`}>
        <h2 className={headingClassName} id="what-each-choice-buys">
          What each choice buys
        </h2>
        <p className="m-0 mt-2 max-w-[68ch] leading-7 text-muted-strong">
          Same workload, run twice, with one choice switched.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
          <ChoiceCard
            explanationHref={comparisonExplanationLinks.order_queue}
            figure={queueComparison.everyBuyerAnswered}
            presetSlug="queue-comparison"
            runLabels={queueComparison.runLabels}
            same={`Same ${queueComparison.ordersConfirmed} orders confirmed, at the same back-office pace.`}
            title="Queue comparison"
          />
          <ChoiceCard
            explanationHref={comparisonExplanationLinks.redis}
            figure={redisComparison.cold.transactions}
            presetSlug="redis-comparison"
            runLabels={redisComparison.cold.runLabels}
            same={`Same ${flashSale.units} units sold, and the same answers.`}
            title="Redis comparison"
          />
        </div>
        <p className="m-0 mt-4 text-sm leading-6 text-muted">{comparisonFiguresNote}</p>
      </section>

      <div className="mt-6 grid grid-cols-2 gap-6 max-[900px]:grid-cols-1">
        <section aria-labelledby="demo-scale" className={cardClassName}>
          <h2 className={headingClassName} id="demo-scale">
            A demo, at demo scale
          </h2>
          <ul className="mb-0 mt-3 grid gap-1 pl-5 leading-7 text-muted-strong">
            <li>
              The whole system runs on one machine, for up to{" "}
              {formatFigure(flashSale.buyers, "count")} buyers arriving in about a second.
            </li>
            <li>No payment step and no bot protection.</li>
            <li>Its databases sit on the same machine as its code, not across a network.</li>
          </ul>
          <LinkRow links={[{ href: sitePages.limits, label: "Limits and known defects" }]} />
        </section>
        <section aria-labelledby="for-engineers" className={cardClassName}>
          <h2 className={headingClassName} id="for-engineers">
            For engineers
          </h2>
          <p className="m-0 mt-3 leading-7 text-muted-strong">
            Node.js · Fastify · Redis · PostgreSQL · BullMQ · k6 · Next.js · Fly.io. The demo sleeps
            when nobody uses it and wakes in about {hostedMeasurements.wakeSeconds} seconds.
          </p>
          <p className="m-0 mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <TextLink href={sitePages.underTheHood}>Under the hood →</TextLink>
            <TextLink external href={publicNarrative.repositoryUrl}>
              Repository ↗
            </TextLink>
          </p>
        </section>
      </div>

      <section
        aria-labelledby="try-demo-heading"
        className="mt-6 flex flex-wrap items-center justify-between gap-5 rounded-2xl bg-reservoir px-10 py-8 text-white max-[900px]:px-6 max-[560px]:px-4"
      >
        <div>
          <h2 className="type-title m-0 text-2xl text-white" id="try-demo-heading">
            See it under load
          </h2>
          <p className="m-0 mt-1 leading-7 text-white/75">
            Choose a simulation, start it, and watch the system handle a release of buyers.
          </p>
        </div>
        <TryDemoLink onDark />
      </section>
    </>
  );
}

/** One comparison's headline figure, with links to run it and to read about it. */
function ChoiceCard({
  explanationHref,
  figure,
  presetSlug,
  runLabels,
  same,
  title,
}: {
  explanationHref: string;
  figure: PairedFigure;
  presetSlug: string;
  runLabels: readonly [string, string];
  same: ReactNode;
  title: string;
}) {
  return (
    <article className="grid content-start gap-4 rounded-xl bg-surface-muted p-5 max-[560px]:p-4">
      <h3 className="type-title m-0 text-lg leading-tight text-ink">{title}</h3>
      <MeasuredPair figure={figure} runLabels={runLabels} />
      <p className="m-0 text-sm leading-6 text-muted-strong">{same}</p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Link className={neutralLinkButtonClassName} href={presetCardLink(presetSlug)}>
          Run it
        </Link>
        <TextLink href={explanationHref}>How to read it →</TextLink>
      </div>
    </article>
  );
}

/**
 * The hero's signature: a dense, uneven surge of arrivals meets one gate and leaves as an evenly
 * spaced line, the same shape as the brand mark. Decorative only.
 */
function SurgeBand() {
  const arrivalCount = 56;
  const arrivals = Array.from({ length: arrivalCount }, (_, index) => {
    const progress = index / (arrivalCount - 1);
    const jitter = 0.55 + 0.45 * Math.abs(Math.sin(index * 2.3));
    return { height: 10 + 90 * progress ** 1.3 * jitter, opacity: 0.2 + progress * 0.7 };
  });
  return (
    <div aria-hidden="true" className="flex h-16 items-center gap-4 max-[560px]:h-12">
      <div className="flex h-full flex-[3] items-center justify-between">
        {arrivals.map((arrival, index) => (
          <span
            className="block w-[3px] rounded-full bg-ink max-[560px]:w-[2px]"
            // biome-ignore lint/suspicious/noArrayIndexKey: A fixed decorative sequence.
            key={index}
            style={{ height: `${arrival.height}%`, opacity: arrival.opacity }}
          />
        ))}
      </div>
      <span className="block h-full w-2.5 shrink-0 rounded-sm bg-signal" />
      <div className="flex h-full flex-[2] items-center justify-between pl-1">
        {Array.from({ length: 12 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: A fixed decorative sequence.
          <span className="block size-1.5 rounded-full bg-ink" key={index} />
        ))}
      </div>
    </div>
  );
}

function TryDemoLink({ onDark = false }: { onDark?: boolean }) {
  return (
    <Link
      className={
        onDark
          ? "inline-flex min-h-11 items-center rounded-lg bg-signal px-5 py-2 text-base font-semibold text-ink transition-colors hover:bg-[#ffc94d] focus-visible:outline-signal"
          : `${primaryButtonClassName} px-5 text-base`
      }
      href={sitePages.demo}
    >
      Try the demo
    </Link>
  );
}
