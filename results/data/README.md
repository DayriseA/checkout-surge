# Structured results data

This directory is the machine-readable layer over the reports in `results/`. The markdown reports remain the source of the full prose; these JSON files are the index the results browser (`web/`) filters, counts, and cross-references. Everything here is hand-editable; the web app validates every file against Zod schemas (`web/src/lib/schema.ts`) at load time and fails loudly on a mismatch.

## Files

| File | Contents |
|------|----------|
| `models.json` | Registry of the evaluated agent models (id, name, effort, report file). |
| `slices.json` | The eight review areas from the shared review helper; findings reference them by id. |
| `findings/<model>.auto-review.json` | One record per finding from that model's post-phase-10 self-audit. |
| `clusters.json` | Cross-model groupings of findings that describe the same underlying issue class. |
| `independent-review-findings/<model>.json` | One record per finding from the fixed-reviewer independent review of that model's post-fix branch. |
| `independent-review-clusters.json` | Cross-model groupings of independent-review findings, same shape as `clusters.json`. |
| `agentic-test-findings/<model>.json` | Bugs found by independent AI tester agents after the model self-audited, received issues for those findings, attempted fixes, and claimed completion. |
| `comparison-entries/<model>.json` | Lossless imported `C{n}` sections from each model's comparison-vs-base report. |
| `comparison-clusters.json` | Editorial groupings of semantically similar comparison entries. |

## Evaluation order

The data here assumes this chronology:

1. Each model built its own Checkout-Surge implementation.
2. Each model self-audited that implementation; those results are the `findings/<model>.auto-review.json` records.
3. The self-audit findings were filed as issues on the respective implementation branches.
4. The model agents attempted to fix their own findings and claimed completion.
5. Independent agentic exploratory testing then exercised the claimed-fixed implementations through the browser.
6. A single fixed reviewer model then code-reviewed each post-fix implementation branch using the same guide (`docs/review_helper.md`); those results are the `independent-review-findings/<model>.json` records.

Agentic test records therefore measure post-fix accountability. A finding can either be an issue class the self-audit caught but the claimed fix failed to eliminate, or an issue class the self-audit missed entirely.

Independent-review records serve a different purpose: because every self-audit was performed by the model that wrote the code, a low self-audit finding count is ambiguous (few issues, or a reviewer blind to its own issues). Holding the reviewer constant across branches makes finding counts comparable across agents. Note the review target is the *post-fix* branch state, so an independent finding count is not directly comparable to the same branch's pre-fix self-audit count — the meaningful comparisons are across branches, and per-finding against the self-audit via `relatedFindingIds`.

## Finding record

```jsonc
{
  "id": "opus-4.8:F14",        // "<model>:<code>", unique across the experiment
  "code": "F14",                // the report's own code (F{n}; N{n} for notes)
  "title": "…",                 // heading title, lightly trimmed
  "severity": "low",            // high | medium | low (info for notes)
  "tier": "finding",            // finding | note (note = lower-confidence observation)
  "slices": [2],                // review areas (see slices.json); can span two for merged findings
  "locations": ["packages/db/src/run-cleanup.ts:80-86"],
  "summary": "…"                // curated 1–3 sentence summary; full prose lives in the report
}
```

### Severity and codes

Reports follow the unified format specified in `docs/review_helper.md` (Report Format section): `F{n}` codes, one severity vocabulary (`High | Medium | Low`), and a `**Slices:**` metadata line per finding — so codes and severities here mirror the reports directly. Lower-confidence report notes are `tier: "note"` with severity `info`.

The three original reports predate the format spec and were retrofitted to it: GPT's `P1/P2/P3` priority codes became sequential `F1…F23` (P1 → High, P2 → Medium, P3 → Low), and hybrid grades (`Medium/Low`, `LOW–MEDIUM`) were collapsed to their leading term. GPT's slice tags are curated (its original report had no slice structure) — treat them as editorial.

## Clusters

A cluster groups findings across models that describe the same underlying issue **class**. Because each model audited its *own independent implementation*, membership means "this class of issue exists in that implementation and the self-audit caught it." A model's absence can mean the issue doesn't exist there, or that it went uncaught — when a report's verified-sound appendix supports the former, the cluster records it under `notObserved`.

```jsonc
{
  "id": "erp-confirm-not-idempotent",
  "title": "…",
  "description": "…",
  "confidence": "high",          // high | medium | low — how confident the grouping itself is
  "members": [ { "findingId": "opus-4.8:F18", "note": "variant details" } ],
  "notObserved": [ { "model": "glm-5.2", "note": "why absence is (or isn't) meaningful" } ]
}
```

The initial cluster mapping was AI-curated — review the `confidence` field and adjust membership freely; the app re-derives all overlap views from this file.

## Independent review findings

Source reports live under `results/independent_review/` (see the README there for report conventions) and follow the same `docs/review_helper.md` format as the self-audits. Each file records which model performed the review:

```jsonc
{
  "model": "opus-4.8",                    // the agent/branch under review
  "reviewType": "independent-review",
  "reviewer": "…",                        // the fixed reviewer model, same for every file
  "source": "independent_review/opus-4.8_independent_review.md",
  "findings": [
    {
      "id": "opus-4.8:ir-F1",             // "<model>:ir-<code>" — the ir- namespace keeps ids
                                          // globally unique vs. auto-review findings
      "code": "F1",                       // the report's own code, plain F{n}/N{n}
      "title": "…",
      "severity": "high",
      "tier": "finding",
      "slices": [1],
      "locations": ["apps/api/src/…:42"],
      "summary": "…",
      "relatedFindingIds": ["opus-4.8:F3"] // auto-review findings on the same branch covering the
                                           // same issue class; empty = the self-audit missed it
    }
  ]
}
```

Cross-model clusters of these findings go in `independent-review-clusters.json`, which has exactly the shape of `clusters.json` but whose `members[].findingId` values reference the `ir-` namespace.

## Agentic test findings

```jsonc
{
  "id": "glm-5.2:E1",            // "<model>:E<n>"
  "title": "…",
  "severity": "medium",          // same normalized scale
  "slices": [5],                 // optional
  "status": "open",              // open | confirmed | fixed | wont-fix
  "postFixAssessment": "self-audit-missed",
  // self-audit-caught-but-reproduced | self-audit-missed
  "relatedFindingIds": [],       // self-audit findings that overlap or should have covered this
  "description": "…"             // markdown allowed
}
```

These findings come from capable AI tester agents simulating real user interactions through browser use ability. Source reports follow `docs/agentic_test_report_format.md`, so the `E{n}` codes here mirror the reports directly.

`postFixAssessment` is the key post-remediation classification:

- `self-audit-caught-but-reproduced`: the model's own audit identified this issue class, the model later claimed to have fixed its self-audit issues, and independent exploratory testing still reproduced the issue or a materially equivalent variant.
- `self-audit-missed`: independent exploratory testing found the issue after the claimed-fix phase, and the self-audit did not identify the issue class.

Use `relatedFindingIds` as evidence for the classification. For `self-audit-caught-but-reproduced`, the schema requires at least one linked self-audit finding that should have covered the post-fix failure.

## Comparison entries and clusters

Source reports follow `docs/comparison_report_format.md`. Because each report was written independently, `C{n}` numbering is only meaningful inside that one report. The browser therefore stores every source section as its own entry and groups similar entries separately.

Entry files live under `comparison-entries/`, one file per model:

```jsonc
{
  "model": "gpt-5.5",
  "reviewType": "comparison-vs-base",
  "source": "comparison_vs_base/gpt-5.5_vs_base.md",
  "entries": [
    {
      "id": "gpt-5.5:C34",
      "model": "gpt-5.5",
      "code": "C34",
      "topic": "Buy response taxonomy, status codes, and retry guidance",
      "verdict": "better",
      "source": "comparison_vs_base/gpt-5.5_vs_base.md",
      "reference": "Markdown from the source section's Reference behavior block.",
      "compared": "Markdown from the Compared behavior block.",
      "rationale": "Markdown from the Verdict rationale block."
    }
  ]
}
```

Clusters live in `comparison-clusters.json`:

```jsonc
{
  "clusters": [
    {
      "id": "buy-response-contract",
      "title": "Buy response contract and taxonomy",
      "description": "HTTP buy response body shape, status-code taxonomy, pending-persistence guidance, and validation.",
      "confidence": "high",
      "members": [
        { "entryId": "glm-5.2:C5", "note": "Also covers outcome headers." },
        { "entryId": "gpt-5.5:C34" }
      ]
    }
  ]
}
```

Clustering is editorial. Prefer under-clustering to over-clustering: if two sections are only remotely similar, keep them separate. If one report splits a concern into several sections and another report combines it, a cluster may contain multiple entries from the same model. The browser renders each member entry independently so reference behavior, compared behavior, rationale, verdict, and source remain reachable.

Use the helper scripts from `web/` for mechanical imports and first-pass cluster seeding:

```bash
npm run import-comparison-report -- gpt-5.5 comparison_vs_base/gpt-5.5_vs_base.md
npm run seed-comparison-clusters
```

## Adding future reports

For new agent-generated reports, prefer emitting this JSON directly alongside the markdown prose (hand the schema above, or `web/src/lib/schema.ts`, to the agent). Then add the model to `models.json`, put the markdown under an appropriate `results/` subfolder, and set `reportFile` to that path relative to `results/` — the app picks up matching markdown by glob.
