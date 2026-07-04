import { cn } from "@/lib/utils";

export function FilterChip({
  active,
  onClick,
  children,
  swatch,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  swatch?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        active
          ? "border-ink-2 bg-ink text-paper"
          : "border-hairline bg-surface text-ink-2 hover:bg-wash",
      )}
    >
      {swatch && (
        <span aria-hidden className="size-2 rounded-full" style={{ background: swatch }} />
      )}
      {children}
    </button>
  );
}
