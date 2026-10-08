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

### Live verification (2026-10-08)

- Fly at `e0895f10`, fresh core `8d14e1bed94708` (recreated by the wake, history empty, policy as seeded).
- Public `preview-1k` (`28607ae5-8c5c-47b2-916e-60c3050e7d79`): completed, delivery `complete`, 1,000/1,000 completed, 0 interrupted, 0 unstarted, 0 failed. The public report shows "All planned attempts completed" and "Reply coverage" (its caption still reads "of dispatched attempts").
- **The failure run was not reproduced.** Admin run `1a6601db-5998-495b-b56d-0da1146ffd02` (constant arrival 1,000/s for 10 s, stock 10,000, 10,000 VUs, fastest ERP), kept in history: completed, delivery `complete`, 10,000/10,000 completed, 0 interrupted, 0 unstarted, 0 failed, p95 25.3 s, no diagnostic, finalized 2 min 16 s after its start. The fresh core answered about 273 accepted orders per second (10,000 in 36.7 s, first attempt to k6 end), against 236 to 244/s in 15a, so every order was answered within k6's 30 s graceful stop. The interrupted path stays verified by the API tests only.
- Second session (owner-approved, core woken by the owner at about 03:26 UTC): the kept run `1a6601db-…` was torn down (`deleted`, 30 s; public detail now 404). The heavy failure run (constant arrival 10,000/s for 1 s, stock 10,000, 10,000 VUs, kept in history) was not run: the agent's permission system refused the detached start of the series in the API container. The interrupted-requests failure is still unverified on Fly.

**Third session (2026-10-08, 10:20 UTC, run by the owner with Codex after the permission system refused the agent's in-container commands).**

- Run `6d4c026d-cc13-4364-87de-23c268ded43a`: constant arrival 10,000/s for 1 s, stock 10,000, 10,000 VUs, kept in history.
  - Status and delivery `failed`, reason `traffic_delivery_major_shortfall`.
  - 10,000 planned and started, 6,590 completed, 3,410 interrupted (34.1 %), 0 unstarted, 0 failed.
  - All 10,000 orders reserved, confirmed and notified.
- **The diagnostic read `virtual_user_limit`,** not `interrupted_requests`: k6 logged one "Insufficient VUs" warning for 2 dropped iterations, and the VU check comes first. The "Server did not answer in time" block never showed.
- **Owner review of the page (2026-10-08).** The report is confusing and erodes trust. It says the generator hit its VU limit, that 3,410 requests "did not complete", and that all 10,000 accepted orders were confirmed. A visitor reads that as fake numbers.
  - The page never says that the server handled those requests and that only their answers arrived after the generator stopped listening.
  - Second pass approved: the diagnosis takes the dominant cause, and new texts replace the explanation.
