# Independent review reports

One report per evaluated implementation branch, all produced by the **same fixed reviewer model**. This is the neutral counterpart to `results/p1-10_auto_review/`: because each agent self-audited its own work there, a low self-audit finding count is ambiguous — it can mean few issues exist, or that the agent could not see its own issues. Holding the reviewer constant across branches removes the reviewer as a variable, so finding counts and severities become comparable across agents.

## Conventions

- **Review target:** the current post-fix state of each agent's implementation branch (after the agent addressed its self-audit findings and claimed completion).
- **Reviewer:** the same model, at the same effort, with the same instructions for every branch. Record the reviewer model and effort in a short preamble at the top of each report.
- **Guide and format:** reviews follow [docs/review_helper.md](../../docs/review_helper.md) — same slice scopes and the same Report Format section (`F{n}` findings, `N{n}` notes, `High | Medium | Low` severities, `**Slices:**` lines), so reports stay machine-ingestable.
- **Filenames:** `<model>_independent_review.md`, where `<model>` is the id of the branch's agent from `results/data/models.json` (e.g. `opus-4.8_independent_review.md`).
- **Structured data:** each report gets a companion `results/data/independent-review-findings/<model>.json` file — see `results/data/README.md` for the record format. Note the JSON ids are namespaced `<model>:ir-F{n}` even though the report codes are plain `F{n}`.
- The reviewer only reports; it must not modify the branch under review.
