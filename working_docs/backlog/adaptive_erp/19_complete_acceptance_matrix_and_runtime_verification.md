# 19 — Complete the acceptance matrix and isolated runtime verification

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 19 of 21. Execute after [18](18_build_runtime_progress_history_and_admin_controls.md); all functional slices must have their focused validation.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 8 and sections 11–13, D01–D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: boundary tests, explicitly invoked isolated runtime verification and evidence collection. Do not postpone earlier tasks' focused tests to this task.

## Objective and fixed rules

Prove the complete narrative beyond favorable presets. Valid finite accepted work survives temporary constraints, one canonical external effect produces one notification, and final reports agree with settled records. Eventually finishing by hammering the ERP is not a pass.

Keep short deterministic checks in ordinary lanes and explicitly invoked long resilience experiments separate. A harness timeout is a failed/inconclusive verification, not an application business deadline. Never lower the 10,000-buyer target, erase incident evidence or silently use the user's active runtime.

## Repository entry points

Tests in `apps/{api,worker,mock-erp,load-orchestrator,web}/test/` and `packages/db/test/`, the named fixtures from task 01, `scripts/runtime-smoke.mjs`, `scripts/runtime-recovery-soak.mjs`, reset/test-environment safety helpers and `package.json`. Follow `docs/automated_testing_infrastructure.md`, `docs/local_development.md` and `docs/reference_runtime_measurements.md`. Add only a focused explicit verification entry point where existing tools do not cover the new boundary; document its exact invocation and isolation requirements.

## Acceptance matrix to implement or trace to existing tests

| Scenario | Required evidence | Primary owner/task |
| --- | --- | --- |
| Original incident: 1,500 attempts, 888 stock, ERP 10/s, 250 ms, concurrency 5 | 888 unique reservations, 612 sold-out, 888 confirmations, 888 notifications, no saturation-induced terminal orders, admissible estimate | Worker/DB/API; 05, 09, 10, 15 |
| Same conditions at supported concurrency levels | Identical business totals, rate/in-flight limits respected, no overload abandonment | Worker; 07–09 |
| Low capacity with finite stock beyond old retry budget | Retained, draining backlog; no exhaustion failure | Worker/queue; 05–09 |
| Capacity decrease then recovery | Prompt reduction, gradual recovery, bounded pressure and no starvation | Worker/mock; 09, 13 |
| Latency exceeds initial deadline | Retained uncertainty, eventual reconciliation, no duplicate external effect | Worker/mock; 03–05, 08 |
| Finite outage | Sparse probes/backoff, automatic recovery, no invented permanent rejection | Worker/mock; 07–09, 13 |
| ERP accepts, response lost, ERP and worker restart | One canonical confirmation, one confirmed order, one notification | Ledger/recovery; 03–05, 09 |
| DB or queue fails around handoff | Durable obligation, one schedule owner, recovery after every publication crash window | Persistence/queue; 02, 05 |
| Work exceeds old drain target or accepted estimate | Visible nonterminal overrun, late notifications, report only at settlement | API/worker/web; 10, 15, 16, 18 |
| Permanent rejection or invalid identity | Recognized rejection is terminal; identity/protocol defect is retained intervention | Contracts/worker/admin; 01, 04, 11 |
| Estimate exceeds 600 seconds or is unsupported | Actionable rejection, no run/stock/traffic or visitor-budget consumption | API/web; 14, 15, 17 |
| Duplicate HTTP attempts | Unique-intent estimate, unique downstream effects and notifications | API/worker; 03–05, 14 |
| Reset/cleanup races a call or publication | Truthful disposition, terminal fence preserved, no deleted active obligation | API/worker/DB; 10, 11 |
| Eligibility/hold timing expires during long-lived work | No reopening or stock release; accepted work remains recoverable | DB/Redis/lifecycle; 10 |
| Standard presets and zero-chaos smoke | Accounting, no overselling, responsiveness, history, notifications and SSE preserved | Cross-boundary; 01–18 |

## Implementation work

- [ ] Map each row to concrete test names/fixtures and evidence paths; fill gaps at the boundary owning the behavior. Include history pruning/counters, stale preview, restart safety and auth-scope intervention checks from their task exit criteria.
- [ ] Use injected clocks/seeds for timing policy and small finite workloads. Use real PostgreSQL/Redis/BullMQ and isolated service restarts where durability is the assertion; a mocked restart cannot prove persisted idempotency.
- [ ] Fault-inject before/after dispatch intent, external acceptance, local result persistence, due-time commit, queue publish/ack, notification publication and finalization. Record attribution and cleanup status even when a fixture fails.
- [ ] Keep fixture identity separate from historic run `c04798ff-042f-43cf-b5ed-4ba48132aa80`; reproduce its parameters with a new isolated run, never mutate its evidence.
- [ ] Collect timing, useful confirmations, actual POST/replay/lookup counts, capacity responses, probe cadence, in-flight maxima, estimate error and durable final counts. Preserve window definitions and versions for task 20.
- [ ] Add safeguards against targeting a reference/active runtime, and exact generated-run cleanup that refuses unresolved obligations. Harness cleanup cannot cancel or delete work merely to produce a passing result.
- [ ] Keep explicitly invoked long runs out of ordinary smoke and composition/characterization suites. Document commands, prerequisites, expected counts, diagnostics and resource isolation.

## Validation and exit

- [ ] Every matrix row has attributable passing evidence or is explicitly blocked; no blanket pass based on seeded zero-chaos smoke.
- [ ] Run relevant focused tests, `pnpm type-check`, `pnpm test:infra:up`, then `pnpm test` for the default unit/API/integration lanes. Run k6 compatibility when changed contracts/scripts require it. Do not invoke composition/characterization unless the user explicitly asks.
- [ ] Long incident/stable-window/profile/restart verification is explicitly invoked against isolated resources and reported separately, with no unsupported production benchmark claim.
- [ ] Failures retain diagnostic evidence and unfinished obligations. No result is fabricated or accepted by weakening D14 targets.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check only touched supported files with Biome, use Linux/Dev Container execution and report actual/skipped checks. No unrelated testing-framework rewrite. Locked behavior changes require explicit approval.

## Completion handoff

Deliver missing tests/tooling and a matrix linked to evidence. Record exact commands, versions, test resources and remaining failures. Next: [20 — calibration and approval](20_calibrate_policy_and_obtain_approval.md); functional acceptance alone does not freeze constants or authorize a full guarantee claim.
