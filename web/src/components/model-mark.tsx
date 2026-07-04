import { modelById } from "@/lib/data";
import { cn, modelColorVar } from "@/lib/utils";

/**
 * A model's identity: colored square + name. The square never carries meaning
 * alone — the name is always present (the yellow slot is low-contrast on light
 * surfaces by design; the label is the mitigation).
 */
export function ModelMark({
  modelId,
  className,
  detail,
}: {
  modelId: string;
  className?: string;
  detail?: boolean;
}) {
  const model = modelById(modelId);
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-[3px]"
        style={{ background: modelColorVar(modelId) }}
      />
      <span className="font-medium text-ink">{model?.name ?? modelId}</span>
      {detail && model && (
        <span className="font-mono text-xs text-ink-3">{model.effort}</span>
      )}
    </span>
  );
}
