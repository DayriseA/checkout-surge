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
- **Owner decision (2026-10-08):** a run succeeds only when every planned request is started and answered.

## Out of Scope

- Capacity-aware admission (15b).

## Done When

- A run with interrupted requests is reported as not complete, with tests through the public API.

## Open Points

- How a handful of interrupted requests is classified (`warning`, `degraded` or `failed`), compared with the existing thresholds for unstarted requests: settled with the owner.

## Working Notes

_None yet._
