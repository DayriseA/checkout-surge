"use client";

import type { ReactNode } from "react";
import type { BackendRead } from "../lib/api";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import {
  type ErrorPresentation,
  type ErrorPresentationContext,
  type ErrorPresentationContextName,
  mapErrorPresentation,
} from "../lib/presentation/error-presentation";
import { neutralLinkButtonClassName } from "./control-styles";

export function ErrorNotice({
  read,
  context,
  presentation,
  protectedDetails = false,
  onRetry,
  className = "",
}: {
  read?: BackendRead<unknown>;
  context: ErrorPresentationContextName | ErrorPresentationContext;
  presentation?: ErrorPresentation;
  protectedDetails?: boolean;
  onRetry?: () => void;
  className?: string;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const resolvedPresentation =
    presentation ?? mapErrorPresentation(read ?? { status: "loading" }, context, locale);
  const mayShowProtectedDetails =
    protectedDetails &&
    (typeof context === "string"
      ? context === "admin-read" || context === "admin-operation"
      : context.protected === true ||
        context.surface === "admin-read" ||
        context.surface === "admin-operation");
  if (read?.status === "available" && resolvedPresentation.action.kind === "none") return null;
  if (read?.status === "loading" && !presentation) {
    return <p className="m-0 text-muted">{t(resolvedPresentation.headline)}.</p>;
  }

  const action = resolvedPresentation.action;
  const retryAction =
    onRetry && (action.kind === "retry" || action.kind === "check") ? onRetry : undefined;
  const toneClassName =
    resolvedPresentation.tone === "warning"
      ? "border-warning-line bg-warning-soft text-warning"
      : "border-danger-line bg-danger-soft text-danger";
  const actionNode: ReactNode = action.href ? (
    <a className={neutralLinkButtonClassName} href={action.href}>
      {t(action.label)}
    </a>
  ) : retryAction ? (
    <button className={neutralLinkButtonClassName} onClick={retryAction} type="button">
      {t(action.label)}
    </button>
  ) : action.kind === "retry" || action.kind === "check" ? null : action.label ? (
    <span className="font-semibold">{t(action.label)}</span>
  ) : null;

  return (
    <div
      aria-live="polite"
      className={`grid gap-1 rounded-xl border px-4 py-3 text-sm leading-6 ${toneClassName} ${className}`}
      role="alert"
    >
      <strong>{t(resolvedPresentation.headline)}</strong>
      {resolvedPresentation.explanation ? <span>{t(resolvedPresentation.explanation)}</span> : null}
      {resolvedPresentation.fieldErrors && resolvedPresentation.fieldErrors.length > 0 ? (
        <ul className="m-0 list-disc pl-5">
          {resolvedPresentation.fieldErrors.map((fieldError) => (
            <li key={`${fieldError.field}:${fieldError.message}`}>
              <strong>
                {t(fieldError.field)}
                {t(": ").trimEnd()}
              </strong>{" "}
              {t(fieldError.message)}
            </li>
          ))}
        </ul>
      ) : null}
      {actionNode ? <span>{actionNode}</span> : null}
      {mayShowProtectedDetails ? (
        <TechnicalDetails details={resolvedPresentation.technicalDetails} />
      ) : null}
    </div>
  );
}

function TechnicalDetails({
  details,
}: {
  details: ReturnType<typeof mapErrorPresentation>["technicalDetails"];
}) {
  const t = useTranslation();

  if (!details || Object.keys(details).length === 0) return null;
  return (
    <details className="mt-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted-strong">
      <summary className="disclosure font-semibold">{t("Technical details")}</summary>
      <dl className="mt-2 grid gap-1">
        {details.code ? <Detail label={t("Code")} value={details.code} /> : null}
        {details.httpStatus ? (
          <Detail label={t("HTTP status")} value={String(details.httpStatus)} />
        ) : null}
        {details.correlationId ? (
          <Detail label={t("Correlation")} value={details.correlationId} />
        ) : null}
        {details.reason ? <Detail label={t("Reason")} value={details.reason} /> : null}
      </dl>
    </details>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  const t = useTranslation();

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
      <dt>{t(label)}</dt>
      <dd className="m-0 [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}
