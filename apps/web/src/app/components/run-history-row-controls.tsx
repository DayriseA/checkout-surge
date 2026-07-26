"use client";

import { FiTrash2 } from "react-icons/fi";
import { useRunHistoryRowAdmin } from "./run-history-admin-context";

interface RunHistoryRowControlsProps {
  runId: string;
  presetName: string;
}

export function RunHistoryRowControls({ runId, presetName }: RunHistoryRowControlsProps) {
  const admin = useRunHistoryRowAdmin();
  if (!admin) return null;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <input
        aria-label={`Select run ${runId}`}
        checked={admin.isSelected(runId)}
        className="size-4 cursor-pointer accent-danger"
        onChange={() => admin.toggleSelection(runId)}
        type="checkbox"
      />
      <button
        aria-label={`Delete run ${presetName} (${runId})`}
        className="inline-flex size-8 items-center justify-center rounded-lg border border-transparent text-muted hover:border-danger hover:bg-danger-soft hover:text-danger"
        onClick={() => admin.requestRunDeletion(runId, presetName)}
        title={`Delete run ${presetName}`}
        type="button"
      >
        <FiTrash2 aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
