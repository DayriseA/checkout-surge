# Implementation Comparison — Report Format

This document specifies the **shape** of the report you create. Follow this shape so reports stay comparable across agents and easy to process downstream.

Write one consolidated markdown report, organized as one section per compared topic.

## Topics

- **One `###` heading per topic:** `### C{n} — {Topic} ({verdict})`
  - Number topics `C1 … Cn` sequentially in document order. Never skip or reuse a code; codes are permanent once published.
  - `{verdict}` is exactly one of `better`, `same`, `worse`, `missing`, or `unknown` — lowercase, one token, no hybrids (`same/worse`). It grades the compared implementation relative to the reference, per the criteria in your task instructions. Use `missing` when the compared implementation has no counterpart for the topic at all, and `unknown` when you could not determine enough to grade it (say why in the body). If a verdict sits between two grades, pick one and argue the nuance in the body.
- **Body is free-form**, but cover:
  - **Reference behavior** — how the reference handles the topic, with evidence as `path:line` references into the reference codebase.
  - **Compared behavior** — how the compared implementation handles it, with evidence as `path:line` references into that codebase.
  - **Verdict rationale** — the concrete differences that led to the grade, not just a restatement of it.
- **Keep one topic per section** — if a topic splits into independently gradable parts, make them separate `C{n}` sections rather than mixing verdicts inside one.
- **Cross-references** to other topics use their codes (`see C4`), never prose numbering ("the second comparison").

## Recommended extras

- An index table near the top: `| Code | Topic | Verdict |`.
- A closing `## Appendix — Scope and caveats` section noting anything that limited the comparison (areas not examined, parts of either codebase you could not run or verify), so an `unknown` or an absent topic is distinguishable from an oversight.
