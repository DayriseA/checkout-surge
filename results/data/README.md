# Structured results data

This directory is the machine-readable layer over the reports in `results/`. The markdown reports remain the source of the full prose; these JSON files are the index the results browser (`web/`) filters, counts, and cross-references. Everything here is hand-editable; the web app validates every file against Zod schemas (`web/src/lib/schema.ts`) at load time and fails loudly on a mismatch.

## Files

| File | Contents |
|------|----------|
| `models.json` | Registry of the evaluated agent models (id, name, effort, report file). |
| `slices.json` | The eight review areas from the shared review helper; findings reference them by id. |
| `findings/<model>.auto-review.json` | One record per finding from that model's post-phase-10 self-audit. |
| `clusters.json` | Cross-model groupings of findings that describe the same underlying issue class. |
| `agentic-test-findings/<model>.json` | Bugs found by independent AI tester agents after the model self-audited, received issues for those findings, attempted fixes, and claimed completion. |
| `comparisons/*.json` | Per-topic implementation comparisons against the reference project. |

## Evaluation order

The data here assumes this chronology:

1. Each model built its own Checkout-Surge implementation.
2. Each model self-audited that implementation; those results are the `findings/<model>.auto-review.json` records.
3. The self-audit findings were filed as issues on the respective implementation branches.
4. The model agents attempted to fix their own findings and claimed completion.
5. Independent agentic exploratory testing then exercised the claimed-fixed implementations through the browser.

Agentic test records therefore measure post-fix accountability. A finding can either be an issue class the self-audit caught but the claimed fix failed to eliminate, or an issue class the self-audit missed entirely.

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

Reports follow the unified format specified in `docs/auto_review_helper.md` (Report Format section): `F{n}` codes, one severity vocabulary (`High | Medium | Low`), and a `**Slices:**` metadata line per finding — so codes and severities here mirror the reports directly. Lower-confidence report notes are `tier: "note"` with severity `info`.

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

## Comparisons (to fill during the comparison phase)

Source reports follow `docs/comparison_report_format.md`; these records are ingested from its per-topic `C{n}` sections. One JSON file per topic in `comparisons/`:

```jsonc
{
  "id": "inventory-hot-path",
  "topic": "Inventory hot path design",
  "reference": "How the original project handles it (markdown)",
  "verdicts": { "glm-5.2": "same", "gpt-5.5": "worse", "opus-4.8": "better" },
  // verdict scale: better | same | worse | missing | unknown
  "notes": "Free-form markdown analysis"
}
```

## Adding future reports

For new agent-generated reports, prefer emitting this JSON directly alongside the markdown prose (hand the schema above, or `web/src/lib/schema.ts`, to the agent). Then add the model to `models.json`, put the markdown under an appropriate `results/` subfolder, and set `reportFile` to that path relative to `results/` — the app picks up matching markdown by glob.
