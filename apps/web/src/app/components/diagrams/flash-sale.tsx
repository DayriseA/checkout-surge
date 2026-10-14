"use client";

import { useLocale, useTranslation } from "../../lib/i18n/locale-context";
import { flashSale, formatFigure } from "../../lib/presentation/measured-figures";
import { Bar, DiagramFigure, type DiagramTone, FlowArrow, Step, type StepTag } from "./primitives";

/** V3: the three numbers of a flash sale, with strips to scale. */
export function FlashSaleNumbers() {
  const locale = useLocale();

  const t = useTranslation();

  const { buyers, units, backOfficePerSecond } = flashSale;
  const rows = [
    {
      figure: t("{buyers} buyers", { buyers: formatFigure(buyers, "count", locale) }),
      detail: "in about a second",
      amount: buyers,
    },
    {
      figure: t("{units} units", { units: formatFigure(units, "count", locale) }),
      detail: "for sale",
      amount: units,
    },
    {
      figure: t("{pace} orders per second", { pace: backOfficePerSecond }),
      detail: "confirmed by the back office (simulated)",
      amount: backOfficePerSecond,
    },
  ];
  return (
    <DiagramFigure
      caption={t(
        "Demand is {value0} times the stock, and it arrives {value1} times faster than the back office confirms orders. The strips are to scale.",
        { value0: buyers / units, value1: buyers / backOfficePerSecond },
      )}
    >
      <dl className="m-0 grid gap-4">
        {rows.map((row) => (
          <div
            className="grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)] items-center gap-x-5 gap-y-1.5 max-[560px]:grid-cols-1"
            key={row.figure}
          >
            <dt className="leading-5">
              <strong className="type-title text-lg text-ink">{row.figure}</strong>{" "}
              <span className="text-sm text-muted-strong">{t(row.detail)}</span>
            </dt>
            <dd className="m-0">
              <Bar className="bg-ink" share={row.amount / buyers} />
            </dd>
          </div>
        ))}
      </dl>
    </DiagramFigure>
  );
}

const journey: readonly {
  name: string;
  detail: string;
  tag: StepTag;
  tone?: DiagramTone;
  dashed?: boolean;
}[] = [
  {
    name: "Waiting room",
    detail: "lets buyers in at a pace",
    tag: "notModelled",
    dashed: true,
  },
  { name: "Stock decision", detail: "one unit each, never more", tag: "shown", tone: "fast" },
  { name: "Hold and payment", detail: "no payment: the order comes at once", tag: "simplified" },
  { name: "Order", detail: "saved before the answer", tag: "shown", tone: "durable" },
  {
    name: "Confirmation and email",
    detail: "by the back office, at its pace",
    tag: "simulated",
    tone: "slow",
    dashed: true,
  },
];

/** V4: the five steps of a real purchase, and what the demo does with each. */
export function PurchaseJourney() {
  const t = useTranslation();

  return (
    <DiagramFigure
      caption={t(
        "A real purchase has five steps. The demo runs the stock decision and the order for real, has no payment step, simulates the back office and the emails, and leaves the waiting room out: its buyers are the ones a waiting room would let through.",
      )}
    >
      <ol className="m-0 flex list-none items-stretch gap-2 p-0 max-[900px]:flex-col">
        {journey.map((step, index) => (
          <li
            className="flex min-w-0 flex-1 items-stretch gap-2 max-[900px]:flex-col"
            key={t(step.name)}
          >
            {index > 0 ? <FlowArrow /> : null}
            <Step
              dashed={step.dashed ?? false}
              detail={t(step.detail)}
              tag={step.tag}
              tone={step.tone ?? "neutral"}
            >
              {t(step.name)}
            </Step>
          </li>
        ))}
      </ol>
    </DiagramFigure>
  );
}
