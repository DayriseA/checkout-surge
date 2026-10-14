"use client";

import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import { deriveRunConfigFacts } from "../lib/presentation/run-config-presentation";

export function ScenarioStrip({ configSnapshot }: { configSnapshot: AcceptedRunConfigSnapshot }) {
  const t = useTranslation();
  const locale = useLocale();
  const facts = deriveRunConfigFacts(configSnapshot, locale);
  return (
    <section className="col-span-12 rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
      <p className="m-0 text-xs font-medium text-muted">{t("Scenario settings")}</p>
      <h2 className="type-title m-0 mt-0.5 text-lg leading-tight text-ink">
        {t("What this run was configured to test")}
      </h2>
      <dl className="m-0 mt-4 grid grid-cols-6 gap-3 max-[900px]:grid-cols-3 max-[560px]:grid-cols-2">
        <Fact label={facts.demandLabel} value={facts.demandValue} />
        <Fact label={t("Starting stock")} value={facts.startingStock} />
        <Fact label={t("Simulated ERP delay")} value={facts.erpDelay} />
        <Fact label={t("Simulated ERP capacity")} value={facts.erpCapacity} />
        <Fact label={t("Duplicate attempts")} value={facts.duplicateAttempts} />
        <Fact label={t("Worker concurrency / backpressure")} value={facts.workerBackpressure} />
      </dl>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  const t = useTranslation();

  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-xs font-medium text-muted">{t(label)}</dt>
      <dd className="m-0 text-sm font-semibold text-ink">
        {typeof value === "string" ? t(value) : value}
      </dd>
    </div>
  );
}
