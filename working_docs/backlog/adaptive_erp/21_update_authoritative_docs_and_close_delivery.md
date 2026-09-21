# 21 — Update authoritative documentation and close delivery

## Handoff

- Status: Pending; blocked until task 20 has explicit user approval.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 21 of 21. Prerequisites: [20](20_calibrate_policy_and_obtain_approval.md) completed with recorded approval of frozen constants/versions, plus passing task 19 acceptance evidence.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 7 and section 13, D01–D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: authoritative project documentation, reproducible evidence references and final cross-boundary consistency review.

## Objective and fixed rules

Describe only the implemented, tested and approved guarantee. Temporary ERP constraints retain accepted work and extend waiting, subject to recoverable infrastructure and eventual successful downstream opportunities. Permanent rejection and non-transient technical errors fail the affected order, and a reset, by an admin or automatic at 900 seconds, deliberately discards the run. This is a local portfolio resilience demonstration, not a production-readiness or optimal-throughput claim.

Do not start closure on an unapproved calibration candidate. Missing evidence or an unresolved acceptance failure blocks the corresponding claim; do not substitute favorable preset smoke for the acceptance matrix.

## Documents to inspect and update

`README.md`, `docs/architecture.md`, `docs/core_business_entities.md`, `docs/scope_and_caveats.md`, `docs/local_development.md`, `docs/redis_inventory_hot_path.md`, `docs/runtime_topology.md`, `docs/reference_runtime_measurements.md`, `working_docs/project_description.md`, and `working_docs/delivery_constraints.md`. Update `docs/cross_service_conventions.md`, `docs/automated_testing_infrastructure.md` and repository layout references where actual changed interfaces/tooling require it. Keep the execution index [`index.md`](index.md) and the calibration report consistent with delivered evidence.

## Implementation work

- [ ] Describe single-owner durable scheduling, generation/lease semantics, actual-call identity, terminal-only mock ledger, lookup/replay, uncertainty, accepted-result recovery and notification obligations. State that real connectors require durable idempotency or authoritative lookup; worker records alone do not prove exactly-once external effects.
- [ ] Explain one worker authority per `run:<id>`/`catalog` quota, dispatch at the declared ERP capacity through the queue's native rate limit (revised D06, with the About note on adaptive limiters for unknown limits), in-flight/resource ceilings, separate capacity/availability feedback, sparse probes, bounded deadlines, restart safety and bounded history. Do not imply independent replicas can safely share a quota.
- [ ] Explain unchanged lifecycle states with the waiting dimension, the two terminal failure categories, traffic versus business settlement, the destructive reset and retained stock/expired holds. Document what reset deletes, the single history line it keeps, that in-flight work is lost on purpose, and the automatic reset 900 seconds after acceptance with its grace-period notice from 600 seconds.
- [ ] Document the API-owned conservative estimate, initial 600-second policy/deployment ceiling, all-mode enforcement without bypass, start-time recomputation as the only authority and side-effect-free rejection. State clearly that the estimate is internal to admission, that an overrun fails no order, and that only the automatic reset frees the slot.
- [ ] Update current configuration references and examples to remove retired engine knobs while explaining read-only historical compatibility. Keep reservation persistence settings distinct. Show approved engine/estimator versions without exposing new public chaos controls.
- [ ] Publish reproducible local evidence: environment, exact fixture/command, expected/actual counts, timing, pacing/pressure, restart behavior, estimate error and approved versions. Link to the report and approval evidence; do not present local measurements as a hosted benchmark or statistical confidence guarantee.
- [ ] Document protected active-work retention, fail-closed sale eligibility after expiry, exact generated-run cleanup, and the absence of payment expiry, stock-release compensation, multi-worker support or a hard wall-clock termination feature.
- [ ] Squash the incremental migrations added after `0005` by this backlog into one migration (user decision, 2026-09-20). This rewrites artifacts already applied to the user's reference database: announce it, reconcile that database's migration journal without wiping or rewriting the incident records, update the migration-metadata entry count, validate the isolated migration from both an empty and a populated database, and correct the single-baseline wording in `docs/local_development.md`.
- [ ] Review contracts, current code, tests, UI wording and documentation together. Search remaining retry-exhaustion/drain-timeout claims and correct active documentation without rewriting historic incident evidence. Update execution status/evidence only for work actually completed.

## Final completion checklist

- [ ] Incident fixture: 888 confirmations and notifications, correct reservation/sold-out totals, admissible and approved timing target met.
- [ ] Temporary constraints and additional supported worker concurrency preserve accounting and downstream protection.
- [ ] External identity, uncertainty, scheduling ownership, retry handoffs and service restarts have durable tested behavior.
- [ ] API admission is explainable, versioned and calibrated; actual overrun remains recoverable and visible.
- [ ] Settlement, immutable history, notification publication fencing and cleanup agree on outstanding work.
- [ ] Dynamic conditions, sparse outage probes and restart evidence go beyond favorable presets.
- [ ] Resource/history bounds preserve unresolved obligations and canonical evidence; no public capability or topology expansion is implied.
- [ ] Task 20 approval is recorded, all relevant acceptance evidence is linked, and no unrun check is reported as passed.
- [ ] Project artifacts are English and the final quality checklist is satisfied.

## Validation and completion handoff

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check only touched supported files with `pnpm exec biome check --write <files>` then `pnpm exec biome check <files>`; inspect Markdown and local links directly if unsupported. Verify documented commands against actual scripts and approved evidence. For any necessary code correction, rerun focused tests, `pnpm type-check` and affected isolated lanes rather than treating a docs-only check as runtime proof.

Use Linux/Dev Container execution; no composition/characterization unless requested, no unannounced reference-runtime smoke/reset, no incident rewrite. Report changed authoritative documents, acceptance/report/approval references, actual checks and any remaining limitations. Close the backlog only after all gates are met; no subsequent numbered task is planned.
