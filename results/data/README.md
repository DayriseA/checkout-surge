# Structured results data

This directory is the machine-readable layer over the reports in `results/`. The markdown reports remain the source of the full prose; these JSON files are the index the results browser (`web/`) filters, counts, and cross-references. Everything here is hand-editable; the web app validates every file against Zod schemas (`web/src/lib/schema.ts`) at load time and fails loudly on a mismatch.

## Files

| File | Contents |
|------|----------|
| `models.json` | Registry of the evaluated agent models (id, name, effort, report file). |
| `slices.json` | The eight review areas from the shared review helper; findings reference them by id. |
| `findings/<model>.auto-review.json` | One record per finding from that model's post-phase-10 self-audit. |
| `clusters.json` | Cross-model groupings of findings that describe the same underlying issue class. |
| `manual-findings/<model>.json` | Bugs found by human testing of that model's implementation (empty for now). |
| `comparisons/*.json` | Per-topic implementation comparisons against the reference project (empty for now). |

## Finding record

```jsonc
{
  "id": "opus-4.8:F14",        // "<model>:<code>", unique across the experiment
  "code": "F14",                // the report's own label (F14, P2-03, N1 for notes)
  "title": "…",                 // heading title, lightly trimmed
  "severity": "low",            // normalized: high | medium | low | info
  "severityRaw": "Low/Medium",  // the report's own label, verbatim
  "tier": "finding",            // finding | note (note = lower-confidence, no own section)
  "slices": [2],                // review areas (see slices.json); can span two for merged findings
  "locations": ["packages/db/src/run-cleanup.ts:80-86"],
  "summary": "…"                // curated 1–3 sentence summary; full prose lives in the report
}
```

### Severity normalization

The three reports use incompatible scales, so each record carries both the verbatim label and a normalized value:

- **GPT 5.5** buckets: `P1` → `high`, `P2` → `medium`, `P3` → `low`.
- **Hybrid labels** (Opus `Medium/Low`, GLM `LOW–MEDIUM`, …) normalize to their **leading** term — the author's primary grade. The raw label is preserved for anyone who wants to weigh them differently.
- Opus's four lower-confidence notes are `tier: "note"`, severity `info`.

Slice assignment is native for Opus and GLM (their reports are slice-structured). The GPT report has no slice structure, so its slice tags are curated here from finding content — treat them as editorial.

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

## Manual findings (to fill during manual testing)

```jsonc
{
  "id": "glm-5.2:M1",            // "<model>:M<n>"
  "title": "…",
  "severity": "medium",          // same normalized scale
  "slices": [5],                 // optional
  "status": "open",              // open | confirmed | fixed | wont-fix
  "caughtInSelfAudit": false,    // the key metric: did the model's own audit see this?
  "relatedFindingIds": [],       // auto-review findings this overlaps, if any
  "description": "…"             // markdown allowed
}
```

## Comparisons (to fill during the comparison phase)

One JSON file per topic in `comparisons/`:

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

For new agent-generated reports, prefer emitting this JSON directly alongside the markdown prose (hand the schema above, or `web/src/lib/schema.ts`, to the agent). Then add the model to `models.json` and drop the files in place — the app picks up everything by glob.
