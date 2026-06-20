export default function AboutPage() {
  return (
    <>
      <header className="routeHeader">
        <div>
          <h1>About</h1>
          <p>
            Checkout-Surge demonstrates a limited-inventory checkout path that reserves quickly,
            queues slow business work, and keeps operators synchronized through recovery reads.
          </p>
        </div>
      </header>
      <section className="aboutBand">
        <h2>Service split</h2>
        <p>
          The API owns request validation, reservation responses, health, readiness, and dashboard
          recovery. The dashboard owns the public demo view, live watch, admin console, run history,
          and this explainer. Inventory, queue, downstream confirmation, realtime telemetry, and
          load generation stay behind service boundaries so the browser remains an operator surface.
        </p>
      </section>
      <section className="aboutBand">
        <h2>Recovery-first dashboard</h2>
        <p>
          Dashboard pages render from API liveness, readiness, and recovery snapshots validated by
          shared contracts. If a service is unavailable or has no current data, the dashboard shows
          that state directly instead of hiding it behind stale numbers.
        </p>
      </section>
    </>
  );
}
