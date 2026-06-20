import type { HealthStatus } from "@checkout-surge/contracts";

type Tone = HealthStatus | "idle" | "pending" | "blocked";

interface StatusPillProps {
  label: string;
  tone: Tone;
}

export function StatusPill({ label, tone }: StatusPillProps) {
  return <span className={`statusPill statusPill-${tone}`}>{label}</span>;
}
