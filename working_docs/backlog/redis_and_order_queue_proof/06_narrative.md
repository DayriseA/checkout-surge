# 06 — Narrative and Decisions

**Design:** sections 1, 3.1, 5 · **Depends on:** 05

## Goal

The demo's texts explain what each comparison shows and why, honestly, and the decisions are recorded.

## Scope

- The preset texts, the overview page, the README and the architecture docs.
- The overview's "known limits" section: remove what the project now shows, and keep what it still cannot show.
- Present any simulated constraint as a simulation.
- State openly that PostgreSQL and Redis run on the API's Machine: in a real deployment they would sit about a millisecond away, which would add about the same to every answer in both modes without changing what the comparisons show (design section 3.1).
- State the Redis trade-off honestly: Redis keeps turned-away buyers off the database, but each winner costs more work, since two stores must be kept in step.
- Decision log entries for the modes, the fairness rules and the comparison-only conditions (including the amendment of HD-51), where they pass the inclusion test.

## Done When

- **Owner checkpoint D:** the owner has reviewed the texts.

## Open Points

- None.

## Working Notes

_None yet._
