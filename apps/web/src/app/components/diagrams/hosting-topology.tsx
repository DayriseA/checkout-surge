import { hostedMeasurements } from "../../lib/presentation/measured-figures";
import { DiagramFigure, type DiagramTone, FlowArrow, Step } from "./primitives";

const coreParts: readonly { label: string; tone: DiagramTone; dashed?: boolean }[] = [
  { label: "Web pages", tone: "neutral" },
  { label: "API", tone: "neutral" },
  { label: "Buy-only API pool (Redis comparison)", tone: "neutral" },
  { label: "Worker", tone: "slow" },
  { label: "Simulated ERP", tone: "slow", dashed: true },
  { label: "PostgreSQL", tone: "durable" },
  { label: "Redis", tone: "fast" },
];

const chipTone: Record<DiagramTone, string> = {
  neutral: "bg-surface-muted",
  fast: "bg-signal",
  slow: "bg-signal-soft",
  durable: "bg-accent-soft",
};

/** V8: where each part runs on Fly.io, and what wakes it. */
export function HostingTopologyDiagram() {
  return (
    <DiagramFigure
      caption={`A visitor always reaches the gate first. While the demo sleeps, the gate shows its own page and wakes the core Machine, in about ${hostedMeasurements.wakeSeconds} seconds; then it relays every request to it. The core Machine holds the whole system under test. The runner Machine holds the load generator, which the API starts for each run, so the simulated buyers never share the core's CPU. An hourly guard stops a Machine left awake or broken.`}
    >
      <div className="flex items-stretch gap-3 max-[900px]:flex-col">
        <Step detail="A browser">Visitor</Step>
        <FlowArrow />
        <Step detail="The only public address: its own pages while the core sleeps, then a relay">
          Gate
        </Step>
        <FlowArrow />
        <div className="grid flex-[2.4] content-start gap-2 rounded-lg border border-ink/70 bg-surface p-3">
          <p className="m-0 text-sm font-bold leading-5 text-ink">
            Core Machine
            <span className="font-normal text-muted-strong"> · sleeps when nobody uses it</span>
          </p>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {coreParts.map((part) => (
              <li
                className={`rounded-md border px-2 py-1 text-xs font-semibold text-ink ${chipTone[part.tone]} ${
                  part.dashed ? "border-dashed border-control-border" : "border-border"
                }`}
                key={part.label}
              >
                {part.label}
              </li>
            ))}
          </ul>
        </div>
        <FlowArrow back />
        <Step detail="The load generator (k6): started for each run, stopped after it">
          Runner Machine
        </Step>
      </div>
    </DiagramFigure>
  );
}
