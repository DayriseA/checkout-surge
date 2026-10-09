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
- **Waiting panel while a run starts** (owner decision, 2026-10-09). After a start click, the page waits for the API to start the run, mostly the load generator's start on Fly.io, before going to `/watch`. That takes a few seconds, and today only the button label and a small "Starting" pill change, so the page looks frozen.
  - On the public page and in the admin start dialog: a visible panel with a loading animation in the gate pages' style and an honest message, for example "Starting the load generator, this usually takes a few seconds".
  - After 10 to 15 s, a reassuring line is added.
  - The relocation notice belongs in that panel.
  - No invented steps or progress.
  - Animations stop under `prefers-reduced-motion: reduce`.
- **Claims about Redis** (owner decision, 2026-10-09, after the comparative runs study). The study measured no speed gain from the Redis layer at the demo's scale. The single API process is the bottleneck, and a sold-out answer costs PostgreSQL little. What Redis measurably buys is keeping turned-away buyers off the database: PostgreSQL was 7–9 % busy with Redis against 50–63 % without, for the same answers. The order queue, which lives in Redis, is what keeps buyers from waiting on the ERP. Reword every sentence that claims or implies a speed gain from Redis.
  - Contradicted: `apps/web/src/app/page.tsx` around line 222 ("would make every buyer, turned-away buyers included, wait for it") and line 216 ("The stock decision is fast for every buyer"); `working_docs/project_description.md` line 37 (the Problem) and line 15 ("high-speed Redis layer"); `working_docs/delivery_constraints.md` line 10 (ms-level p95 for the fast path, not met under a burst).
  - To complete: `working_docs/project_description.md` line 39 (the Benefit: add that Redis keeps turned-away buyers off the database).
  - Optional softenings: `page.tsx` line 183 ("a fast in-memory decision"), `README.md` line 3 (the burst absorption measured comes from the order queue), `docs/architecture.md` line 176 ("fast").
  - Still accurate: "answered from Redis alone, without touching the database", and successful buyers waiting longer (consider "usually").
  - Line numbers are as of `7a770a9c`. The measurements are in `../redis_and_order_queue_proof/design.md`, section 2.
- **"Known limits" section** (owner decision, 2026-10-09). A short, separate section at the very end of the overview page, for transparency and the curious, not put forward.
  - What the demo cannot show at its scale, and why: one API process, a local database, a single machine, so no speed gain from Redis is visible.
  - The planned later work, without dates or details: a comparison with and without the Redis layer and with and without the order queue, several API processes, and the database at a realistic distance.
  - Distinct from "What a production system should add", which describes industry practice, and from "What limits a run, and what makes it fail", which explains run outcomes. No repetition of either.

## Out of Scope

- Behavior changes to waking, recovery or runs.
- The gate's pages (16a).
- Runner counters: request timeouts and the reply count off by one (task 22).
- Runs that failed before task 17 with `load_orchestrator_unavailable` before traffic, which keep the old traffic-failure wording: dropped (owner decision, 2026-10-08). The hosted core has been recreated empty since, and local data is disposable (HD-05).

## Done When

- The listed messages and the Redis claims are reworded, the known-limits section is written, and all are reviewed with the owner.
- The wording changes are covered at the boundaries that render them.

## Open Points

- None.

## Working Notes

_None yet._
