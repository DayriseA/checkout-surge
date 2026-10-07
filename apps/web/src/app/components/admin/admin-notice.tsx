"use client";

import type { AdminNotice } from "../../lib/presentation/admin-notice";
import { ErrorNotice } from "../error-notice";

export function AdminNoticeView({
  notice,
  onRetry,
  startRequestOutcome = false,
}: {
  notice: AdminNotice | null;
  onRetry?: () => void;
  /** Set when the notice presents the outcome of a submitted run start. */
  startRequestOutcome?: boolean;
}) {
  return (
    <>
      <p
        className={
          typeof notice === "string"
            ? "m-0 mt-4 text-sm font-semibold text-muted-strong"
            : "sr-only"
        }
        role="status"
      >
        {typeof notice === "string" ? notice : ""}
      </p>
      {notice && typeof notice !== "string" ? (
        <ErrorNotice
          context={
            startRequestOutcome
              ? { surface: "admin-operation", startRequestOutcome: true }
              : "admin-operation"
          }
          {...(onRetry ? { onRetry } : {})}
          protectedDetails
          read={notice.read}
        />
      ) : null}
    </>
  );
}
