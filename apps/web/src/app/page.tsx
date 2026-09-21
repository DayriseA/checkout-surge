import type { Metadata } from "next";
import Link from "next/link";
import { neutralLinkButtonClassName, primaryButtonClassName } from "./components/control-styles";
import { publicNarrative, publicVocabulary } from "./lib/presentation/public-vocabulary";

export const metadata: Metadata = {
  title: { absolute: "Checkout-Surge · Flash-sale checkout demo" },
};
export const dynamic = "force-dynamic";

const sectionClassName = "mt-4 rounded-lg border border-border bg-surface p-5";
const termLinkClassName = "font-semibold text-accent underline";

export default function OverviewPage() {
  return (
    <>
      <header className="rounded-lg border border-border bg-surface p-8 max-[560px]:p-5">
        <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Checkout-Surge</h1>
        <p className="mt-3 max-w-[66ch] text-lg leading-7 text-muted-strong">
          A flash-sale checkout that sells limited stock to a surge of buyers without overselling,
          while protecting a deliberately slow back-office system.
        </p>
        <p className="mt-3 max-w-[66ch] leading-6 text-muted">
          Start a simulated sale on a real API, Redis, PostgreSQL, and BullMQ stack and watch it
          unfold live, or read on for how it works.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <TryDemoLink />
          <a className={`${neutralLinkButtonClassName} text-base`} href="#failure-story">
            How it works
          </a>
        </div>
      </header>
      <TechnicalAbout />
      <section
        aria-labelledby="try-demo-heading"
        className={`${sectionClassName} flex flex-wrap items-center justify-between gap-4`}
      >
        <div>
          <h2 className="m-0 text-xl font-bold text-ink" id="try-demo-heading">
            See it under load
          </h2>
          <p className="mt-2 leading-7 text-muted-strong">
            Choose a simulation, start it, and watch a simulated flash sale unfold.
          </p>
        </div>
        <TryDemoLink />
      </section>
    </>
  );
}

function TryDemoLink() {
  return (
    <Link className={`inline-flex items-center ${primaryButtonClassName}`} href="/demo">
      Try the demo
    </Link>
  );
}

function TechnicalAbout() {
  return (
    <>
      <section className={sectionClassName} id="failure-story" tabIndex={-1}>
        <h2 className="m-0 text-xl font-bold text-ink">The flash-sale failure story</h2>
        <p className="mt-3 leading-7 text-muted-strong">
          Simulated buyers arrive together and compete for fewer units than they want. If every
          checkout waits for a slower back-office system before deciding who gets stock, requests
          pile up, buyers retry, and separate decisions can oversell the same inventory. The safe
          split is to secure the scarce unit first, then let confirmation finish asynchronously.
        </p>
      </section>

      <section className={sectionClassName} id="redis-fast-path" tabIndex={-1}>
        <h2 className="m-0 text-xl font-bold text-ink">Redis makes the atomic scarcity decision</h2>
        <p className="mt-3 leading-7 text-muted-strong">
          The API asks Redis to reserve each unit immediately in one atomic operation. Competing
          attempts therefore cannot spend the same unit, while PostgreSQL remains the durable record
          for reservations, orders, attempts, and final outcomes. Putting the initial stock decision
          on that slower database path would make every buyer wait for more durable work during the
          spike.
        </p>
        <ArchitectureDiagram />
      </section>

      <section className={sectionClassName} id="queue-protection" tabIndex={-1}>
        <h2 className="m-0 text-xl font-bold text-ink">The queue protects the simulated ERP</h2>
        <p className="mt-3 leading-7 text-muted-strong">
          Orders for unique reservations enter a BullMQ queue. Workers take that{" "}
          <a className={termLinkClassName} href="#backpressure">
            backlog
          </a>{" "}
          at a safe rate instead of forwarding the whole surge to the deliberately slow simulated
          ERP. Retries, worker limits, and the{" "}
          <a className={termLinkClassName} href="#circuit-breaker">
            circuit breaker
          </a>{" "}
          keep downstream pressure bounded while reserved work waits without being lost.
        </p>
        <p className="mt-3 leading-7 text-muted-strong">
          The worker is configured with the ERP’s declared capacity, as is common with mainstream
          ERP and SaaS APIs that publish their limits. When a downstream limit is unknown or
          variable, an adaptive client-side limiter, such as the adaptive retry mode of the AWS
          SDKs, is the appropriate technique. This demo deliberately shows the common case of a
          known limit.
        </p>
      </section>

      <section className={sectionClassName} id="real-and-simulated" tabIndex={-1}>
        <h2 className="m-0 text-xl font-bold text-ink">What is real and what is simulated</h2>
        <div className="mt-3 grid grid-cols-2 gap-4 max-[700px]:grid-cols-1">
          <div>
            <h3 className="m-0 text-base font-bold text-ink">Real demo components</h3>
            <p className="mt-2 leading-7 text-muted-strong">
              A real API, Redis, PostgreSQL, BullMQ queue, and worker runtime execute the
              reservation, durable-record, and background-processing paths.
            </p>
          </div>
          <div>
            <h3 className="m-0 text-base font-bold text-ink">Simulated business activity</h3>
            <p className="mt-2 leading-7 text-muted-strong">
              The buyers are simulated by the load generator (k6). Legacy-ERP delay, capacity,
              failures, and outages are simulated, and post-confirmation notifications are{" "}
              {publicVocabulary.notifications}. There is no production external ERP or notification
              integration.
            </p>
          </div>
        </div>
      </section>

      <section className={sectionClassName} id="gold-signals" tabIndex={-1}>
        <h2 className="m-0 text-xl font-bold text-ink">Four signals tell one causal story</h2>
        <ol className="mt-3 grid gap-3 pl-5 leading-7 text-muted-strong">
          <li>
            <strong className="text-ink">Request arrival</strong> shows checkout attempts starting
            at the load generator, so the opening surge is visible rather than inferred from
            completed responses.
          </li>
          <li>
            <strong className="text-ink">Inventory drain</strong> shows remaining stock falling from
            the starting amount as reservation quantities are secured, alongside the authoritative
            oversell result.
          </li>
          <li>
            <strong className="text-ink">Processing backlog</strong> shows reserved orders waiting
            for their first processing start, then draining as workers admit work safely.
          </li>
          <li>
            <strong className="text-ink">Confirmation convergence</strong> shows those reservations
            reaching confirmed or failed durable outcomes; reservation-to-confirmation time explains
            the expected lag.
          </li>
        </ol>
      </section>

      <section className={sectionClassName} id="success" tabIndex={-1}>
        <h2 className="m-0 text-xl font-bold text-ink">What success means</h2>
        <p className="mt-3 leading-7 text-muted-strong">
          Every unique reservation must first reach a durable confirmed or failed order outcome. A
          run completes successfully only when oversold units and failed or pending orders are all
          zero. Accepted responses can outnumber unique reservations when an{" "}
          <a className={termLinkClassName} href="#idempotency">
            idempotent
          </a>{" "}
          replay returns the original result; the final result keeps those populations distinct and
          shows their invariant proof.
        </p>
      </section>

      <section className={sectionClassName} id="limits-and-source" tabIndex={-1}>
        <h2 className="m-0 text-xl font-bold text-ink">Results are environment-dependent</h2>
        <p className="mt-3 leading-7 text-muted-strong">
          Throughput and timing depend on the host, available resources, configuration, and
          competing processes. A local or containerized result is not universal production evidence,
          a hosted benchmark, or a production-readiness claim.
        </p>
        <RepositoryLink />
      </section>

      <PublicGlossary />
    </>
  );
}

function RepositoryLink() {
  return (
    <a
      className="mt-3 inline-block font-semibold text-accent underline"
      href={publicNarrative.repositoryUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      View the Checkout-Surge repository
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function ArchitectureDiagram() {
  return (
    <figure className="m-0 mt-5">
      <p className="m-0 mb-2 text-sm text-muted">Architecture diagram scrolls sideways.</p>
      <section
        aria-label="Scrollable architecture diagram"
        className="overflow-x-auto"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The overflow region must be keyboard-scrollable.
        tabIndex={0}
      >
        <svg
          aria-labelledby="architecture-diagram-title architecture-diagram-description"
          className="h-auto min-w-[900px] w-full"
          role="img"
          viewBox="0 0 980 210"
        >
          <title id="architecture-diagram-title">Checkout-Surge request and processing paths</title>
          <desc id="architecture-diagram-description">
            Simulated buyers send requests to the API. Redis makes the fast atomic reservation
            decision. Reserved work passes through a BullMQ queue and worker to the simulated ERP,
            with PostgreSQL retaining the slow durable record.
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
          <g fill="none" markerEnd="url(#architecture-arrow)" stroke="currentColor" strokeWidth="3">
            <path d="M130 65h40" />
            <path d="M290 65h40" />
            <path d="M450 65v80h40" />
            <path d="M610 145h40" />
            <path d="M770 145h40" />
            <path d="M710 115V88H870V78" />
          </g>
          <DiagramNode label="Simulated buyers" x={10} y={35} />
          <DiagramNode label="API" x={170} y={35} />
          <DiagramNode label="Redis fast path" tone="fast" x={330} y={35} />
          <DiagramNode label="BullMQ queue" tone="slow" x={490} y={115} />
          <DiagramNode label="Worker" tone="slow" x={650} y={115} />
          <DiagramNode label="Simulated ERP" tone="slow" x={810} y={115} />
          <DiagramNode label="PostgreSQL" tone="durable" x={810} y={18} />
        </svg>
      </section>
      <figcaption className="mt-2 text-sm leading-6 text-muted">
        Fast path: atomic stock reservation in Redis. Slow path: queued processing and durable
        outcomes in PostgreSQL.
      </figcaption>
    </figure>
  );
}

function DiagramNode({
  label,
  tone = "neutral",
  x,
  y,
}: {
  label: string;
  tone?: "neutral" | "fast" | "slow" | "durable";
  x: number;
  y: number;
}) {
  const fill =
    tone === "fast"
      ? "var(--color-accent-soft)"
      : tone === "slow"
        ? "var(--color-warning-soft)"
        : tone === "durable"
          ? "var(--color-info-soft)"
          : "var(--color-surface-muted)";

  return (
    <g>
      <rect fill={fill} height="60" rx="10" stroke="currentColor" width="120" x={x} y={y} />
      <text
        fill="currentColor"
        fontSize="13"
        fontWeight="700"
        textAnchor="middle"
        x={x + 60}
        y={y + 35}
      >
        {label}
      </text>
    </g>
  );
}

function PublicGlossary() {
  const terms = [
    [
      "erp",
      "ERP",
      "Enterprise resource planning: the back-office system represented here by deliberately slow simulated behavior.",
    ],
    ["tps", "TPS", "Transactions per second; here, the simulated ERP call capacity."],
    [
      "p95",
      "p95",
      "The value that 95 percent of recorded observations are at or below for the named measurement boundary.",
    ],
    [
      "vu",
      "VU",
      "Virtual user: a reusable load-generator worker that runs scenario iterations and may run multiple checkout attempts.",
    ],
    [
      "circuit-breaker",
      "Circuit breaker",
      "Protection that pauses calls after repeated downstream failures, then probes for recovery.",
    ],
    [
      "backpressure",
      "Backpressure",
      "Limiting how quickly queued work enters a slower dependency so a surge does not overwhelm it.",
    ],
    [
      "idempotency",
      "Idempotency",
      "Repeating the same eligible request returns its original reservation instead of consuming stock again.",
    ],
    [
      "projection",
      "Projection",
      "A read-ready view assembled from authoritative run data for the dashboard.",
    ],
    [
      "recovery",
      "Recovery",
      "Rebuilding current state after a missed update, or safely retrying incomplete durable work.",
    ],
    ["drain", "Drain", "Processing queued work until the run-owned backlog returns to zero."],
    [
      "reservation-hold",
      "Reservation hold",
      "The Redis record that secures stock before the order reaches its durable outcome.",
    ],
    [
      "reservation-vs-confirmation",
      "Reservation versus confirmation",
      "Reservation secures scarce stock immediately; confirmation is the later successful order state after queued processing. Failure is a separate durable outcome.",
    ],
  ] as const;

  return (
    <section
      aria-labelledby="glossary-heading"
      className={sectionClassName}
      id="glossary"
      tabIndex={-1}
    >
      <h2 className="m-0 text-xl font-bold text-ink" id="glossary-heading">
        Glossary
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
        {terms.map(([id, term, definition]) => (
          <div className="rounded-lg bg-surface-muted p-3" id={id} key={id} tabIndex={-1}>
            <dt className="font-bold text-ink">{term}</dt>
            <dd className="m-0 mt-1 leading-6 text-muted-strong">{definition}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
