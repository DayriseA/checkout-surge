# Issue 10 - Restrict generated-run cleanup to generated sale offers

Status: Fixed

## Recommended Order Rationale

After lifecycle/reset terminal data is reliable, cleanup can safely be tightened to avoid deleting catalog data referenced by malformed, legacy, or manually repaired runs.

## Ownership Boundary

- API maintenance service cleanup
- DB ownership checks around generated-run sale context

## Problem

`cleanupOldRuns()` collects `saleOfferId` from every deletable terminal run and deletes `sale_offers` by ID only. It does not verify generated-run ownership through `demo_run_sale_contexts` or `sale_offers.purpose = 'generated_run'`.

## Task

Constrain cleanup deletes:

- Collect generated sale offers through verified `demo_run_sale_contexts` rows, or
- Add `sale_offers.purpose = 'generated_run'` to the delete condition, preferably with context validation.
- Leave catalog sale offers untouched even if a terminal run references one.

## Acceptance Criteria

- Cleanup never deletes a catalog sale offer.
- Generated-run-owned sale offers are still cleaned up when eligible.
- Malformed or legacy references fail safely.

## Tests

Add a cleanup regression test proving a terminal run that references a catalog offer does not delete that offer.
