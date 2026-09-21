# 13 — Add the automatic run reset

## Handoff

- Status: Done (staged, not committed).
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 13 of 21. Execute after [12](12_implement_destructive_admin_reset.md); the destructive reset workflow accepts a caller-supplied reason.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), section 5, Phase 4, D02 and D10. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: API application service and its composition-root wiring, shared run failure-reason and deadline contracts, history presentation label.

## Objective and fixed rules

No run may monopolize the shared demo. A run still nonterminal 900 seconds after its durable acceptance time is reset automatically through the same destructive workflow as the admin reset, with reason `auto_reset`. Admission stays at the 600-second estimate; the 300 seconds in between are a grace period.

The deadline acts on the whole run. It never fails individual orders, adds no retry limit, and is not a worker concern. It applies to public and admin runs alike and needs no admin session.

This task delivers the server behavior and exposes the deadline to readers. The dashboard grace-period notice is task [18](18_build_runtime_progress_and_grace_notice.md).

## Repository entry points

Task 12's reset workflow in `apps/api/src/services/admin-demo-reset-service.ts`; existing periodic API services and their wiring in `apps/api/src/index.ts` (for example the retention and startup-reconciliation services) as the pattern to follow; `internalRunFailureReasonSchema` and the run snapshot in `packages/contracts/src/`; `estimatedDemoOccupancyCeilingSeconds` in `packages/contracts/src/estimate.ts`; `run-history-service.ts` and the web run-result presentation for the label.

## Implementation work

- [x] Export the 900-second automatic reset deadline as one constant next to the occupancy ceiling. It is not configurable from the dashboard.
- [x] Add the `auto_reset` run failure reason in contracts and wherever the reason vocabulary is mirrored.
- [x] Add a small periodic API application service that finds nonterminal runs whose acceptance timestamp is older than the deadline and resets them through task 12's workflow with reason `auto_reset`. Use an injected clock, hold no timer per run, and wire it in the composition root beside the existing periodic services.
- [x] Derive the deadline only from the durable acceptance timestamp, so it survives an API restart. A run already past its deadline at startup is reset on the first check.
- [x] Share the reset fence and maintenance authority with the admin reset, so an automatic and an admin reset of the same run cannot interleave and produce one history line.
- [x] Expose the run's automatic reset time in the existing run snapshot so task 18 can render the grace notice without its own clock rule.
- [x] Present an `auto_reset` run in history as cancelled by automatic reset, with the same discarded-data notice as an admin reset.
- [x] Log each automatic reset with run id and correlation id.

## Non-goals

No per-order deadline, no configurable or per-preset deadline, no warning UI (task 18), no change to estimated-duration admission (tasks 15–16).

## Acceptance and validation

- [x] Under an injected clock, a run nonterminal just before 900 seconds is untouched, and just after is reset with reason `auto_reset`, its internal data purged and one history line kept; a successor can start.
- [x] A run that completes normally before the deadline is never reset.
- [x] After an API restart past the deadline, the first check resets the run.
- [x] An admin reset racing the automatic reset yields one terminal outcome and one history line.
- [x] Run focused API service tests, `pnpm type-check`, `pnpm test:infra:up`, `pnpm test:api`, and affected contract and web presentation tests. Do not wait real minutes in tests.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep the workflow in a service and infrastructure in the composition root. Format/check touched supported files with Biome; use the documented Linux/Dev Container path. Do not run composition/characterization suites or reset the user's reference runtime. Report checks and obtain explicit approval before deviating from D10.

## Completion handoff

Deliver the periodic service, the deadline constant, the `auto_reset` reason and label, and their tests. Record the check cadence, the snapshot field carrying the reset time, and restart behavior. Next: [14 — scenario and engine configuration separation](14_retire_scenario_engine_controls.md).

## Completion notes

- Check cadence: every 5 seconds from a dedicated interval in `apps/api/src/index.ts`, plus one awaited check at startup before startup reconciliation. A failed startup check is logged and does not block API startup (the load orchestrator starts only after the API is healthy, so the first abort can legitimately fail); the poller retries. Overlapping checks share one in-flight promise and shutdown awaits it before closing dependencies.
- Snapshot field: `autoResetAt` (optional ISO timestamp, `started_at` + `automaticRunResetDeadlineSeconds`), populated by `toDemoRunSnapshot` whenever `startedAt` exists. Task 18 should only render it for nonterminal runs from 600 seconds on.
- Restart behavior: the deadline derives only from durable `demo_runs.started_at`. The first check after a restart resets an overdue run, resumes an interrupted `failed/auto_reset` run, and finishes pending post-purge projection cleanup of an `auto_reset` run (detected through the existing pending-projection Redis marker).
- Race safety: the workflow re-validates the deadline inside the shared maintenance authority and reset fence when the reason is `auto_reset`, and returns an empty response when nothing is due, so a stale check cannot reset a successor. A resumed incomplete reset keeps the reason persisted on the run, regardless of which caller retries it.
- Vocabulary: `destructiveResetReasonValues` / `isDestructiveResetReason` in contracts are the single definition used by the API, `purgeResetRunDurable`, and the worker fences. `failure_reason` is a text column, so no migration. Public failure category for `auto_reset` is the new `automatic_reset` value; internal reasons stay out of public responses.
- Checks: Biome on touched files, `pnpm type-check`, `pnpm test:unit`, `pnpm test:api` (637 tests), `pnpm test:integration` (189 tests) all green. `pnpm format:check` still reports two pre-existing untouched files (`apps/mock-erp/src/persistence/postgres-confirmation-ledger.ts`, `packages/db/drizzle/meta/0007_snapshot.json`).
- Noted follow-ups: the 5-second cadence is a literal in the composition root rather than a named constant; `autoResetAt` is also present on terminal snapshots, where it carries no meaning.
