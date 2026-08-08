"use client";

import { FiTrash2 } from "react-icons/fi";
import { dangerLinkButtonClassName } from "./control-styles";
import { useRunHistoryRowAdmin } from "./run-history-admin-context";

/** Renders nothing for visitors, leaving the public pagination bar untouched. */
export function RunHistoryDeleteAllButton() {
  const admin = useRunHistoryRowAdmin();
  if (!admin) return null;

  return (
    <button
      className={dangerLinkButtonClassName}
      onClick={admin.requestDeleteAll}
      type="button"
    >
      <FiTrash2 aria-hidden="true" className="size-4" />
      Delete all run summaries
    </button>
  );
}
