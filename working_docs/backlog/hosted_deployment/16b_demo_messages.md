# 16b — Demo Messages

**Design:** section 6 · **Depends on:** 17

## Goal

The demo's messages about starting and failing runs read consistently and clearly to a visitor who does not know the infrastructure, and a run start no longer looks frozen.

## Context

- Task 16 was split into 16a (gate pages) and 16b (demo messages) on 2026-10-08. Its runner counters moved to task 22.
- On 2026-10-09 the narrative work (Redis claims, known limits) moved to 16c.
- A read-only inventory (2026-10-09) located every text below. Paths are under `apps/web/src/app` unless stated.

## Scope

Owner decisions of 2026-10-09 throughout.

- **Failed-run messages: one source, one vocabulary.**
  - Keep a single failed-run explanation. Today there are three copies:
    - `publicFailureExplanation` (`lib/presentation/public-vocabulary.ts`), used by the report, Watch and the admin "What happened";
    - `failedSentence` (`run-result-presentation.ts`), whose fallback produces "a inventory failure" or a raw slug;
    - `failedRunExplanation` (`error-presentation.ts`), which has no production caller.
  - The report states the fact once. Today a run that did not start says it three times: the verdict sentence, the explanation and the Consistency block (`run-conclusion.tsx`). Watch has the same repetition.
  - The same words at start time and in the recorded run. Today the start error says "Fly.io has no room … in Europe" and "could not be started", while the recorded failure says "the hosting provider" and "no traffic was sent".
  - A run refused while the demo updates says so, if the stored run can tell. Today it reads as "could not be started" (HD-14).
  - Scenarios: relocation, provider capacity, a generator that could not start, a version mismatch. Surfaces: the public page, Watch, the run report and history, and the admin start dialog and Current run panel.
- **Admin read failures.** Today `retryPresentation` (`error-presentation.ts`) shows "The latest information is temporarily unavailable" for every read failure other than a start. Tell apart:
  - "the API cannot be reached" (`backend_unavailable`);
  - "the API is busy, try again in N s" (`dashboard_recovery_unavailable`, with its Retry-After and `details.reason`).
- **"Sending ended at".**
  - "Checkout attempts … ended at" (`runRecap` in `components/run-history-detail.tsx`) uses `trafficEndedAt`, the runner's report time, about 55 s after a 10 s sending window. It does not match "30 seconds after its sending window closed" in the late-answer explanation.
  - Show the true end of sending instead: `firstAttemptStartedAt + dispatchDurationSeconds` from the stored arrival summary, with no API change. Name it as such, and make the other traffic-end mentions follow ("Checkout traffic ended", the admin "Traffic ended").
- **Run report header.**
  - Keep the header label. Drop the duplicate "Completed" title under "Final result".
  - The environment note shows only the half that applies to the run: a hosted run records a runner region, a local run none. Show it once: there is a near copy in `components/transport-observation.tsx`.
- **Singular grammar.** One small pluralization helper for run presentation, applied at the sites found by the inventory:
  - `run-result-presentation.ts`, including "All 1 available units" and "All 1 reservations";
  - `run-failure-explanation.tsx`;
  - "Up to 1 starts per visitor" and "Wait N seconds" (`public-demo-entry.tsx`);
  - `operator-dashboard.tsx`, `run-history-list.tsx`, `run-history-detail.tsx`, `admin-authenticated-surface.tsx`.
- **Waiting panel while a run starts.**
  - After a start click, the page waits for the API to start the run, mostly the load generator's start on Fly.io: 3.5 to 10 s, about 15 s or more with a relocation. Today only the button label and a small "Starting" pill change, so the page looks frozen.
  - On the public page and in the admin start dialog: a visible panel with a loading animation in the gate pages' style and an honest message, for example "Starting the load generator, this usually takes a few seconds".
  - After 10 to 15 s, a reassuring line is added (a browser-side timer).
  - The relocation notice belongs in that panel.
  - No invented steps or progress.
  - The web has no animation component: write a small CSS animation for the demo. Animations stop under `prefers-reduced-motion: reduce`.
  - The public page's 6 s recovery poll stays as it is.
- **Tests.** The pending start with the relocation notice and the hidden "already in progress" notice in `apps/web/test/browser-workflows.test.ts`. Today relocation is tested only in `run-presentation-state.test.ts` and `admin-controller-state.test.tsx`. Cover the wording changes at the boundaries that render them, with a stock-1 case for the grammar.

## Out of Scope

- Behavior changes to waking, recovery or runs.
- The gate's pages (16a).
- The Redis claims and the known-limits section (16c).
- Runner counters: request timeouts and the reply count off by one (task 22).
- Runs that failed before task 17 with `load_orchestrator_unavailable` before traffic, which keep the old traffic-failure wording: dropped (owner decision, 2026-10-08). The hosted core has been recreated empty since, and local data is disposable (HD-05).

## Done When

- The listed messages are reworded, the waiting panel is in place, and the owner has reviewed them.
- The wording changes are covered at the boundaries that render them.

## Open Points

- None.

## Working Notes

_None yet._
