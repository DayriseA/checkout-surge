"use client";

import {
  adminDeleteRunHistoryResponseSchema,
  type RunHistorySummary,
} from "@checkout-surge/contracts";
import { useMemo, useState } from "react";
import { adminPassphraseHeaderName, adminRunHistoryProxyPath } from "../lib/control-paths";

interface RunHistoryAdminControlsProps {
  summaries: RunHistorySummary[];
}

export function RunHistoryAdminControls({ summaries }: RunHistoryAdminControlsProps) {
  const [adminPassphrase, setAdminPassphrase] = useState("");
  const [deleteAllConfirmation, setDeleteAllConfirmation] = useState("");
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const visibleRunIds = useMemo(() => summaries.map((summary) => summary.runId), [summaries]);

  function toggleRunId(runId: string) {
    setSelectedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  }

  async function deleteSelected() {
    const runIds = Array.from(selectedRunIds);
    if (runIds.length === 0) {
      setStatusMessage("Select at least one visible summary.");
      return;
    }

    await submitDelete({ runIds, visibleFilter: { runIds: visibleRunIds } });
  }

  async function deleteAll() {
    await submitDelete({ deleteAllConfirmation });
  }

  async function submitDelete(body: unknown) {
    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const response = await fetch(adminRunHistoryProxyPath, {
        method: "DELETE",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          [adminPassphraseHeaderName]: adminPassphrase,
        },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setStatusMessage(errorMessageFromPayload(payload));
        return;
      }

      const parsed = adminDeleteRunHistoryResponseSchema.safeParse(payload);
      if (!parsed.success) {
        setStatusMessage("Deletion response did not match the shared contract.");
        return;
      }

      setStatusMessage(`Deleted ${parsed.data.deletedSummaryCount} run summaries.`);
      setSelectedRunIds(new Set());
      window.location.reload();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="mt-4 rounded-lg border border-border bg-surface p-4">
      <div className="mb-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Admin history cleanup</p>
        <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">Protected deletion</h2>
      </div>
      <div className="grid gap-3">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 max-[700px]:grid-cols-1">
          <label className="grid gap-1 text-sm font-semibold text-muted-strong">
            <span>Admin passphrase</span>
            <input
              className="min-h-10 min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-ink"
              onChange={(event) => setAdminPassphrase(event.target.value)}
              type="password"
              value={adminPassphrase}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-muted-strong">
            <span>Delete-all confirmation</span>
            <input
              className="min-h-10 min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-ink"
              onChange={(event) => setDeleteAllConfirmation(event.target.value)}
              value={deleteAllConfirmation}
            />
          </label>
        </div>
        {summaries.length > 0 ? (
          <div className="grid gap-2 border-t border-border pt-3">
            {summaries.map((summary) => (
              <label
                className="flex min-w-0 items-center gap-2 text-sm font-semibold text-muted-strong"
                key={summary.runId}
              >
                <input
                  checked={selectedRunIds.has(summary.runId)}
                  onChange={() => toggleRunId(summary.runId)}
                  type="checkbox"
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {summary.presetName} · {summary.runId}
                </span>
              </label>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <button
            className="min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSubmitting || summaries.length === 0}
            onClick={() => {
              void deleteSelected();
            }}
            type="button"
          >
            Delete Selected
          </button>
          <button
            className="min-h-10 rounded-lg border border-danger bg-danger-soft px-3.5 py-2.5 font-semibold text-danger disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSubmitting}
            onClick={() => {
              void deleteAll();
            }}
            type="button"
          >
            Delete All
          </button>
        </div>
        {statusMessage ? (
          <p className="m-0 text-sm font-semibold text-muted-strong">{statusMessage}</p>
        ) : null}
      </div>
    </section>
  );
}

function errorMessageFromPayload(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }

  return "Run History deletion failed.";
}
