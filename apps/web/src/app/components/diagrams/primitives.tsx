"use client";

import type { ReactNode } from "react";
import { useTranslation } from "../../lib/i18n/locale-context";

/**
 * Shared pieces of the content pages' visuals. Colors come from the design tokens only: signal
 * for the fast path, signal-soft for the slow one, accent-soft for durable stores, and a dashed
 * outline for anything simulated or not modelled.
 */
export type DiagramTone = "neutral" | "fast" | "slow" | "durable";

const toneFill: Record<DiagramTone, string> = {
  neutral: "var(--color-surface)",
  fast: "var(--color-signal)",
  slow: "var(--color-signal-soft)",
  durable: "var(--color-accent-soft)",
};

const toneClassName: Record<DiagramTone, string> = {
  neutral: "bg-surface",
  fast: "bg-signal",
  slow: "bg-signal-soft",
  durable: "bg-accent-soft",
};

/**
 * A visual with its caption. The caption names and describes it for every reader, so the
 * drawing itself can stay decorative where it repeats the caption.
 */
export function DiagramFigure({
  caption,
  children,
  className = "",
}: {
  caption: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure
      className={`m-0 mt-6 rounded-xl border border-border bg-surface-muted p-5 max-[560px]:p-3 ${className}`}
    >
      {children}
      <figcaption className="mt-4 max-w-[80ch] text-sm leading-6 text-muted">{caption}</figcaption>
    </figure>
  );
}

export type StepTag = "shown" | "compared" | "simplified" | "simulated" | "notModelled";

const tagLabel: Record<StepTag, string> = {
  shown: "Shown live",
  compared: "Compared live",
  simplified: "Simplified",
  simulated: "Simulated",
  notModelled: "Not modelled",
};

const tagClassName: Record<StepTag, string> = {
  shown: "bg-accent-soft text-accent",
  compared: "bg-signal text-ink",
  simplified: "border border-control-border text-muted-strong",
  simulated: "border border-dashed border-control-border text-muted-strong",
  notModelled: "border border-dashed border-control-border text-muted",
};

/** What the demo does with a practice or a step: shown, compared, simplified, simulated, or not. */
export function Tag({ kind }: { kind: StepTag }) {
  const t = useTranslation();

  return (
    <span
      className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-semibold leading-4 ${tagClassName[kind]}`}
    >
      {t(tagLabel[kind])}
    </span>
  );
}

/** A step of an HTML diagram. Dashed when the step is simulated or not modelled. */
export function Step({
  children,
  detail,
  marker,
  tag,
  tone = "neutral",
  dashed = false,
}: {
  children: ReactNode;
  detail?: ReactNode;
  marker?: string;
  tag?: StepTag;
  tone?: DiagramTone;
  dashed?: boolean;
}) {
  return (
    <div
      className={`grid min-w-0 flex-1 content-start gap-1 rounded-lg border px-3 py-2.5 ${toneClassName[tone]} ${
        dashed ? "border-dashed border-control-border" : "border-ink/70"
      }`}
    >
      <p className="m-0 text-sm font-bold leading-5 text-ink">
        {marker ? <span className="mr-1.5">{marker}</span> : null}
        {children}
      </p>
      {detail ? <p className="m-0 text-xs leading-4 text-muted-strong">{detail}</p> : null}
      {tag ? <Tag kind={tag} /> : null}
    </div>
  );
}

/**
 * An arrow between steps: rightwards (or leftwards with `back`), turning to point down (or up)
 * once the diagram stacks below 900 px.
 */
export function FlowArrow({ back = false }: { back?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`size-4 shrink-0 self-center justify-self-center text-ink ${
        back ? "rotate-180 max-[900px]:-rotate-90" : "max-[900px]:rotate-90"
      }`}
      viewBox="0 0 16 16"
    >
      <path d="M2 8h10M8 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}

/** A horizontal bar, as a share of its track. */
export function Bar({
  share,
  className = "bg-accent",
}: {
  /** From 0 to 1. A non-zero share always shows at least a sliver. */
  share: number;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className="block h-2.5 min-w-0 rounded-full bg-border/60">
      <span
        className={`block h-full min-w-[3px] rounded-full ${className}`}
        style={{ width: `${Math.min(1, share) * 100}%` }}
      />
    </span>
  );
}

/** A labelled box of an SVG diagram. */
export function DiagramNode({
  label,
  tone = "neutral",
  x,
  y,
}: {
  label: string;
  tone?: DiagramTone;
  x: number;
  y: number;
}) {
  const t = useTranslation();

  return (
    <g>
      <rect
        fill={toneFill[tone]}
        height="60"
        rx="8"
        stroke="currentColor"
        strokeWidth="1.5"
        width="120"
        x={x}
        y={y}
      />
      <text
        fill="currentColor"
        fontSize="13"
        fontWeight="650"
        textAnchor="middle"
        x={x + 60}
        y={y + 35}
      >
        {t(label)}
      </text>
    </g>
  );
}
