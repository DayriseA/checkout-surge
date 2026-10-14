"use client";

import type { ReactNode } from "react";
import { useTranslation } from "../../lib/i18n/locale-context";
import { DiagramFigure, FlowArrow, Step } from "./primitives";

/**
 * V1: one purchase and its answers. The markers ① ② ③ match the practices' cards beside it.
 */
export function PurchasePathDiagram() {
  const t = useTranslation();

  return (
    <DiagramFigure
      caption={t(
        "One purchase, three moments. Every buyer gets a stock decision made in memory, and a buyer turned away is answered right there, without the database. A buyer who gets a unit is answered once the order is saved. The order then waits in a queue, and a worker has the back office confirm it at the back office's own pace. The waiting room in front is not modelled, and the back office is simulated.",
      )}
    >
      <div className="grid gap-3">
        <Lane answer={t("“Sold out”")} note={t("answered from memory")} title={t("Every buyer")}>
          <Step dashed detail={t("lets buyers in")} tag="notModelled">
            {t("Waiting room")}
          </Step>
          <FlowArrow />
          <Step detail={t("a repeat click gets the same answer")} marker="③">
            {t("Checkout")}
          </Step>
          <FlowArrow />
          <Step detail={t("in memory, in one step")} marker="①" tone="fast">
            {t("Stock decision")}
          </Step>
        </Lane>
        <Lane
          answer={t("“You got it”")}
          note={t("once the order is saved")}
          title={t("If a unit is left")}
        >
          <Step detail={t("in the database")} tone="durable">
            {t("Order saved")}
          </Step>
        </Lane>
        <Lane
          answer={t("“Confirmed”")}
          note={t("by email, simulated")}
          title={t("Then, at the back office's pace")}
        >
          <Step marker="②" tone="slow">
            {t("Order queue")}
          </Step>
          <FlowArrow />
          <Step tone="slow">{t("Worker")}</Step>
          <FlowArrow />
          <Step dashed tag="simulated">
            {t("Back office")}
          </Step>
        </Lane>
      </div>
    </DiagramFigure>
  );
}

function Lane({
  answer,
  children,
  note,
  title,
}: {
  answer: string;
  children: ReactNode;
  note: string;
  title: string;
}) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)_auto_10rem] items-center gap-3 rounded-lg bg-surface/70 p-3 max-[900px]:grid-cols-1 max-[900px]:gap-2">
      <p className="m-0 text-xs font-semibold uppercase leading-4 tracking-wide text-muted">
        {title}
      </p>
      <div className="flex items-stretch gap-2 max-[900px]:flex-col">{children}</div>
      <FlowArrow />
      <p className="m-0 grid gap-0.5 max-[900px]:justify-items-center">
        <span className="w-fit rounded-full border border-ink/70 bg-surface px-3 py-1 text-sm font-bold text-ink">
          {answer}
        </span>
        <span className="text-xs leading-4 text-muted-strong">{note}</span>
      </p>
    </div>
  );
}
