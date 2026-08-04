export default function AboutPage() {
  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">About</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Checkout-Surge simulates a flash sale: buyers arrive together, scarce inventory is
            reserved quickly, and slower order confirmation runs in the background.
          </p>
        </div>
      </header>
      <section className="mt-4 rounded-lg border border-border bg-surface p-5">
        <h2 className="m-0 text-xl font-bold text-ink">What the demo shows</h2>
        <p className="mt-3 leading-7 text-muted-strong">
          The load generator sends checkout attempts to the API. The API protects inventory and
          records durable checkout outcomes while a worker processes simulated ERP confirmation. The
          browser presents buyer actions, system behavior, and durable evidence in one story.
        </p>
      </section>
      <section className="mt-4 rounded-lg border border-border bg-surface p-5">
        <h2 className="m-0 text-xl font-bold text-ink">The load generator (k6)</h2>
        <p className="mt-3 leading-7 text-muted-strong">
          The load generator sends the scenario's checkout attempts and reports what it saw;
          Checkout-Surge records the durable reservation and order evidence separately. If a run has
          not started or an update is unavailable, the dashboard says so directly.
        </p>
      </section>
    </>
  );
}
