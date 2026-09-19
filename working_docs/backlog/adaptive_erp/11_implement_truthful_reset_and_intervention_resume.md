# 11 — Implement truthful reset and explicit intervention resume

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 11 of 21. Execute after [10](10_align_finalization_retention_and_long_lived_work.md); durable claims, lookup/replay and settlement are available.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 4, D01–D05. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: API administrative application services, worker dispatch/recovery, shared control contracts and durable stop/intervention persistence.

## Objective and fixed rules

Reset stops the experiment; it does not retroactively cancel external effects or release reserved stock. Persist an administrative stop, forbid new business dispatch, reconcile the already-dispatched set, preserve acquired confirmations and their notifications, and release the run slot only when settlement is truthful. An unavailable ERP can leave reset visibly incomplete.

Capacity, recognized unavailability and timeouts recover automatically. Authentication/authorization interventions block one downstream scope (`run:<id>` or `catalog`); malformed protocol and identity contradictions block the affected order. Explicit authenticated admin resume clears the relevant intervention and reschedules the existing control record. It does not change immutable identity or accepted configuration, and nothing blocks the entire worker.

## Repository entry points

Inspect `apps/api/src/routes/admin-maintenance-routes.ts`, `apps/api/src/routes/demo-run-routes.ts`, existing reset/incomplete-reset services under `apps/api/src/services/`, `generated-run-teardown-service.ts`, `demo-run-finalization-service.ts`, `packages/db/src/{demo-run-locks,demo-run-maintenance,schema}.ts`, worker handler/recovery/publication-fence adapters, and shared demo/ERP contracts. Reuse the existing admin authentication, CSRF and reset-client patterns in `scripts/`; do not create a parallel administrative framework.

## Implementation work

- [ ] Persist administrative-stop evidence on the nonterminal run before stopping traffic or clearing runtime state. Move to `draining`; record traffic `failed` when reset aborts traffic. Close sale eligibility, abort traffic and fence dashboard ingestion without fencing required business settlement.
- [ ] Serialize stop and dispatch decisions with the existing durable ownership/locking boundary. The worker rechecks stop before dispatch; the set requiring reconciliation is exactly the durable dispatched-but-unresolved set, not an inferred queue snapshot.
- [ ] Administratively fail orders with neither dispatched-call evidence nor a recorded external outcome. Preserve confirmed/permanently rejected outcomes. Never dispose a dispatched uncertain order merely because its lookup returns `unknown`.
- [ ] Reconcile existing dispatched intents through D05: lookup first and, where required by that rule, admitted same-key idempotent replay as reconciliation of that existing obligation. The stop must prevent first/new business dispatch, not erase prior uncertainty. Do not broaden this exception to undispatched orders, create a new key, or infer cancellation from a missing ledger row.
- [ ] Keep notification recovery/publication enabled while the stopped run remains nonterminal. Once all uncertainty/intervention and required local/notification work is settled, write terminal `failed` / `admin_reset` with distinct confirmed, business-rejected and administrative counts. Keep the terminal fence intact.
- [ ] Keep the reset HTTP request bounded. Return in-progress disposition and disposed/confirmed/still-uncertain counts when settlement continues; repeated reset resumes the same workflow. Do not release one-nonterminal-run admission early or move uncertainty to a new post-closure case system.
- [ ] Add authenticated admin resume at order and scope boundaries. Clear only the intended intervention, preserve unresolved-call identity, and reschedule the same durable control record with valid generation/lease rules. Repeated or racing resume/reset must not duplicate work or undo administrative stop.
- [ ] Make cleanup honor these obligations and return an attributable refusal/incomplete result rather than deleting them. Keep existing public/admin access limits, correlation and structured errors. Update control clients/tests alongside response contracts so this slice stays runnable.

## Acceptance and validation

- [ ] Reset with no dispatched effects disposes eligible orders; reset racing dispatch records one truthful outcome, not a false rollback.
- [ ] Reset after ERP acceptance but before local response/persistence preserves one confirmation and notification; `unknown` remains uncertainty until reconciled.
- [ ] ERP lookup unavailability leaves reset incomplete, protected from cleanup, and blocks a successor run. Repeated reset resumes without double disposition.
- [ ] Scope intervention leaves unrelated scopes running; order intervention leaves other orders running. Unauthorized resume is rejected; authorized resume retains identity and resumes existing work only.
- [ ] Run focused reset/resume/finalization/worker tests, `pnpm type-check`, `pnpm test:infra:up`, `pnpm test:api` and relevant integration races using isolated resources.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep routes thin, infrastructure in composition roots and artifacts in English. Format/check touched supported files with Biome; use the documented Linux/Dev Container path. Do not run composition/characterization suites or reset the user's reference runtime. Do not add stock release, compensation, new lifecycle states or a dashboard bypass. Report checks and obtain explicit approval before deviating from D02/D03.

## Completion handoff

Deliver the complete administrative workflow and clients/tests. Record dispatch/stop serialization, reconciliation-only behavior, reset progress contract, resume scope and cleanup protections. Next: [12 — scenario and engine configuration separation](12_retire_scenario_engine_controls.md).
