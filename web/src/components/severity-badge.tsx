import type { Severity } from "@/lib/schema";
import { cn, severityColorVar, severityLabel } from "@/lib/utils";

/**
 * Severity chip: colored dot + text label in ink (color never alone).
 * Pass `raw` to also show the report's verbatim grade when it differs.
 */
export function SeverityBadge({
  severity,
  raw,
  className,
}: {
  severity: Severity;
  raw?: string;
  className?: string;
}) {
  const showRaw = raw && raw.toLowerCase() !== severity && severity !== "info";
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
      {showRaw && <span className="font-mono text-[0.65rem] text-ink-3">({raw})</span>}
    </span>
  );
}
