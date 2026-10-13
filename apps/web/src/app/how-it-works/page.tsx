import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  ContentPage,
  ContentSection,
  LinkRow,
  proseClassName,
  subheadingClassName,
  TextLink,
} from "../components/content-page";
import { neutralLinkButtonClassName } from "../components/control-styles";
import { FlashSaleNumbers, PurchaseJourney } from "../components/diagrams/flash-sale";
import { MeasuredPair } from "../components/diagrams/measured-pair";
import { StockDecisionDots, WhoWaitsDiagram } from "../components/diagrams/practice-visuals";
import { DiagramFigure, type StepTag, Tag } from "../components/diagrams/primitives";
import {
  type ComparisonMeasurement,
  type PairedFigure,
  queueComparison,
  redisComparison,
} from "../lib/presentation/measured-figures";
import { presetCardLink, siteAnchors, siteLink, sitePages } from "../lib/site-links";

export const metadata: Metadata = { title: "How it works" };
export const dynamic = "force-dynamic";

const anchors = siteAnchors.howItWorks;
const redis = redisComparison.cold;

const contents = [
  [anchors.threeNumbers, "Three numbers"],
  [anchors.waitingRoom, "1. Waiting room"],
  [anchors.stockInMemory, "2. Stock in memory"],
  [anchors.yesNow, "3. Yes now, confirm later"],
  [anchors.safeRetries, "4. Safe retries"],
  [anchors.atItsScale, "At the demo's scale"],
  [anchors.queueComparison, "Queue comparison"],
  [anchors.redisComparison, "Redis comparison"],
] as const;

const comparisonLimitsLinks = [
  { href: siteLink("limits", "comparisonLimits"), label: "What this comparison does not show" },
  { href: siteLink("underTheHood", "measurement"), label: "How it is measured" },
] as const;

/** "about 2.6 times", or a whole number from 4 times up. */
function aboutTimes({ first, second }: PairedFigure): string {
  const ratio = second[0] / first[0];
  return `about ${ratio >= 4 ? Math.round(ratio) : ratio.toFixed(1)} times`;
}

export default function HowItWorksPage() {
  return (
    <ContentPage
      contents={contents}
      lead="What shops do when demand far exceeds stock, why it is standard, and what this demo shows of it."
      title="How flash-sale checkouts are built"
    >
      <ContentSection id={anchors.threeNumbers} title="A flash sale in three numbers">
        <p className={proseClassName}>
          A flash sale puts many buyers in front of little stock, all at once. Take this demo&apos;s
          largest preset:
        </p>
        <FlashSaleNumbers />
        <p className={proseClassName}>
          So the system must answer everyone fast, sell each unit only once, and protect both the
          back office and the rest of the shop. A real purchase goes through five steps, and the
          demo covers some of them:
        </p>
        <PurchaseJourney />
        <p className={proseClassName}>
          Four practices are standard for this. Each one solves a problem, and each one has a cost.
        </p>
      </ContentSection>

      <Practice
        brings="The checkout sees a load it was sized for, and visitors see a place in line instead of errors."
        costs="Buyers wait before they can even try. And each release still arrives as a burst, so the checkout behind the waiting room must still take a spike."
        demo={
          <>
            The demo is the checkout behind the waiting room. “Everyone at once” plays one release,
            and “Steady stream” plays its steady outflow. See{" "}
            <TextLink href={siteLink("limits", "realAndSimulated")}>what is simulated</TextLink>.
          </>
        }
        demoTag="notModelled"
        id={anchors.waitingRoom}
        problem="Tens of thousands of people press “Buy” in the same second. No checkout answers that many at once, and a crowd that times out keeps retrying."
        solution="A virtual waiting room in front of the shop. It holds visitors in line and lets them through in batches, or as a steady stream, at a rate the checkout can absorb."
        title="1. Let buyers in at a pace you can absorb"
      />

      <Practice
        brings="No unit is ever sold twice, and the turned-away buyers never touch the database: it only does the orders' work."
        costs="Redis keeps turned-away buyers off the database, but each winner costs more work, since two stores must be kept in step, with a recovery for when the second write fails. Redis has its own ceiling, and winners are not faster."
        demo={
          <>
            Every run decides the stock in Redis. The{" "}
            <TextLink href={`#${anchors.redisComparison}`}>Redis comparison</TextLink> runs the same
            sale with the stock in PostgreSQL instead. One limit:{" "}
            <TextLink href={siteLink("limits", "comparisonLimits")}>
              winners are not faster
            </TextLink>
            .
          </>
        }
        demoTag="compared"
        id={anchors.stockInMemory}
        problem="Thousands of buyers ask for the last units at the same moment. If two of them can see the same unit as free, it is sold twice. And if every one of them queries the main database, the turned-away crowd keeps it busy just to hear “sold out”."
        solution="Keep the stock count in an in-memory store (Redis) and decide each request there in one atomic step: check and take a unit together, so no two buyers can take the same one. Only the buyers who get a unit go on to the database, where their order is saved."
        title="2. Decide the stock in memory, in one step"
        visual={<StockDecisionDots />}
        why="The main database (PostgreSQL) is the system of record. It has one primary that accepts writes and a limited number of connections, and the rest of the shop depends on it. Redis decides in memory, atomically and without row locks, scales out cheaply, and holds data that can be rebuilt. The point is not to move the load elsewhere: it is to keep the database free for the orders, and to keep the surge away from the rest of the shop."
      />

      <Practice
        brings="Buyers get their answer in seconds, whatever the back office does. The back office is never flooded. Queued orders survive a crash and are retried safely."
        costs="“Secured” comes before “confirmed”, so a failure after the “yes” must be handled. There are more moving parts to run and watch. And the back office is not faster: the queue moves the wait, it does not remove it."
        demo={
          <>
            Every run&apos;s backlog chart shows the queue fill and drain. Slow ERP and Laggy ERP
            slow the back office down. The{" "}
            <TextLink href={`#${anchors.queueComparison}`}>queue comparison</TextLink> runs the same
            sale with each winner waiting for the back office.
          </>
        }
        demoTag="compared"
        extra={
          <p className={proseClassName}>
            Here the worker follows the back office&apos;s declared limit, as is common with ERP and
            SaaS services that publish theirs. When a limit is unknown or changes, an adaptive
            limiter on the caller&apos;s side is the usual technique.
          </p>
        }
        id={anchors.yesNow}
        problem="The back office (an ERP, payment capture, a warehouse) handles a few dozen orders per second; a sale produces hundreds in a second. If each buyer's request waits for the back office, buyers wait in line behind it, and a back office pushed past its limit slows down or fails."
        solution="Save the order, answer the buyer at once, and put the order in a queue (BullMQ). A worker takes orders from the queue at the pace the back office can handle, and has each one confirmed."
        title="3. Say “yes” now, confirm later"
        visual={<WhoWaitsDiagram />}
      />

      <Practice
        brings="A double click, a timeout or a retry never buys twice, so every part of the system can retry freely."
        costs="Keys to store and look up, and a back office that supports them: if it cannot say whether it already took an order, no retry is safe."
        demo={
          <>
            The Duplicate-click storm preset clicks “Buy” twice for every buyer. The simulated ERP
            keeps a ledger of confirmations, so the worker checks an uncertain call before replaying
            it. See the{" "}
            <TextLink href={siteLink("underTheHood", "safetyNets")}>safety nets</TextLink>.
          </>
        }
        demoTag="shown"
        id={anchors.safeRetries}
        problem="Buyers double-click, phones lose their connection, and systems retry after a timeout. Without care, a retry buys twice, or confirms an order twice."
        solution="Give each request a key (an idempotency key). A request that comes back with a key already seen gets the first answer again instead of acting again. And when a call's result is uncertain, check it before any replay."
        title="4. Make every step safe to repeat"
      />

      <ContentSection id={anchors.atItsScale} title="What the demo shows, at its scale">
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left text-sm leading-6">
            <thead>
              <tr className="border-b border-border text-xs text-muted">
                {["Practice", "In every run", "Compared live", "Where to see it"].map((column) => (
                  <th className="py-2 pr-4 font-semibold" key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scaleTable.map(([practice, everyRun, compared, where]) => (
                <tr className="border-b border-border last:border-b-0" key={practice}>
                  <th className="py-2 pr-4 font-semibold text-ink" scope="row">
                    {practice}
                  </th>
                  <td className="py-2 pr-4 text-muted-strong">{everyRun}</td>
                  <td className="py-2 pr-4 text-muted-strong">{compared}</td>
                  <td className="py-2 pr-4 text-muted-strong">{where}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={proseClassName}>
          Real sales can be far larger. The patterns carry over; the numbers do not. See{" "}
          <TextLink href={siteLink("limits", "scale")}>the demo&apos;s scale</TextLink>.
        </p>
      </ContentSection>

      <ContentSection id={anchors.queueComparison} title="The queue comparison">
        <Comparison
          figures={[
            queueComparison.everyBuyerAnswered,
            queueComparison.winnersP95,
            queueComparison.erpPace,
            queueComparison.slowestOrder,
          ]}
          measurement={queueComparison}
          presetSlug="queue-comparison"
          reading="The queue moves the wait from the buyer to the back office; it does not make the back office faster."
          whatItRuns={`Surge 5k (5,000 buyers released at once for 500 units, with a back office that confirms 20 orders per second, simulated), twice in a row. Run 1 is the demo as built. In run 2, each winner's request stays open until the same worker has the order confirmed by the back office. After 45 seconds, a winner would be told “secured, not yet confirmed” and the order would still be confirmed later: nothing is lost by design. All ${queueComparison.ordersConfirmed} orders were confirmed in every measured run.`}
        >
          <ReadingGuide
            entries={[
              [
                "Winners' time to an answer",
                "From a winner's click to the answer, over all winners. The 95th percentile is the time within which 95 % of them were answered.",
              ],
              [
                "Every buyer had an answer within",
                "The slowest answer of the run, winners and turned-away buyers alike.",
              ],
              [
                "The back office's pace",
                "Orders confirmed per second, from the first buyer to the last confirmation, against its limit of 20.",
              ],
              [
                "Slowest order",
                "The longest time from an order's “yes” to its confirmation by the back office.",
              ],
              [
                "×4.7 vs run 1",
                "On Watch and in the reports: run 2's figure as a multiple of run 1's.",
              ],
            ]}
          />
          <FairTest>
            Same buyers, stock, back-office limit, worker and protections in both runs. The order is
            fixed: the run with the queue always goes first.
          </FairTest>
        </Comparison>
      </ContentSection>

      <ContentSection id={anchors.redisComparison} title="The Redis comparison">
        <Comparison
          figures={[
            redis.transactions,
            redis.timeInQueries,
            redis.postgresCpu,
            redis.turnedAwayWait,
            redis.winnersWait,
            redis.everyBuyerAnswered,
          ]}
          measurement={redis}
          presetSlug="redis-comparison"
          reading={`The headline is the database's load. With the stock in PostgreSQL, it runs ${aboutTimes(redis.transactions)} the transactions and spends ${aboutTimes(redis.timeInQueries)} as long in queries, for the same 500 units sold. Turned-away buyers are answered a little sooner with Redis, and winners wait about the same. The speed gap stays small because the database is not the bottleneck at this scale. It would be with several API instances sharing it, with a remote database behind a small connection pool, or with a database busy with the rest of the shop.`}
          whatItRuns="Surge 10k (10,000 buyers released at once for 500 units), twice in a row. Run 1 is the demo as built. Run 2 moves both of Redis's jobs, the stock decision and the order queue, into PostgreSQL, with the same protections. Redis still carries the live counters and the notifications in both runs, and the same two buy-only API processes serve both."
        >
          <ReadingGuide
            entries={[
              [
                "While selling",
                "From the run's start until every buyer has an answer: the database figures cover this window.",
              ],
              [
                "A transaction",
                "One unit of database work that commits or rolls back, counted for the whole database: the API's, the worker's and recovery's work alike.",
              ],
              [
                "Time in database queries",
                "How long the database's connections spent running statements, waits for the stock row included. Connections work in parallel, so it can exceed the window.",
              ],
              ["Database CPU time", "The processor time of the database's own container."],
              [
                "Time to an answer",
                "From a buyer's click to the answer, averaged over all turned-away buyers, or over all winners.",
              ],
            ]}
          />
          <FairTest>
            A standard PostgreSQL design, not a strawman: one stock row, a conditional decrement, a
            read-only check first, and no write for a sold-out answer. The same connection pools and
            protections in both runs, and a window that leaves out up to its last second of the
            database&apos;s work, which understates the gap. The order is fixed: the Redis run
            always goes first. PostgreSQL and Redis run on the API&apos;s machine. In a real
            deployment they would sit about a millisecond away, which would add about the same to
            every answer in both runs without changing what the comparison shows.
          </FairTest>
        </Comparison>
        <LinkRow
          links={[
            { href: sitePages.limits, label: "Next: limits and known defects" },
            { href: sitePages.underTheHood, label: "Under the hood" },
          ]}
        />
      </ContentSection>
    </ContentPage>
  );
}

const scaleTable = [
  [
    "1. Waiting room",
    "Not modelled",
    "No",
    "“Everyone at once” and “Steady stream” play its releases",
  ],
  ["2. Stock in memory", "Yes", "Redis comparison", "Every preset"],
  [
    "3. Yes now, confirm later",
    "Yes",
    "Queue comparison",
    "The backlog chart, Slow ERP, Laggy ERP",
  ],
  ["4. Safe retries", "Yes", "No", "Duplicate-click storm, the ERP's ledger"],
] as const;

/** A standard practice: the problem, the standard answer, what it brings and costs, and the demo. */
function Practice({
  brings,
  costs,
  demo,
  demoTag,
  extra,
  id,
  problem,
  solution,
  title,
  visual,
  why,
}: {
  brings: string;
  costs: string;
  demo: ReactNode;
  demoTag: StepTag;
  extra?: ReactNode;
  id: string;
  problem: string;
  solution: string;
  title: string;
  visual?: ReactNode;
  why?: string;
}) {
  const parts: [string, string][] = [
    ["The problem", problem],
    ["The standard answer", solution],
  ];
  if (why) parts.push(["Why it is standard", why]);
  parts.push(["What it brings", brings], ["What it costs", costs]);
  return (
    <ContentSection id={id} title={title}>
      {visual}
      <dl className="mb-0 mt-5 grid max-w-[68ch] gap-4">
        {parts.map(([term, text]) => (
          <div key={term}>
            <dt className="text-sm font-semibold uppercase tracking-wide text-muted">{term}</dt>
            <dd className="m-0 mt-1 text-base leading-7 text-muted-strong">{text}</dd>
          </div>
        ))}
      </dl>
      {extra}
      <aside className="mt-5 grid max-w-[68ch] gap-2 rounded-xl border border-border bg-surface-muted p-4">
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
          In this demo <Tag kind={demoTag} />
        </p>
        <p className="m-0 text-sm leading-6 text-muted-strong">{demo}</p>
      </aside>
    </ContentSection>
  );
}

/** One comparison: what it runs, its measured pairs (V7), the reading, and how to read it. */
function Comparison({
  children,
  figures,
  measurement,
  presetSlug,
  reading,
  whatItRuns,
}: {
  children: ReactNode;
  figures: readonly PairedFigure[];
  measurement: ComparisonMeasurement;
  presetSlug: string;
  reading: string;
  whatItRuns: string;
}) {
  return (
    <>
      <p className={proseClassName}>{whatItRuns}</p>
      <DiagramFigure caption={`${measurement.method} Your run will differ a little.`}>
        <div className="grid grid-cols-2 gap-x-8 gap-y-5 max-[900px]:grid-cols-1">
          {figures.map((figure) => (
            <MeasuredPair
              figure={figure}
              key={figure.label}
              runLabels={measurement.runLabels}
              showRange
            />
          ))}
        </div>
      </DiagramFigure>
      <p className="m-0 mt-5 max-w-[68ch] border-l-4 border-signal pl-4 text-lg leading-7 text-ink">
        {reading}
      </p>
      {children}
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Link className={neutralLinkButtonClassName} href={presetCardLink(presetSlug)}>
          Run it
        </Link>
        <LinkRow className="m-0" links={comparisonLimitsLinks} />
      </div>
    </>
  );
}

function ReadingGuide({ entries }: { entries: readonly (readonly [string, string])[] }) {
  return (
    <>
      <h3 className={subheadingClassName}>How to read each figure</h3>
      <dl className="mb-0 mt-3 grid max-w-[68ch] gap-2 text-sm leading-6">
        {entries.map(([term, text]) => (
          <div key={term}>
            <dt className="inline font-semibold text-ink">{term}: </dt>
            <dd className="m-0 inline text-muted-strong">{text}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function FairTest({ children }: { children: ReactNode }) {
  return (
    <>
      <h3 className={subheadingClassName}>A fair test</h3>
      <p className={proseClassName}>{children}</p>
    </>
  );
}
