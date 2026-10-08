# 20 — Core Incidents Under Saturation

**Design:** section 3 · **Depends on:** 15c

## Goal

The two incidents seen while pushing the hosted core beyond its capacity are understood, then fixed or accepted by the owner.

## Context

- Both were seen during the Fly measurement for 15a (2026-10-08, see its working notes).
- Only admin runs beyond capacity reached them; visitors stay under the public limits.
- **API restart.** During a constant-arrival run at 5,000 per second (capacity about 3,500), the API container restarted.
  - Its CPU fell from about 1.6 cores to about 0.01 for 8 s, with 10,003 connections open. Then its cgroup was recreated (restart policy `on-failure`).
  - 6,801 requests got `connection reset by peer`.
  - No log covers the moment.
  - Neither 13a's 5,000 per second run on Fly nor an 8,000 per second run on a 4 vCPU cloud VM restarted the API.
- **Stuck order job.** After an all-accepted run (750 per second, stock 7,500, every order confirmed), one `orders:process` job stayed active.
  - `DELETE /admin/demo/runs/:runId` answered 409 `active_job` for 10 minutes.
  - At the idle stop, the worker and the web did not exit and were killed at the 30 s stop timeout (32.6 s instead of about 11 s, see HD-52).

- **Load ingestion timeouts.** During a run of 10,000 accepted requests in 1 s (2026-10-08), the runner logged eight "API load ingestion request failed.: API load ingestion request timed out after 5000ms." warnings: the API was too busy to take the runner's metric stream.

## Scope

- Reproduce each incident with logging: on a cloud VM first, on Fly only if needed and with the owner's approval.
- Find the causes, and propose fixes or acceptance. The owner decides.

## Out of Scope

- Raising capacity (HD-51).

## Done When

- Both incidents are explained, and fixed or accepted.

## Open Points

- None.

## Working Notes

_None yet._
