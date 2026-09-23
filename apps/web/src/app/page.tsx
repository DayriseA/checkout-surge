import {
  automaticRunResetDeadlineSeconds,
  automaticRunResetGraceNoticeSeconds,
  estimatedDemoOccupancyCeilingSeconds,
} from "@checkout-surge/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import {
  neutralLinkButtonClassName,
  primaryButtonClassName,
  textLinkClassName,
} from "./components/control-styles";
import { publicNarrative, publicVocabulary } from "./lib/presentation/public-vocabulary";

export const metadata: Metadata = {
  title: { absolute: "Checkout-Surge · Flash-sale checkout demo" },
};
export const dynamic = "force-dynamic";

const sectionClassName =
  "scroll-mt-24 border-t border-border py-8 first:border-t-0 first:pt-0 max-[560px]:py-6";
const headingClassName = "type-title m-0 text-2xl leading-tight text-ink";
const proseClassName = "mt-3 max-w-[68ch] text-base leading-7 text-muted-strong";
const termLinkClassName = textLinkClassName;
const occupancyCeilingMinutes = estimatedDemoOccupancyCeilingSeconds / 60;
const graceNoticeMinutes = automaticRunResetGraceNoticeSeconds / 60;
const automaticResetMinutes = automaticRunResetDeadlineSeconds / 60;

const contents = [
  ["failure-story", "The failure story"],
  ["redis-fast-path", "Atomic scarcity"],
  ["queue-protection", "Protecting the ERP"],
  ["real-and-simulated", "Real and simulated"],
  ["gold-signals", "Four signals"],
  ["run-finish", "How a run finishes"],
  ["success", "What success means"],
  ["run-reset", "Admission and reset"],
  ["limits-and-source", "Limits"],
  ["glossary", "Glossary"],
] as const;

export default function OverviewPage() {
  return (
    <>
      <header className="grid gap-8 pb-10 pt-6 max-[560px]:pb-8 max-[560px]:pt-2">
        <SurgeBand />
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-10 gap-y-6 max-[900px]:grid-cols-1">
          <div>
            <h1 className="type-display m-0 text-[clamp(2.75rem,7.5vw,5.75rem)] leading-[0.92] text-ink">
              Checkout-Surge
            </h1>
            <p className="m-0 mt-5 max-w-[46ch] text-xl leading-8 text-ink max-[560px]:text-lg max-[560px]:leading-7">
              A flash-sale checkout that sells limited stock to a surge of buyers without
              overselling, while protecting a deliberately slow back-office system.
            </p>
            <p className="m-0 mt-3 max-w-[60ch] leading-6 text-muted">
              Start a simulated sale on a real API, Redis, PostgreSQL, and BullMQ stack and watch it
              unfold live, or read on for how it works.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <TryDemoLink />
            <a className={`${neutralLinkButtonClassName} text-base`} href="#failure-story">
              How it works
            </a>
          </div>
        </div>
      </header>
      <div className="grid grid-cols-[13rem_minmax(0,1fr)] items-start gap-10 rounded-2xl border border-border bg-surface px-10 py-10 max-[900px]:grid-cols-1 max-[900px]:gap-6 max-[900px]:px-6 max-[900px]:py-8 max-[560px]:px-4">
        <nav
          aria-label="On this page"
          className="sticky top-24 grid gap-0.5 text-sm max-[900px]:hidden"
        >
          <p className="m-0 mb-2 text-sm font-semibold text-ink">On this page</p>
          {contents.map(([id, label]) => (
            <a
              className="rounded-md border-l-2 border-border py-1 pl-3 text-muted hover:border-accent hover:text-ink"
              href={`#${id}`}
              key={id}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="min-w-0">
          <TechnicalAbout />
        </div>
      </div>
      <section
        aria-labelledby="try-demo-heading"
        className="mt-6 flex flex-wrap items-center justify-between gap-5 rounded-2xl bg-reservoir px-10 py-8 text-white max-[900px]:px-6 max-[560px]:px-4"
      >
        <div>
          <h2 className="type-title m-0 text-2xl text-white" id="try-demo-heading">
            See it under load
          </h2>
          <p className="m-0 mt-1 leading-7 text-white/75">
            Choose a simulation, start it, and watch a simulated flash sale unfold.
          </p>
        </div>
        <TryDemoLink onDark />
      </section>
    </>
  );
}

/**
 * The hero's signature: a dense, uneven surge of arrivals meets one gate and leaves as an evenly
 * spaced line, the same shape as the brand mark. Decorative only.
 */
function SurgeBand() {
  const arrivalCount = 56;
  const arrivals = Array.from({ length: arrivalCount }, (_, index) => {
    const progress = index / (arrivalCount - 1);
    const jitter = 0.55 + 0.45 * Math.abs(Math.sin(index * 2.3));
    return { height: 10 + 90 * progress ** 1.3 * jitter, opacity: 0.2 + progress * 0.7 };
  });
  return (
    <div aria-hidden="true" className="flex h-16 items-center gap-4 max-[560px]:h-12">
      <div className="flex h-full flex-[3] items-center justify-between">
        {arrivals.map((arrival, index) => (
          <span
            className="block w-[3px] rounded-full bg-ink max-[560px]:w-[2px]"
            // biome-ignore lint/suspicious/noArrayIndexKey: A fixed decorative sequence.
            key={index}
            style={{ height: `${arrival.height}%`, opacity: arrival.opacity }}
          />
        ))}
      </div>
      <span className="block h-full w-2.5 shrink-0 rounded-sm bg-signal" />
      <div className="flex h-full flex-[2] items-center justify-between pl-1">
        {Array.from({ length: 12 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: A fixed decorative sequence.
          <span className="block size-1.5 rounded-full bg-ink" key={index} />
        ))}
      </div>
    </div>
  );
}

function TryDemoLink({ onDark = false }: { onDark?: boolean }) {
  return (
    <Link
      className={
        onDark
          ? "inline-flex min-h-11 items-center rounded-lg bg-signal px-5 py-2 text-base font-semibold text-ink transition-colors hover:bg-[#ffc94d] focus-visible:outline-signal"
          : `${primaryButtonClassName} px-5 text-base`
      }
      href="/demo"
    >
      Try the demo
    </Link>
  );
}

function TechnicalAbout() {
  return (
    <>
      <section className={sectionClassName} id="failure-story" tabIndex={-1}>
        <h2 className={headingClassName}>The flash-sale failure story</h2>
        <p className={proseClassName}>
          Simulated buyers arrive together and compete for fewer units than they want. If every
          checkout waits for a slower back-office system before deciding who gets stock, requests
          pile up, buyers retry, and separate decisions can oversell the same inventory. The safe
          split is to secure the scarce unit first, then let confirmation finish asynchronously.
        </p>
      </section>

      <section className={sectionClassName} id="redis-fast-path" tabIndex={-1}>
        <h2 className={headingClassName}>Redis makes the atomic scarcity decision</h2>
        <p className={proseClassName}>
          The API asks Redis to reserve each unit immediately in one atomic operation. Competing
          attempts therefore cannot spend the same unit, while PostgreSQL remains the durable record
          for reservations, orders, attempts, and final outcomes. Putting the initial stock decision
          on that slower database path would make every buyer wait for more durable work during the
          spike.
        </p>
        <ArchitectureDiagram />
      </section>

      <section className={sectionClassName} id="queue-protection" tabIndex={-1}>
        <h2 className={headingClassName}>The queue protects the simulated ERP</h2>
        <p className={proseClassName}>
          Orders for unique reservations enter a BullMQ queue. Workers take that{" "}
          <a className={termLinkClassName} href="#backpressure">
            backlog
          </a>{" "}
          at a safe rate instead of forwarding the whole surge to the deliberately slow simulated
          ERP. Retries, worker limits, and the{" "}
          <a className={termLinkClassName} href="#circuit-breaker">
            circuit breaker
          </a>{" "}
          keep downstream pressure bounded. Reserved work waits in the queue rather than being
          dropped; the one deliberate exception is a{" "}
          <a className={termLinkClassName} href="#run-reset">
            run reset
          </a>
          , which discards the whole run.
        </p>
        <p className={proseClassName}>
          The worker is configured with the ERP’s declared capacity, as is common with mainstream
          ERP and SaaS APIs that publish their limits. When a downstream limit is unknown or
          variable, an adaptive client-side limiter, such as the adaptive retry mode of the AWS
          SDKs, is the appropriate technique. This demo deliberately shows the common case of a
          known limit.
        </p>
        <p className={proseClassName}>
          An ERP call can also end without a usable answer, such as a timeout. The worker never
          retries such an{" "}
          <a className={termLinkClassName} href="#uncertain-result">
            uncertain result
          </a>{" "}
          blindly: it first asks the ERP’s durable confirmation ledger whether that idempotency key
          already succeeded or was rejected, and replays the request with the same key only when the
          ERP has no record of it. That is what keeps a retry from creating a second order.
        </p>
      </section>

      <section className={sectionClassName} id="real-and-simulated" tabIndex={-1}>
        <h2 className={headingClassName}>What is real and what is simulated</h2>
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border max-[700px]:grid-cols-1">
          <div className="bg-surface p-5">
            <h3 className="m-0 flex items-center gap-2 text-base font-bold text-ink">
              <span aria-hidden="true" className="size-2.5 rounded-full bg-ok" />
              Real demo components
            </h3>
            <p className="mb-0 mt-2 leading-7 text-muted-strong">
              A real API, Redis, PostgreSQL, BullMQ queue, and worker runtime execute the
              reservation, durable-record, and background-processing paths.
            </p>
          </div>
          <div className="bg-surface p-5">
            <h3 className="m-0 flex items-center gap-2 text-base font-bold text-ink">
              <span aria-hidden="true" className="size-2.5 rounded-full bg-signal" />
              Simulated business activity
            </h3>
            <p className="mb-0 mt-2 leading-7 text-muted-strong">
              The buyers are simulated by the load generator (k6). Legacy-ERP delay, capacity,
              failures, and outages are simulated, and post-confirmation notifications are{" "}
              {publicVocabulary.notifications}. There is no production external ERP or notification
              integration.
            </p>
          </div>
        </div>
      </section>

      <section className={sectionClassName} id="gold-signals" tabIndex={-1}>
        <h2 className={headingClassName}>Four signals tell one causal story</h2>
        <ol className="mt-4 grid max-w-[68ch] list-none gap-4 p-0 leading-7 text-muted-strong [counter-reset:signal] [&>li]:relative [&>li]:pl-10 [&>li]:[counter-increment:signal] [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:top-0.5 [&>li]:before:grid [&>li]:before:size-7 [&>li]:before:place-items-center [&>li]:before:rounded-full [&>li]:before:bg-ink [&>li]:before:text-xs [&>li]:before:font-bold [&>li]:before:text-white [&>li]:before:content-[counter(signal)]">
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

      <section className={sectionClassName} id="run-finish" tabIndex={-1}>
        <h2 className={headingClassName}>How a run finishes</h2>
        <p className={proseClassName}>
          Once the load generator has sent its last attempt, the run enters a finishing phase and
          stops accepting new traffic. An empty queue is not the end. The run completes only when
          nothing is queued, processing, or waiting to retry, every uncertain ERP call has been
          resolved, every Redis hold has reached its durable record, and every confirmed order has
          its simulated email recorded. This phase has no elapsed-time deadline; the only time-based
          stop is the automatic reset described below.
        </p>
      </section>

      <section className={sectionClassName} id="success" tabIndex={-1}>
        <h2 className={headingClassName}>What success means</h2>
        <p className={proseClassName}>
          Every unique reservation must first reach a durable confirmed or failed order outcome. A
          run completes successfully only when the finishing phase has settled every remaining
          obligation and oversold units and failed or pending orders are all zero. Accepted
          responses can outnumber unique reservations when an{" "}
          <a className={termLinkClassName} href="#idempotency">
            idempotent
          </a>{" "}
          replay returns the original result; the final result keeps those populations distinct and
          shows their invariant proof.
        </p>
      </section>

      <section className={sectionClassName} id="run-reset" tabIndex={-1}>
        <h2 className={headingClassName}>Admission, grace period, and reset</h2>
        <p className={proseClassName}>
          Before a run starts, the API estimates how long the chosen configuration would occupy the
          demo and rejects it when that conservative estimate exceeds the demo limit of at most{" "}
          {occupancyCeilingMinutes} minutes. The estimate serves admission only: an accepted run
          that overruns it is neither stopped nor failed. From {graceNoticeMinutes} minutes after
          acceptance the dashboard shows a grace-period notice if the run is still unfinished. A run
          still unfinished at {automaticResetMinutes} minutes is reset automatically so the next
          visitor can start. An admin can also reset a run manually. Either reset stops all demo
          work immediately and discards the run’s data; one history line marked as cancelled
          remains.
        </p>
      </section>

      <section className={sectionClassName} id="limits-and-source" tabIndex={-1}>
        <h2 className={headingClassName}>Results are environment-dependent</h2>
        <p className={proseClassName}>
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
      className={`mt-3 inline-block ${textLinkClassName}`}
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
    <figure className="m-0 mt-6 rounded-xl border border-border bg-surface-muted p-5 max-[560px]:p-3">
      <p className="m-0 mb-2 text-sm text-muted min-[1100px]:sr-only">
        Architecture diagram scrolls sideways.
      </p>
      <section
        aria-label="Scrollable architecture diagram"
        className="overflow-x-auto"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The overflow region must be keyboard-scrollable.
        tabIndex={0}
      >
        <svg
          aria-labelledby="architecture-diagram-title architecture-diagram-description"
          className="h-auto min-w-[900px] w-full text-ink"
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
          <g fill="none" markerEnd="url(#architecture-arrow)" stroke="currentColor" strokeWidth="2">
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
      ? "var(--color-signal)"
      : tone === "slow"
        ? "var(--color-signal-soft)"
        : tone === "durable"
          ? "var(--color-accent-soft)"
          : "var(--color-surface)";

  return (
    <g>
      <rect
        fill={fill}
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
      "Repeating the same eligible request returns its original result instead of acting again: a replayed checkout returns its reservation, and a replayed ERP call cannot create a second order.",
    ],
    [
      "uncertain-result",
      "Uncertain result",
      "An ERP call whose outcome never reached the worker. It is verified against the ERP’s confirmation ledger before any replay.",
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
    [
      "drain",
      "Drain",
      "Finishing a run after traffic stops: queued work, retries, uncertain ERP calls, pending holds, and missing simulated emails must all be settled before the run completes.",
    ],
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
      <h2 className={headingClassName} id="glossary-heading">
        Glossary
      </h2>
      <dl className="mb-0 mt-4 grid grid-cols-2 gap-x-10 max-[700px]:grid-cols-1">
        {terms.map(([id, term, definition]) => (
          <div className="scroll-mt-24 border-t border-border py-3" id={id} key={id} tabIndex={-1}>
            <dt className="font-bold text-ink">{term}</dt>
            <dd className="m-0 mt-1 text-sm leading-6 text-muted-strong">{definition}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
