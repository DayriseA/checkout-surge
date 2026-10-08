# 18 — Interrupted Requests in the Run Outcome

**Design:** section 1.2 · **Depends on:** none

## Goal

A run whose requests were interrupted is never reported as complete, to the owner or to visitors.

## Context

- Found during the cloud VM A measurement for 15a (2026-10-08, see its working notes).
- Two all-accepted constant-arrival runs (1,000 per second for 10 s, stock 10,000) reported delivery status `complete` with 0 dropped iterations. Yet over 2,200 of their 10,000 requests were interrupted: started, never answered, then cut by k6's 30 s graceful stop.
- Unstarted requests already lower the status: 2 unstarted out of 30,000 gave `warning`, 713 gave `degraded`. Interrupted requests do not.
- `droppedIterations` also misses requests the scheduler never started.

## Scope

- Confirm in the code where the delivery status is derived, and why interrupted requests do not count.
- Count interrupted requests in the delivery status, consistently with unstarted ones.
- Check what the run report, the history, the watch page and the failure explanation show for such a run, and whether the run's outcome for visitors depends on the delivery status.
- **Owner decisions (2026-10-08):**
  - A run succeeds only when every planned request is started and answered.
  - The delivery shortfall becomes planned − answered (unstarted plus interrupted), with the existing thresholds: up to 1 % `warning`, up to 5 % `degraded`, above `failed`.
  - No data migration: this is an incompatible change. Fly gets a fresh core when it is deployed (the documented `--fresh-core` procedure), and local databases are reset.
  - The failure explanation recognizes a run failed by interrupted requests: the server did not answer before the generator stopped.
- Update the labels that say "dispatched" where they now mean answered, and the docs that say the status comes from planned and unstarted requests.

## Out of Scope

- Capacity-aware admission (15b).

## Done When

- A run with interrupted requests is reported as not complete, with tests through the public API.

## Open Points

- None.

## Working Notes

### Investigation (2026-10-08, read-only)

- **Classifier.** `classifyTrafficDelivery` (`apps/api/src/services/traffic-delivery-classifier.ts`) reads only planned and unstarted requests. Unstarted / planned gives: 0 → `complete`, ≤ 1 % → `warning`, ≤ 5 % → `degraded`, above → `failed` (`warningShortfallRatio`, `failureShortfallRatio`).
  - Interrupted requests are left out on purpose: its doc comment calls a run whose attempts all started "complete attempt delivery".
  - The status is set in the API only (`TrafficCompletionService`).
- **Counts.** The runner computes interrupted = started − completed and unstarted = planned − started from the k6 script's own counters (`k6-output-parser.ts`), sent as `transportAttemptCounts`. `droppedIterations` is only a diagnostic note.
  - No runner change is needed, so the HD-14 handshake is not involved.
- **Outcome.** Only delivery `failed` fails the run (`traffic_delivery_major_shortfall`); `warning` and `degraded` finalize as `completed`. k6 exits 0 after its 30 s graceful stop, so the runner reports success.
- **What ac-1000 shows.**
  - History: "Completed". Public report: "All planned attempts dispatched", delivery coverage 78 %, "Replies not recorded" 2,231, and two caveats ("Reply observation incomplete", "Evidence incomplete").
  - Admin: "Delivery complete".
  - No failure explanation, since the run did not fail. The diagnostic recognizes only the VU limit, so such a run would read "unidentified" if it failed.
- **Stored rows.** Readers re-derive the status and throw on a mismatch (`parsePersistedTrafficDeliverySummary`: finalization, history, recovery, reset, redelivery). Stored runs with interrupted > 0 whose status changes would become unreadable. Only a baseline migration exists (`packages/db/drizzle/0000_baseline.sql`).
- **Tests and docs to update:**
  - `traffic-delivery-classifier.test.ts`, the fixture helper in `demo-run-finalization-service.test.ts`, the fixture in `dashboard-recovery-service.test.ts` (stores `complete` with 250 / 1,000 interrupted);
  - `docs/core_business_entities.md`, `docs/load_generation_metrics_streaming.md`;
  - the label in `public-vocabulary.ts` ("dispatched").
  - Missing: a test through the public API that completes a run with interrupted requests and reads it back from history.

### Implementation (2026-10-08, worktree, uncommitted)

- **Classifier.** `classifyTrafficDelivery` now takes planned and completed requests: shortfall = planned − completed (= unstarted + interrupted), same tiers. It is the only place that derives the status; every reader re-derives it through `parsePersistedTrafficDeliverySummary`.
  - A status-0 transport failure still completes its attempt, so it stays out of the delivery shortfall and is graded only as transport loss.
- **Diagnostic.** New public cause `interrupted_requests`: a major delivery shortfall whose interrupted requests alone exceed the failure tier (> 5 % of planned). The VU-limit case is checked first and unchanged. The history service passes the run's transport counts.
- **Explanation.** New heading, summary, block, next step and "why" for that cause; its shortfall is (planned − completed) / planned. The VU-limit and unidentified copy is unchanged (moved into one `causeCopy` switch).
- **Labels.** "All planned attempts dispatched" → "All planned attempts completed"; "Partial delivery: not all planned checkout attempts were delivered." → "… completed." "Completed", not "answered", because a transport failure counts as completed and the same report shows it as "Generator received no reply".
- **No migration.** Documented as an incompatible change: `docs/load_generation_metrics_streaming.md` (rule + local wipe and fresh-core links), `docs/hosted_operations.md` (example in "Incompatible changes"). Deploy with `node infra/fly/deploy.mjs all --fresh-core` before merging to `main`; locally `pnpm runtime:wipe`, `pnpm runtime:setup`, `pnpm runtime:up`.
- **Decision log.** HD-58 (it reverses a choice the old doc comment called deliberate, and records the rejected separate grading).
- **Timeouts (coordinator addition).** Not recognized. The stored evidence cannot tell a k6 request timeout from a connection error: `transportFailures` is one status-0 count, the script records no k6 error code, timing summaries are aggregates, and stderr keeps only the last 50 lines, which favor timeouts since they end last. A run failed by `traffic_transport_major_loss` stays "unidentified". Telling them apart needs a runner change (a separate timeout counter, so the HD-14 handshake and HD-43 initialization apply).
- **Tests.** Classifier threshold cases with interrupted requests; diagnostic cases (above/at the tier, unknown counts, VU limit first); recovery fixtures made coherent (the stored run is now a failed shortfall; the harness passes `failed`); finalization fixture helper classifies the counts it persists; a completion with 1 of 10 requests interrupted read back from history (`failed` status and outcome, `interrupted_requests` cause); web explanation test.
- **Checks.** Biome clean, `pnpm type-check` passes, unit tests pass except 24 `load-orchestrator` failures, all Windows-specific in an untouched package (23 `EPERM: operation not permitted, fsync`, 1 SIGTERM read as exit code 1). Docker was not running, so `pnpm test:api` (including the new completion-to-history test) was not run locally.

### Fix pass (2026-10-08, after review and cloud verification)

- **Explanation block.** One block for every cause, shown when completed < planned: the "never sent" line when unstarted > 0, the "still waiting" line for `interrupted_requests`, then the shared "{completed} of {planned} requests completed ({n}% shortfall)." with (planned − completed) / planned. It replaces the launched-only shortfall in the VU-limit and unidentified explanations.
- **Copy.** The "Server did not answer in time" summary gains the owner-approved sentence about late answers. "Delivery coverage" becomes "Reply coverage" in the report figures.
- **Tests.** New unidentified case (100 planned, 97 started, 93 completed → 7 %); the interrupted case now has coherent sold-out counts and checks the never-sent line and the new sentence.
- **HD-58.** Renamed "Interrupted requests count in the delivery shortfall, like unstarted ones"; the Decision separates delivery `complete` from run success; the evidence is no longer called hosted. "answered" became "completed" in `core_business_entities.md` and the classifier comment.
- **Checks.** Biome clean, `pnpm type-check` passes, web 754 and api 330 unit tests pass. Docker unavailable; the API suite already passed in the cloud verification and this pass changes no API behavior.
