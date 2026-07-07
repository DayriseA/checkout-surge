# Implementation Comparison — Report Format

This document specifies the **shape** of the report you create. Follow this shape so reports stay comparable across agents and easy to process downstream.

Write one consolidated markdown report, organized as one section per compared topic.

## Topics

- **One `###` heading per topic:** `### C{n} — {Topic} ({verdict})`
  - Number topics `C1 … Cn` sequentially in document order. Never skip or reuse a code; codes are permanent once published.
  - `{verdict}` is exactly one of `better`, `same`, `worse`, `missing`, or `unknown` — lowercase, one token, no hybrids (`same/worse`). It grades the compared implementation relative to the reference, per the criteria in your task instructions. Use `missing` when the compared implementation has no counterpart for the topic at all, and `unknown` when you could not determine enough to grade it (say why in the body). If a verdict sits between two grades, pick one and argue the nuance in the body.
- **Use this required body structure for every topic:**

#### Reference behavior

Write clear natural-language prose first. Explain how the reference implementation behaves and why that matters for this topic. Do **not** put long chains of file references inline in the prose.

**References:**
- `checkout-forge/path/to/file.ts:12` — short label for what this line proves.
- `checkout-forge/path/to/other-file.ts:34` — another short evidence label.

#### Compared behavior

Write clear natural-language prose first. Explain how the compared implementation behaves, including meaningful differences from the reference. Do **not** put long chains of file references inline in the prose.

**References:**
- `checkout-surge/path/to/file.ts:56` — short label for what this line proves.
- `checkout-surge/path/to/other-file.ts:78` — another short evidence label.

#### Verdict rationale

Explain the concrete differences that led to the grade. This should be readable without opening the referenced files. Put nuance here when a verdict is close, but still choose exactly one allowed verdict.

---

- **Evidence formatting rules:**
  - Use repo-relative references such as `checkout-forge/apps/api/src/server.ts:42`, not absolute local paths.
  - Keep references out of normal prose unless a single inline reference is genuinely clearer.
  - Prefer 2-6 high-signal references per behavior section. Do not cite every line that supports an obvious point.
  - If many adjacent lines in one file matter, cite the first line and describe the block in the label rather than listing every line.
  - A human reader should be able to skim the prose and skip the `References` blocks without losing the argument.
- **Keep one topic per section** — if a topic splits into independently gradable parts, make them separate `C{n}` sections rather than mixing verdicts inside one.
- **Cross-references** to other topics use their codes (`see C4`), never prose numbering ("the second comparison").

## Recommended extras

- An index table near the top: `| Code | Topic | Verdict |`.
- A closing `## Appendix — Scope and caveats` section noting anything that limited the comparison (areas not examined, parts of either codebase you could not run or verify), so an `unknown` or an absent topic is distinguishable from an oversight.
