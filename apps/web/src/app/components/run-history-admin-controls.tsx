"use client";

import { deleteAllRunHistoryConfirmationToken } from "@checkout-surge/contracts";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { FiTrash2 } from "react-icons/fi";
import { formatCount } from "../lib/presentation/format";
import { AdminNoticeView } from "./admin/admin-notice";
import { ConfirmationDialog } from "./confirmation-dialog";
import { RunHistoryAdminProvider } from "./run-history-admin-context";
import { type DeleteIntent, useRunHistoryDeletion } from "./use-run-history-deletion";

interface RunHistoryAdminControlsProps {
  visibleRunIds: string[];
  children?: ReactNode;
}

export function RunHistoryAdminControls({ visibleRunIds, children }: RunHistoryAdminControlsProps) {
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
          description: `run summary “${presetName}” (${runId})`,
        }),
      requestDeleteAll: () => deletion.openIntent({ kind: "all" }),
    }),
    [deletion.openIntent, deletion.selectedRunIds, deletion.toggleSelection],
  );

  return (
    <RunHistoryAdminProvider value={rowAdmin}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-muted-strong">
          <input
            aria-label="Select all visible runs"
            checked={allVisibleSelected}
            className="size-4 cursor-pointer accent-danger"
            onChange={deletion.toggleAllVisible}
            ref={(node) => {
              if (node) node.indeterminate = selectedCount > 0 && !allVisibleSelected;
            }}
            type="checkbox"
          />
          Select all visible ({visibleRunIds.length})
        </label>
        <p aria-live="polite" className="m-0 text-sm text-muted">
          {deletion.statusMessage}
        </p>
      </div>

      {children}

      {selectedCount > 0 ? (
        <div className="fixed bottom-6 right-6 z-40 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-xl">
          <p className="m-0 text-sm font-semibold text-muted-strong">{selectedCount} selected</p>
          <button
            className="min-h-10 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-muted-strong"
            onClick={deletion.clearSelection}
            type="button"
          >
            Clear
          </button>
          <button
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-danger bg-danger-soft px-3.5 py-2.5 text-sm font-semibold text-danger"
            onClick={() =>
              deletion.openIntent({
                kind: "runs",
                runIds: Array.from(deletion.selectedRunIds),
                description: `${formatCount(selectedCount) ?? "an unknown number of"} selected run summaries`,
              })
            }
            type="button"
          >
            <FiTrash2 aria-hidden="true" className="size-4" />
            Delete selected ({selectedCount})
          </button>
        </div>
      ) : null}

      <ConfirmationDialog
        confirmDisabled={
          deletion.intent?.kind === "all" &&
          deletion.deleteAllConfirmation !== deleteAllRunHistoryConfirmationToken
        }
        confirmLabel={confirmLabel(deletion.intent)}
        description={
          deletion.intent?.kind === "all"
            ? "Permanently delete every run summary. This cannot be undone."
            : `Permanently delete ${deletion.intent?.description ?? ""}. This cannot be undone.`
        }
        error={deletion.error ? <AdminNoticeView notice={deletion.error} /> : null}
        onCancel={deletion.closeIntent}
        onConfirm={() => void deletion.confirmDelete()}
        open={deletion.intent !== null}
        pending={deletion.isSubmitting}
        title={
          deletion.intent?.kind === "all" ? "Delete all run summaries?" : "Delete run summaries?"
        }
      >
        {deletion.intent?.kind === "all" ? (
          <label className="grid gap-1 text-sm font-semibold text-muted-strong">
            <span>Type {deleteAllRunHistoryConfirmationToken} to confirm</span>
            <input
              className="min-h-10 rounded-lg border border-border bg-bg px-3 py-2 text-ink"
              onChange={(event) => deletion.setDeleteAllConfirmation(event.target.value)}
              value={deletion.deleteAllConfirmation}
            />
          </label>
        ) : null}
      </ConfirmationDialog>
    </RunHistoryAdminProvider>
  );
}

function confirmLabel(intent: DeleteIntent | null): string {
  if (intent?.kind === "all") return "Delete all summaries";
  return intent?.runIds.length === 1 ? "Delete run summary" : "Delete selected summaries";
}
