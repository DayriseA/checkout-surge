"use client";

import type { MouseEvent } from "react";
import { useTranslation } from "../lib/i18n/locale-context";
import { neutralLinkButtonClassName } from "./control-styles";

export function ReportMeasurementsLink({ targetId }: { targetId: string }) {
  const t = useTranslation();

  function revealMeasurements(event: MouseEvent<HTMLAnchorElement>) {
    const target = document.getElementById(targetId);
    if (!target) return;

    event.preventDefault();
    const disclosure = target.querySelector("details");
    if (disclosure) disclosure.open = true;
    target.focus();
  }

  return (
    <a className={neutralLinkButtonClassName} href={`#${targetId}`} onClick={revealMeasurements}>
      {t("View technical measurements")}
    </a>
  );
}
