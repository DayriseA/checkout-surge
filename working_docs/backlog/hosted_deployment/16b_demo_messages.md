# 16b — Demo Messages

**Design:** section 6 · **Depends on:** 17

## Goal

The demo's messages about starting and failing runs read consistently and clearly to a visitor who does not know the infrastructure.

## Context

- Task 16 was split into 16a (gate pages) and 16b (demo messages) on 2026-10-08. Its runner counters moved to task 22.

## Scope

- **Run-start and run-failure messages.** Review the wording on the public page, the watch page, the run report and history, and the admin start dialog and Current run panel, for consistency and clarity: relocation, provider capacity, a generator that could not start, version mismatch while the demo updates.
  - The failed-run explanation exists in three copies: `publicFailureExplanation` (`public-vocabulary.ts`), `failedSentence` (`run-result-presentation.ts`) and `failedRunExplanation` (`error-presentation.ts`, apparently reached only by its test). Keep one.
- **Known gaps.**
  - **Admin read failures.** The admin shows the generic "The latest information is temporarily unavailable" for read failures other than a start (`retryPresentation` in `apps/web/src/app/lib/presentation/error-presentation.ts`), whatever the cause.
  - **"Checkout attempts … ended at" shows the runner's report time** (seen during the task 18 second pass, 2026-10-08). The label uses the runner's `completedAt`, stored after k6's graceful stop, its shutdown and the final metric batches. That is about 55 s after a 10 s sending window, so the run seems to last 65 s, and it does not match "30 seconds after its sending window closed" in the late-answer explanation.
  - **Run report header** (15d rendering review, 2026-10-08). "Completed" appears twice: the header label and the conclusion title. The environment note states both topologies on every run. Show only the relevant half when the environment is known: hosted runs record a runner region, local runs record none.
  - **Singular grammar.** "All 1 available units were reserved…" and "All 1 reservations were confirmed" on a run with stock 1 (`run-result-presentation.ts`).
  - **Pending start with relocation.** `apps/web/test/browser-workflows.test.ts` already holds a visitor's start pending, but not with the relocation notice, nor the hidden "already in progress" notice.

## Out of Scope

- Behavior changes to waking, recovery or runs.
- The gate's pages (16a).
- Runner counters: request timeouts and the reply count off by one (task 22).
- Runs that failed before task 17 with `load_orchestrator_unavailable` before traffic, which keep the old traffic-failure wording: dropped (owner decision, 2026-10-08). The hosted core has been recreated empty since, and local data is disposable (HD-05).

## Done When

- The listed messages are reworded and reviewed with the owner.
- The wording changes are covered at the boundaries that render them.

## Open Points

- None.

## Working Notes

_None yet._
