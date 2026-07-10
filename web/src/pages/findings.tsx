import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { allFindings, models, slices, type BrowsableFinding } from "@/lib/data";
import { SEVERITY_ORDER, type Severity } from "@/lib/schema";
import { modelColorVar, severityColorVar, severityLabel } from "@/lib/utils";
import { FilterChip } from "@/components/filter-chip";
import { FindingRow } from "@/components/finding-row";
import { Card } from "@/components/ui/card";

/**
 * Every finding of a dataset (self-audit by default) in one filterable list.
 * Filters live in the URL so views can be shared/bookmarked.
 */
export function FindingsView({
  showHeader = true,
  findings = allFindings,
}: {
  showHeader?: boolean;
  findings?: BrowsableFinding[];
}) {
  const [params, setParams] = useSearchParams();

  const selectedModels = params.getAll("model");
  const selectedSeverities = params.getAll("severity") as Severity[];
  const selectedSlices = params.getAll("slice").map(Number);
  const includeNotes = params.get("notes") === "1";

  function toggle(key: string, value: string) {
    const next = new URLSearchParams(params);
    const current = next.getAll(key);
    next.delete(key);
    for (const v of current.filter((v) => v !== value)) next.append(key, v);
    if (!current.includes(value)) next.append(key, value);
    setParams(next, { replace: true });
  }

  const filtered = useMemo(
    () =>
      findings
        .filter((f) => (includeNotes ? true : f.tier === "finding"))
        .filter((f) => selectedModels.length === 0 || selectedModels.includes(f.model))
        .filter((f) => selectedSeverities.length === 0 || selectedSeverities.includes(f.severity))
        .filter(
          (f) => selectedSlices.length === 0 || f.slices.some((s) => selectedSlices.includes(s)),
        )
        .sort(
          (a, b) =>
            SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
            a.model.localeCompare(b.model) ||
            a.code.localeCompare(b.code, undefined, { numeric: true }),
        ),
    [findings, selectedModels, selectedSeverities, selectedSlices, includeNotes],
  );

  return (
    <div className="space-y-6">
      {showHeader && (
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Findings</h1>
          <p className="mt-1 text-sm text-ink-2">
            All self-audit findings, cross-model. Each row expands to the full section from its
            source report.
          </p>
        </header>
      )}

      <div className="space-y-2.5">
        <FilterGroup label="Agent">
          {models.map((model) => (
            <FilterChip
              key={model.id}
              active={selectedModels.includes(model.id)}
              onClick={() => toggle("model", model.id)}
              swatch={modelColorVar(model.id)}
            >
              {model.name}
            </FilterChip>
          ))}
        </FilterGroup>
        <FilterGroup label="Severity">
          {SEVERITY_ORDER.filter((s) => s !== "info").map((severity) => (
            <FilterChip
              key={severity}
              active={selectedSeverities.includes(severity)}
              onClick={() => toggle("severity", severity)}
              swatch={severityColorVar[severity]}
            >
              {severityLabel[severity]}
            </FilterChip>
          ))}
          <FilterChip
            active={includeNotes}
            onClick={() => {
              const next = new URLSearchParams(params);
              if (includeNotes) next.delete("notes");
              else next.set("notes", "1");
              setParams(next, { replace: true });
            }}
          >
            + lower-confidence notes
          </FilterChip>
        </FilterGroup>
        <FilterGroup label="Area">
          {slices.map((slice) => (
            <FilterChip
              key={slice.id}
              active={selectedSlices.includes(slice.id)}
              onClick={() => toggle("slice", String(slice.id))}
            >
              S{slice.id} {slice.name}
            </FilterChip>
          ))}
        </FilterGroup>
      </div>

      <p className="font-mono text-xs text-ink-3" role="status">
        {filtered.length} of {findings.length} findings
      </p>

      <Card>
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-3">
            No findings match these filters — clear a chip or two above.
          </p>
        ) : (
          filtered.map((finding) => <FindingRow key={finding.id} finding={finding} />)
        )}
      </Card>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-16 shrink-0 font-mono text-[0.65rem] tracking-[0.15em] text-ink-3 uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}
