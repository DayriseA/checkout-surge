# 19 — Complete the acceptance matrix and isolated runtime verification

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 19 of 21. Execute after [18](18_build_runtime_progress_and_grace_notice.md); all functional slices must have their focused validation.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 7 and sections 11–13, D01–D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: boundary tests, explicitly invoked isolated runtime verification and evidence collection. Do not postpone earlier tasks' focused tests to this task.

## Objective and fixed rules

Prove the complete narrative beyond favorable presets. Valid finite accepted work survives temporary constraints, one canonical external effect produces one notification, and final reports agree with settled records. Eventually finishing by hammering the ERP is not a pass.

Keep short deterministic checks in ordinary lanes and explicitly invoked long resilience experiments separate. A harness timeout is a failed/inconclusive verification, not an application business deadline. Never lower the 10,000-buyer target or discard verification results to hide a failure.

Follow the [current runtime and evidence rules](index.md#common-guardrails-and-reporting): development database contents are disposable, and the reference runtime may be wiped and reused as the clean verification runtime. No historical run, UUID, volume or original machine is a prerequisite. Preserve scenario definitions and recorded verification evidence outside disposable runtime storage; identify the current environment and avoid interference with concurrent work.

## Repository entry points

Tests in `apps/{api,worker,mock-erp,load-orchestrator,web}/test/` and `packages/db/test/`, the named fixtures from task 01, `scripts/runtime-smoke.mjs`, `scripts/runtime-recovery-soak.mjs`, reset/test-environment safety helpers and `package.json`. Follow `docs/automated_testing_infrastructure.md`, `docs/local_development.md` and `docs/reference_runtime_measurements.md`. Add only a focused explicit verification entry point where existing tools do not cover the new boundary; document its exact invocation and isolation requirements.

## Acceptance matrix to implement or trace to existing tests

| Scenario | Required evidence | Primary owner/task |
| --- | --- | --- |
| Original incident: 1,500 attempts, 888 stock, ERP 10/s, 250 ms, concurrency 5 | 888 unique reservations, 612 sold-out, 888 confirmations, 888 notifications, no saturation-induced terminal orders, admissible estimate | Worker/DB/API; 05, 09, 10, 16 |
| Same conditions at supported concurrency levels | Identical business totals, native queue rate/global concurrency limits respected from first dispatch, no overload abandonment | API/worker; 07–09, 17b |
| Low capacity with finite stock beyond old retry budget | Retained, draining backlog; no exhaustion failure | Worker/queue; 05–09 |
| Capacity decrease then recovery | Capacity responses pause native delivery for `Retry-After`; affected orders remain recoverable; delivery resumes at the configured declared-capacity limit after the pause, with bounded pressure and no starvation; no learned-rate ramp | Worker/mock; 09, 17b |
| Queue limits across restart, settlement and reset | Accepted-snapshot rate/global concurrency limits are re-applied after API/worker restart and return to catalog defaults after terminality or reset | API/worker; 17b |
| Latency exceeds initial deadline | Retained uncertainty, eventual reconciliation, no duplicate external effect | Worker/mock; 03–05, 08 |
| Finite outage | Sparse probes/backoff, automatic recovery, no invented permanent rejection | Worker/mock; 07–09 |
| ERP accepts, response lost, ERP and worker restart | One canonical confirmation, one confirmed order, one notification | Ledger/recovery; 03–05, 09 |
| DB or queue fails around handoff | Durable obligation, one schedule owner, recovery after every publication crash window | Persistence/queue; 02, 05 |
| Work exceeds old drain target | Visible nonterminal processing, late notifications, report only at settlement | API/worker/web; 10, 18 |
| Run still nonterminal 900 seconds after acceptance | Grace notice from 600 seconds only; automatic destructive reset at the deadline, including after API restart; one `auto_reset` history line; successor can start | API/web; 12, 13, 18 |
| Permanent rejection, authentication failure, malformed response or invalid identity | Order fails terminally with the right category and code, no retry; other orders and the run complete normally | Contracts/worker; 01, 04, 11 |
| Estimate exceeds 600 seconds or is unsupported | Current declared-capacity estimator (v2 from 17c, until calibrated) governs preview/start; actionable rejection, no run/stock/traffic or visitor-budget consumption | API/web; 15, 16, 17, 17c |
| Duplicate HTTP attempts | Unique-intent estimate, unique downstream effects and notifications | API/worker; 03–05, 15 |
| Reset/cleanup races a call or publication | Reset never waits on the ERP, purges run data, keeps one `admin_reset` history line, late worker write recreates nothing; retention/teardown delete no unfinished obligation; terminal fence preserved | API/worker/DB; 10, 12 |
| Eligibility/hold timing expires during long-lived work | No reopening or stock release; accepted work remains recoverable | DB/Redis/lifecycle; 10 |
| Standard presets and zero-chaos smoke | Accounting, no overselling, responsiveness, history, notifications and SSE preserved | Cross-boundary; 01–18, including 17b/17c |

## Implementation work

- [ ] Map each row to concrete test names/fixtures and evidence paths; fill gaps at the boundary owning the behavior. Use revised D06/D07 and task 17b's native queue limits rather than the superseded learned-rate assertions of tasks 07/09, and task 17c's estimator envelope. Include history pruning/counters, out-of-order preview responses, restart safety and technical-failure checks from their task exit criteria, plus task 18's deferred full API matrix and non-nominal browser states. Rows that need conditions to change during a run apply the change through the mock's existing chaos controls from the test harness.
- [ ] Use injected clocks/seeds for timing policy and small finite workloads. Use real PostgreSQL/Redis/BullMQ and isolated service restarts where durability is the assertion; a mocked restart cannot prove persisted idempotency.
- [ ] Fault-inject before/after dispatch intent, external acceptance, local result persistence, due-time commit, queue publish/ack, notification publication and finalization. Record attribution and cleanup status even when a fixture fails.
- [ ] Reproduce the incident parameters through the `original-incident` acceptance fixture with a fresh run identity. Do not require the historical incident's stored rows or UUID.
- [ ] Collect timing, useful confirmations, actual POST/replay/lookup counts, capacity responses, probe cadence, in-flight maxima, estimate error and durable final counts. Preserve window definitions and versions for task 20.
- [ ] Identify the selected runtime/resources and prevent interference with other runs. The disposable reference runtime is an allowed target. Keep exact generated-run cleanup that refuses unresolved obligations outside a reset; after recording the result and collecting diagnostics, an explicit reset or teardown of the owned disposable environment is allowed. Harness cleanup cannot turn an interrupted or failed recovery into a pass.
- [ ] Keep explicitly invoked long runs out of ordinary smoke and composition/characterization suites. Document commands, prerequisites, expected counts, diagnostics and resource isolation.

## Validation and exit

- [ ] Every matrix row has attributable passing evidence or is explicitly blocked; no blanket pass based on seeded zero-chaos smoke.
- [ ] Run relevant focused tests, `pnpm type-check`, `pnpm test:infra:up`, then `pnpm test` for the default unit/API/integration lanes. Run k6 compatibility when changed contracts/scripts require it. Do not invoke composition/characterization unless the user explicitly asks.
- [ ] Long incident/stable-window/changing-condition/restart verification is explicitly invoked against isolated resources and reported separately, with no unsupported production benchmark claim.
- [ ] Preserve unfinished obligations while testing recovery. On failure, record diagnostics and outstanding counts before reset/teardown; record cleanup separately and keep the verification failed/inconclusive. No indefinite preservation of test databases is required. No result is fabricated or accepted by weakening D14 targets.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check only touched supported files with Biome, use Linux/Dev Container execution and report actual/skipped checks. No unrelated testing-framework rewrite. Locked behavior changes require explicit approval.

## Completion handoff

Deliver missing tests/tooling and a matrix linked to evidence. Record exact commands, versions, test resources and remaining failures. Next: [20 — calibration and approval](20_calibrate_policy_and_obtain_approval.md); functional acceptance alone does not freeze constants or authorize a full guarantee claim.
