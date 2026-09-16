# Task 02 — Shared result summary and essential warnings

Status: Done (2026-09-16) · Depends on: [Task 01](01-public-view-foundation.md) · Next: [Task 03](03-watch-experience.md)

## Outcome

Public Watch and the public saved report share a concise, truthful result summary. It keeps material outcome and measurement warnings visible in both views, while proof and diagnostic detail can move to Advanced without changing the verdict.

## Read first

- [Design contract](design-contract.md), especially truth/vocabulary and data limits; [W06–W10 and W16–W18](state-coverage.md).
- `apps/web/src/app/components/run-conclusion.tsx`, `operator-dashboard.tsx` (`TerminalNarrative`), `run-history-detail.tsx` (`PublicRunHistoryDetail` and its admin caller), `transport-observation.tsx`.
- `apps/web/src/app/lib/presentation/run-result-presentation.ts`, `run-presentation-state.ts`, `public-vocabulary.ts`, `run-config-presentation.ts`.
- Read-only contract sources: `packages/contracts/src/demo.ts`, `dashboard-projection.ts`, `load.ts`, and the exported `deriveRunResult` implementation.
- Existing `run-result-presentation.test.ts`, `run-presentation-state.test.ts`, `public-vocabulary.test.ts`, `transport-observation.test.ts`, `run-history.test.ts`, `watch-narrative.test.tsx`.

## Work

1. Build a small public summary/presentation adapter around the existing canonical `RunResult`, not a second derivation. Expose only the concise scenario/outcome, known stock/order counts, material caveats and next-action slots needed by Watch and report.
2. Start from the existing helpers: `runConclusionSentence` already produces the plain-language verdict and `publicFailureExplanation` the failure reason and action. Extend them where the public wording needs a short title plus one sentence; do not write a parallel sentence builder. Add public-language messages for pending orders, oversell, incomplete/contradictory evidence and investigation-worthy reconciliation. Preserve severity and do not turn expected duplicate-population differences into an alarm. Do not merely show the highest-priority warning if that would hide a second material qualification.
3. Present delivery and speed-target qualifications from existing available inputs. Read `trafficDeliverySummary`, transport/reply evidence and `fastReservationTargetEvaluation` where supplied. A `qualified` target is distinct from `pass` or `fail`. Watch without saved report evidence cannot invent this evaluation.
4. Split concise conclusion from invariant/reconciliation detail. Preserve `RunConclusion`'s current admin behavior/defaults; use a narrow public composition or explicit option. Put exact expressions, actual/expected values and detailed population reasoning in Advanced, keeping their meaningful warning outside that boundary.
5. Wire the shared result into both actual public terminal call sites now (`TerminalNarrative` on Watch and the conclusion block of `PublicRunHistoryDetail`), so the task does not leave an unused component library. Touch only those conclusion blocks and remove the duplicate public verdict sentence in the report header; the rest of each page's restructuring belongs to tasks 03/04.
6. Keep counts and labels semantically correct for unknowns, zero stock, partial stock, quantity per checkout greater than one and duplicates. Do not add percentage calculations merely for decoration.

## Acceptance criteria

- Switching mode leaves the canonical result, visible essential counts and warning meaning unchanged.
- Business success with failed speed target displays both facts. Qualified measurement remains visibly qualified. Neither case becomes an order failure.
- Failed/pending orders, oversell, missing evidence and contradictory evidence are readable before technical disclosure. Unknown values are not rendered as zero or success.
- Advanced still exposes every existing public invariant and reconciliation input, with measurement bounds intact.
- Existing admin conclusion/proof rendering remains detailed regardless of any public view cookie.
- Public copy is safe; no protected error payload is introduced. No shared contract, backend or result-calculation behavior changes.

## Validation

Use a small set of contract-valid result/detail fixtures spanning the state IDs above. Assert visible summary equality across modes and Advanced evidence availability. Include business success plus target failure, qualified/missing measurement, expected duplicate differences, an incomplete result and a correctness failure. Reuse existing derivation tests; add presentation cases at the web boundary only.

Run the six listed relevant suites, new presentation tests, and common formatting/type checks. Where old tests expected proof in the default view, explicitly render Advanced or the preserved admin variant; keep the underlying evidence assertions.

## Handoff

Document the shared summary input shape and which caveats require saved-report evidence. Task 03 can retain that small public subset from an already-fetched exact report. Suggested commit subject: `feat(web): share concise public run outcomes and caveats`.

## Completion notes

- Shared summary: `derivePublicRunSummary(input)` in `apps/web/src/app/lib/presentation/public-run-summary.ts`. Input shape: `{ result: RunResult; trafficDeliveryStatus: TrafficDeliveryStatus | null; fastReservationTargetEvaluation: FastReservationTargetEvaluation | null; transportObservation: TransportObservation | null }`. Output: `{ outcome, title, sentence, counts (nine `number | null` stock/order counts, never zero for unknown), caveats: Array<{ message, tone: "warning" | "danger" }>, failure: { explanation, action } | null }`. It is a presentation adapter over the canonical `deriveRunResult` output; wording comes from `runResultOutcomeLabel`, `runConclusionSentence(result, { concise: true })` and `publicFailureExplanation`.
- Caveat rules (all material ones render, in this order): contradictory evidence (broken invariant or `correctness_failure` reconciliation, danger), reconciliation warning, incomplete evidence (`not_evaluable` invariant or `evidence_incomplete` reconciliation), incomplete reply observation (`hasUnrecordedReplies` / `hasUndispatchedAttempts`), partial or failed delivery, failed or qualified speed target (`qualified` stays distinct from `fail`; the threshold is rendered as a `≤` bound). A caveat is skipped only when the indeterminate headline already states exactly that meaning. `expected_population_difference` never produces a caveat.
- Caveats requiring saved-report evidence: only the delivery caveat (`trafficDeliverySummary.trafficDeliveryStatus`) and the speed-target caveat (`fastReservationTargetEvaluation`). Live Watch passes `null` for both and never invents them; the reply-observation caveat comes from live `transportAttemptCounts` + `httpSummary.transportFailures` via `deriveTransportObservation`, available on both surfaces. Task 03 can retain exactly those two saved-report fields from the already-fetched exact report.
- Concise verdict: `runConclusionSentence(result, { concise: true })` returns the outcome headline plus the existing order sentence whenever failed or pending orders are known and non-zero and the headline does not already state them (W07/W16). The default form is unchanged.
- Component: `PublicRunConclusion` in `apps/web/src/app/components/run-conclusion.tsx` renders title, concise sentence and caveats outside the Advanced boundary, and the full narration, `ReconciliationStatus`, invariant rows with actual/expected values and the reconciliation proof inside `AdvancedOnly`. `RunConclusion` (admin) is unchanged apart from the internal `ConclusionEvidence` extraction and the removal of the now-unused `showSentence` prop. `AdvancedOnly` now renders visibly when no `PageView` context exists, so surfaces without a public view control stay detailed.
- Wired into `TerminalNarrative` (Watch) and the conclusion block of `PublicRunHistoryDetail`; the duplicate verdict sentence was removed from the public report header. Page restructuring is left to tasks 03/04.
- Tests: `apps/web/test/public-run-summary.test.tsx` (adapter cases for success + failed target, qualified/missing measurement, expected duplicate differences, incomplete, contradictory, oversell with pending orders, failed run with broken invariant, reply observation with complete delivery; DOM cases asserting essential content has no `hidden` ancestor in both modes and proof is hidden in Basic only). `run-history.test.ts` asserts the concise sentence on the public route. Covers W06–W10 and W16–W18 at the presentation boundary.
- Validation run: the six listed suites plus the new file and every suite rendering `RunConclusion` / `TerminalNarrative` / `PublicRunHistoryDetail` / `PageView` (18 files), then the full web unit suite (47 files, 775 tests) green; `biome check` clean on touched files; `pnpm --filter web type-check` and `pnpm type-check:test` green.
