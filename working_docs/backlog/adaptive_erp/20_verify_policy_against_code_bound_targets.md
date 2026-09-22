# 20 — Verify the policy against code-bound targets

## Handoff

- Status: Completed on 2026-09-22.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 20 of 23. Execute after [19](19_complete_acceptance_matrix_and_runtime_verification.md), [19a](19a_fix_recovery_publication_lease_starvation.md) and [19b](19b_settle_orphaned_active_jobs_before_exact_run_teardown.md); `pnpm runtime:acceptance` and its fixtures must be available.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 7, D06, D08, D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: one verification pass of the worker policy on a clean runtime and a short evidence recap. No code change is expected; a failure becomes a follow-up fix task, not a tuning exercise.

## Scope revision (user decision, 2026-09-22)

This task replaces the original "calibrate policy constants and obtain explicit approval" task. The project owner decided that:

- Fitting constants to one developer machine has no value: nobody knows the hardware the repository will be deployed on. Host-dependent constants become environment-configurable in [task 21](21_make_estimator_constants_env_configurable.md), and [task 22](22_document_calibration_procedure.md) documents how to re-measure them on a target host.
- The mandatory formal approval gate and the calibration report are dropped. A recap of the changes, validation results and any remaining issues is sufficient for routine task handoff. Any separately required owner decisions still apply. D14's "calibration may adjust constants only" rule stays as a guardrail; D14's report/approval mechanism is superseded.
- This task keeps only the targets that test the **code** — the dispatch, protection and settlement logic against a mock ERP whose capacity and latency are simulated — and are therefore expected to hold on any host that is not itself the bottleneck.

## Targets to verify

| Domain | Target | Evidence source |
| --- | --- | --- |
| Accounting | Exact acceptance-matrix totals; zero duplicate effects/notifications; zero saturation-induced abandonment | `assertAcceptance` in `scripts/runtime-acceptance.mjs` on every scenario run |
| Original incident | 888 confirmations and 888 notifications | `original-incident` fixture |
| Stabilized throughput | ERP 10/s, latency 250 ms, concurrency 5: at least 8 confirmations/s after stabilization | `original-incident` (888 orders at about 9.5/s give a drain longer than the 60-second window); confirmations per window in the run report |
| Stabilized pressure | Same fixture, no injected errors: at most 5% capacity (`429`) responses over a stable 60-second window, counted against capacity-consuming calls only | `capacityResponseShare` in the same run report |
| Outage | After the circuit opens, at most one probe per scope per 5 seconds, excluding already-dispatched calls | `finite-outage` fixture; `probeEvidence` assertion |
| Restart safety | Killing the worker mid-run loses no accepted work and settles exactly | `original-incident-restart` fixture |
| Admission | All public presets and the incident remain admissible under the current estimator | Preview/start on the seeded presets |

Not targets here (host-bound, moved to task 22 as measurements to record): the 240-second incident settlement time, the estimator's empirical error ratios, and the throughput/pressure trade-off explanation. The script's existing `< 240 s` incident assertion stays as a coarse sanity bound; if it fails on a clearly slower host while accounting is exact, report it as an environment limitation rather than a policy failure.

## Implementation work

- [x] Wipe and rebuild the clean development runtime per the [runtime and evidence rules](index.md#common-guardrails-and-reporting). Record commit, host topology (CPU, memory, container limits), one-worker configuration and tool versions once, at the top of the recap.
- [x] Run `pnpm runtime:acceptance <scenario> <ignored-output-dir>` for each fixture in the table above, sequentially, with fresh run identities. Export the reports before teardown.
- [x] Fill a pass/fail line per target with the measured value and the report file it came from. An inconclusive run is reported as inconclusive, never re-run until it passes.
- [x] If a target fails, do not tune constants to make it pass: open a follow-up task (`20a_…`) describing the failure and its evidence, as 19a and 19b did.
- [x] Record the recap in this document's completion section. No separate calibration report file.

## Non-goals

- Changing any constant in `apps/worker/src/application/erp-resilience-policy.ts`, `packages/contracts/src/processing-control.ts` or `apps/api/src/services/demo-duration-estimator.ts`. Worker policy constants stay hardcoded and versioned (`declared-capacity-erp-dispatch` v2); estimator constants are handled by task 21.
- Repeated-measurement fitting, confidence claims or a production benchmark.
- Resolving [carried-over follow-up 6](carried_over_follow_ups.md) (D11 envelope shape). It remains an open owner decision.

## Acceptance and validation

- [x] Every target in the table has a measured value and a pass/fail/inconclusive status backed by an exported report.
- [x] Full-matrix accounting is exact on every run.
- [x] `pnpm type-check`, `pnpm test:infra:up` and `pnpm test` pass on the verified commit (no code change expected; if a follow-up fix was needed, its task records its own checks).

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Use Linux/Dev Container and the selected clean runtime; do not run composition/characterization. Report all actual/skipped checks.

## Completion handoff

**Environment (2026-09-22).** Verified commit `387650839b00c1d0afcd5ae7ffcf37f8e0b4b600`, branch `feat/adaptive-erp-and-admission`; working tree initially clean. WSL2 Linux dev container (`6.18.33.2-microsoft-standard-WSL2`, x86_64), Docker engine `cc4755363137`, 16 logical CPUs, 9,369,710,592 bytes RAM (8.73 GiB), 4 GiB swap. This is the observed memory, rather than the rounded 8 GB in the request. Dev-container cgroups: `cpu.max=max 100000`, `memory.max=max`. All eight runtime containers: `Memory=0`, `NanoCpus=0`, `CpuQuota=0`, empty CPU set (no explicit container limits). Node `v24.18.0`, pnpm `10.33.2`, Docker `29.6.1-1` (build `8900f1d330cb39e93e16d780a26bff1d7e07ba03`), Compose `v2.40.3`.

**Runtime ownership.** `run-with-env.mjs` loads runtime env files through `buildRuntimeEnv`; no effective `COMPOSE_PROJECT_NAME` override was set, so `docker-compose.yml` selected `checkout-surge-gpt-55`. Resolved Compose configuration has one worker (default scale 1, no deploy/replica override); inspection confirmed exactly one worker container. The worker scanning ceiling is 10; the incident snapshot selects concurrency 5. The separate `checkout-surge-gpt-55-test` containers were neither removed nor recreated: PostgreSQL `91b97c607200`, Redis `7f504f3810f6` remained healthy with their original identities. The required test-infra command reused them; validation used their isolated test databases.

**Preparation and scope.** `pnpm runtime:wipe`, `pnpm runtime:setup`, `pnpm runtime:up`, then `node scripts/run-with-env.mjs docker compose up -d --wait` all exited 0. Migrations and seed succeeded; all eight services were healthy before measurement. `pnpm build:shared` passed (3/3 cached tasks). `pnpm runtime:smoke` passed service readiness, dashboard recovery/SSE lifecycle/heartbeat, exact 32-buyer accounting and teardown (correlation `runtime-smoke-ca75d58b-bfad-4c81-b5ac-6a5db66d046e`). No tests or builds ran alongside the acceptance scenarios.

Public classification comes from `visibility: "public"` in `packages/db/src/scripts/seed.ts`: `preview-1k`, `surge-5k`, `surge-10k`, `idempotency-check-200`, `public-custom`. Four use the harness `presetCounts`; `surge-10k-preset-reference` references the actual seeded `surge-10k` with no override. All five received full runs. `admin-smoke-constant`, `admin-failure-path`, and `custom` have `visibility: "admin"` and were not run. These checks use the unchanged harness’s admin-authenticated preview/start route, proving estimator admissibility of the public configurations, not public-cookie/rate-budget UX.

**Runs.** Each command was `pnpm runtime:acceptance <scenario> .cache/task20`, once, sequentially, with a fresh identity. Every command exited 0, every harness assertion (including `assertAcceptance`) passed, and every cleanup was `exact-run-teardown-passed`. No failed/inconclusive final run, scenario rerun, or infrastructure retry occurred. Duration is the report’s `durationSeconds` (application acceptance-to-settlement), excluding later observation/cleanup.

| Report / scenario | Correlation ID | Duration (s) | Harness verdict |
| --- | --- | ---: | --- |
| R1: original-incident — `.cache/task20/original-incident-acceptance-e51d1dae-4734-4c86-bac2-5cb9b7dbd3f3.json`; SHA-256: `03066568bcfe36610174778bb19215e9041d1da01773becc021396fdefc175f5` | `acceptance-e51d1dae-4734-4c86-bac2-5cb9b7dbd3f3` | 95.816 | Pass |
| R2: finite-outage — `.cache/task20/finite-outage-acceptance-5490bfef-3566-446f-8f83-5060a36a26a5.json`; SHA-256: `6145356132782cffeefd701ca9135f5feff4d3b5baa55daff831bfe46984f858` | `acceptance-5490bfef-3566-446f-8f83-5060a36a26a5` | 81.304 | Pass |
| R3: original-incident-restart — `.cache/task20/original-incident-restart-acceptance-d08bc884-38fc-4afd-8196-7834aebb9aab.json`; SHA-256: `492678f74bdb7c587dbe2d5ef49836033f3af97ce7d337763d6c49ae76a1cdc6` | `acceptance-d08bc884-38fc-4afd-8196-7834aebb9aab` | 134.104 | Pass |
| R4: preview-1k — `.cache/task20/preview-1k-acceptance-a617fc70-da8e-4bb5-9b79-f67189f303fd.json`; SHA-256: `acc01a263d2b0bfce48ea971ef7341f5846db26f683f0503d53c2f4eabf5e9c9` | `acceptance-a617fc70-da8e-4bb5-9b79-f67189f303fd` | 12.478 | Pass |
| R5: surge-5k — `.cache/task20/surge-5k-acceptance-05bd92d2-615f-448f-8f14-8e53b42069aa.json`; SHA-256: `a7936e50f3ccc685ff4b586c9cdc368d8490e6a661ad352b41729ede84fad6be` | `acceptance-05bd92d2-615f-448f-8f14-8e53b42069aa` | 21.088 | Pass |
| R6: surge-10k-preset-reference — `.cache/task20/surge-10k-preset-reference-acceptance-168a697d-9ba2-4f8f-926f-a82ec4c3d94d.json`; SHA-256: `a969d7c3c09445a43e165889c189d31fe98ca87e844145fefb9e1f9166ebf412` | `acceptance-168a697d-9ba2-4f8f-926f-a82ec4c3d94d` | 29.261 | Pass |
| R7: idempotency-check-200 — `.cache/task20/idempotency-check-200-acceptance-7a814d4e-aea9-40f3-b25b-9d5ff5e43fba.json`; SHA-256: `133dda59f6987badae9697c3d035ed367040b953f50a3025175a3448f0d579d1` | `acceptance-7a814d4e-aea9-40f3-b25b-9d5ff5e43fba` | 5.440 | Pass |
| R8: public-custom — `.cache/task20/public-custom-acceptance-e4a8cede-d360-4475-993d-af8c52bd4d1e.json`; SHA-256: `0568db132639757305b9da5017b2431fa0d7795b08348b89c47aa477e0279741` | `acceptance-e4a8cede-d360-4475-993d-af8c52bd4d1e` | 6.482 | Pass |

**Exact accounting.** Counts below are read from `detail.summary` and `durable`. For every run: planned = started = completed attempts; failed orders, outstanding orders, unresolved calls, interrupted/unstarted requests, dropped iterations, transport failures and unexpected responses are all zero. Reservations = canonical ledger effects = confirmed orders = notifications; no duplicate effect/notification or saturation-induced abandonment was observed.

| Report | Attempts | Reservations / ledger / confirmed / notifications (each) | Sold-out | Duplicate HTTP replays |
| --- | ---: | ---: | ---: | ---: |
| R1 | 1500 | 888 | 612 | 0 |
| R2 | 200 | 200 | 0 | 0 |
| R3 | 1500 | 888 | 612 | 0 |
| R4 | 1000 | 250 | 750 | 0 |
| R5 | 5000 | 750 | 4250 | 0 |
| R6 | 10000 | 1000 | 9000 | 0 |
| R7 | 400 | 200 | 0 | 200 |
| R8 | 500 | 100 | 400 | 0 |

**Per-target verdicts.** R1–R8 identify the original JSON reports by repository-root-relative path and SHA-256 above.

| Target | Measured value | Verdict | Evidence |
| --- | --- | --- | --- |
| Accounting | All eight exact totals above; 0 duplicate effects/notifications, failures, outstanding/unresolved obligations or abandoned attempts | Pass | R1–R8: `detail.summary`, `durable`; `assertAcceptance` passed |
| Original incident | 888 confirmations, 888 notifications, 888 canonical effects | Pass | R1: `durable` |
| Stabilized throughput ≥ 8/s | 563 successes / 60 s = **9.383333333333333/s**; `covered=true` | Pass | R1: `stableWindow.confirmationsPerSecond` |
| Stabilized pressure ≤ 5% | **0 / 562 POSTs = 0%**; no injected errors | Pass | R1: `stableWindow.capacityResponseShare` |
| Outage: ≤ 1 probe per scope per 5 s after opening | Circuit opening observed `01:56:41.323Z`; ERP start requested `01:56:54.956Z`; **0** failed post-opening probe completions in this interval; recovery lookup observed `01:57:00.998Z` | Pass | R2: `outage.probeEvidence`; `assertOutageEvidence` passed |
| Restart safety | 3 externally accepted unresolved calls frozen before kill; final 888 reservations/effects/confirmations/notifications; 0 outstanding/unresolved | Pass | R3: `restart.frozen.acceptedUnresolved`, `durable`, restored `restart.queueLimits` |
| Admission | Incident + all 5 public presets preview-admitted and started; estimates respectively 168.474, 55.5, 118.4375, 163, 33.2, 29.6 s, all ≤ 600 s | Pass | R1, R4–R8: `estimate.result`, `run` |
| Existing incident sanity assertion (< 240 s; not a code-bound performance target) | **95.816 s** | Pass | R1: `durationSeconds`; harness assertion passed |

**Interpretation and anomalies.** The stabilized window is `[2026-09-22T01:54:28.477Z, 2026-09-22T01:55:28.477Z)`, first observed POST +10 s. Its denominator is capacity-consuming POSTs, not lookups; completions and request starts can differ across window edges. The harness only records throughput/pressure; the two threshold verdicts above were evaluated from those JSON fields. Outage evidence uses worker completion timestamps after a 1-second-poll observation of circuit opening, excluding initial detection failures; it is not packet-level dispatch evidence. Zero observed probes satisfies the upper bound but does not measure spacing between positive probes. The restart run exercised the known orphaned-active-job cleanup path: `Exact-run teardown waiting for active jobs ... (up to 59867 ms)` was logged, then cleanup succeeded within the existing deadline. No monitoring backoffs were recorded. Outage actual time (81.304 s) exceeded its estimate (70.2 s); finite injected outages are not modeled, and estimator accuracy is outside this task’s targets. Build output contained existing ignored dependency-build-script, legacy-deploy/deprecation warnings and two Turbopack warnings about `node:crypto` in Edge instrumentation (`admin-session.ts` and `public-visitor-credential.js`); builds exited 0, with no code or dependency changes.

**Evidence retention.** Reports and command logs live in the git-ignored `.cache/task20/`, consistent with tasks 19a/19b. Each original report is identified by correlation ID, repository-root-relative path and SHA-256 in the run table above. The originals were not overwritten; the hashes cover their original bytes. The untracked repository evidence copies were removed after verifying that the directory contained only the eight generated copies. No calibration report was created.

**Validation on the verified commit.** All commands exited 0; no validation command was retried.

| Command | Actual result |
| --- | --- |
| `pnpm type-check` | Pass: Turbo 11/11 tasks (11 cache hits), followed by successful `tsc -p tsconfig.test.json --noEmit` |
| `pnpm test:infra:up` | Pass: existing PostgreSQL/Redis test containers reused, healthy; no restart/recreation |
| `pnpm test` | Pass: 7 environment-safety + 62 script + 1,474 workspace unit + 662 API + 203 integration = **2,408 passing tests represented in output**. Workspace unit: 1,339 cached results, 135 worker tests freshly executed (Turbo 10/11 cached tasks including shared builds). API: 662 freshly executed (3 shared builds cached). Integration: DB 84, mock ERP 6, worker 113 freshly executed (3 shared builds cached). No failed/skipped tests reported. |
| Report-value/evidence checks and `git diff --check` | Pass: all 8 original reports exist and their recorded SHA-256 hashes match, exact totals and target thresholds checked, no whitespace errors |

Composition, characterization and standalone k6 compatibility were not run: the first two are explicitly excluded; the latter is outside this verification scope and traffic-generation code is unchanged. No extra admin presets or unrelated acceptance scenarios were run. Markdown is not Biome-formatted. Original command logs are in `.cache/task20/` (`runtime-wipe.log`, `runtime-setup.log`, `runtime-up.log`, `runtime-health.log`, `build-shared.log`, `runtime-smoke.log`, one log per scenario, `runtime-down.log`, `type-check.log`, `test-infra-up.log`, `test.log`, `biome.log`). `biome.log` records a `biome check --write` pass over an interim copy of the eight reports that was later removed; no repository file was formatted and the original reports in `.cache/task20/` are unchanged (hashes above).

**Files and final self-review.** Modified only this task document; all eight report JSON files remain in the ignored `.cache/task20/`. No task 20a or index change was needed because no target failed; the conditional follow-up checkbox records that disposition. Changes stay within verification/documentation ownership; application routes, clients, contracts and package boundaries are untouched. All requested checks ran or have the explicit exclusions above. No temporary implementation adapter or tuning was introduced.

**Handoff.** No code, constants, policy, estimator, fixture or harness changes. No failed target requires task 20a. Verification runtime was stopped with successful `pnpm runtime:down` after reports were saved; its volumes remain. Test infrastructure remains up and healthy. No commit was created. Proceed to [task 21](21_make_estimator_constants_env_configurable.md); retain the measurement and admin-authentication limitations above when reviewing these results.
