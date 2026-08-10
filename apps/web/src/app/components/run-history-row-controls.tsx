"use client";

import { useRunHistoryRowAdmin } from "./run-history-admin-context";

interface RunHistoryRowControlsProps {
  runId: string;
  presetName: string;
  showSelection?: boolean;
}

export function RunHistoryRowControls({
  runId,
  presetName,
  showSelection = true,
}: RunHistoryRowControlsProps) {
  const admin = useRunHistoryRowAdmin();
  if (!admin) return null;

  return (
    <div className="flex shrink-0 items-center gap-2">
      {showSelection ? (
        <label className="inline-flex size-11 items-center justify-center">
          <input
            aria-label={`Select run ${runId}`}
            checked={admin.isSelected(runId)}
            className="size-4 cursor-pointer accent-danger"
            onChange={() => admin.toggleSelection(runId)}
            type="checkbox"
          />
        </label>
      ) : null}
      <button
        aria-label={`Delete run ${presetName} (${runId})`}
        className="inline-flex size-11 items-center justify-center rounded-lg border border-transparent text-muted hover:border-danger hover:bg-danger-soft hover:text-danger"
        onClick={() => admin.requestRunDeletion(runId, presetName)}
        title={`Delete run ${presetName}`}
        type="button"
      >
        <svg
          aria-hidden="true"
          className="size-4"
          fill="none"
          focusable="false"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v5" />
          <path d="M14 11v5" />
        </svg>
      </button>
    </div>
  );
}
