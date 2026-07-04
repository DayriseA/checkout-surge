import type { Severity } from "@/lib/schema";
import { cn, severityColorVar, severityLabel } from "@/lib/utils";

/** Severity chip: colored dot + text label in ink (color never alone). */
export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-hairline px-2 py-0.5 text-xs font-medium text-ink-2",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ background: severityColorVar[severity] }}
      />
      {severityLabel[severity]}
    </span>
  );
}
