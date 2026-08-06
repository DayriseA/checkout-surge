"use client";

import { FiTrash2 } from "react-icons/fi";
import { useRunHistoryRowAdmin } from "./run-history-admin-context";

/** Renders nothing for visitors, leaving the public pagination bar untouched. */
export function RunHistoryDeleteAllButton() {
  const admin = useRunHistoryRowAdmin();
  if (!admin) return null;

  return (
    <button
      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-danger bg-danger-soft px-3.5 py-2.5 text-sm font-semibold text-danger"
      onClick={admin.requestDeleteAll}
      type="button"
    >
      <FiTrash2 aria-hidden="true" className="size-4" />
      Delete all run summaries
    </button>
  );
}
