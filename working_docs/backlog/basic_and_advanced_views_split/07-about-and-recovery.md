# Task 07 — About and public recovery language

Status: Done (2026-09-17) · Depends on: [Task 06](06-public-run-history.md) · Next: [Task 08](08-integration-and-validation.md)

## Outcome

About explains the simulation using a simple causal model. Technical architecture and glossary remain available in Advanced. Public recovery messages use the same understandable vocabulary as the rest of the journey.

## Read first

- [Design contract](design-contract.md), About allocation and vocabulary; [A01 and H03](state-coverage.md), plus recovery rows already owned by tasks 03/05/06.
- `apps/web/src/app/about/page.tsx`, `not-found.tsx`.
- `components/error-notice.tsx`, `lib/presentation/error-presentation.ts`, `public-vocabulary.ts`.
- Public unavailable/invalid-context call sites in Demo, Watch and history, already modified by preceding tasks.

## Work

1. Reorder Basic About around an oversubscribed-sale example and a small conceptual diagram: Buyers → Reserve stock → Wait for processing → Order outcome. Show that an order can fail as well as confirm. Use accessible HTML/SVG or existing local primitives; no new diagram dependency.
2. Explain reservation versus confirmation, expected sold-out attempts and the success criteria: all reservations reach an outcome, none fail or remain pending, and nothing is oversold, with sufficient evidence to verify this. Keep business correctness distinct from speed/delivery qualifications.
3. Keep the simulation caveat visible: buyers and business activity are simulated, no real purchase takes place, and local results depend on the environment. Keep the repository link secondary but available.
4. Advanced retains the current architecture diagram, components and responsibilities, atomic reservation/queued processing rationale, gold-signal definitions, duplicate/idempotency explanation, benchmark/evidence caveats and full glossary. Preserve meaningful existing anchor targets where practical, or update in-repository links that actually use them. Technical anchor navigation must not leave the destination hidden in Basic.
5. Review public error/recovery text and the introductory copy under each public h1 across the completed pages. Replace user-facing “accepted run context”, “durable result”, “durable checkout outcomes”, “simulated ERP behavior” and similar internal language with readable explanations. Keep one useful valid action; preserve distinctions among loading, unavailable, no data, not found, cooldown and uncertain submission.
6. Keep public diagnostics secondary and safe in both views. Do not globally change admin copy, canonical error codes, status enums, retry timing or protected-detail rules. Prefer context-specific presentation changes over broad string replacement. Do not add admin controls to public recovery.

## Acceptance criteria

- Basic About is understandable before reading the glossary, and its diagram has a useful text equivalent and a failure path.
- Both views clearly identify simulation and explain what a confirmed reservation means. No copy claims guaranteed performance or that stock exhaustion alone proves success.
- Advanced retains all existing explanatory content families. Technical links reveal their target and preserve navigation/focus expectations.
- Missing/invalid report links offer history/demo navigation without selecting an unrelated result. Public errors reveal no protected message, identifier payload or unsafe action through Advanced.
- Recovery meanings and behavior from tasks 03/05/06 remain intact; this task aligns wording and accessibility rather than changing workflows.

## Validation

Update/run `public-mental-model.test.tsx`, `public-vocabulary.test.ts`, `error-presentation.test.ts`, `error-notice.test.tsx`, `not-found.test.tsx`, `route-metadata.test.ts`, and focused affected Watch/Demo/history tests. Assert the conceptual model, simulation caveat and Advanced architecture/glossary without fixing tests to paragraph lengths or exact decorative markup. Check public/protected error context explicitly.

Run common formatting/type checks. Review About in both modes and follow contextual technical/recovery links with a keyboard. Check narrow diagram wrapping and text alternatives.

## Handoff

Record any changed public vocabulary and preserved/mapped anchors. Suggested commit subject: `feat(web): explain the public demo in plain language`.

## Completion notes

- About (`apps/web/src/app/about/page.tsx`): Basic is a `BasicOnly` block with four sections (`sale-example`, `reservation-and-confirmation`, `basic-success`, `simulation-and-source`): a 100-buyers/10-units example, a wrapping HTML conceptual diagram (ordered list Buyers → Reserve stock → Wait for processing → Order outcome "Confirmed or failed", with a `figcaption` text equivalent), reservation versus confirmation, the success test kept separate from speed/delivery qualification, the simulation caveat and the repository link. Advanced is an `AdvancedOnly` block holding the entire previous page unchanged (architecture SVG and scroll region, components, queue/ERP rationale, real vs simulated, four signals, success/idempotency, environment caveats, glossary).
- Anchors: all previous section ids (`failure-story`, `redis-fast-path`, `queue-protection`, `real-and-simulated`, `gold-signals`, `success`, `limits-and-source`, `glossary`) and the 12 glossary ids are preserved inside Advanced and are programmatically focusable (`tabIndex={-1}`). In-page term links stay inside Advanced content. `RevealAdvancedHashTarget` (`components/page-view.tsx`) handles `/about#<advanced-id>` deep links and later `hashchange` events by calling the existing `revealAdvanced` (switch to Advanced, focus the target); it runs on arrival only, so an explicit switch back to Basic is honored while the hash remains. No in-repository link targets About anchors.
- Public vocabulary changes: `publicVocabulary.soldOutAttempts` added ("Attempts turned away because stock ran out"); `publicNarrative.watchOrientation` and `run-presentation-state.ts` say "confirmed or failed" instead of "durable outcomes"; `publicFailureExplanation` reconciliation/business sentences reworded in plain language ("The final counts did not agree, so the result could not be verified." / "One or more reserved orders did not reach a confirmed or failed outcome."); Demo intro says "confirmed or failed outcome"; the invalid Watch link block reads "Saved run report / This Watch link is invalid / This link does not identify a saved run. No result has been selected."; the missing-report presentation reads "That saved report could not be found / Choose an available report from run history."; the public unavailable-report page adds a one-line explanation and no longer prints the run ID; not-found reads "We could not find this page or saved run report." Actions, links, retry timing, error codes and enums are unchanged.
- `ErrorNotice` now shows technical details only when the context is protected (`admin-read`, `admin-operation`, or `protected: true`), even if a caller passes `protectedDetails`; admin callers are unaffected.
- Validation: `pnpm exec biome check` on touched files; focused vitest for `public-mental-model`, `public-vocabulary`, `error-presentation`, `error-notice`, `not-found`, `route-metadata`, `watch-narrative`, `browser-workflows`, `run-history`, `page-view`; `pnpm --filter web test:unit` (47 files, 811 tests); `pnpm --filter web type-check` and `pnpm type-check:test` all passed. Coverage: A01 via `public-mental-model.test.tsx` and `page-view.test.tsx`; H03 wording via `browser-workflows.test.ts`, `run-history.test.ts`, `error-presentation.test.ts`, `not-found.test.tsx`; public/protected boundary via `error-notice.test.tsx`. No browser keyboard/narrow-width pass was performed here; the conceptual diagram relies on flex wrapping. Left to Task 08.
- Follow-up: the reworded `publicFailureExplanation` sentences also appear in the authenticated report's "What happened" section because that surface reuses the public wording authority; no admin-specific variant was added.
