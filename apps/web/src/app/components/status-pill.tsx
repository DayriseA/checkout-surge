import type { HealthStatus } from "@checkout-surge/contracts";

type Tone = HealthStatus | "idle" | "pending" | "blocked";

interface StatusPillProps {
  label: string;
  tone: Tone;
}

const toneClassNames: Record<Tone, string> = {
  blocked: "bg-danger-soft text-danger",
  degraded: "bg-warning-soft text-warning",
  idle: "bg-surface-muted text-muted-strong",
  ok: "bg-accent-soft text-accent",
  pending: "bg-warning-soft text-warning",
  unavailable: "bg-danger-soft text-danger",
};

export function StatusPill({ label, tone }: StatusPillProps) {
  return (
    <span
      className={`inline-flex min-h-7 items-center whitespace-nowrap rounded-full px-2 text-xs font-bold ${toneClassNames[tone]}`}
    >
      {label}
    </span>
  );
}
