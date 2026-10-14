"use client";

import { useTranslation } from "../lib/i18n/locale-context";

import { dangerLinkButtonClassName } from "./control-styles";
import { useRunHistoryRowAdmin } from "./run-history-admin-context";

/** Renders nothing for visitors, leaving the public pagination bar untouched. */
export function RunHistoryDeleteAllButton() {
  const t = useTranslation();
  const admin = useRunHistoryRowAdmin();
  if (!admin) return null;

  return (
    <button className={dangerLinkButtonClassName} onClick={admin.requestDeleteAll} type="button">
      {t("Delete all run summaries")}
    </button>
  );
}
