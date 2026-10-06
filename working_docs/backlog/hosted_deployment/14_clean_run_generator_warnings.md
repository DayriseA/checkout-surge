# 14 — Clean-Run Generator Warnings

**Design:** section 4.3 (missing evidence is unavailable, never zero) · **Depends on:** 03

## Goal

A clean run shows no generator warnings, locally or on Fly. Warnings stay reserved for real evidence gaps.

## Context

Found in task 02 (see its Working Notes) and confirmed on a clean local run by a cloud agent on 2026-10-03:

- **k6 counters.** On a run with no incident, `transportFailures`, `unexpectedResponses`, `droppedIterations` and `soldOutResponses` have no source (unavailable), and the run stores `k6_outcome_counter_summary_export_unavailable`. This predates the hosted work and happens locally too. Likely cause, unverified: k6 omits from its summary export a counter that was never incremented.
- **Platform probes.** On Fly (cgroup v1), the memory `high` event counter has no equivalent, so every hosted run reports it as unavailable. Other probes can be absent on some local hosts too (separate `cpu` and `cpuacct` mounts were seen on a cloud runner).

## Scope

- **Confirm the k6 cause** before changing anything: how k6 exports a declared counter with zero samples, and whether the export itself is present on a clean run.
- **k6 counters:** when the summary export exists and a counter is absent from it, count zero. When the export itself is missing, keep the counters unavailable. This must stay consistent with the unknown-versus-zero semantics delivered by task 03.
- **Platform probes:** a probe the platform does not provide is reported as not applicable, not as a generator warning. A probe that should exist but fails stays a warning.
- **Web:** the run report reflects these states without alarming wording on a clean run.

## Out of Scope

- New probes or metrics.

## Done When

- A clean `surge-10k` run on Fly and a clean local run both show zero generator warnings.
- A run whose k6 summary export is really missing still reports unavailable counters.
- Tests cover both cases at the parser and diagnostics boundaries.

## Open Points

- None.

## Inputs from Task 03

- The completion path still writes `0` for a counter with no source (`selectCount` in `apps/load-orchestrator/src/application/k6-output-parser.ts:345` returns `value: 0, source: null`); only the diagnostics mark it unavailable.
- Task 03 kept completion reports strictly measured (`measuredTransportAttemptCountsSchema`, `measuredTrafficHttpSummarySchema`), and stored HTTP outcomes are all known or all unknown together. Reporting individual counters as `null` when the export is missing needs both relaxed: nullable fields in the completion schema and per-counter nulls in the stored HTTP summary, with the `failedRequests` equation applied only when its terms are known.

## Working Notes

### Implementation (2026-10-05)

Branch: `hosted/14-clean-run-warnings`, based on `origin/dev` at `755e001ce3b580549c126e62f871969cdde6f55a`. This is an implementation handoff, not completion of the task. The backlog status stays unchanged. Findings and proposed decisions are recorded here because the design and decision log are being edited in parallel.

- **Confirmation before editing:** ran the pinned `grafana/k6:2.0.0` binary with one declared counter never sampled, one receiving `add(0)`, and one receiving `add(1)`. The summary file existed; the untouched counter was absent, while the sampled counters exported counts of zero and one. A subsequent generated checkout run also exported a valid summary while omitting transport-failure, unexpected-response, and dropped-iteration counters.
- **Parser and contracts:** absent counters in a validated export are zero with `summary_export` provenance. A present but invalid counter is not normalized to zero. Missing, invalid, or unreadable exports retain point-stream evidence independently and leave unsourced HTTP/iteration counts null. Transport totals retain their all-known/all-unknown rule. Completion contracts now accept unavailable evidence; the HTTP failure equation applies when its terms are known. Removed the measured-only schemas made unused by this change.
- **Platform diagnostics:** cgroup mount/controller metadata identifies unsupported existing probes; `notApplicableProbes` carries that distinction without inventing numeric values. Supported read failures and unreadable platform metadata remain unavailable. cgroup v1 memory-high events are not applicable, including hybrid hosts with v2 under `unified`. The existing CPU usage probe also reads separate v1 `cpuacct` mounts. CPU normalization still requires a finite quota or an explicitly unlimited quota.
- **Nullable-evidence consumers:** unavailable immutable acceptance counts no longer block finalization after pending persistence and durable reservation/order accounting settle. Known acceptance shortfalls still block, and unknown counters do not create underreport warnings. Result reconciliation keeps independently available accepted/sold-out comparisons and marks unavailable comparisons incomplete. Web diagnostics show "Not applicable" for unsupported probes, and unknown transport-count wording no longer asserts that no completion report exists or that every HTTP measurement is unknown.
- **Tests:** cover omitted zero-sample counters versus missing exports at the parser boundary, v1/v2/hybrid platform support and read failures at diagnostics boundaries, separate CPU mounts, nullable contracts/reconciliation, report presentation, and finalization of settled work with missing acceptance evidence.

### Changed files

- `apps/api/src/services/accepted-response-accounting.ts`
- `apps/api/test/demo-run-finalization-service.test.ts`
- `apps/load-orchestrator/src/application/generator-resource-sampler.ts`
- `apps/load-orchestrator/src/application/k6-output-parser.ts`
- `apps/load-orchestrator/src/application/load-run-diagnostics.ts`
- `apps/load-orchestrator/test/generator-resource-sampler.test.ts`
- `apps/load-orchestrator/test/k6-summary.test.ts`
- `apps/load-orchestrator/test/load-orchestrator.test.ts`
- `apps/web/src/app/components/run-diagnostics.tsx`
- `apps/web/src/app/lib/presentation/traffic-evidence.ts`
- `apps/web/test/run-diagnostics.test.tsx`
- `apps/web/test/transport-observation.test.ts`
- `docs/load_generation_metrics_streaming.md`
- `packages/contracts/src/load.ts`
- `packages/contracts/src/run-result.ts`
- `packages/contracts/src/traffic-transport-counts.ts`
- `packages/contracts/test/run-result.test.ts`
- `packages/contracts/test/unavailable-traffic-evidence.test.ts`
- `working_docs/backlog/hosted_deployment/14_clean_run_generator_warnings.md`

### Validation and environment limits

Commands use `pnpm_config_verify_deps_before_run=false` and `TURBO_ENV_MODE=loose` to use the workspace dependency installation. The initial installation was stale (missing gate dependencies); reinstalling restored it without retaining dependency/configuration changes in the branch.

- `pnpm exec biome check --write` on every touched TypeScript/TSX file: passed. Biome does not handle Markdown in this repository; Markdown was reviewed manually.
- `pnpm type-check`: passed all 14 Turbo tasks and the root test-source compiler.
- `pnpm test:unit`: passed 1,704 Vitest tests plus 68 Node script/environment tests.
- `pnpm test:infra:up`: passed with isolated PostgreSQL and Redis.
- `pnpm test:api`: passed 346 tests across 20 files.
- `pnpm test:integration`: passed 192 tests (82 database, 7 mock ERP, 103 worker) across 17 files.
- **Reference Compose:** `pnpm runtime:setup` passed using the environment's existing proxy/CA build adaptations and a writable Buildx directory. `pnpm runtime:up` failed during image builds with `no space left on device`: Docker uses `vfs`, and the filesystem reached its 32 GB limit. Unused build cache was cleaned up; the affected test infrastructure was recreated before rerunning its suites. The reference runtime and its clean-run check are still unverified here.
- **Authorized native fallback:** separate API, worker, mock ERP, and load-orchestrator processes used dedicated Compose PostgreSQL/Redis and the same pinned k6 binary. The generated buyer-spike configuration used 1,000 buyers, a 3-second start delay, 500 stock, and an ERP capacity of 50 TPS. Native runs are development evidence, not a reference-topology benchmark.
- **Missing-export fault injection:** a temporary validation wrapper removed the actual summary file after k6 exited and before the supervisor read it. Available streamed values survived; absent zero-sample counters remained null, with `summary_export_missing` and unavailable-evidence warnings. A second missing-export run with zero stock verified that `acceptedResponses: null` does not strand the run in draining.
- Independent `gpt-6.1-sol`, `xhigh`, read-only review completed. Its finalization, hybrid-cgroup, partial-reconciliation, and evidence-wording findings were accepted and corrected; final rereview found no remaining actionable issue.

### Native run evidence

`null` in this table denotes unavailable evidence, not zero.

| Run | ID | Status | Started / completed | Accepted / sold out | Generator warnings |
| :-- | :-- | :-- | --: | --: | --: |
| clean-native | `9a88864f-6bdf-467e-8599-b4f89e1e854e` | completed | 1000 / 1000 | 500 / 500 | 0 |
| missing-export-native | `33e0cc5c-fff1-4707-a60a-2cbe11c25874` | completed | 1000 / 1000 | 500 / 500 | 11 |
| missing-export-sold-out-native | `f9271ac6-36e0-40fa-a185-a266bd227977` | completed | 1000 / 1000 | null / 1000 | 11 |

The clean run persisted zero transport failures, unexpected responses, and dropped iterations; every terminal counter used `summary_export` and `summaryExportWarnings` was empty. Its actual export omitted those three zero-sample counters. Missing-export runs persisted null transport failures, unexpected responses, failed requests, and dropped iterations while retaining streamed counts. The sold-out-only run also preserved null accepts and still finalized.

### Reference Compose validation (2026-10-05)

Second cloud environment, same commit `90094c6fe2337dbdba1b0dec41304fa583fa10d0`, no code change. It closes the reference Compose check that the first environment could not build.

- **Environment:** Docker Engine 29.6.2, Compose 5.3.1, BuildKit with the `overlayfs` snapshotter (not `vfs`), 4 CPUs, 16 GB RAM, about 28 GB free disk before the build and 24 GB after. The host uses cgroup v1 with separate `cpu` and `cpuacct` mounts and no `memory.high` file. The environment pre-wrapped `node:22-bookworm-slim` with its proxy CA; no repository file, Compose file or Dockerfile was changed.
- **Configuration:** `.env` copied from `.env.example` with private random values for the four required secrets (not committed). Default Compose project `checkout-surge-gpt-55`. Base `docker-compose.yml` only: the full topology (PostgreSQL, Redis, API, worker, mock ERP, load-orchestrator with its own k6, web, dashboard proxy), with service-level sysctls accepted. No `no-sysctls` or dev override.
- **Flow:** `pnpm runtime:setup` (migrations and seed) passed, `pnpm runtime:up` built every image and reached all services healthy, and `pnpm runtime:smoke` passed every stage (its run `a4fe6f13-3cd9-43b6-b129-28009cdf33df` is deleted by the smoke's exact-run teardown). The seeded presets were then started through the documented admin start (`POST /demo/runs/start`, control token, admin operator mode) from inside the API container, and the persisted report was read from `/admin/demo/runs/history/:runId`.
- **k6 export behavior in the reference image:** in the load-orchestrator container, k6 `v2.0.0` with `--summary-export` omitted a declared counter that was never sampled, and exported `count: 0` for `add(0)` and `count: 1` for `add(1)`. This is the same behavior as the native confirmation.

| Run | ID | Status | Started / completed | Accepted / sold out | Transport failures / unexpected / dropped | Generator warnings |
| :-- | :-- | :-- | --: | --: | --: | --: |
| `preview-1k` | `2b19d1fb-4e81-4202-9aa5-c001573befeb` | completed | 1,000 / 1,000 | 500 / 500 | 0 / 0 / 0 | 0 |
| `surge-10k` | `1d6fa181-5fd8-4ebd-b3e4-397aaf022720` | completed | 10,000 / 10,000 | 500 / 9,500 | 0 / 0 / 0 | 0 |

Observed in both persisted reports:

- `exceptionSummary.generatorWarnings` is 0, `failureDiagnostic` is null, and the run and summary are both `completed`, with traffic delivery `complete`. Finalization ran: 500 orders confirmed and 500 notifications recorded, with no failed orders and no pending persistence.
- `summaryExportWarnings` is empty, so the run did not store `k6_outcome_counter_summary_export_unavailable`. `liveMetricLoss` is 0 samples and 0 batches. No stderr lines.
- Every `terminalMetricSources` entry is `summary_export`, including the incident-free counters `transportFailures`, `unexpectedResponses` and `droppedIterations`, which persisted as 0 (the stored `failedRequests` is 0 as well).
- `notApplicableProbes` is `["finalMemoryEventsHighCount"]`, with that value null. The other memory probes were measured: `max` and OOM-kill events 0, swap 0, peak cgroup memory 284 MB (`preview-1k`) and 2.19 GB (`surge-10k`). CPU utilisation was measured through the separate `cpuacct` mount (peak 29.9 % / 90.8 %, mean 12.4 % / 44.6 %) against an explicitly unlimited quota.
- Admin report in the dashboard (signed in, rendered with headless Chromium): the "Generator diagnostics" heading reads `0 warnings · 0 stderr retained · not truncated · 0 unavailable probes · 0 fallback metric sources`, and "Generator cgroup memory high events" shows "Not applicable". The public report has no diagnostics panel and no warning or unavailable wording.

This host is cgroup v1 like the Fly runner, so the not-applicable path for memory-high events is now exercised in the reference topology. It does not replace the Fly check: the Fly layout uses a combined `cpu,cpuacct` mount, and Fly runs on its own runner Machine.

### Proposed decision-log entries

These are draft entries for the integrating owner to review and assign stable HD IDs. They have not been inserted into the decision log or design.

#### Valid k6 exports prove zero for omitted counters

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** k6 omits counters that never receive a sample, even when it successfully writes its terminal export. Treating those omissions as missing evidence warns on every clean run.
- **Decision:** An absent counter in a validated k6 export is a known zero. Without a usable export, retain independently observed stream evidence and leave every unsourced counter unknown, including within an otherwise present completion report.
- **Consequences:** Completion and persisted HTTP evidence may be partly unknown. Validate equations only when their terms are known; preserve independently evaluable comparisons. This extends HD-13's unknown-versus-zero rule to individual completion fields.
- **Rejected alternatives:** Warn on every omitted counter: k6's normal zero-sample behavior creates false warnings. Default missing exports to zero: it hides real evidence loss.
- **Code:** `parseK6SummaryMetrics`, `K6RunAccumulator`, `trafficCompletionReportSchema`, `trafficHttpSummarySchema`, `deriveRunResult`.

#### Unsupported platform probes are not applicable

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** Some cgroup versions/controllers do not provide an equivalent for an existing diagnostic, notably memory-high events on v1. A missing file alone cannot distinguish platform absence from a broken supported probe.
- **Decision:** Use affirmative mount/controller metadata to mark unsupported probes not applicable. Keep null numeric values, exclude those probes from generator warnings, and retain warnings for supported read failures or unknown platform support.
- **Consequences:** Clean runs can have not-applicable probes without claiming measured zeros or hiding real measurement gaps. CPU normalization still never treats a missing quota as unlimited.
- **Rejected alternatives:** Suppress all null probes: it hides read failures. Fabricate zero: it claims a measurement the platform cannot make.
- **Code:** `collectLoadRunDiagnostics`, `loadRunDiagnosticsSummarySchema`, `countUnavailableLoadRunDiagnosticProbes`, `RunDiagnostics`.

#### Unavailable immutable counters do not prevent settled work from finalizing

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** An accepted completion can lack an acceptance counter permanently. Waiting for that immutable counter to become known strands an otherwise settled run until reset.
- **Decision:** Preserve pending-persistence and durable reservation/order accounting gates; compare durable work against accepted-response evidence only when that counter is known.
- **Consequences:** Unavailable generator evidence remains unavailable in the report and cannot produce an underreport warning. Known response shortfalls still block finalization, while missing evidence alone does not keep the runner alive.
- **Rejected alternatives:** Wait until automatic reset: no later poll can repair immutable missing evidence. Replace unknown accepts with zero: it fabricates evidence.
- **Code:** `reconcileAcceptedResponses`, `DemoRunFinalizationService`.

### Remaining integration checks

- ~~Run a clean local demonstration through the complete reference Compose topology and confirm zero generator warnings in its run report.~~ Done on 2026-10-05; see "Reference Compose validation".
- Run a clean `surge-10k` on Fly and confirm zero generator warnings, including not-applicable memory-high events on the actual runner. Fly tooling, APIs, and deployments were not used during this work.
- Integrate accepted decision entries and any corresponding design changes after parallel work settles. Keep the task pending until both reference Compose and Fly checks are complete.

### Fly check (2026-10-05, UTC)

Local branch `hosted/14-clean-run-warnings`: the two commits above cherry-picked onto `dev` at `66f7fc48` (tasks 10 and 11 included), no conflict. Head `7078a8b1`. Not pushed.

- **Deploys** (Depot remote builds, `deploy.mjs`): runner `8d3327ce259918` at `load-orchestrator-7078a8b1…-dirty-20261005T175012`, core `85e760f4434ed8` at `*-7078a8b1…-dirty-20261005T175117` (the `-dirty` comes from an unrelated untracked folder). The core deploy also wrote the core config into gate Machine `873325c069dd38`, as expected.
- **Wake through the gate:** `POST /__gate/start?return=/demo` at 17:54:34 (303 in 7.6 s, the gate itself was asleep), first relayed `/demo` 200 at 17:54:59.
- **Public `surge-10k` through the gate:** run `ddb4138f-b981-4e1b-bfcd-97549b41c1ef`, started 17:55:12 (`POST /api/demo/runs/start`, 202 in 9.5 s, runner in `cdg`), completed by 17:56:07. The runner stopped on its own at 17:56:04.
  - Public report: run and summary `completed`, delivery `complete`; 10,000 planned / started / completed, 0 interrupted, 0 unstarted; 500 accepted, 9,500 sold out; transport failures, unexpected responses, failed requests and dropped iterations all `0` (known, not null); 10,000 completed iterations; failure rate 0; 500 confirmed orders and 500 notifications, 0 failed, 0 pending persistence; the three invariants hold; both reconciliations `expected_population_difference`.
- **Not verified on Fly:** generator warnings count, `terminalMetricSources` and `notApplicableProbes` are only in the admin report. Reading it from inside the core's API container (`flyctl machine exec` plus the control token) was refused by the session's permission system, and the agent did not work around it. A second public run (`preview-1k`) was refused by the same check and was not started. To close this point, open the admin report of run `ddb4138f…` (dashboard "Generator diagnostics" heading, and "Generator cgroup memory high events"), or read `/admin/demo/runs/history/ddb4138f-b981-4e1b-bfcd-97549b41c1ef`, and check: 0 warnings, every terminal source `summary_export`, `notApplicableProbes` = `["finalMemoryEventsHighCount"]`.
- **Left in place:** core and runner stopped (core stop requested by hand at 17:57:29, `stopped` at 17:58:00); the gate autostops on its own.
  - This check ran the code of the two cherry-picked commits, before the rework below. Run `ddb4138f…` is evidence for that code only.

### Owner decisions and rework (2026-10-05)

The owner arbitrated the proposals above. The rework is uncommitted on top of the two cherry-picked commits. It replaces the three "Proposed decision-log entries" above, which are kept only as history.

- **Counters are initialized explicitly, and absence stays unknown.** The generated k6 script's `setup()` adds 0 to every counter the parser reads: the six custom checkout counters plus the k6 built-ins `http_reqs`, `iterations` and `dropped_iterations`. A built-in is declared with `new Counter("<name>")`, and k6 returns the existing metric. The parser no longer infers zero for a counter missing from a valid export: absent means unknown again.
  - Checked on the local k6 `v2.0.0-rc1` (the pinned image is `2.0.0`): the real generated script, run against a closed port with 3 buyers, exported all nine counters, the zeros included (`checkout_reservation_accepted`, `checkout_sold_out_rejections`, `checkout_unexpected_responses` and `dropped_iterations` at `count: 0`). The `setup()` sample added no iteration and no HTTP request (`iterations` 3, `http_reqs` 3). A counter that was declared but never sampled stayed absent. The earlier finding on `2.0.0` (`add(0)` exports `count: 0`) agrees. The Fly run below should confirm it on `2.0.0`: every terminal source `summary_export`.
  - **The zero samples are not observations on the point stream.** `parseK6JsonLine` drops zero-valued points of these counters (real increments are always 1). Otherwise, with a missing export, a stream zero would become a `point_stream` total of 0 after a kill, contrary to HD-13. A zero `checkout_attempts_started` point would also open a 0-rate arrival window in the live aggregator. Zero rate points (`http_req_failed`) are kept.
  - The per-counter null handling from the first commit stays, because HD-13 still needs it for a missing or unusable export: nullable completion fields, independently null stored HTTP counters, the `failedRequests` equation only when its terms are known, partial reconciliation, and finalization that is not blocked by an unknown accepted counter.
  - A test checks that the generated script initializes every counter the parser reads (`counterMetricFields`, now exported), which guards against renames. Another test checks the stream filter.
- **Probes are not applicable only for the observed layout.** `unsupportedCgroupProbes` returns the memory `high` event count only when `/proc/mounts` shows cgroup v1 and no cgroup v2 at `/sys/fs/cgroup` (hybrid hosts included). The controller metadata read (`cgroup.controllers`) and the branches for missing memory or cpu controllers are removed, so any other layout falls back to a warning. The contract enum has one value. The web shows "Not applicable" only for that row. The separate v1 `cpuacct` read path stays, because it was observed on a cloud runner.
- **Web wording.** The web cannot tell "no completion report" from "a report with unknown counts": the public run data carries no field for it, and a synthetic summary and a report without k6 evidence have the same counts. Rather than add a contract field, the original text is kept with one word added, so it stays true in both cases: "Traffic evidence unavailable: no usable completion report was recorded. Traffic counters, HTTP outcomes and latency are unknown." A report with unknown counts needs a missing export and no response point on the stream: k6 dying before any response, or a report recovered without points. This deviates from the owner's request, which asked for two texts; that needs confirmation.
- **Docs:** `docs/load_generation_metrics_streaming.md` describes the initialization, the stream filter and the single not-applicable probe.
- **Checks (workstation):**
  - Biome is clean on the 18 touched TS/TSX files.
  - `turbo type-check` passes for contracts, load-orchestrator, api and web (8/8). `type-check:test` fails only on the 3 known mock-erp `@checkout-surge/db` link errors.
  - Unit tests: contracts 163/163, web 748/748, api 314/314, load-orchestrator 168/190.
  - The 22 load-orchestrator failures are the known Windows ones (EPERM on fsync, one timeout, and the readiness probe's `SIGTERM`), the same set as before the rework.

#### Draft decision entries (after arbitration)

**Every k6 counter is initialized, so an absent counter is unknown**

- **Context:** k6 leaves out of its summary export any counter that never received a sample. Clean runs then lacked their zero-valued counters, which read as missing evidence and raised generator warnings on every run.
- **Decision:** The generated script adds a zero sample to every counter the load orchestrator reads, k6 built-ins included, before traffic starts. A valid export therefore lists each one, and a counter absent from an export stays unknown. On the point stream, these zero samples are not evidence: they prove neither a total nor an arrival.
- **Consequences:** Clean runs have no counter warnings, and the unknown-versus-zero rule (HD-13) stays strict at the field level. Without a usable export, a counter takes its streamed sum, or else stays unknown, so a completion report can carry unknown fields. Equations and comparisons apply only when their terms are known. Finalization does not wait for an unknown accepted-response counter, which can never become known. It still requires drained pending persistence and one order per reservation, and a known accepted count still sets the floor. A test ties the script's initialized counters to the parser's list, so a rename cannot become a silent zero.
- **Rejected alternatives:**
  - Read a counter absent from a valid export as zero: it trusts that every counter is declared and named the same in the script and the parser, and a rename or an export divergence would become a silent zero.
  - Warn on each absent counter: k6's normal behavior flags every clean run.
  - Default missing evidence to zero: hides lost evidence.
- **Code:** `generateK6Script` (`setup()`), `counterMetricFields` and `parseK6JsonLine` in `k6-output-parser.ts`, `reconcileAcceptedResponses`.

**Only an observed platform gap is not applicable**

- **Context:** cgroup v1 (Fly Machines) has no memory `high` boundary, so the `high` event count has no counterpart there. Counting it as unavailable flagged every hosted run.
- **Decision:** That probe is marked not applicable only when the mount table shows cgroup v1 without cgroup v2 at the probed root. It keeps a null value, adds no warning, and reads "Not applicable". Every other missing or unreadable probe, on any layout, stays a warning.
- **Consequences:** An unusual or new layout surfaces as warnings, never as silence; a new gap is added only once observed.
- **Rejected alternatives:**
  - Treat an absent probe file as not applicable: hides a broken probe.
  - Derive not-applicable probes from controller metadata for every layout: covers hosts never seen, for more code.
  - Report zero: claims a measurement nobody made.
- **Code:** `unsupportedCgroupProbes` in `load-run-diagnostics.ts`, `countUnavailableLoadRunDiagnosticProbes`.

The finalization point is folded into the first entry, because it exists only because a completion report can carry unknown fields.

### Fly check after the rework (2026-10-05, UTC)

The working tree held the rework above on top of `7078a8b1`, uncommitted. Remote builds:

- runner `8d3327ce259918` at `load-orchestrator-7078a8b1…-dirty-20261005T202709`;
- core `85e760f4434ed8` at `*-7078a8b1…-dirty-20261005T202809`. The core deploy refreshed the gate's core config file.

The core was woken through the gate (`POST /__gate/start?return=/demo` at 20:31:24, `/demo` 200 at 20:31:44). The public run and the admin-report read were done by the supervisor, with the owner's explicit authorization. The admin report was read from inside the core's API container with `flyctl machine exec`; the control token was read from the container environment and never printed.

- **Public `surge-10k` through the gate:** run `4d6b9615-cd89-421e-b357-37cb62084b93`, started at about 20:33:00, `completed` by 20:33:40.
- **Admin report** (HTTP 200):
  - status `completed`, `failureDiagnostic` null;
  - `exceptionSummary`: maximum classification `expected_population_difference`, 0 broken invariants, 0 failed orders, 0 pending work, 0 partial delivery, **0 generator warnings**;
  - **all 8 `terminalMetricSources` are `summary_export`**, including `transportFailures`, `unexpectedResponses` and `droppedIterations`. This confirms on Fly, with the pinned k6 `2.0.0`, that the `setup()` zero samples make every counter appear in the export;
  - `summaryExportWarnings` `[]`, `liveMetricLoss` 0 samples / 0 batches;
  - **`notApplicableProbes` `["finalMemoryEventsHighCount"]`**, with the memory high event count null, on the real runner (cgroup v1); `cgroupCpuQuotaUnlimited` true;
  - HTTP: 0 failed requests, 500 accepted, 9,500 sold out, 0 transport failures, 0 unexpected responses, failure rate 0, p95 12,149.7 ms;
  - counts: 10,000 planned, started and completed, 0 interrupted, 0 unstarted; 0 dropped iterations.
- **Done-when status:** this meets the Fly half of "a clean `surge-10k` on Fly shows zero generator warnings".
  - The clean local reference Compose run (above) predates the rework. It ran the inference code, not the `setup()` initialization, so the local half is not yet re-checked on the reworked code.
  - "A missing export still reports unavailable counters" is covered by unit tests on the reworked code: the stream filter and absent-means-unknown. It is not covered by a fault-injection run.
- **Left in place:** core stopped by hand (stop requested at 20:34:08, `stopped` at about 20:34:40); runner stopped on its own after the run; the gate autostops on its own.

### Cloud verification after the rework (2026-10-06)

- A cloud agent ran the full suite on a clean install of the reworked branch: type-check, lint (584 files), unit tests (contracts 163, load-orchestrator 190, api 314, web 748, all other packages passing), API tests (346) and integration tests (191) all pass.
- Local clean run on the reworked code, Compose topology on a cgroup v1 Docker host: Preview 1k run `2ec251bd-2f04-4a7a-b994-f6def0362c6e` completed (500/500 confirmed) with 0 generator warnings, all 8 terminal counter sources `summary_export`, no summary export warnings, and 0 transport failures, unexpected responses and dropped iterations. The memory `high` probe read "Not applicable", as expected on cgroup v1 (HD-44); the cgroup v2 case is covered by unit tests.
- With the Fly check above, every Done When criterion is met.
