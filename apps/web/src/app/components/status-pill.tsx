import type {
  PresentationState,
  PresentationTone,
} from "../lib/presentation/run-presentation-state";

interface StatusPillProps {
  status: Pick<PresentationState, "label" | "tone">;
}

const toneClassNames: Record<PresentationTone, string> = {
  danger: "bg-danger-soft text-danger",
  idle: "bg-surface-muted text-muted-strong ring-1 ring-inset ring-border",
  ok: "bg-ok-soft text-ok",
  progress: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
};

const toneMarkers: Record<PresentationTone, string> = {
  danger: "×",
  idle: "•",
  ok: "✓",
  progress: "↻",
  warning: "!",
};

export function StatusPill({ status }: StatusPillProps) {
  return (
    <span
      className={`inline-flex min-h-6 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${toneClassNames[status.tone]}`}
    >
      <span aria-hidden="true">{toneMarkers[status.tone]}</span>
      {status.label}
    </span>
  );
}
