import {
  automaticRunResetDeadlineSeconds,
  automaticRunResetGraceNoticeSeconds,
  estimatedDemoOccupancyCeilingSeconds,
  k6GracefulStopSeconds,
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
  title: { absolute: "Checkout-Surge: the system behind the waiting room of a flash sale" },
};
export const dynamic = "force-dynamic";

const sectionClassName =
  "scroll-mt-24 border-t border-border py-8 first:border-t-0 first:pt-0 max-[560px]:py-6";
const headingClassName = "type-title m-0 text-2xl leading-tight text-ink";
const proseClassName = "mt-3 max-w-[68ch] text-base leading-7 text-muted-strong";
const listClassName =
  "mb-0 mt-3 grid max-w-[68ch] gap-1 pl-6 text-base leading-7 text-muted-strong";
const termLinkClassName = textLinkClassName;
const occupancyCeilingMinutes = estimatedDemoOccupancyCeilingSeconds / 60;
const graceNoticeMinutes = automaticRunResetGraceNoticeSeconds / 60;
const automaticResetMinutes = automaticRunResetDeadlineSeconds / 60;

/** Measured on the hosted demo; quoted as text, not read from the API. */
const hostedMeasurements = {
  soldOutRate: "3,500",
  acceptedRate: "240",
  spikeRate: "2,600",
  surge10kP95: "between about 8 and 14 seconds",
} as const;

const contents = [
  ["waiting-room", "Behind a waiting room"],
  ["redis-fast-path", "The atomic scarcity decision"],
  ["queue-protection", "The queue protects the ERP"],
  ["real-and-simulated", "Real and simulated"],
  ["production", "What production should add"],
  ["gold-signals", "Four signals"],
  ["run-finish", "How a run finishes"],
  ["success", "What success means"],
  ["run-reset", "Admission, grace period, reset"],
  ["limits-and-source", "What limits a run"],
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
              The purchase system behind a waiting room: it sells limited stock to the buyers let
              through without overselling, while protecting a deliberately slow back-office system.
            </p>
            <p className="m-0 mt-3 max-w-[60ch] leading-6 text-muted">
              Release simulated buyers on a real API, Redis, PostgreSQL, and BullMQ stack and watch
              the run unfold live, or read on for how it works.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <TryDemoLink />
            <a className={`${neutralLinkButtonClassName} text-base`} href="#waiting-room">
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
            Choose a simulation, start it, and watch the system handle a release of buyers.
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
      <section className={sectionClassName} id="waiting-room" tabIndex={-1}>
        <h2 className={headingClassName}>Behind a waiting room</h2>
        <p className={proseClassName}>
          A popular sale does not let every buyer reach checkout at once: a virtual waiting room
          lets them through at a rate the purchase system can absorb. Checkout-Surge models the
          purchase system behind that waiting room. Its traffic is what the waiting room lets
          through in an interval: “Steady stream” is the waiting room’s steady outflow, and
          “Everyone at once” is a batch released together.*
        </p>
        <p className={proseClassName}>A real purchase journey has five steps:</p>
        <ol className={`${listClassName} list-decimal`}>
          <li>a waiting room;</li>
          <li>a fast in-memory decision that turns buyers away once the stock is gone;</li>
          <li>a temporary hold on the unit, then payment;</li>
          <li>the durable order;</li>
          <li>asynchronous fulfilment and notifications.</li>
        </ol>
        <p className={proseClassName}>
          The demo explains this journey without modelling all of it. It demonstrates the in-memory
          stock decision in Redis, which answers buyers turned away without touching the database;{" "}
          <a className={termLinkClassName} href="#idempotency">
            idempotency
          </a>
          ; asynchronous processing that protects a slow downstream system with a queue, a rate
          limit, and a circuit breaker; and no overselling.
        </p>
        <p className={proseClassName}>
          One simplification: a secured reservation creates its order at once; there is no payment
          step between them. The API records both durably in PostgreSQL before answering a buyer who
          secures a unit, which is why successful buyers wait longer for their answer than
          turned-away buyers.
        </p>
        <p className="m-0 mt-4 max-w-[68ch] text-sm leading-6 text-muted">
          * The demo’s capacity limits are measured on its host’s hardware, and it does not start
          runs the host could not handle.
        </p>
      </section>

      <section className={sectionClassName} id="redis-fast-path" tabIndex={-1}>
        <h2 className={headingClassName}>Redis makes the atomic scarcity decision</h2>
        <p className={proseClassName}>
          Every checkout attempt first asks Redis to reserve its unit in one atomic operation, so
          competing attempts cannot spend the same unit. Once the stock is gone, buyers turned away
          are answered from Redis alone, without touching the database. A buyer who secures a unit
          is answered only after the API has written its reservation and order to PostgreSQL in one
          transaction and published the order to the queue. The stock decision is fast for every
          buyer; the answer is not, because it also includes waiting for a busy API and, for
          successful buyers, the database write. Run history shows the two apart: the reservation
          timing measures the decision, the response timing measures the whole answer.
        </p>
        <p className={proseClassName}>
          Making the stock decision in the database instead would make every buyer, turned-away
          buyers included, wait for it.
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
              integration. The waiting room is not modelled: the load generator plays the traffic it
              lets through.
            </p>
          </div>
        </div>
      </section>

      <section className={sectionClassName} id="production" tabIndex={-1}>
        <h2 className={headingClassName}>What a production system should add</h2>
        <p className={proseClassName}>
          The demo leaves out what it does not aim to demonstrate. A production purchase system
          should add:
        </p>
        <ul className={`${listClassName} list-disc`}>
          <li>
            a waiting room in front of checkout, deciding how many buyers reach the purchase system
            and when;
          </li>
          <li>
            temporary holds with an expiry, then payment: unpaid holds would expire automatically
            and free their unit, and a background job would check that Redis and the database agree;
          </li>
          <li>
            several API instances, so one process no longer bounds how fast buyers are answered;
          </li>
          <li>bot protection, so the stock goes to people rather than scripts.</li>
        </ul>
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
          resolved, every reservation has reached its durable record, and every confirmed order has
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
        <h2 className={headingClassName}>What limits a run, and what makes it fail</h2>
        <p className={proseClassName}>
          The figures below are measurements of the hosted demo, from a few runs each. They describe
          that one environment, not a benchmark or a guarantee.
        </p>
        <ul className={`${listClassName} list-disc`}>
          <li>
            <strong className="text-ink">One API process.</strong> A single API process answers
            every buyer. Once the stock is gone, the hosted demo answers about{" "}
            {hostedMeasurements.soldOutRate} sold-out buyers per second from a steady stream.
          </li>
          <li>
            <strong className="text-ink">The database pool for successful buyers.</strong> Each unit
            sold is first written to the database, through a small pool of PostgreSQL connections.
            Buyers who secure a unit are answered at about {hostedMeasurements.acceptedRate} per
            second, an order of magnitude below turned-away buyers.
          </li>
          <li>
            <strong className="text-ink">Everyone at once against a steady stream.</strong> In a
            steady stream, virtual users reuse their connections. When everyone arrives at once,
            each buyer opens a new connection, which costs the API more: about{" "}
            {hostedMeasurements.spikeRate} sold-out buyers per second on the hosted demo.
          </li>
          <li>
            <strong className="text-ink">Stock.</strong> The more units a run sells, the more of its
            answers wait for the database, so the same traffic takes longer with more stock. In
            Surge 10k, where 10,000 buyers compete for 500 units, the time within which 95 percent
            of answers arrived ranged {hostedMeasurements.surge10kP95} across runs on the hosted
            demo.
          </li>
          <li>
            <strong className="text-ink">A slow ERP does not slow purchases.</strong> Only the
            worker calls the ERP. A slow or limited ERP makes the order backlog grow and drain at
            its pace, but buyers are answered before their order is confirmed: the run takes longer
            to finish, and the answers do not.
          </li>
          <li>
            <strong className="text-ink">Late answers.</strong> The load generator keeps listening
            for {k6GracefulStopSeconds} seconds after its sending window closes. If answers arrive
            later, they are not recorded and the run fails: the answers arrived too late.
          </li>
          <li>
            <strong className="text-ink">The virtual-user limit.</strong> In a steady stream, each
            virtual user waits for its answer before sending again. When answers slow down, every
            virtual user can end up waiting; the load generator then cannot keep the rate, skips
            attempts, and the run reports its virtual-user limit.
          </li>
        </ul>
        <p className={proseClassName}>
          Before a visitor’s run starts, the API compares it with these measured limits and refuses
          a run that is too heavy for the demo’s server, rather than letting it fail. Throughput and
          timing depend on the host, available resources, configuration, and competing processes. A
          local or containerized result is not a benchmark or a production-readiness claim.
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
          viewBox="0 0 980 230"
        >
          <title id="architecture-diagram-title">Checkout-Surge request and processing paths</title>
          <desc id="architecture-diagram-description">
            Simulated buyers send checkout attempts to the API. For every attempt, Redis makes the
            fast atomic stock decision, and a buyer turned away is answered after that step alone.
            For a buyer who secures a unit, the API first writes the reservation and its order to
            PostgreSQL in one transaction and publishes the order to the BullMQ queue. The worker
            takes orders from the queue to the simulated ERP and records their outcomes in
            PostgreSQL.
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
              Every attempt: atomic stock decision.
            </text>
            <text x={460} y={52}>
              Turned-away buyers are answered after this step alone.
            </text>
            <text x={300} y={112}>
              Successful buyer: order job
            </text>
            <text x={245} y={168}>
              Successful buyer:
            </text>
            <text x={245} y={182}>
              one transaction
            </text>
            <text x={560} y={182}>
              Order outcomes
            </text>
          </g>
          <DiagramNode label="Simulated buyers" x={10} y={90} />
          <DiagramNode label="API" x={170} y={90} />
          <DiagramNode label="Redis fast path" tone="fast" x={330} y={10} />
          <DiagramNode label="BullMQ queue" tone="slow" x={490} y={90} />
          <DiagramNode label="Worker" tone="slow" x={650} y={90} />
          <DiagramNode label="Simulated ERP" tone="slow" x={810} y={90} />
          <DiagramNode label="PostgreSQL" tone="durable" x={410} y={160} />
        </svg>
      </section>
      <figcaption className="mt-2 text-sm leading-6 text-muted">
        Buyers turned away: Redis only. Buyers who secure a unit: the Redis decision, then one
        PostgreSQL transaction and a queue publish before the answer. Slow path: the worker confirms
        queued orders with the simulated ERP and records their outcomes in PostgreSQL.
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
      "Finishing a run after traffic stops: queued work, retries, uncertain ERP calls, reservations awaiting their durable record, and missing simulated emails must all be settled before the run completes.",
    ],
    [
      "pending-reservation",
      "Reservation awaiting its durable record",
      "A unit Redis has reserved whose reservation and order PostgreSQL has not recorded yet, for example while the database is briefly unavailable. Recovery records it later, and a run cannot finish while one remains.",
    ],
    [
      "reservation-vs-confirmation",
      "Reservation versus confirmation",
      "A reservation secures scarce stock in one fast decision and creates its order at once; confirmation is the later successful order state after queued processing. Failure is a separate durable outcome.",
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
