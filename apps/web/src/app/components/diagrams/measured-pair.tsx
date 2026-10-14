"use client";

import { useLocale, useTranslation } from "../../lib/i18n/locale-context";
import {
  type ComparisonMeasurement,
  formatFigure,
  formatRange,
  type PairedFigure,
} from "../../lib/presentation/measured-figures";
import { Bar } from "./primitives";

/**
 * V2 and V7: one measured figure of a comparison, as two bars of the two runs' medians, each
 * labelled with its run and value. `showRange` adds the lowest and highest pair.
 */
export function MeasuredPair({
  figure,
  runLabels,
  showRange = false,
}: {
  figure: PairedFigure;
  runLabels: ComparisonMeasurement["runLabels"];
  showRange?: boolean;
}) {
  const locale = useLocale();

  const t = useTranslation();

  const runs = [
    { spread: figure.first, barClassName: "bg-accent" },
    { spread: figure.second, barClassName: "bg-muted" },
  ] as const;
  const largest = Math.max(figure.first[0], figure.second[0]);
  return (
    <div className="min-w-0">
      <p className="m-0 text-sm font-semibold leading-5 text-ink">{t(figure.label)}</p>
      <dl className="m-0 mt-2 grid gap-2">
        {runs.map(({ spread, barClassName }, index) => (
          <div className="grid gap-0.5" key={t(runLabels[index as 0 | 1])}>
            <dt className="text-xs leading-4 text-muted-strong">
              {t(runLabels[index as 0 | 1])}
              {showRange ? (
                <span className="text-muted">
                  {" "}
                  {t("· pairs ranged ")}
                  {formatRange(spread, figure.format, locale)}
                </span>
              ) : null}
            </dt>
            <dd className="m-0 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
              <Bar className={barClassName} share={spread[0] / largest} />
              <span className="text-sm font-semibold text-ink">
                {formatFigure(spread[0], figure.format, locale)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The full figures of a comparison: each run's median and range, for engineers. */
export function MeasurementTable({
  caption,
  figures,
  runLabels,
}: {
  caption: string;
  figures: readonly PairedFigure[];
  runLabels: ComparisonMeasurement["runLabels"];
}) {
  const locale = useLocale();

  const t = useTranslation();

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <caption className="mb-2 text-left text-sm leading-6 text-muted">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-xs text-muted">
            <th className="py-2 pr-4 font-semibold" scope="col">
              {t("Figure")}
            </th>
            {runLabels.map((label) => (
              <th className="py-2 pr-4 font-semibold" key={t(label)} scope="col">
                {t(label)}
                {t(", median (range)")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {figures.map((figure) => (
            <tr className="border-b border-border last:border-b-0" key={t(figure.label)}>
              <th className="py-2 pr-4 font-normal text-muted-strong" scope="row">
                {t(figure.label)}
              </th>
              {[figure.first, figure.second].map((spread, index) => (
                <td
                  className="whitespace-nowrap py-2 pr-4 text-ink"
                  key={t(runLabels[index as 0 | 1])}
                >
                  <span className="font-semibold">
                    {formatFigure(spread[0], figure.format, locale)}
                  </span>
                  <span className="text-muted">
                    {" "}
                    ({formatRange(spread, figure.format, locale)})
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
