# 23 — Update authoritative documentation and close delivery

## Handoff

- Status: Done (2026-09-22); not committed. Tasks 20, 21 and 22 are complete.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 23 of 23. Prerequisites: [20](20_verify_policy_against_code_bound_targets.md) verification recap, [21](21_make_estimator_constants_env_configurable.md) environment-configurable estimator constants and [22](22_document_calibration_procedure.md) calibration procedure, plus passing task 19 acceptance evidence. The former approval gate and calibration report were dropped by user decision on 2026-09-22 (see task 20).
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 7 and section 13, D01–D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: authoritative project documentation, reproducible evidence references and final cross-boundary consistency review.

## Objective and fixed rules

Describe only the implemented and tested guarantee. Temporary ERP constraints retain accepted work and extend waiting, subject to recoverable infrastructure and eventual successful downstream opportunities. Permanent rejection and non-transient technical errors fail the affected order, and a reset, by an admin or automatic at 900 seconds, deliberately discards the run. This is a local portfolio resilience demonstration, not a production-readiness or optimal-throughput claim.

Missing evidence or an unresolved acceptance failure blocks the corresponding claim; do not substitute favorable preset smoke for the acceptance matrix.

## Documents to inspect and update

`README.md`, `docs/architecture.md`, `docs/core_business_entities.md`, `docs/scope_and_caveats.md`, `docs/local_development.md`, `docs/redis_inventory_hot_path.md`, `docs/runtime_topology.md`, `docs/reference_runtime_measurements.md`, `working_docs/project_description.md`, and `working_docs/delivery_constraints.md`. Update `docs/cross_service_conventions.md`, `docs/automated_testing_infrastructure.md` and repository layout references where actual changed interfaces/tooling require it. Keep the execution index [`index.md`](index.md) consistent with delivered evidence.

## Implementation work

- [x] Describe single-owner durable scheduling, generation/lease semantics, actual-call identity, terminal-only mock ledger, lookup/replay, uncertainty, accepted-result recovery and notification obligations. State that real connectors require durable idempotency or authoritative lookup; worker records alone do not prove exactly-once external effects.
- [x] Explain one worker authority per `run:<id>`/`catalog` quota, dispatch at the declared ERP capacity through the queue's native rate limit (revised D06, with the About note on adaptive limiters for unknown limits), in-flight/resource ceilings, separate capacity/availability feedback, sparse probes, bounded deadlines, restart safety and bounded history. Do not imply independent replicas can safely share a quota.
- [x] Explain unchanged lifecycle states with the waiting dimension, the two terminal failure categories, traffic versus business settlement, the destructive reset and retained stock/expired holds. Document what reset deletes, the single history line it keeps, that in-flight work is lost on purpose, and the automatic reset 900 seconds after acceptance with its grace-period notice from 600 seconds.
- [x] Document the API-owned conservative estimate, initial 600-second policy/deployment ceiling, all-mode enforcement without bypass, start-time recomputation as the only authority and side-effect-free rejection. State clearly that the estimate is internal to admission, that an overrun fails no order, and that only the automatic reset frees the slot.
- [x] Update current configuration references and examples to remove retired engine knobs while explaining read-only historical compatibility. Keep reservation persistence settings distinct. Show the engine/estimator versions and the task 21 estimator variables (with the calibration-origin note and a link to `docs/estimator_calibration.md`) without exposing new public chaos controls.
- [x] Publish reproducible local evidence: environment, exact fixture/command, expected/actual counts, timing, pacing/pressure, restart behavior, estimate error and versions, taken from the task 20 recap and the task 22 dry run. Do not present local measurements as a hosted benchmark or statistical confidence guarantee.
- [x] Document protected active-work retention, fail-closed sale eligibility after expiry, exact generated-run cleanup, and the absence of payment expiry, stock-release compensation, multi-worker support or a hard wall-clock termination feature.
- [x] Squash the incremental migrations added after `0005` by this backlog into one migration (user decision, 2026-09-20). Follow the [current runtime and evidence rules](index.md#common-guardrails-and-reporting): rebuild the disposable development database if it has applied the replaced migrations, rather than preserving its rows or manually reconciling its old journal. Update the migration-metadata entry count, validate the isolated migration from both an empty database and one populated with test fixtures at the retained migration boundary, and correct the single-baseline wording in `docs/local_development.md`.
- [x] Review contracts, current code, tests, UI wording and documentation together. Search remaining retry-exhaustion/drain-timeout claims and correct active documentation without presenting historical measurements as new results. Historical database rows are not required. Update execution status/evidence only for work actually completed.

- [x] Verify that authoritative `docs/` explicitly state accepted-run snapshot precedence: global ERP chaos controls affect only catalog/non-run fallback calls, never an active run. Describe task 19's real stop/start outage, stable-latency snapshot and in-process capacity test without implying a dynamic ERP profile or production injection mode.

## Final completion checklist

- [x] Incident fixture: 888 confirmations and notifications, correct reservation/sold-out totals, admissible; settlement time reported as a local observation.
- [x] Temporary constraints and additional supported worker concurrency preserve accounting and downstream protection.
- [x] External identity, uncertainty, scheduling ownership, retry handoffs and service restarts have durable tested behavior.
- [x] API admission is explainable, versioned and deployment-configurable with a documented calibration procedure; actual overrun remains recoverable and visible.
- [x] Settlement, immutable history, notification publication fencing and cleanup agree on outstanding work.
- [x] Dynamic conditions, sparse outage probes and restart evidence go beyond favorable presets.
- [x] Resource/history bounds preserve unresolved obligations and canonical evidence; no public capability or topology expansion is implied.
- [x] All relevant acceptance evidence is linked, and no unrun check is reported as passed.
- [x] Project artifacts are English and the final quality checklist is satisfied.

## Validation and completion handoff

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check only touched supported files with `pnpm exec biome check --write <files>` then `pnpm exec biome check <files>`; inspect Markdown and local links directly if unsupported. Verify documented commands against actual scripts and recorded evidence. For any necessary code correction, rerun focused tests, `pnpm type-check` and affected isolated lanes rather than treating a docs-only check as runtime proof.

Use Linux/Dev Container execution; no composition/characterization unless requested. Identify the selected runtime and prevent interference with concurrent work; the development reference runtime may be wiped and reused, with verification evidence exported before teardown. Report changed authoritative documents, acceptance evidence references, actual checks and any remaining limitations. Close the backlog only after all gates are met; no subsequent numbered task is planned.

## Completion notes (2026-09-22)

Not committed; all changes are left in the working tree.

### Migration squash (the only runtime-affecting change)

The seven migrations this backlog added after `0005` (`0006_persist_mock_erp_ledger`, `0007_fat_captain_universe`, `0008_overrated_lester`, `0009_high_franklin_richards`, `0010_fail_orders_on_non_transient_erp_errors`, `0011_destructive_admin_reset`, `0012_retire_scenario_engine_controls`; 88 SQL lines) are replaced by one migration, `packages/db/drizzle/0006_adaptive_erp_processing_and_admission.sql`, with one snapshot (`meta/0006_snapshot.json`, `id` = the former `0012` id `f6b3a2f2-6deb-4ed4-ac84-39db811560c4`, `prevId` = the `0005` id `87f3e691-b626-4316-8715-b196aa67ddab`) and one journal entry (`idx: 6`, `when: 1789956068665`, `breakpoints: true`). `0000`–`0005` and their snapshots are untouched. The journal now has 7 entries; `packages/db/test/unit/migration-metadata.test.ts` expects 7.

The merged SQL is the ordered concatenation of `0006`–`0012` with the statement pairs that later migrations fully undo removed, and `--> statement-breakpoint` markers preserved:

- `0007`'s two `erp_scope_resilience_state` intervention columns and `0010`'s two matching `DROP COLUMN` statements are both removed (net zero).
- `0008`'s `erp_outcome_disposition` enum is created directly with the final value set including `technical_failure`; `0010`'s text round-trip (`ALTER TYPE`/`DROP TYPE`/re-create/cast back) for that enum is removed.
- `0010`'s `ALTER TYPE "order_failure_category" ADD VALUE 'technical'` is removed because `0011` drops and re-creates that type; `0011`'s round-trip is kept unchanged.
- Everything else (`erp_confirmation_ledger` and its index, the `erp_attempts.disposition` backfill, the `order_events` payload linkage, `0009`'s availability columns and backfill, `0010`'s `order_waiting_reason` round-trip and `order_recovery_jobs.intervention_reason` drop, `0011`'s `demo_runs.administrative_stop` drop, `0012`'s two engine-policy columns) is kept in order.

One deliberate, documented behavioural difference on a populated database: the `erp_attempts.disposition` backfill now writes `technical_failure` where the original `0008` wrote `intervention_required` and `0010` renamed it afterwards. `0010` never rewrote the `order_events` payload copy of that value, so applying the old chain left `"disposition": "intervention_required"` inside historical event payloads while the squashed migration writes `"technical_failure"`. The squashed result matches the current vocabulary (`intervention_required` was removed from contracts in task 11), so this is a correction rather than a regression. Everything else is statement-for-statement equivalent.

`packages/db/test/integration/db.integration.test.ts` gains one test, "applies the squashed adaptive-ERP migration to a database populated at the retained boundary". It builds a temporary migrations folder from the journal minus its newest entry (so the boundary follows the journal automatically), applies `0000`–`0005`, inserts fixtures at that boundary through the file's existing helpers (catalog/generated sale offer, preset, demo run, sale context, reservation, a failed order with `failure_category`, three `erp_attempts` covering the success / capacity / unrecognized-error backfill branches, an `order_events` `erp.attempt.failed` row, a simulated notification, an `order_recovery_jobs` row with `waiting_reason = 'intervention_required'` and an `intervention_reason`, and an `erp_scope_resilience_state` row with an open circuit), then applies the squashed `0006` and asserts the migration count, the three backfilled dispositions, the availability backfill, the event payload linkage, the nulled waiting reason and the absence of both retired columns. Empty-database coverage is the existing "applies the baseline to an empty dedicated test database and reruns as a no-op" test, which reads the expected count from the journal.

`grep` over the whole repository for the seven retired tags, `0006_persist_mock_erp_ledger` and "13 entries" found matches only in the historical task documents 03, 05, 06, 09, 11, 14 and 16, which are intentionally left as history. `docs/local_development.md` and `docs/repository_layout.md` were corrected; the `index.md` migration guardrail now records the squash.

The disposable development runtime (`checkout-surge-gpt-55`) was **not** wiped or rebuilt: no runtime run was required for this task, and the isolated `checkout-surge-gpt-55-test-*` containers were reused through `pnpm test:infra:up` only. A development runtime that has applied the replaced journal must be wiped (`pnpm runtime:wipe`, then `runtime:setup`) before it is used again.

### Changed documents

- `README.md`: the worker step now describes declared-capacity pacing, the durable mock-ERP ledger and the "worker records do not prove exactly-once external effects" limit; feature bullets replaced the retired per-run retry policy with declared-capacity dispatch and added API-owned duration admission with the automatic reset; the snapshot-precedence note was added to the chaos-control bullet.
- `docs/architecture.md`: removed the three stale references to resolving a frozen per-run retry policy; documented the single durable control record, its generation bump, publication owner and 30-second lease; added the About-page note that adaptive limiters belong to unknown limits; stated that worker records are not proof of an external effect and that a real connector needs durable idempotency or an authoritative lookup; recorded accepted-run snapshot precedence and how the outage, stable-latency and capacity conditions are actually exercised; replaced the backlog-task references in the estimator paragraph with links to `reference_runtime_measurements.md` and `estimator_calibration.md`; stated that the estimate is internal to admission, that an overrun neither terminates the run nor fails an order, and that occupancy is released by ordinary finalization or an admin reset as well, with the automatic reset as the elapsed-time fallback.
- `docs/core_business_entities.md`: added the waiting dimension and the two terminal failure categories to `Order`; added the historical-snapshot read-only compatibility note, the destructive-reset description (what is deleted, the single retained summary line, deliberately lost in-flight work, retained stock and holds) and the automatic 900-second reset with its 600-second grace notice to `DemoRun`; removed the stale "resolves its frozen run policy" clause.
- `docs/scope_and_caveats.md`: the circuit-breaker caveat was rewritten as a process-local protection-state caveat. The queue's declared-capacity limits live in shared Redis queue metadata, so extra worker processes would draw from the same quota; what is uncoordinated across processes is the worker's in-flight ceilings, latency windows, availability counters and probe flag.
- `docs/runtime_topology.md`: corrected the Mock ERP readiness and Compose-dependency wording (it owns a PostgreSQL ledger and replay now survives restart), and the worker admission wording (native rate limit and global concurrency configured by the API); added the one-authority-per-quota sentence.
- `docs/reference_runtime_measurements.md`: new "Adaptive ERP acceptance observations" section with environment, exact command, the eight fixtures with expected/actual counts and durations, pacing and capacity-pressure figures, outage and restart behaviour, and estimate-error ratios, framed as local observations.
- `docs/local_development.md`: the migration-directory paragraph now states seven entries and the squash, and a note separates the reservation-persistence settings from the retired scenario-engine knobs.
- `docs/repository_layout.md`: the `packages/db` artifact description no longer claims a single baseline file, journal entry and snapshot.
- `docs/redis_inventory_hot_path.md`: removed the stale frozen-retry-policy clause.
- `working_docs/project_description.md`: the "Worker Strategy" bullet now describes declared-capacity pacing with separate capacity and availability feedback instead of exponential backoff plus circuit breakers, and a snapshot-precedence bullet was added.
- `working_docs/delivery_constraints.md`: the "Controlled Backpressure" guarantee now matches the implemented mechanism and states that a temporary constraint extends waiting rather than failing an order.

`docs/cross_service_conventions.md` and `docs/automated_testing_infrastructure.md` needed no change: no interface or tooling they describe changed.

### Acceptance evidence referenced

All acceptance numbers come from [task 20](20_verify_policy_against_code_bound_targets.md) (eight runs on 2026-09-22, correlation IDs and SHA-256 hashes recorded there, raw JSON git-ignored in `.cache/task20/`) and the [task 22](22_document_calibration_procedure.md) dry run (twelve measurement runs plus six re-check runs, `.cache/task22/`). Concurrency 1/5/10 equivalence comes from [task 19](19_complete_acceptance_matrix_and_runtime_verification.md). No acceptance run was executed by this task, and no historical measurement is presented as a new result.

### Checks actually run

| Command | Result |
| --- | --- |
| `pnpm test:infra:up` | Pass: isolated PostgreSQL/Redis created and healthy |
| `pnpm --filter @checkout-surge/db test:unit` | Pass: 8 files, 60 tests (includes the journal-count and drizzle-kit drift tests) |
| `pnpm --filter @checkout-surge/db test:integration` | Pass: 6 files, 85 tests (84 before, plus the new populated-boundary test) |
| `pnpm test:db:migrate` | Pass: isolated test database rebuilt from the squashed migration chain |
| `pnpm --filter worker test:integration` | Final run: pass, 10 files / 113 tests. An earlier run of the same lane had 1 failure / 112 passes — `order-processing-workflow.test.ts` "drains 300 orders at declared capacity…" asserted `capacityResponses === 0` and observed 1; re-running that file alone passed 44/44, and the full lane passed on the final run. The assertion is timing-sensitive and has no schema dependency, so it is reported as an observed flake rather than hidden. |
| `pnpm type-check` | Pass: 11/11 Turbo tasks, then `tsc -p tsconfig.test.json --noEmit` clean |
| `pnpm exec biome check --write` then `biome check` on the touched supported files | Pass, no remaining diagnostics. Formatting also fixed `packages/db/drizzle/meta/_journal.json` and the new `meta/0006_snapshot.json`. |
| `pnpm format:check` | 1 error, pre-existing and untouched: `apps/mock-erp/src/persistence/postgres-confirmation-ledger.ts`. The other three offenders recorded in task 16 (`meta/0007_snapshot.json`, `meta/0012_snapshot.json`, `meta/_journal.json`) disappeared with the squash and the reformat. |

Not run: `pnpm test:composition` and `pnpm test:characterization` (excluded by the guardrails), and any acceptance/runtime scenario (no runtime change to verify; evidence is reused from tasks 19–22).

### Cycle-2 corrections (reviewer findings)

Six documentation corrections were applied after review; no migration or test change was needed.

1. `docs/reference_runtime_measurements.md` — the estimate-error ratios were attributed to the wrong runs. Recomputed from `estimateError.estimateToActualRatio` in the eight `.cache/task20/*.json` reports: 0.863–6.103, or 1.256–6.103 excluding `finite-outage`. The task 22 calibration repetitions (1.701–6.247) are now named separately, and the incorrect "never fell below 1" claim is removed — `finite-outage` is below 1.
2. `docs/scope_and_caveats.md` and `docs/runtime_topology.md` — the "each replica would receive the whole declared quota" assertion was wrong and is deleted. BullMQ's `setGlobalRateLimit`/`setGlobalConcurrency` write to the queue's shared Redis `:meta` hash and the limiter counter is a shared Redis key consumed by `moveToActive`, so extra workers draw from the same quota. The real gap, now documented, is the uncoordinated process-local protection layer (in-flight ceilings, latency window, availability counters, single-probe flag).
3. `working_docs/delivery_constraints.md` — the backpressure guarantee is now qualified exactly as the task's fixed rule requires: subject to recoverable infrastructure and eventual successful downstream opportunities, and except for a reset (admin, or automatic at 900 seconds) which deliberately discards the run and its in-flight work.
4. `docs/architecture.md`, `docs/core_business_entities.md`, `docs/reference_runtime_measurements.md` — "only the automatic reset frees the slot" overstated the mechanism. The start check looks for a `starting`/`active`/`draining` row, so normal finalization and an admin reset release occupancy too; the automatic reset is the elapsed-time fallback for a run still nonterminal at the deadline.
5. `docs/local_development.md` and `docs/load_generation_metrics_streaming.md` — the smoke deadline is now described as the harness-owned fixed 300-second tail allowance in `scripts/runtime-smoke.mjs`, and finalization is described through its outstanding-work checks rather than a drain timeout. A repeat grep over the active documents leaves only three occurrences, each explicitly labelled as retired or historical.
6. `working_docs/project_description.md` — the `MAX_TPS` knob returns `429 erp_capacity_exceeded` with `Retry-After: 1`; 503 is the forced-outage/injected-error response.

### Remaining limitations

- The dashboard's ERP circuit field read the per-scope Redis snapshot keys that no production code wrote any more (`setErpCircuitBreakerSnapshot` had no application caller since the worker moved its safety state to PostgreSQL), so it always reported "no snapshot". This pre-existing dead path was left for a project-owner decision at delivery time; it has since been removed entirely (Redis helpers, API reader, contract `circuit` fields and the dashboard protection panel) in the dead-code cleanup that followed this delivery.
- `apps/worker/src/persistence/postgres-erp-scope-resilience-persistence.ts` still carries a comment mentioning "learned rate"; no such mechanism exists. Left untouched as unrelated to this task's scope.
- The acceptance evidence is a single observation per scenario on one host (three repetitions only for the calibration fixtures). It is a local demonstration, not a benchmark or a statistical guarantee.
- The `finite-outage` actual duration exceeds its admission estimate, because a finite injected outage is not modelled by the estimator. Recorded as an observation; it fails no order.
- [Carried-over follow-up 6](carried_over_follow_ups.md) (the D11 envelope shape) remains an open owner decision and is unaffected by this task.
