# 19 — Complete the acceptance matrix and isolated runtime verification

## Handoff

- Status: Verification evidence recorded; the stable-high-latency recovery failure that blocked acceptance was fixed and re-verified by task 19a on 2026-09-21 (see its completion notes). Runtime and integration mechanisms clarified by the user on 2026-09-21. Implementation follow-up: [19a — recovery publication starvation](19a_fix_recovery_publication_lease_starvation.md).
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
| Capacity decrease then recovery (in-process integration; runtime Compose blocked: mock honors the accepted snapshot) | Capacity responses pause native delivery for `Retry-After`; affected orders remain recoverable; delivery resumes at the configured declared-capacity limit after the pause, with bounded pressure and no starvation; no learned-rate ramp | Worker/mock; 09, 17b |
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

- [x] Map each row to concrete test names/fixtures and evidence paths; fill gaps at the boundary owning the behavior. Use revised D06/D07 and task 17b's native queue limits rather than the superseded learned-rate assertions of tasks 07/09, and task 17c's estimator envelope. Include history pruning/counters, out-of-order preview responses, restart safety and technical-failure checks from their task exit criteria, plus task 18's deferred full API matrix and non-nominal browser states. The accepted run snapshot takes precedence over global chaos controls. Verify a finite outage by stopping/starting the mock-erp container, latency beyond the initial deadline with a stable high-latency snapshot, and capacity decrease/recovery only in an in-process integration test through ChaosConfirmationDecisionProvider's existing `resolveConfig` seam with real PostgreSQL, Redis and BullMQ.
- [x] Use injected clocks/seeds for timing policy and small finite workloads. Use real PostgreSQL/Redis/BullMQ and isolated service restarts where durability is the assertion; a mocked restart cannot prove persisted idempotency.
- [x] Fault-inject before/after dispatch intent, external acceptance, local result persistence, due-time commit, queue publish/ack, notification publication and finalization. Record attribution and cleanup status even when a fixture fails.
- [x] Reproduce the incident parameters through the `original-incident` acceptance fixture with a fresh run identity. Do not require the historical incident's stored rows or UUID.
- [x] Collect timing, useful confirmations, actual POST/replay/lookup counts, capacity responses, probe cadence, in-flight maxima, estimate error and durable final counts. Preserve window definitions and versions for task 20.
- [x] Identify the selected runtime/resources and prevent interference with other runs. The disposable reference runtime is an allowed target. Keep exact generated-run cleanup that refuses unresolved obligations outside a reset; after recording the result and collecting diagnostics, an explicit reset or teardown of the owned disposable environment is allowed. Harness cleanup cannot turn an interrupted or failed recovery into a pass.
- [x] Keep explicitly invoked long runs out of ordinary smoke and composition/characterization suites. Document commands, prerequisites, expected counts, diagnostics and resource isolation.

## Validation and exit

- [x] Every matrix row has attributable passing evidence or is explicitly blocked; no blanket pass based on seeded zero-chaos smoke.
- [x] Run relevant focused tests, `pnpm type-check`, `pnpm test:infra:up`, then `pnpm test` for the default unit/API/integration lanes. Run k6 compatibility when changed contracts/scripts require it. Do not invoke composition/characterization unless the user explicitly asks.
- [x] Long incident/stable-window/changing-condition/restart verification is explicitly invoked against isolated resources and reported separately, with no unsupported production benchmark claim.
- [x] Preserve unfinished obligations while testing recovery. On failure, record diagnostics and outstanding counts before reset/teardown; record cleanup separately and keep the verification failed/inconclusive. No indefinite preservation of test databases is required. No result is fabricated or accepted by weakening D14 targets.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check only touched supported files with Biome, use Linux/Dev Container execution and report actual/skipped checks. No unrelated testing-framework rewrite. Locked behavior changes require explicit approval.

## Execution recap and handoff (2026-09-21)

**Update 2026-09-21: [task 19a](19a_fix_recovery_publication_lease_starvation.md) fixed the starvation described below; its exact workload now settles (600/600/600 in 429.954 s, before any reset) and the comparison scenarios were rerun. The text below is the original record.** At the time of writing, acceptance was blocked by task 19a. The checked items above record verification work, including explicit failures, not a blanket functional pass. Resolve 19a and rerun its exact workload before closing task 19 or proceeding to task 20 approval.

### What was validated

| Verification | Actual result |
| --- | --- |
| Original incident, concurrency 5 | 1500 attempts, 888 reservations, 612 sold-out, 888 confirmations/notifications; 97.755 s |
| Same incident, concurrency 1 / 10 | Same business totals; 266.470 s / 98.762 s |
| Low capacity, finite backlog | 600 attempts, 300 reservations, 300 sold-out, 300 confirmations/notifications; 159.541 s |
| Actual worker/ERP/API restarts | Three externally accepted calls without local results observed before termination; all 888 orders/notifications recovered; 149.318 s |
| Duplicate attempts | 400 HTTP attempts, 200 unique reservations, canonical effects and notifications |
| Finite outage | Actual mock stop near +10 s, 30 s stopped, then restart: 200 reservations/confirmations/notifications, no terminal failures; 78.472 s after the shutdown fix |
| Eight seeded presets, including 10,000 buyers | All passed; the 10,000-attempt reference produced 1000 reservations/confirmations/notifications and 9000 sold-out responses |
| Capacity decrease/recovery | **runtime Compose: blocked, not reachable (mock honors the accepted snapshot)**. Substitution: real PostgreSQL/Redis/BullMQ integration through the existing `resolveConfig` seam; actual 429, native Retry-After pause, 20 confirmed/canonical results, 21 POSTs, resumed 8–10/s without starvation |
| Browser and late-run presentation | Real outage/recovery, live reload, nonterminal display beyond the former drain target, grace notice after 600 s and no premature final report. Limiting/unreadable/error distinctions and 599/601 s rendering additionally checked using explicitly browser-only projections/clocks |
| Automatic reset and successor | The stalled latency run reset at 902.230 s; catalog queue limits restored; a subsequent 32-buyer runtime smoke passed, including SSE and exact cleanup |

There were 15 passing named runtime scenarios. Existing default integration/service tests cover publication/crash windows, notification idempotency, reset/retention fences, eligibility expiry, history pruning, preview ordering and legitimate terminal failures; these are not all separate destructive Compose experiments. Successful rendering or a focused single-order test does not prove recovery of the failed 600-order backlog.

### What remains wrong

With constant ERP latency of 3000 ms (initial deadline 2000 ms), 600 accepted orders and concurrency 5, progress stopped at 210 confirmed orders/notifications. There were 390 outstanding orders, 215 canonical ERP results, five unresolved externally accepted calls and zero lookups. Thousands of stale queue deliveries accumulated while durable processing generations kept advancing. The working diagnosis is publication-lease expiry superseding deliveries that are still legitimately waiting in the native queue. [Task 19a](19a_fix_recovery_publication_lease_starvation.md) contains the observed facts, code entry points, exact reproduction, safety constraints and acceptance criteria. No worker ownership/policy change has yet been implemented.

### Durable changes retained

- **Application fix:** `apps/mock-erp/src/server.ts` uses native `return503OnClosing: false`. Fastify's generic closing 503 had caused a terminal malformed-lookup failure (199/200 confirmations) during a real stop/start. The normal protocol now handles shutdown-time requests. The HTTP regression “keeps a lookup response contract-valid while graceful shutdown begins” in `apps/mock-erp/test/unit/mock-erp.test.ts` failed before the change and passes afterwards. This is normal lifecycle behavior, not a testing mode.
- **Permanent regression coverage:** `apps/worker/test/integration/order-processing-workflow.test.ts`, “recovers a test-composed capacity decrease through resolveConfig with native Retry-After pacing”; `apps/mock-erp/test/integration/postgres-confirmation-ledger.integration.test.ts`, “recovers a discarded terminal response through lookup and replay after SIGKILL”; and the combined limiting/outage/technical-failure/late-settlement projection test in `apps/api/test/dashboard-recovery-service.test.ts`.
- **Reusable reproducer:** `scripts/runtime-acceptance.mjs`, its three assertion tests, and `pnpm runtime:acceptance` remain because 19a needs the exact failing workload and comparative reruns. Run sequentially, exclusively against a disposable Compose project, with output under `.cache/task19a`. The command refuses foreign active work and separates failed verification from protected cleanup.
- **Documentation correction:** accepted snapshots override global `/chaos`; outage uses stop/start, high latency a separate stable snapshot, and capacity change the in-process seam. Exported fixture configurations/counts, snapshot precedence and its integration test are unchanged. No production injection or dynamic ERP feature was added. Historical task 14 lines 34 and 56 still claim chaos controls drive run segments; they are intentionally not rewritten. Task 21 must state the precedence rule in authoritative docs.

### Validation and interpretation

On the disposable Linux Compose runtime `checkout-surge-gpt-55`: Node 24.18.0, pnpm 10.33.2, Docker 29.6.1-1, Compose 2.40.3, k6 2.0.0+dirty, 16 logical CPUs and 8.7 GiB RAM. Measurements are single-run functional checks, not benchmarks or calibration approval.

```bash
pnpm exec biome check --write apps/api/test/dashboard-recovery-service.test.ts apps/mock-erp/src/server.ts apps/mock-erp/test/unit/mock-erp.test.ts apps/mock-erp/test/integration/postgres-confirmation-ledger.integration.test.ts apps/worker/test/integration/order-processing-workflow.test.ts packages/contracts/src/acceptance-fixtures.ts package.json scripts/runtime-acceptance.mjs scripts/runtime-acceptance.test.mjs
pnpm type-check
pnpm test:infra:up
pnpm test
node --test scripts/runtime-acceptance.test.mjs
pnpm --filter worker exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.integration.config.ts test/integration/order-processing-workflow.test.ts -t "test-composed capacity decrease"
pnpm --filter mock-erp test:unit
node scripts/run-with-env.mjs docker compose up -d --build --no-deps --wait mock-erp
pnpm runtime:smoke
```

Final Biome/type-check/default lanes passed: **2395 tests** (7 environment safety, 57 script, 1470 workspace unit, 662 API, 199 integration). The unchanged snapshot-precedence test passed. Runtime smoke passed with 32 buyers, final accounting, SSE lifecycle/heartbeat and protected cleanup. These results predate this documentation/artifact cleanup. Composition/characterization were not invoked; no separate k6 compatibility run was required because generator/wire behavior was unchanged.

Runtime commands used `pnpm runtime:acceptance <scenario> <output-directory>` for `original-incident`, `original-incident-c1`, `original-incident-c10`, `low-capacity-backlog`, `original-incident-restart`, `duplicate-attempts`, `finite-outage`, `stable-high-latency`, `surge-10k-preset-reference`, `preview-1k`, `surge-5k`, `idempotency-check-200`, `public-custom`, `admin-smoke-constant`, `admin-failure-path`, and `custom`. The original output directory was `working_docs/backlog/adaptive_erp/evidence/task19`; future runs must use an ignored directory such as `.cache/task19a`.

Early attempts also exposed harness issues (excessive monitoring requests, API bridge IP changing after restart, an outage assertion excluding transport uncertainty), one missed generated arrival during concurrent tests, and one API unit timeout under concurrent load. The harness issues were fixed and isolated reruns passed; they must not be confused with the still-failing application recovery case. The first outage with the real closing-503 defect failed before the correction. The stable-latency run remained failed after automatic reset and cleanup; no successful verdict was inferred from its purge.

At the user's request, session screenshots, raw reports/logs, the one-off browser script and the separate evidence matrix were removed after transferring actionable findings here and into 19a. This supersedes the earlier raw-artifact retention instructions for this campaign; the cleanup does not erase or reclassify its failures. Keep future handoffs concise and generated diagnostics out of the repository. The runtime was left healthy, with no nonterminal run or waiting processing jobs. Policy/estimator constants remain provisional and task 20 approval is not granted.

Cleanup verification: Biome passed on the retained shutdown fix, regression, runtime verifier/assertions and package manifest; the focused graceful-shutdown regression passed (1 test) and `node --test scripts/runtime-acceptance.test.mjs` passed (3 tests). Local task/index links and `git diff --check` passed. No runtime behavior was changed during cleanup, so the full suite/runtime campaign was not repeated.
