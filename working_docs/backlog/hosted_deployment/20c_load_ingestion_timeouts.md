# 20c — Load Ingestion Timeouts

**Design:** section 3 · **Depends on:** none

## Goal

The live metric stream's losses under load are all counted, so a run's diagnostics state them honestly.

## Context

- Split from task 20 on 2026-10-09, after a read-only investigation.
- **Incident** (2026-10-08). During a run of 10,000 accepted requests in 1 s, the runner logged eight "API load ingestion request timed out after 5000ms" warnings.
- **What the code says:**
  - **Retries.** A batch is retried up to 3 times, 25 ms apart, with the same `batchId`, and the API deduplicates it (`api-client.ts`, `dashboard-traffic-metric-store.ts`). Each failed attempt logs one warning, so eight warnings are at most eight attempts. A batch that fails 3 times is dropped and counted as `liveMetricLoss` in the terminal diagnostics.
  - **Why it times out.** Ingestion locks the run's row (`SELECT … FOR UPDATE`) in a transaction on the API's single pool of 10 connections. That pool is already queued 8 to 30 s behind accepted orders.
  - **The final report misses nothing.** It comes from the runner's accumulator and the k6 summary, not from the live stream. Only the live dashboard can have gaps.
  - **A silent drop.** Once 10 batches are pending, the API answers 202 without ingesting anything (`traffic-metric-ingestion-service.ts`). Nothing counts that loss.

## Scope

- Accept the timeouts (owner decision, 2026-10-09): they are retried, and the final report is unaffected.
- Count the API's silent drop, and show it with the run's live metric loss in its diagnostics, so the reported loss stays honest.

## Done When

- A batch dropped by the API is counted and visible in the run's diagnostics, and the acceptance is recorded.

## Open Points

- None.

## Working Notes

- **Where the count lives.** In the ingestion service's memory: the `batchId`s it answered 202 without ingesting, per run. The single API process both drops and finalizes, so no shared store is needed and the drop path stays free of any I/O. A restart makes the count unknown: a run that started before the current process reads `null`.
- **No over-count.** A dropped retry whose earlier attempt was still queued is no loss. Finalization counts only the dropped IDs missing from the run's Redis accepted-batch set (`countUnacceptedBatches`, one `SMISMEMBER`).
- **How it reaches the admin view.** Finalization writes `apiDroppedLiveMetricBatchCount` into the stored `loadRunDiagnosticsSummary` JSON (like `accountingWarnings`), only when known. The admin run detail returns it as a top-level `apiDroppedLiveMetricBatchCount: number | null`, and the web shows it in a "Live metric stream" group of the generator diagnostics, next to the runner's `liveMetricLoss` (which was stored but not rendered until now). No runner contract change.
- **Accepted after review (2026-10-10).** A reset, admin or automatic, writes no count: its run data is discarded and its diagnostics are not shown. The per-process memory of dropped IDs is negligible, since the API restarts at each wake.
- **Acceptance recorded** in `docs/load_generation_metrics_streaming.md` (decision table row and the ingestion and batcher paragraphs).
- **Tests.** Unit: the drop path and the unknown read (API), the rendering (web). DB/Redis-backed (written, not run locally, Docker unavailable): `countUnacceptedBatches`, the admin detail read.
