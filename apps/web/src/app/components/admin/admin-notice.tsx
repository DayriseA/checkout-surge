"use client";

import type { AdminNotice } from "../../lib/presentation/admin-notice";
import { ErrorNotice } from "../error-notice";

export function AdminNoticeView({
  notice,
  onRetry,
}: {
  notice: AdminNotice | null;
  onRetry?: () => void;
}) {
  if (!notice) return null;
  if (typeof notice === "string") {
    return <p className="m-0 mt-4 text-sm font-semibold text-muted-strong">{notice}</p>;
  }
  return (
    <ErrorNotice
      context="admin-operation"
      {...(onRetry ? { onRetry } : {})}
      protectedDetails
      read={notice.read}
    />
  );
}
