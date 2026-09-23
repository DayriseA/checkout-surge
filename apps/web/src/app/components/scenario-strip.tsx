import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";
import { deriveRunConfigFacts } from "../lib/presentation/run-config-presentation";

export function ScenarioStrip({ configSnapshot }: { configSnapshot: AcceptedRunConfigSnapshot }) {
  const facts = deriveRunConfigFacts(configSnapshot);
  return (
    <section className="col-span-12 rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
      <p className="m-0 text-xs font-medium text-muted">Scenario settings</p>
      <h2 className="type-title m-0 mt-0.5 text-lg leading-tight text-ink">
        What this run was configured to test
      </h2>
      <dl className="m-0 mt-4 grid grid-cols-6 gap-3 max-[900px]:grid-cols-3 max-[560px]:grid-cols-2">
        <Fact label={facts.demandLabel} value={facts.demandValue} />
        <Fact label="Starting stock" value={facts.startingStock} />
        <Fact label="Simulated ERP delay" value={facts.erpDelay} />
        <Fact label="Simulated ERP capacity" value={facts.erpCapacity} />
        <Fact label="Duplicate attempts" value={facts.duplicateAttempts} />
        <Fact label="Worker concurrency / backpressure" value={facts.workerBackpressure} />
      </dl>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-xs font-medium text-muted">{label}</dt>
      <dd className="m-0 text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}
