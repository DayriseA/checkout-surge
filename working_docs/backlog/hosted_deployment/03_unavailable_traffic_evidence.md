# 03 — Unavailable Traffic Evidence

**Design:** section 4.3, last item · **Depends on:** none

## Goal

Traffic counters that have no k6 report behind them are shown as unknown, never as zeros.

## Scope

- **Contracts:** traffic counters can be explicitly unknown.
- **Persistence:** run summaries store unknown counters.
- **API:** `syntheticFailedTrafficSummary` (`apps/api/src/services/traffic-delivery-plan.ts`) and its callers separate two cases:
  - no traffic was started, so zeros are true;
  - traffic may have happened without a report, so counters are unknown. This covers admin and automatic resets during traffic.
- **Web:** the run report displays unavailable evidence.

## Out of Scope

- The `load_generator_lost` failure reason and its detection (task 06).

## Done When

- An admin or automatic reset during traffic produces a report with unavailable counters.
- A failure before traffic start still reports true zeros.
- Contract and service tests cover both cases.

## Open Points

- None.

## Working Notes

_None yet._
