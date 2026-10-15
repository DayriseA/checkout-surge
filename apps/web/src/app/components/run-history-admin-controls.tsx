"use client";

import { deleteAllRunHistoryConfirmationToken } from "@checkout-surge/contracts";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import { getTranslation, type Locale } from "../lib/i18n/translate";
import { adminMessageText } from "../lib/presentation/admin-notice";
import { AdminNoticeView } from "./admin/admin-notice";
import { ConfirmationDialog } from "./confirmation-dialog";
import { buttonClassName, dangerLinkButtonClassName, inputClassName } from "./control-styles";
import { RunHistoryAdminProvider } from "./run-history-admin-context";
import { type DeleteIntent, useRunHistoryDeletion } from "./use-run-history-deletion";

interface RunHistoryAdminControlsProps {
  visibleRunIds: string[];
  children?: ReactNode;
  showBulkControls?: boolean;
  showSelectionToolbar?: boolean;
}

export function RunHistoryAdminControls({
  visibleRunIds,
  children,
  showBulkControls = true,
  showSelectionToolbar = true,
}: RunHistoryAdminControlsProps) {
  const t = useTranslation();
  const locale = useLocale();
  const deletion = useRunHistoryDeletion(visibleRunIds);
  const selectedCount = deletion.selectedRunIds.size;
  const allVisibleSelected =
    visibleRunIds.length > 0 && visibleRunIds.every((runId) => deletion.selectedRunIds.has(runId));

  const rowAdmin = useMemo(
    () => ({
      isSelected: (runId: string) => deletion.selectedRunIds.has(runId),
      toggleSelection: deletion.toggleSelection,
      requestRunDeletion: (runId: string, presetName: string) =>
        deletion.openIntent({
          kind: "runs",
          runIds: [runId],
          description: {
            messageKey: "run summary “{value1}” ({value2})",
            values: { value1: presetName, value2: runId },
          },
        }),
      requestDeleteAll: () => deletion.openIntent({ kind: "all" }),
    }),
    [deletion.openIntent, deletion.selectedRunIds, deletion.toggleSelection],
  );

  return (
    <RunHistoryAdminProvider value={rowAdmin}>
      {showBulkControls ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-muted-strong">
            <input
              aria-label={t("Select all visible runs")}
              checked={allVisibleSelected}
              className="size-4 cursor-pointer accent-danger"
              onChange={deletion.toggleAllVisible}
              ref={(node) => {
                if (node) node.indeterminate = selectedCount > 0 && !allVisibleSelected;
              }}
              type="checkbox"
            />
            {t("Select all visible (")}
            {visibleRunIds.length})
          </label>
          <p aria-live="polite" className="m-0 text-sm text-muted">
            {deletion.statusMessage}
          </p>
        </div>
      ) : null}

      {children}

      {showSelectionToolbar && selectedCount > 0 ? (
        <div className="sticky bottom-6 z-40 ml-auto mt-3 w-fit flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-xl">
          <p className="m-0 text-sm font-semibold text-muted-strong">
            {t("{count} selected", { count: selectedCount })}
          </p>
          <button
            className={`${buttonClassName} px-3 py-2 text-sm`}
            onClick={deletion.clearSelection}
            type="button"
          >
            {t("Clear")}
          </button>
          <button
            className={dangerLinkButtonClassName}
            onClick={() =>
              deletion.openIntent({
                kind: "runs",
                runIds: Array.from(deletion.selectedRunIds),
                description: {
                  messageKey: "{value1} selected run summaries",
                  values: { value1: { count: selectedCount } },
                },
              })
            }
            type="button"
          >
            {t("Delete selected (")}
            {selectedCount})
          </button>
        </div>
      ) : null}

      <ConfirmationDialog
        confirmDisabled={
          deletion.intent?.kind === "all" &&
          deletion.deleteAllConfirmation !== deleteAllRunHistoryConfirmationToken
        }
        confirmLabel={confirmLabel(deletion.intent, locale)}
        description={
          deletion.intent?.kind === "all"
            ? t("Permanently delete every run summary. This cannot be undone.")
            : t("Permanently delete {value1}. This cannot be undone.", {
                value1:
                  deletion.intent?.kind === "runs"
                    ? typeof deletion.intent.description === "string"
                      ? t(deletion.intent.description)
                      : adminMessageText(deletion.intent.description, locale)
                    : "",
              })
        }
        error={deletion.error ? <AdminNoticeView notice={deletion.error} /> : null}
        onCancel={deletion.closeIntent}
        onConfirm={() => void deletion.confirmDelete()}
        open={deletion.intent !== null}
        pending={deletion.isSubmitting}
        title={
          deletion.intent?.kind === "all"
            ? t("Delete all run summaries?")
            : t("Delete run summaries?")
        }
      >
        {deletion.intent?.kind === "all" ? (
          <label className="grid gap-1 text-sm font-semibold text-muted-strong">
            <span>
              {t("Type")} {deleteAllRunHistoryConfirmationToken} {t("to confirm")}
            </span>
            <input
              className={inputClassName}
              onChange={(event) => deletion.setDeleteAllConfirmation(event.target.value)}
              value={deletion.deleteAllConfirmation}
            />
          </label>
        ) : null}
      </ConfirmationDialog>
    </RunHistoryAdminProvider>
  );
}

function confirmLabel(intent: DeleteIntent | null, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  if (intent?.kind === "all") return t("Delete all summaries");
  return intent?.runIds.length === 1 ? t("Delete run summary") : t("Delete selected summaries");
}
