export default function AboutPage() {
  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">About</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Checkout-Surge demonstrates a limited-inventory checkout path that reserves quickly,
            queues slow business work, and keeps operators synchronized through recovery reads.
          </p>
        </div>
      </header>
      <section className="mt-4 rounded-lg border border-border bg-surface p-5">
        <h2 className="m-0 text-xl font-bold text-ink">Service split</h2>
        <p className="mt-3 leading-7 text-muted-strong">
          The API owns request validation, reservation responses, health, readiness, and dashboard
          recovery. The dashboard owns the public demo view, live watch, admin console, run history,
          and this explainer. Inventory, queue, downstream confirmation, realtime telemetry, and
          load generation stay behind service boundaries so the browser remains an operator surface.
        </p>
      </section>
      <section className="mt-4 rounded-lg border border-border bg-surface p-5">
        <h2 className="m-0 text-xl font-bold text-ink">Recovery-first dashboard</h2>
        <p className="mt-3 leading-7 text-muted-strong">
          Dashboard pages render from API liveness, readiness, and recovery snapshots validated by
          shared contracts. If a service is unavailable or has no current data, the dashboard shows
          that state directly instead of hiding it behind stale numbers.
        </p>
      </section>
    </>
  );
}
