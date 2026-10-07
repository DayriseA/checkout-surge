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
