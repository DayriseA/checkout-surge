import {
  automaticRunResetDeadlineSeconds,
  automaticRunResetGraceNoticeSeconds,
  estimatedDemoOccupancyCeilingSeconds,
} from "@checkout-surge/contracts";
import type { Metadata } from "next";
import { ContentPage, ContentSection, LinkRow, TextLink } from "../components/content-page";
import {
  listClassName,
  noteClassName,
  proseClassName,
  subheadingClassName,
} from "../components/content-styles";
import { ArchitectureDiagram } from "../components/diagrams/architecture-diagram";
import { HostingTopologyDiagram } from "../components/diagrams/hosting-topology";
import { MeasurementTable } from "../components/diagrams/measured-pair";
import { getLocale } from "../lib/i18n/server";
import { getTranslation, type Locale } from "../lib/i18n/translate";
import {
  hostedMeasurements,
  hostingSizes,
  postgresQueueDrain,
  queueComparison,
  redisComparison,
} from "../lib/presentation/measured-figures";
import { publicVocabulary } from "../lib/presentation/public-vocabulary";
import { siteAnchors, siteLink } from "../lib/site-links";

export async function generateMetadata(): Promise<Metadata> {
  const t = getTranslation(await getLocale());
  return { title: t("Under the hood") };
}
export const dynamic = "force-dynamic";

const anchors = siteAnchors.underTheHood;
const occupancyCeilingMinutes = estimatedDemoOccupancyCeilingSeconds / 60;
const graceNoticeMinutes = automaticRunResetGraceNoticeSeconds / 60;
const automaticResetMinutes = automaticRunResetDeadlineSeconds / 60;

const contents = [
  [anchors.architecture, "Architecture"],
  [anchors.buyPath, "The buy path"],
  [anchors.safetyNets, "Safety nets"],
  [anchors.runs, "How a run works"],
  [anchors.signals, "Live signals"],
  [anchors.measurement, "How the comparisons are measured"],
  [anchors.hosting, "Hosting"],
  [anchors.glossary, "Glossary"],
] as const;

export default async function UnderTheHoodPage() {
  const locale = await getLocale();
  const t = getTranslation(locale);

  return (
    <ContentPage
      contents={contents}
      lead={t(
        "How Checkout-Surge is built, how a run works, how the comparisons are measured, and how the demo is hosted. Written for engineers.",
      )}
      title={t("Under the hood")}
    >
      <ContentSection id={anchors.architecture} title={t("Architecture")}>
        <p className={proseClassName}>
          {t(
            "Five applications and two stores. The API owns the buy path. A worker owns everything after a buyer's answer. A simulated ERP plays the back office, a load generator plays the buyers, and the web app shows each run live.",
          )}
        </p>
        <ArchitectureDiagram />
        <dl className="mb-0 mt-6 grid max-w-[68ch] grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm leading-6 max-[560px]:grid-cols-1 max-[560px]:gap-y-0">
          {stack.map(([layer, technology]) => (
            <div className="contents" key={t(layer)}>
              <dt className="text-muted max-[560px]:mt-2">{t(layer)}</dt>
              <dd className="m-0 font-semibold text-ink">{t(technology)}</dd>
            </div>
          ))}
        </dl>
      </ContentSection>

      <ContentSection id={anchors.buyPath} title={t("The buy path")}>
        <p className={proseClassName}>
          {t(
            "Every checkout attempt first asks Redis to reserve its unit in one atomic operation, so competing attempts cannot spend the same unit. Once the stock is gone, buyers turned away are answered from Redis alone, without touching the database. A buyer who secures a unit is answered only after the API has written its reservation and order to PostgreSQL in one transaction and published the order to the queue.",
          )}
        </p>
        <p className={proseClassName}>
          {t(
            "A buyer's answer includes more than the stock decision: waiting for a busy API and, for successful buyers, the database write. Run history shows the two apart: the reservation timing measures the decision, the response timing measures the whole answer.",
          )}
        </p>
        <p className={proseClassName}>
          {t("Orders for unique reservations enter a BullMQ queue. Workers take that")}{" "}
          <TextLink href="#backpressure">{t("backlog")}</TextLink>
          {t(
            " at a safe rate instead of forwarding the whole surge to the deliberately slow simulated ERP. Retries, worker limits, and the",
          )}{" "}
          <TextLink href="#circuit-breaker">{t("circuit breaker")}</TextLink>
          {t(
            " keep downstream pressure bounded. Reserved work waits in the queue rather than being dropped; the one deliberate exception is a ",
          )}
          <TextLink href={`#${anchors.runs}`}>{t("run reset")}</TextLink>
          {t(", which discards the whole run.")}
        </p>
        <p className={proseClassName}>
          {t(
            "The worker is configured with the ERP's declared capacity, as is common with mainstream ERP and SaaS APIs that publish their limits. When a downstream limit is unknown or variable, an adaptive client-side limiter, such as the adaptive retry mode of the AWS SDKs, is the appropriate technique. This demo deliberately shows the common case of a known limit.",
          )}
        </p>
        <p className={proseClassName}>
          {t(
            "An ERP call can also end without a usable answer, such as a timeout. The worker never retries such an ",
          )}
          <TextLink href="#uncertain-result">{t("uncertain result")}</TextLink>
          {t(
            " blindly: it first asks the ERP's durable confirmation ledger whether that idempotency key already succeeded or was rejected, and replays the request with the same key only when the ERP has no record of it. That is what keeps a retry from creating a second order.",
          )}
        </p>
      </ContentSection>

      <ContentSection id={anchors.safetyNets} title={t("Safety nets")}>
        <p className={proseClassName}>{t("Each failure the demo expects, and what catches it.")}</p>
        <dl className="mb-0 mt-4 grid max-w-[68ch] gap-3 text-base leading-7">
          {safetyNets.map(([failure, net]) => (
            <div key={t(failure)}>
              <dt className="font-semibold text-ink">{t(failure)}</dt>
              <dd className="m-0 text-muted-strong">
                {t(net, { minutes: automaticResetMinutes })}
              </dd>
            </div>
          ))}
        </dl>
      </ContentSection>

      <ContentSection id={anchors.runs} title={t("How a run works")}>
        <h3 className={subheadingClassName}>{t("Admission")}</h3>
        <p className={proseClassName}>
          {t(
            "One run at a time uses the demo, for every visitor. Before a run starts, the API estimates how long the chosen configuration would occupy the demo and rejects it when that conservative estimate exceeds the demo limit of at most ",
          )}
          {occupancyCeilingMinutes}
          {t(
            " minutes. A visitor's custom run is also compared with the demo's measured capacity, and refused if it is not expected to complete. The estimate serves admission only: an accepted run that overruns it is neither stopped nor failed.",
          )}
        </p>
        <h3 className={subheadingClassName}>{t("Finishing")}</h3>
        <p className={proseClassName}>
          {t(
            "Once the load generator has sent its last attempt, the run enters a finishing phase and stops accepting new traffic. An empty queue is not the end. The run completes only when nothing is queued, processing, or waiting to retry, every uncertain ERP call has been resolved, every reservation has reached its durable record, and every confirmed order has its ",
          )}
          {t(publicVocabulary.notifications)}
          {t(
            ". This phase has no elapsed-time deadline; the only time-based stop is the automatic reset below.",
          )}
        </p>
        <h3 className={subheadingClassName}>{t("Success")}</h3>
        <p className={proseClassName}>
          {t(
            "Every unique reservation must first reach a durable confirmed or failed order outcome. A run completes successfully only when the finishing phase has settled every remaining obligation and oversold units and failed or pending orders are all zero. Accepted responses can outnumber unique reservations when an",
          )}{" "}
          <TextLink href="#idempotency">{t("idempotent")}</TextLink>
          {t(
            " replay returns the original result; the final result keeps those populations distinct and shows their invariant proof.",
          )}
        </p>
        <h3 className={subheadingClassName}>{t("Grace period and reset")}</h3>
        <p className={proseClassName}>
          {t("From ")}
          {graceNoticeMinutes}
          {t(
            " minutes after acceptance the dashboard shows a grace-period notice if the run is still unfinished. A run still unfinished at ",
          )}
          {automaticResetMinutes}{" "}
          {t(
            "minutes is reset automatically so the next visitor can start. An admin can also reset a run manually. Either reset stops all demo work immediately and discards the run's data; one history line marked as cancelled remains.",
          )}
        </p>
        <h3 className={subheadingClassName}>{t("Comparisons: two runs in one slot")}</h3>
        <p className={proseClassName}>
          {t(
            "A comparison preset runs its two modes as two chained runs on the same workload. The second run starts as soon as the first completes, in the same slot, and the visitor's run budget is charged once. Each run keeps its own time limit and automatic reset, and its own report.",
          )}
        </p>
      </ContentSection>

      <ContentSection id={anchors.signals} title={t("Live signals")}>
        <ol className="mt-4 grid max-w-[68ch] list-none gap-4 p-0 leading-7 text-muted-strong [counter-reset:signal] [&>li]:relative [&>li]:pl-10 [&>li]:[counter-increment:signal] [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:top-0.5 [&>li]:before:grid [&>li]:before:size-7 [&>li]:before:place-items-center [&>li]:before:rounded-full [&>li]:before:bg-ink [&>li]:before:text-xs [&>li]:before:font-bold [&>li]:before:text-white [&>li]:before:content-[counter(signal)]">
          <li>
            <strong className="text-ink">{t("Request arrival")}</strong>
            {t(
              " shows checkout attempts starting at the load generator, so the opening surge is visible rather than inferred from completed responses.",
            )}
          </li>
          <li>
            <strong className="text-ink">{t("Inventory drain")}</strong>
            {t(
              " shows remaining stock falling from the starting amount as reservation quantities are secured, alongside the authoritative oversell result.",
            )}
          </li>
          <li>
            <strong className="text-ink">{t("Processing backlog")}</strong>
            {t(
              " shows reserved orders waiting for their first processing start, then draining as workers admit work safely.",
            )}
          </li>
          <li>
            <strong className="text-ink">{t("Confirmation convergence")}</strong>
            {t(
              " shows those reservations reaching confirmed or failed durable outcomes; reservation-to-confirmation time explains the expected lag.",
            )}
          </li>
        </ol>
      </ContentSection>

      <ContentSection id={anchors.measurement} title={t("How the comparisons are measured")}>
        <p className={proseClassName}>
          {t(
            "Each comparison runs one preset twice and switches one choice. A mode is a property of the run, set only by its comparison preset.",
          )}
        </p>
        <ul className={`${listClassName} list-disc`}>
          {modes.map(([mode, description]) => (
            <li key={t(mode)}>
              <strong className="text-ink">{t(mode)}.</strong> {t(description)}
            </li>
          ))}
        </ul>
        <h3 className={subheadingClassName}>{t("Fairness rules")}</h3>
        <ul className={`${listClassName} list-disc`}>
          {fairnessRules.map((rule) => (
            <li key={t(rule)}>{t(rule)}</li>
          ))}
        </ul>
        <h3 className={subheadingClassName}>{t("The selling window")}</h3>
        <p className={proseClassName}>
          {t(
            "The Redis comparison's database figures cover the selling window: from the run's start until every buyer has an answer. Transactions and time in queries come from PostgreSQL's statistics for the whole database (the API's, the worker's and recovery's work alike), and CPU time from PostgreSQL's own container. PostgreSQL publishes a busy connection's statistics about once a second, so up to the window's last second is left out, mostly the PostgreSQL run's decision reads: the figures understate the gap.",
          )}
        </p>
        <h3 className={subheadingClassName}>{t("The buy-only pool")}</h3>
        <p className={proseClassName}>
          {t(
            "Both runs of the Redis comparison are served by the same two buy-only API processes, while one control process keeps run starts, resets, runner operations and recovery. With a single process, that process was the bottleneck in both modes, so the comparison would have measured the API rather than the stores. Ordinary runs and the queue comparison use the single API process.",
          )}
        </p>
        <h3 className={subheadingClassName}>{t("Pairs, medians and ranges")}</h3>
        <p className={proseClassName}>
          {t(
            "Each comparison was started repeatedly on a copy of this demo with the same Machines. A figure is the median across the pairs, with the lowest and highest pair in brackets, and a difference is claimed only when every pair agrees. The run order is fixed, with the demo as built first.",
          )}
        </p>
        <MeasurementTable
          caption={t("Queue comparison. {value0}", { value0: t(queueComparison.method) })}
          figures={[
            queueComparison.everyBuyerAnswered,
            queueComparison.winnersP95,
            queueComparison.winnersAverage,
            queueComparison.erpPace,
            queueComparison.slowestOrder,
          ]}
          runLabels={queueComparison.runLabels}
        />
        {[redisComparison.cold, redisComparison.warm].map((measurement) => (
          <MeasurementTable
            caption={t("Redis comparison. {value0}", { value0: t(measurement.method) })}
            figures={[
              measurement.transactions,
              measurement.timeInQueries,
              measurement.postgresCpu,
              measurement.turnedAwayWait,
              measurement.winnersWait,
              measurement.everyBuyerAnswered,
            ]}
            key={measurement.method}
            runLabels={measurement.runLabels}
          />
        ))}
        <p className={noteClassName}>
          {t(
            "In every pair, all 500 orders were confirmed and no buyer went without an expected answer. Over whole Redis comparison runs, the PostgreSQL order queue drains about",
          )}{" "}
          {new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US").format(
            postgresQueueDrain.postgres,
          )}
          {t(" orders per second against ")}
          {new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US").format(
            postgresQueueDrain.bullmq,
          )}
          {t(
            " with BullMQ; this happens after the selling window, so the figures above do not include it.",
          )}
        </p>
        <LinkRow
          links={[
            { href: siteLink("howItWorks", "queueComparison"), label: "The queue comparison" },
            { href: siteLink("howItWorks", "redisComparison"), label: "The Redis comparison" },
            { href: siteLink("limits", "comparisonLimits"), label: "What they do not show" },
          ]}
        />
      </ContentSection>

      <ContentSection id={anchors.hosting} title={t("Hosting")}>
        <HostingTopologyDiagram />
        <ul className={`${listClassName} list-disc`}>
          <li>
            <strong className="text-ink">{t("Sleep and wake.")}</strong>
            {t(
              " The core stops itself after a quiet period with no run. The next visitor wakes it through the gate, in about",
            )}{" "}
            {hostedMeasurements.wakeSeconds}
            {t(
              " seconds. A countdown under the header shows when it will sleep, with a button to keep it awake.",
            )}
          </li>
          <li>
            <strong className="text-ink">{t("Sizes.")}</strong>
            {t(" The core Machine has ")}
            {t(hostingSizes.core)}
            {t(", and the runner Machine has ")}
            {t(hostingSizes.runner)}
            {t(", so the load generator never runs short of CPU while it sends.")}
          </li>
          <li>
            <strong className="text-ink">{t("A warm start.")}</strong>
            {t(
              " PostgreSQL saves the list of its cached pages when it stops and reloads them when it starts (pg_prewarm), and each buy-only process opens its connections before it accepts buyers.",
            )}
          </li>
          <li>
            <strong className="text-ink">{t("Disposable data.")}</strong>
            {t(
              " Run history and admin edits live on the core's disk with no backup: a reinstall on new servers starts empty.",
            )}
          </li>
        </ul>
      </ContentSection>

      <PublicGlossary locale={locale} />
    </ContentPage>
  );
}

const stack = [
  ["Web pages and live view", "Next.js, React, Tailwind CSS"],
  ["API", "Node.js, Fastify"],
  ["Stock decision", "Redis, one atomic script per attempt"],
  ["Durable records", "PostgreSQL, Drizzle ORM"],
  ["Order queue and worker", "BullMQ on Redis"],
  ["Live updates", "Server-sent events, Redis Pub/Sub"],
  ["Simulated buyers", "k6, on its own Machine"],
  ["Shared contracts", "TypeScript, Zod"],
] as const;

const safetyNets = [
  [
    "A double click, a timeout or a client retry",
    "The idempotency key replays the original reservation; nothing is bought twice.",
  ],
  [
    "The queue publish is lost after the order is saved",
    "A dispatch scanner finds the committed order and publishes it again.",
  ],
  [
    "The database fails after Redis reserved a unit",
    "The reservation waits for its durable record, and recovery writes it later. A run cannot finish while one remains.",
  ],
  [
    "The ERP call ends without an answer",
    "The worker checks the ERP's confirmation ledger before any replay, with the same key.",
  ],
  [
    "The ERP is slow or at its limit",
    "The queue's rate limit, the worker's in-flight limits and capacity cooldowns hold the work back.",
  ],
  ["The ERP is down", "A circuit breaker pauses calls, then probes for recovery."],
  [
    "The worker restarts",
    "The cooldown and circuit deadlines are stored durably and restored at startup.",
  ],
  ["A simulated email is missing", "A notification scanner queues it again."],
  [
    "A run never finishes",
    "It is reset automatically at {minutes} minutes, so the next visitor can start.",
  ],
] as const;

const modes = [
  [
    "The demo as built",
    "Every ordinary run, and run 1 of both comparisons: Redis decides the stock and holds the order queue (BullMQ); the worker calls the ERP after the buyer's answer.",
  ],
  [
    "Without the order queue",
    "Run 2 of the queue comparison: a winner's request waits until the same worker has the order confirmed by the ERP, at the ERP's pace. After 45 seconds it is told “secured, not yet confirmed”, and the order is confirmed later as usual.",
  ],
  [
    "Stock and order queue in PostgreSQL",
    "Run 2 of the Redis comparison: PostgreSQL decides the stock and holds the order queue. Redis still carries the live counters and the notifications.",
  ],
] as const;

const fairnessRules = [
  "Same Machines, same preset, same API processes and connection pools in both runs.",
  "Same protections in every mode: idempotency, the run fence, the bookkeeping, and the reservation and order recorded before “yes”.",
  "A standard PostgreSQL design, not a strawman: one stock row, a conditional decrement, a read-only check first, and no write for a sold-out answer.",
  "A winner commits in one transaction on a reserved connection, in both modes.",
  "Without the queue, the request waits for the same worker instead of calling the ERP itself, so the ERP client and its pacing stay the same.",
  "Equal groups: all winners, or all buyers, in both runs; never only those who got a given answer.",
] as const;

function PublicGlossary({ locale = "en" }: { locale?: Locale }) {
  const t = getTranslation(locale);

  const terms = [
    [
      "erp",
      "ERP",
      "Enterprise resource planning: the back-office system represented here by deliberately slow simulated behavior.",
    ],
    ["tps", "TPS", "Transactions per second; here, the simulated ERP call capacity."],
    [
      "p95",
      "p95",
      "The value that 95 percent of recorded observations are at or below for the named measurement boundary.",
    ],
    [
      "vu",
      "VU",
      "Virtual user: a reusable load-generator worker that runs scenario iterations and may run multiple checkout attempts.",
    ],
    [
      "circuit-breaker",
      "Circuit breaker",
      "Protection that pauses calls after repeated downstream failures, then probes for recovery.",
    ],
    [
      "backpressure",
      "Backpressure",
      "Limiting how quickly queued work enters a slower dependency so a surge does not overwhelm it.",
    ],
    [
      "idempotency",
      "Idempotency",
      "Repeating the same eligible request returns its original result instead of acting again: a replayed checkout returns its reservation, and a replayed ERP call cannot create a second order.",
    ],
    [
      "uncertain-result",
      "Uncertain result",
      "An ERP call whose outcome never reached the worker. It is verified against the ERP’s confirmation ledger before any replay.",
    ],
    [
      "projection",
      "Projection",
      "A read-ready view assembled from authoritative run data for the dashboard.",
    ],
    [
      "recovery",
      "Recovery",
      "Rebuilding current state after a missed update, or safely retrying incomplete durable work.",
    ],
    [
      "drain",
      "Drain",
      "Finishing a run after traffic stops: queued work, retries, uncertain ERP calls, reservations awaiting their durable record, and missing simulated emails must all be settled before the run completes.",
    ],
    [
      "pending-reservation",
      "Reservation awaiting its durable record",
      "A unit Redis has reserved whose reservation and order PostgreSQL has not recorded yet, for example while the database is briefly unavailable. Recovery records it later, and a run cannot finish while one remains.",
    ],
    [
      "reservation-vs-confirmation",
      "Reservation versus confirmation",
      "A reservation secures scarce stock in one atomic decision and creates its order at once; confirmation is the later successful order state after queued processing. Failure is a separate durable outcome.",
    ],
  ] as const;

  return (
    <ContentSection id={anchors.glossary} title={t("Glossary")}>
      <dl className="mb-0 mt-4 grid grid-cols-2 gap-x-10 max-[700px]:grid-cols-1">
        {terms.map(([id, term, definition]) => (
          <div className="scroll-mt-24 border-t border-border py-3" id={id} key={id} tabIndex={-1}>
            <dt className="font-bold text-ink">{t(term)}</dt>
            <dd className="m-0 mt-1 text-sm leading-6 text-muted-strong">{t(definition)}</dd>
          </div>
        ))}
      </dl>
    </ContentSection>
  );
}
