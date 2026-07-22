"use client";

import {
  adminDeleteRunHistoryResponseSchema,
  type RunHistorySummary,
} from "@checkout-surge/contracts";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { adminRunHistoryProxyPath } from "../lib/control-paths";
import { ConfirmationDialog } from "./confirmation-dialog";

const deleteAllToken = "DELETE_ALL_RUN_SUMMARIES";
type DeleteIntent = { kind: "selected"; runIds: string[] } | { kind: "all" };

export function RunHistoryAdminControls({ summaries }: { summaries: RunHistorySummary[] }) {
  const router = useRouter();
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [intent, setIntent] = useState<DeleteIntent | null>(null);
  const [deleteAllConfirmation, setDeleteAllConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const visibleRunIds = useMemo(() => summaries.map((summary) => summary.runId), [summaries]);

  function closeDialog() {
    if (isSubmitting) return;
    setIntent(null);
    setDeleteAllConfirmation("");
    setError(null);
  }

  async function confirmDelete() {
    if (!intent || isSubmitting) return;
    const body =
      intent.kind === "all"
        ? { deleteAllConfirmation }
        : { runIds: intent.runIds, visibleFilter: { runIds: visibleRunIds } };
    setIsSubmitting(true);
    setError(null);
    try {
      let response: Response;
      try {
        response = await fetch(adminRunHistoryProxyPath, {
          method: "DELETE",
          cache: "no-store",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Run History deletion failed.");
        return;
      }
      const payload = await response.json().catch(() => null);
      if (response.status === 401) {
        setIntent(null);
        setSelectedRunIds(new Set());
        setDeleteAllConfirmation("");
        setError(null);
        setStatusMessage(null);
        router.refresh();
        return;
      }
      if (!response.ok) {
        setError(errorMessageFromPayload(payload, "Run History deletion failed."));
        return;
      }
      const parsed = adminDeleteRunHistoryResponseSchema.safeParse(payload);
      if (!parsed.success) {
        setError("Deletion response did not match the shared contract.");
        return;
      }
      setStatusMessage(`Deleted ${parsed.data.deletedSummaryCount} run summaries.`);
      setSelectedRunIds(new Set());
      setIntent(null);
      setDeleteAllConfirmation("");
      router.refresh();
    } finally {
      setIsSubmitting(false);
    }
  }

  const selectedCount = selectedRunIds.size;
  return (
    <section className="mt-4 rounded-lg border border-border bg-surface p-4">
      <div className="mb-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Admin history cleanup</p>
        <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">Protected deletion</h2>
      </div>
      <div className="grid gap-3">
        {summaries.map((summary) => (
          <label
            className="flex min-w-0 items-center gap-2 text-sm font-semibold text-muted-strong"
            key={summary.runId}
          >
            <input
              aria-label={`Select run ${summary.runId}`}
              checked={selectedRunIds.has(summary.runId)}
              onChange={() =>
                setSelectedRunIds((current) => {
                  const next = new Set(current);
                  next.has(summary.runId) ? next.delete(summary.runId) : next.add(summary.runId);
                  return next;
                })
              }
              type="checkbox"
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {summary.presetName} · {summary.runId}
            </span>
          </label>
        ))}
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <button
            className="min-h-10 rounded-lg border border-danger bg-danger-soft px-3.5 py-2.5 font-semibold text-danger disabled:opacity-60"
            disabled={selectedCount === 0}
            onClick={() => {
              setError(null);
              setIntent({ kind: "selected", runIds: Array.from(selectedRunIds) });
            }}
            type="button"
          >
            Delete Selected ({selectedCount})
          </button>
          <button
            className="min-h-10 rounded-lg border border-danger bg-danger-soft px-3.5 py-2.5 font-semibold text-danger"
            onClick={() => {
              setError(null);
              setIntent({ kind: "all" });
            }}
            type="button"
          >
            Delete All Run Summaries
          </button>
        </div>
        {statusMessage ? (
          <p className="m-0 text-sm font-semibold text-muted-strong">{statusMessage}</p>
        ) : null}
      </div>
      <ConfirmationDialog
        confirmDisabled={intent?.kind === "all" && deleteAllConfirmation !== deleteAllToken}
        confirmLabel={intent?.kind === "all" ? "Delete all summaries" : "Delete selected summaries"}
        description={
          intent?.kind === "all"
            ? "Permanently delete every run summary. This cannot be undone."
            : `Permanently delete ${intent?.runIds.length ?? 0} selected run summaries. This cannot be undone.`
        }
        error={error}
        onCancel={closeDialog}
        onConfirm={() => void confirmDelete()}
        open={intent !== null}
        pending={isSubmitting}
        title={
          intent?.kind === "all" ? "Delete all run summaries?" : "Delete selected run summaries?"
        }
      >
        {intent?.kind === "all" ? (
          <label className="grid gap-1 text-sm font-semibold text-muted-strong">
            <span>Type {deleteAllToken} to confirm</span>
            <input
              className="min-h-10 rounded-lg border border-border bg-bg px-3 py-2 text-ink"
              onChange={(event) => setDeleteAllConfirmation(event.target.value)}
              value={deleteAllConfirmation}
            />
          </label>
        ) : null}
      </ConfirmationDialog>
    </section>
  );
}

function errorMessageFromPayload(payload: unknown, fallback: string): string {
  return typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
    ? payload.message
    : fallback;
}
