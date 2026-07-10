import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import {
  findingById,
  modelById,
  reportMarkdown,
  sliceById,
  sourceMarkdown,
  type BrowsableFinding,
} from "@/lib/data";
import { extractSection } from "@/lib/report-sections";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { ModelMark } from "./model-mark";
import { SeverityBadge } from "./severity-badge";

/**
 * One finding, collapsed to a scannable row; expands in place to the finding's
 * full section extracted from the source report. Handles both self-audit
 * findings and independent-review findings — the latter carry their own
 * `source` report and a self-audit caught/missed relation.
 */
export function FindingRow({
  finding,
  showModel = true,
  defaultOpen = false,
}: {
  finding: BrowsableFinding;
  showModel?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <article className="border-b border-hairline last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "grid w-full grid-cols-[auto_1fr] items-baseline gap-x-3 px-3 py-2.5 text-left",
          "hover:bg-wash focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink",
        )}
      >
        <span className="flex items-center gap-2 self-center">
          <ChevronRight
            aria-hidden
            className={cn("size-3.5 text-ink-3 transition-transform", open && "rotate-90")}
          />
          <span className="w-14 font-mono text-xs text-ink-3">{finding.code}</span>
        </span>
        <span>
          <span className="text-sm leading-snug font-medium text-ink">{finding.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {showModel && <ModelMark modelId={finding.model} className="text-xs" />}
            <SeverityBadge severity={finding.severity} />
            {finding.slices.map((sliceId) => (
              <span key={sliceId} className="font-mono text-[0.68rem] tracking-wide text-ink-3 uppercase">
                S{sliceId} · {sliceById(sliceId)?.name}
              </span>
            ))}
            {"relatedFindingIds" in finding &&
              (finding.relatedFindingIds.length > 0 ? (
                <span className="font-mono text-[0.68rem] tracking-wide text-ink-3 uppercase">
                  self-audit · caught
                </span>
              ) : (
                <span
                  className="font-mono text-[0.68rem] tracking-wide uppercase"
                  style={{ color: "var(--sev-medium)" }}
                >
                  self-audit · missed
                </span>
              ))}
          </span>
        </span>
      </button>
      {open && <FindingDetail finding={finding} />}
    </article>
  );
}

function FindingDetail({ finding }: { finding: BrowsableFinding }) {
  const model = modelById(finding.model);

  const section = useMemo(() => {
    if ("source" in finding) return extractSection(sourceMarkdown(finding.source), finding.code);
    if (!model) return null;
    return extractSection(reportMarkdown(model), finding.code);
  }, [model, finding]);

  return (
    <div className="border-t border-dashed border-hairline bg-wash/50 px-4 pt-3 pb-4 pl-12">
      <p className="max-w-prose text-sm leading-relaxed text-ink-2">{finding.summary}</p>
      {finding.locations.length > 0 && (
        <ul className="mt-3 space-y-0.5">
          {finding.locations.map((location) => (
            <li key={location} className="font-mono text-xs break-all text-ink-3">
              {location}
            </li>
          ))}
        </ul>
      )}
      {"relatedFindingIds" in finding &&
        (finding.relatedFindingIds.length > 0 ? (
          <div className="mt-3">
            <p className="font-mono text-xs tracking-wider text-ink-3 uppercase">
              Same issue class in the self-audit
            </p>
            <div className="mt-1.5 rounded-md border border-hairline bg-surface">
              {finding.relatedFindingIds.map((id) => (
                <FindingRow key={id} finding={findingById(id)} showModel={false} />
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-3 max-w-prose text-xs leading-relaxed text-ink-3">
            No self-audit finding covers this issue class — the branch's own review did not report
            it.
          </p>
        ))}
      {section ? (
        <details className="mt-3">
          <summary className="cursor-pointer font-mono text-xs tracking-wider text-ink-3 uppercase hover:text-ink">
            Full section from the report
          </summary>
          <div className="mt-2 max-w-[75ch] rounded-md border border-hairline bg-surface px-4 py-1">
            <Markdown>{section}</Markdown>
          </div>
        </details>
      ) : (
        <p className="mt-3 text-xs text-ink-3">
          Section not located in the report.{" "}
          <Link
            to={`/models/${finding.model}?tab=${"source" in finding ? "independent-report" : "report"}`}
            className="underline hover:text-ink"
          >
            Open the report
          </Link>
        </p>
      )}
    </div>
  );
}
