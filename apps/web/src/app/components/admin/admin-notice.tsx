"use client";
import { useLocale, useTranslation } from "../../lib/i18n/locale-context";
import { type AdminNotice, adminMessageText } from "../../lib/presentation/admin-notice";
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
  const t = useTranslation();
  const locale = useLocale();
  const message =
    typeof notice === "string"
      ? t(notice)
      : notice?.kind === "message"
        ? adminMessageText(notice, locale)
        : null;
  return (
    <>
      <p
        className={
          message !== null ? "m-0 mt-4 text-sm font-semibold text-muted-strong" : "sr-only"
        }
        role="status"
      >
        {message ?? ""}
      </p>
      {notice && typeof notice !== "string" && notice.kind === "failure" ? (
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
