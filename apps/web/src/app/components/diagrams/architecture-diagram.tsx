"use client";

import { useTranslation } from "../../lib/i18n/locale-context";
import { DiagramNode } from "./primitives";

/** The buy path and the processing path, for engineers. Dense, so it scrolls sideways. */
export function ArchitectureDiagram() {
  const t = useTranslation();

  return (
    <figure className="m-0 mt-6 rounded-xl border border-border bg-surface-muted p-5 max-[560px]:p-3">
      <p className="m-0 mb-2 text-sm text-muted min-[1100px]:sr-only">
        {t("Architecture diagram scrolls sideways.")}
      </p>
      <section
        aria-label={t("Scrollable architecture diagram")}
        className="overflow-x-auto"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The overflow region must be keyboard-scrollable.
        tabIndex={0}
      >
        <svg
          aria-labelledby="architecture-diagram-title architecture-diagram-description"
          className="h-auto min-w-[900px] w-full text-ink"
          role="img"
          viewBox="0 0 980 230"
        >
          <title id="architecture-diagram-title">
            {t("Checkout-Surge request and processing paths")}
          </title>
          <desc id="architecture-diagram-description">
            {t(
              "Simulated buyers send checkout attempts to the API. For every attempt, Redis makes the in-memory atomic stock decision, and a buyer turned away is answered after that step alone. For a buyer who secures a unit, the API first writes the reservation and its order to PostgreSQL in one transaction and publishes the order to the BullMQ queue. The worker takes orders from the queue to the simulated ERP and records their outcomes in PostgreSQL.",
            )}
          </desc>
          <defs>
            <marker
              id="architecture-arrow"
              markerHeight="8"
              markerWidth="8"
              orient="auto"
              refX="7"
              refY="4"
            >
              <path d="M0 0 8 4 0 8z" fill="currentColor" />
            </marker>
          </defs>
          <g fill="none" markerEnd="url(#architecture-arrow)" stroke="currentColor" strokeWidth="2">
            <path d="M130 120h40" />
            <path d="M260 90V40H330" />
            <path d="M290 120H490" />
            <path d="M230 150V190H410" />
            <path d="M610 120h40" />
            <path d="M770 120h40" />
            <path d="M710 150V190H530" />
          </g>
          <g fill="currentColor" fontSize="11">
            <text x={460} y={36}>
              {t("Every attempt: atomic stock decision.")}
            </text>
            <text x={460} y={52}>
              {t("Turned-away buyers are answered after this step alone.")}
            </text>
            <text x={300} y={112}>
              {t("Successful buyer: order job")}
            </text>
            <text x={245} y={168}>
              {t("Successful buyer:")}
            </text>
            <text x={245} y={182}>
              {t("one transaction")}
            </text>
            <text x={560} y={182}>
              {t("Order outcomes")}
            </text>
          </g>
          <DiagramNode label={t("Simulated buyers")} x={10} y={90} />
          <DiagramNode label={t("API")} x={170} y={90} />
          <DiagramNode label={t("Redis decision")} tone="fast" x={330} y={10} />
          <DiagramNode label={t("BullMQ queue")} tone="slow" x={490} y={90} />
          <DiagramNode label={t("Worker")} tone="slow" x={650} y={90} />
          <DiagramNode label={t("Simulated ERP")} tone="slow" x={810} y={90} />
          <DiagramNode label={t("PostgreSQL")} tone="durable" x={410} y={160} />
        </svg>
      </section>
      <figcaption className="mt-2 text-sm leading-6 text-muted">
        {t(
          "Buyers turned away: Redis only. Buyers who secure a unit: the Redis decision, then one PostgreSQL transaction and a queue publish before the answer. Slow path: the worker confirms queued orders with the simulated ERP and records their outcomes in PostgreSQL.",
        )}
      </figcaption>
    </figure>
  );
}
