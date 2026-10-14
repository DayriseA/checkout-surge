import { k6GracefulStopSeconds } from "@checkout-surge/contracts";
import type { Metadata } from "next";
import { ContentPage, ContentSection, LinkRow, TextLink } from "../components/content-page";
import { listClassName, proseClassName } from "../components/content-styles";
import { getLocale } from "../lib/i18n/server";
import { getTranslation } from "../lib/i18n/translate";
import {
  formatFigure,
  hostedMeasurements,
  postgresQueueDrain,
  queueComparison,
} from "../lib/presentation/measured-figures";
import { publicVocabulary } from "../lib/presentation/public-vocabulary";
import { siteAnchors, siteLink } from "../lib/site-links";

export async function generateMetadata(): Promise<Metadata> {
  const t = getTranslation(await getLocale());
  return { title: t("Limits and known defects") };
}
export const dynamic = "force-dynamic";

const anchors = siteAnchors.limits;
const lastWinnerSeconds = Math.round(queueComparison.everyBuyerAnswered.second[0]);
const slowerDrainPercent = Math.round(
  (1 - postgresQueueDrain.postgres / postgresQueueDrain.bullmq) * 100,
);

const contents = [
  [anchors.realAndSimulated, "Real and simulated"],
  [anchors.scale, "Scale"],
  [anchors.runLimits, "What limits a run"],
  [anchors.comparisonLimits, "What the comparisons do not show"],
  [anchors.production, "What a real system would add"],
  [anchors.knownDefects, "Known defects"],
] as const;

export default async function LimitsPage() {
  const locale = await getLocale();
  const t = getTranslation(locale);

  return (
    <ContentPage
      contents={contents}
      lead={t(
        "What is simulated, what the demo's scale means, what the comparisons cannot show, what a real system would add, and the defects we know of.",
      )}
      title={t("Limits and known defects")}
    >
      <ContentSection id={anchors.realAndSimulated} title={t("What is real and what is simulated")}>
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border max-[700px]:grid-cols-1">
          <div className="bg-surface p-5">
            <h3 className="m-0 flex items-center gap-2 text-base font-bold text-ink">
              <span aria-hidden="true" className="size-2.5 rounded-full bg-ok" />
              {t("Real demo components")}
            </h3>
            <p className="mb-0 mt-2 leading-7 text-muted-strong">
              {t(
                "A real API, Redis, PostgreSQL, BullMQ queue, and worker runtime execute the reservation, durable-record, and background-processing paths.",
              )}
            </p>
          </div>
          <div className="bg-surface p-5">
            <h3 className="m-0 flex items-center gap-2 text-base font-bold text-ink">
              <span aria-hidden="true" className="size-2.5 rounded-full bg-signal" />
              {t("Simulated business activity")}
            </h3>
            <p className="mb-0 mt-2 leading-7 text-muted-strong">
              {t(
                "The buyers are simulated by the load generator (k6). Legacy-ERP delay, capacity, failures, and outages are simulated, and post-confirmation notifications are",
              )}{" "}
              {t(publicVocabulary.notifications)}
              {t(
                ". There is no production external ERP or notification integration. The waiting room is not modelled: the load generator plays the traffic it lets through.",
              )}
            </p>
          </div>
        </div>
        <ul className={`${listClassName} list-disc`}>
          <li>
            {t(
              "There is no payment step: a buyer who secures a unit gets an order at once, recorded before the answer.",
            )}
          </li>
          <li>
            {t(
              "The two other modes, without the order queue and with the stock and the order queue in PostgreSQL, exist only in the two comparison presets. Every other run uses the demo as built.",
            )}
          </li>
        </ul>
      </ContentSection>

      <ContentSection id={anchors.scale} title={t("Scale")}>
        <ul className={`${listClassName} list-disc`}>
          <li>
            {t(
              "One core Machine runs everything except the load generator: the API, the worker, the simulated ERP, PostgreSQL and Redis share its CPUs.",
            )}
          </li>
          <li>
            {t(
              "One API process answers every buyer of an ordinary run and of the queue comparison. Two buy-only processes serve the Redis comparison's runs, because a single process was the bottleneck in both of its modes.",
            )}
          </li>
          <li>
            {t(
              "The largest preset releases 10,000 buyers in about a second. Real sales can be far larger: the patterns carry over, the numbers do not.",
            )}
          </li>
          <li>
            {t(
              "The demo refuses a visitor's run that is too heavy for it, rather than letting it fail (see ",
            )}
            <TextLink href={`#${anchors.runLimits}`}>{t("what limits a run")}</TextLink>).
          </li>
          <li>
            {t(
              "When 10,000 buyers arrive at once, connections can take seconds to open: one process accepts a burst of new connections only so fast.",
            )}
          </li>
          <li>
            {t("Every figure on this site is an observation of one environment, not a benchmark.")}
          </li>
        </ul>
      </ContentSection>

      <ContentSection id={anchors.runLimits} title={t("What limits a run, and what makes it fail")}>
        <p className={proseClassName}>
          {t(
            "The figures below are measurements of the hosted demo, from a few runs each. They describe that one environment, not a benchmark or a guarantee.",
          )}
        </p>
        <ul className={`${listClassName} list-disc`}>
          <li>
            <strong className="text-ink">{t("One API process.")}</strong>
            {t(" Once the stock is gone, the hosted demo answers about ")}
            {formatFigure(
              Number(hostedMeasurements.soldOutRate.replaceAll(",", "")),
              "count",
              locale,
            )}
            {t(" sold-out buyers per second from a steady stream.")}
          </li>
          <li>
            <strong className="text-ink">{t("The database pool for successful buyers.")}</strong>
            {t(
              " Each unit sold is first written to the database, through a small pool of PostgreSQL connections. Buyers who secure a unit are answered at about ",
            )}
            {formatFigure(
              Number(hostedMeasurements.acceptedRate.replaceAll(",", "")),
              "count",
              locale,
            )}
            {t(" per second, an order of magnitude below turned-away buyers.")}
          </li>
          <li>
            <strong className="text-ink">{t("Everyone at once against a steady stream.")}</strong>
            {t(
              " In a steady stream, virtual users reuse their connections. When everyone arrives at once, each buyer opens a new connection, which costs the API more: about",
            )}{" "}
            {formatFigure(
              Number(hostedMeasurements.spikeRate.replaceAll(",", "")),
              "count",
              locale,
            )}
            {t(" sold-out buyers per second on the hosted demo.")}
          </li>
          <li>
            <strong className="text-ink">{t("Stock.")}</strong>
            {t(
              " The more units a run sells, the more of its answers wait for the database, so the same traffic takes longer with more stock. In Surge 10k, the time within which 95 percent of answers arrived ranged",
            )}{" "}
            {t(hostedMeasurements.surge10kP95)}
            {t(" across runs on the hosted demo.")}
          </li>
          <li>
            <strong className="text-ink">{t("A slow ERP does not slow purchases.")}</strong>
            {t(
              " Only the worker calls the ERP. A slow or limited ERP makes the order backlog grow and drain at its pace, but buyers are answered before their order is confirmed: the run takes longer to finish, and the answers do not.",
            )}
          </li>
          <li>
            <strong className="text-ink">{t("Late answers.")}</strong>
            {t(" The load generator keeps listening for ")}
            {k6GracefulStopSeconds}
            {t(
              " seconds after its sending window closes. If answers arrive later, they are not recorded and the run fails: the answers arrived too late.",
            )}
          </li>
          <li>
            <strong className="text-ink">{t("The virtual-user limit.")}</strong>
            {t(
              " In a steady stream, each virtual user waits for its answer before sending again. When answers slow down, every virtual user can end up waiting; the load generator then cannot keep the rate, skips attempts, and the run reports its virtual-user limit.",
            )}
          </li>
        </ul>
        <p className={proseClassName}>
          {t(
            "Before a visitor's run starts, the API compares it with these measured limits and refuses a run that is too heavy for the demo's server, rather than letting it fail.",
          )}
        </p>
      </ContentSection>

      <ContentSection id={anchors.comparisonLimits} title={t("What the comparisons do not show")}>
        <ul className={`${listClassName} list-disc`}>
          <li>
            <strong className="text-ink">{t("The stores sit next to the API.")}</strong>
            {t(
              " PostgreSQL and Redis run on the API's machine. In a real deployment they would sit about a millisecond away, which would add about the same to every answer in both runs without changing what the comparison shows.",
            )}
          </li>
          <li>
            <strong className="text-ink">{t("Winners are not faster with Redis.")}</strong>
            {t(" A buyer who gets a unit pays the Redis decision, then the same database work.")}
          </li>
          <li>
            <strong className="text-ink">{t("A speed gap needs a database bottleneck")}</strong>
            {t(
              " that the demo does not have: several API instances sharing one database, a remote database behind a small connection pool, or a database busy with the rest of the shop.",
            )}
          </li>
          <li>
            <strong className="text-ink">{t("Redis's own ceiling is not measured.")}</strong>
            {t(" It runs each command on one thread, so it too has a maximum rate of answers.")}
          </li>
          <li>
            <strong className="text-ink">{t("The run order is fixed:")}</strong>
            {t(
              " the demo as built always runs first, and the second run finds a warmer system. The measured gaps are far larger than that effect.",
            )}
          </li>
          <li>
            <strong className="text-ink">
              {t("The first comparison after a wake is slower,")}
            </strong>
            {t(" in both runs: the processes start cold.")}
          </li>
          <li>
            <strong className="text-ink">
              {t("The 45-second answer never occurs on the preset.")}
            </strong>{" "}
            {t("Without the queue, the last winner waits about ")}
            {lastWinnerSeconds}
            {t(" seconds, so the “secured, not yet confirmed” answer is covered by tests only.")}
          </li>
        </ul>
        <LinkRow
          links={[
            { href: siteLink("underTheHood", "measurement"), label: "How they are measured" },
          ]}
        />
      </ContentSection>

      <ContentSection id={anchors.production} title={t("What a real system would add")}>
        <p className={proseClassName}>
          {t(
            "The demo leaves out what it does not aim to demonstrate. A production purchase system should add:",
          )}
        </p>
        <ul className={`${listClassName} list-disc`}>
          <li>
            {t(
              "a waiting room in front of checkout, deciding how many buyers reach the purchase system and when;",
            )}
          </li>
          <li>
            {t(
              "temporary holds with an expiry, then payment: unpaid holds would expire automatically and free their unit, and a background job would check that Redis and the database agree;",
            )}
          </li>
          <li>
            {t(
              "several API instances, so one process no longer bounds how fast buyers are answered;",
            )}
          </li>
          <li>{t("back-office protection coordinated across several workers;")}</li>
          <li>{t("bot protection, so the stock goes to people rather than scripts;")}</li>
          <li>
            {t("monitoring and alerts: the demo has its logs and nothing that pages anyone.")}
          </li>
        </ul>
      </ContentSection>

      <ContentSection id={anchors.knownDefects} title={t("Known defects")}>
        <ul className={`${listClassName} list-disc`}>
          {knownDefects.map((defect) => (
            <li
              key={t(defect, {
                drain: slowerDrainPercent,
                postgres: formatFigure(postgresQueueDrain.postgres, "pace", locale),
                bullmq: formatFigure(postgresQueueDrain.bullmq, "pace", locale),
              })}
            >
              {defect}
            </li>
          ))}
        </ul>
      </ContentSection>
    </ContentPage>
  );
}

const knownDefects = [
  "The PostgreSQL order queue confirms orders about {drain} % slower than BullMQ ({postgres} against {bullmq}), after the measured window: the Redis comparison's second run takes a little longer to finish.",
  "A run started at the very moment the demo goes to sleep is interrupted, then settled at the next wake.",
  "Right after “stay awake”, the countdown can show the old deadline for a few seconds.",
  "Run history and admin edits are lost when the demo is reinstalled on new servers.",
  "The custom-run form's field messages follow the browser's language, while the surrounding copy follows the selected site language.",
] as const;
