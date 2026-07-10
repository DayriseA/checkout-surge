import { Link } from "react-router-dom";
import {
  browserUseTestFiles,
  findingById,
  independentFindingById,
  modelById,
} from "@/lib/data";
import type { PostFixAssessment } from "@/lib/schema";
import { Markdown } from "@/components/markdown";
import { ModelMark } from "@/components/model-mark";
import { SeverityBadge } from "@/components/severity-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const assessmentLabel: Record<PostFixAssessment, string> = {
  "self-audit-caught-but-reproduced": "survived claimed fix",
  "self-audit-missed": "self-audit blind spot",
};

const assessmentTitle: Record<PostFixAssessment, string> = {
  "self-audit-caught-but-reproduced":
    "The self-audit identified this issue class, but independent post-fix testing still reproduced it.",
  "self-audit-missed":
    "Independent post-fix testing found this issue class, and the self-audit did not identify it.",
};

/**
 * Bugs found by independent browser testers after self-audit findings were filed,
 * attempted fixes were claimed complete, and the implementation was retested.
 */
export function BrowserUseTestingView() {
  const total = browserUseTestFiles.reduce((n, file) => n + file.findings.length, 0);
  const reproduced = browserUseTestFiles.reduce(
    (n, file) =>
      n +
      file.findings.filter((f) => f.postFixAssessment === "self-audit-caught-but-reproduced")
        .length,
    0,
  );
  const missed = browserUseTestFiles.reduce(
    (n, file) =>
      n + file.findings.filter((f) => f.postFixAssessment === "self-audit-missed").length,
    0,
  );
  const codeReviewOverlap = browserUseTestFiles.reduce(
    (n, file) =>
      n +
      file.findings.filter((finding) => finding.relatedIndependentReviewFindings.length > 0)
        .length,
    0,
  );

  return (
    <div className="space-y-6">
      <header className="max-w-[70ch]">
        <h2 className="text-xl font-semibold tracking-tight">Browser-use testing</h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          A supplementary behavioral pass in which independent testers exercised each claimed-fixed
          implementation through a browser. It was intended to catch visible problems that code
          inspection might miss, not to serve as a second full review. Each entry maps back to the
          self-audit and, where applicable, to the fixed-reviewer code findings above.
        </p>
      </header>

      {total === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium">No browser-use findings recorded yet</p>
            <p className="mx-auto mt-2 max-w-[52ch] text-xs leading-relaxed text-ink-2">
              As testers exercise the implementations through a browser, record issues in{" "}
              <code className="rounded bg-wash px-1 font-mono">
                results/data/browser-use-test-findings/&lt;model&gt;.json
              </code>{" "}
              (schema in <code className="rounded bg-wash px-1 font-mono">results/data/README.md</code>).
              Set <code className="rounded bg-wash px-1 font-mono">postFixAssessment</code> and link
              related self-audit findings as evidence for the post-fix classification.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="font-mono text-xs text-ink-3">
            {total} browser-use findings · {reproduced} survived claimed fixes · {missed} self-audit
            blind spots · {codeReviewOverlap} also covered by the independent code review
          </p>
          {browserUseTestFiles
            .filter((file) => file.findings.length > 0)
            .map((file) => (
              <Card key={file.model}>
                <CardHeader>
                  <CardTitle>
                    <ModelMark modelId={file.model} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {file.findings.map((finding) => (
                    <article
                      key={finding.id}
                      className="border-b border-hairline pb-4 last:border-b-0 last:pb-0"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-ink-3">{finding.id.split(":")[1]}</span>
                        <h3 className="text-sm font-medium">{finding.title}</h3>
                        <SeverityBadge severity={finding.severity} />
                        <span className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[0.62rem] tracking-wider uppercase">
                          {finding.status}
                        </span>
                        <span
                          className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[0.62rem] tracking-wider uppercase"
                          title={assessmentTitle[finding.postFixAssessment]}
                        >
                          {assessmentLabel[finding.postFixAssessment]}
                        </span>
                      </div>
                      <Markdown className="mt-2 text-sm">{finding.description}</Markdown>
                      {finding.relatedFindingIds.length > 0 && (
                        <p className="mt-1 text-xs text-ink-3">
                          self-audit evidence:{" "}
                          {finding.relatedFindingIds.map((id, i) => {
                            const related = findingById(id);
                            const model = modelById(related.model);
                            return (
                              <span key={id}>
                                {i > 0 && ", "}
                                <Link
                                  to={`/models/${related.model}`}
                                  className="font-mono underline hover:text-ink"
                                >
                                  {model?.name} {related.code}
                                </Link>
                              </span>
                            );
                          })}
                        </p>
                      )}
                      {finding.relatedIndependentReviewFindings.length > 0 ? (
                        <div className="mt-3 rounded-md border border-hairline bg-wash/50 px-3 py-2">
                          <p className="font-mono text-[0.68rem] tracking-wider text-ink-3 uppercase">
                            Independent code-review overlap
                          </p>
                          <ul className="mt-1.5 space-y-2">
                            {finding.relatedIndependentReviewFindings.map((relation) => {
                              const related = independentFindingById(relation.findingId);
                              return (
                                <li
                                  key={relation.findingId}
                                  className="text-xs leading-relaxed text-ink-2"
                                >
                                  <Link
                                    to={`/models/${related.model}?tab=independent`}
                                    className="font-medium underline hover:text-ink"
                                  >
                                    {related.code} — {related.title}
                                  </Link>{" "}
                                  <span className="font-mono text-[0.65rem] tracking-wide text-ink-3 uppercase">
                                    {relation.relationship === "same-issue"
                                      ? "same issue"
                                      : "related symptom"}
                                  </span>
                                  <span className="block text-ink-3">{relation.note}</span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-ink-3">
                          Not reported as a matching issue in the independent code review.
                        </p>
                      )}
                    </article>
                  ))}
                </CardContent>
              </Card>
            ))}
        </>
      )}
    </div>
  );
}
