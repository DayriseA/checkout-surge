# Exploratory Test Session — Report Format

This document specifies the **shape** of the report you create. Follow this shape so reports stay comparable across testing agents and easy to process downstream.

Write one consolidated markdown report. How you organize working notes during the session is up to you; only the final report must follow this shape.

## Findings

- **One `###` heading per finding:** `### E{n} — {Title} ({Severity})`
  - Number findings `E1 … En` sequentially in document order. Never skip or reuse a code; codes are permanent once published.
  - `{Severity}` is exactly one of `High`, `Medium`, or `Low`. No hybrid grades (`Low–Medium`), no qualifiers inside the parentheses, no other scales (`P1`, `blocker`). If a finding sits between two grades, pick the one that matches its real impact and argue the nuance in the body.
- **Body is free-form**, but cover:
  - **What happens** — observed behavior versus what you expected.
  - **Reproduction** — the exact steps that trigger it, starting from a describable state, so someone else can replay the session.
  - **Where** — the page, URL, or endpoint involved; quote relevant on-screen text, console errors, or response payloads as evidence.
  - **Impact** — who hits this and how bad it is.
- **Lower-confidence observations** — things you could not reliably reproduce, or are not sure are actually bugs — go in their own section as `### N{n} — {Title}` entries (no severity grade). They are notes, not findings; keep them out of finding totals.
- **Grouping is free** — by severity, by area of the app, or in discovery order; the codes carry the semantics either way.
- **Cross-references** to other findings use their codes (`see E3`), never prose numbering ("the third bug").

## Recommended extras

- An index table near the top: `| Code | Finding | Severity |`.
- A closing `## Appendix — Session coverage` section listing the surfaces and flows you exercised and found sound, so the absence of a finding is distinguishable from the absence of testing.
