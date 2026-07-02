# Issue 17 - Scope mock ERP TPS limiting by run or config

Status: Fixed


## Recommended Order Rationale

This is a contained mock ERP correctness issue. Schedule it after core worker retry fixes so ERP behavior is stable before tightening request-scoped load simulation semantics.

## Ownership Boundary

- Mock ERP chaos control service
- Request-scoped ERP config resolution

## Problem

The mock ERP resolves request-scoped `erpConfig`, but TPS limiting uses one process-wide window. Confirmations from one run or config can consume capacity for another run/config in the same second.

## Task

Scope TPS windows:

- Use `runId` when present.
- Use a separate key for global/catalog traffic.
- If configs materially differ without a run ID, include the relevant config scope in the key.

## Acceptance Criteria

- Two different run IDs do not throttle each other.
- Catalog/global traffic does not consume a generated run's request-scoped TPS capacity.
- Existing single-scope TPS limiting remains enforced.

## Tests

Add mock ERP tests proving two run IDs with the same max TPS have independent windows.
