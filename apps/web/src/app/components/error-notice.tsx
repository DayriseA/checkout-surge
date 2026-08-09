import type { ReactNode } from "react";
import type { BackendRead } from "../lib/api";
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
  const resolvedPresentation =
    presentation ?? mapErrorPresentation(read ?? { status: "loading" }, context);
  if (read?.status === "available" && resolvedPresentation.action.kind === "none") return null;
  if (read?.status === "loading" && !presentation) {
    return <p className="m-0 text-muted">{resolvedPresentation.headline}.</p>;
  }

  const action = resolvedPresentation.action;
  const retryAction =
    onRetry && (action.kind === "retry" || action.kind === "check") ? onRetry : undefined;
  const toneClassName =
    resolvedPresentation.tone === "warning"
      ? "border-[#ecd08f] bg-warning-soft text-warning"
      : "border-[#f7b4ad] bg-danger-soft text-danger";
  const actionNode: ReactNode = action.href ? (
    <a className={neutralLinkButtonClassName} href={action.href}>
      {action.label}
    </a>
  ) : retryAction ? (
    <button className={neutralLinkButtonClassName} onClick={retryAction} type="button">
      {action.label}
    </button>
  ) : action.kind === "retry" || action.kind === "check" ? null : action.label ? (
    <span className="font-semibold">{action.label}</span>
  ) : null;

  return (
    <div
      aria-live="polite"
      className={`grid gap-1 rounded-lg border p-3 leading-6 ${toneClassName} ${className}`}
      role="alert"
    >
      <strong>{resolvedPresentation.headline}</strong>
      {resolvedPresentation.explanation ? <span>{resolvedPresentation.explanation}</span> : null}
      {resolvedPresentation.fieldErrors && resolvedPresentation.fieldErrors.length > 0 ? (
        <ul className="m-0 list-disc pl-5">
          {resolvedPresentation.fieldErrors.map((fieldError) => (
            <li key={`${fieldError.field}:${fieldError.message}`}>
              <strong>{fieldError.field}:</strong> {fieldError.message}
            </li>
          ))}
        </ul>
      ) : null}
      {actionNode ? <span>{actionNode}</span> : null}
      {protectedDetails ? (
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
  if (!details || Object.keys(details).length === 0) return null;
  return (
    <details className="mt-2 rounded border border-border bg-surface px-3 py-2 text-sm text-muted-strong">
      <summary className="cursor-pointer font-semibold">Technical details</summary>
      <dl className="mt-2 grid gap-1">
        {details.code ? <Detail label="Code" value={details.code} /> : null}
        {details.httpStatus ? (
          <Detail label="HTTP status" value={String(details.httpStatus)} />
        ) : null}
        {details.correlationId ? (
          <Detail label="Correlation" value={details.correlationId} />
        ) : null}
        {details.reason ? <Detail label="Reason" value={details.reason} /> : null}
      </dl>
    </details>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
      <dt>{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}
