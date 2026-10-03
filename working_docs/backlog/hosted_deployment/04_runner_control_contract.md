# 04 — Runner Control Contract

**Design:** sections 1.3, 4.2, 4.3, 8 · **Depends on:** none

## Goal

The load-orchestrator gains the identity and self-termination behavior that a per-run lifecycle needs. Everything here is testable locally, without Fly.

## Scope

- **Boot ID.**
  - The load-orchestrator generates a boot ID at process start and exposes it.
  - Every start or replay carries the expected boot ID, and a mismatch is rejected.
- **Fenced shutdown:** a `shutdown(runId, bootId)` endpoint. The process exits only when the request matches its current boot.
- **Self-exit:**
  - after 3 minutes with no execution and no completion report awaiting acknowledgement;
  - at a maximum lifetime derived from `automaticRunResetDeadlineSeconds` plus a small margin.
- **Off unless configured:** both self-exit timers are disabled by default, so the local topology keeps a long-lived load-orchestrator (design section 1.3).
- **Version:** the load-orchestrator exposes its commit SHA.
- **Contracts:** boot ID and version fields in the runner control contracts.

## Out of Scope

- The API side: the operations owner, boot-ID persistence and the version handshake (task 05).

## Done When

- Tests cover the boot-ID mismatch rejection, the fenced shutdown and both self-exit timers.
- A local Compose run still works.

## Open Points

- None.

## Working Notes

### Summary (by package)

- `@checkout-surge/contracts`: added runner identity/control and fenced shutdown contracts; status now includes `bootId` and `version`; start requests accept optional `expectedBootId`; added dedicated boot-mismatch and stopping error codes.
- `apps/load-orchestrator`: one process boot UUID, supplied commit version, authenticated control/status exposure, start/replay fencing before runner admission, and a focused lifecycle service for shutdown and timers. Existing k6 shutdown, journal publication, and completion delivery code is reused unchanged.
- `apps/api`: updated unit-test status fixtures to satisfy the extended shared contract; no lifecycle, persistence, operations-owner, or version-handshake implementation.

### Configuration (defaults/enabling)

- `RUNNER_LIFECYCLE_ENABLED` defaults to `false`. Set exactly `true` to enable the shutdown endpoint and both self-exit timers together. Other nonempty values except `false` fail configuration validation. Local Compose files are unchanged.
- `COMMIT_SHA` supplies `version` at runtime (a build can provide it as an image environment variable); missing/blank values explicitly expose `unknown`.
- The idle threshold is three minutes, checked each second. Maximum lifetime starts from process boot and initiates shutdown at the imported `automaticRunResetDeadlineSeconds` plus a 30-second margin.

### Shutdown semantics (states)

- `POST /traffic/shutdown` requires the existing control token and `{runId, bootId}`. Boot mismatch returns `ignored_boot_mismatch`; mismatch with an existing journal/execution run returns `ignored_run_mismatch`. Neither initiates shutdown.
- Matching requests while a start is awaiting admission, k6 is preparing/running/stopping, or the journal is `accepted`, `executing`, `completion_pending`, or `completion_rejected` return `deferred_busy`. The caller may retry; execution and completion retries continue untouched, and parked reports remain available.
- A matching request with an empty journal or `completed` journal returns `shutdown_requested`, immediately fences new starts, then invokes the existing graceful process shutdown after the HTTP acknowledgement can be sent.
- Idle shutdown requires no execution/admission in flight and an empty or `completed` journal. Work and unacknowledged/parked reports reset the idle window. The start guard and admission generation prevent shutdown from racing an admission whose journal write has not finished yet or whose complete execution interleaves with a stale journal read. Reads begun during execution also defer shutdown even if execution finishes before the read resolves. The idle check applies the same guard.
- Maximum lifetime initiates existing graceful shutdown regardless of execution/report state. Executing interruption publishes the existing failure report; shutdown retains the durable journal and joins existing bounded completion delivery guarantees. It does not falsely acknowledge or delete a report.

### Decisions to review

- `expectedBootId` deliberately remains optional for task 05 staging. Omitted values preserve current start behavior; a supplied mismatch rejects both new starts and same-run replays before any runner call.
- One flag enables the endpoint and both timers. The lifetime margin is 30 seconds; the idle policy has up to one second of polling delay.
- A hard lifetime fallback cannot guarantee API acknowledgement during a permanent API outage. Pending and permanently rejected reports remain in the existing journal at exit; preserving that journal across a future ephemeral hosted Machine requires task 02/05 deployment/storage policy. The explicit endpoint and idle policy refuse to discard such reports. No Fly/storage or indefinite-drain behavior was added.

### Questions for owner

- Confirm the future hosted storage/collection policy for a report still unacknowledged at the maximum lifetime, especially a permanently rejected report. This task preserves the existing journal but does not provision persistent hosted storage.

### Documentation impact (list only)

- `docs/runtime_topology.md`: runner identity/version, opt-in lifecycle configuration, and explicit versus maximum-lifetime shutdown policies.
- `docs/load_generation_metrics_streaming.md`: shutdown admission deferral and pending/rejected report treatment.
- `working_docs/backlog/hosted_deployment/05_runner_lifecycle.md`: staged optional boot fencing, control/shutdown response vocabulary, owner retry and version handshake integration.
- Deployment configuration/environment reference: `RUNNER_LIFECYCLE_ENABLED` and `COMMIT_SHA`.

### Validation (commands/results)

- Validation used installed pnpm `11.19.0` and existing dependencies. A temporary `/tmp/runner-pnpm-bin/pnpm` wrapper set `pnpm_config_verify_deps_before_run=false` and `npm_config_manage_package_manager_versions=false` before invoking installed pnpm, because its default dependency verification tried to install under unwritable `/home/agent`; Turbo strips those variables without the wrapper. Commands below used `PATH=/tmp/runner-pnpm-bin:$PATH`. No repository dependency or package-manager configuration was changed.
- `pnpm exec biome check --write <all touched files>`: passed; 11 supported TypeScript files checked, no final fixes or lint errors. Markdown is ignored by the existing Biome configuration. `git diff --check`: passed.
- `pnpm type-check`: passed, all 11 Turbo tasks plus `tsc -p tsconfig.test.json --noEmit`.
- `pnpm test:unit`: passed, all 11 Turbo tasks; load-orchestrator has 176 passing tests including 13 new runner-control tests. Initial runs caught updated-contract fixture omissions and new test fixture typing/setup mistakes; all were corrected before the final green checks.
- `pnpm test:infra:up`: passed; isolated PostgreSQL and Redis containers healthy. Docker daemon and networking guidance were read before these commands; inherited proxy settings were preserved.
- `pnpm test`: passed unit, API, and integration phases. API: 334 tests in 20 files; integrations: DB 82 tests, worker 103 tests, mock ERP 7 tests. Turbo phases completed 11/11, 4/4, and 6/6 tasks respectively.
- No full local Compose runtime or `runtime:smoke` run was performed. Default-off configuration/endpoint tests, unchanged Compose files, and the Docker-backed default suite provide compatibility evidence, but are not a full local runtime smoke proof. Neither `test:composition` nor `test:characterization` was run.

- Follow-up review fix: a delayed journal read could return an old empty/completed slot after a fast admission had already published its pending completion. Admission-generation checks now span the read and the exit decision, including a late previous-run shutdown after a later completed admission. Three regression tests cover these complete interleavings.
- Follow-up `pnpm exec biome check --write <three changed TypeScript files>`: passed; final `git diff --check`: passed.
- Follow-up `pnpm --filter load-orchestrator test:unit`: passed, 179 tests in 8 files, including 16 runner-control tests. Follow-up `pnpm type-check`: passed, all 11 Turbo tasks plus test TypeScript checking. The earlier full Docker-backed suite remains the recorded integration result; infrastructure and unrelated integration suites were not repeated for this isolated runner lifecycle fix.

### Integration (2026-10-03)

- Merged into `dev` after review. All four owner decisions listed in the task stand: optional `expectedBootId` until task 05, endpoint and timers off by default, boot ID checks active everywhere, commit SHA exposed.
- **Owner decision, answering the open question:** no persistent storage for a report still unacknowledged at the maximum lifetime. Design section 4.1 accepts its loss with the volume-less runner. By then the API has already auto-reset the run, and task 06 detects the loss.
- **Review fix:** a `completion_rejected` report no longer blocks the fenced shutdown or the idle exit. The API has answered it definitively, so nothing awaits acknowledgement (design section 4.2). This supersedes the `completion_rejected` entries in the shutdown semantics above.
- **Review fix:** the idle check returns before reading the journal while an execution is in memory, so the runner no longer reads the journal every second during traffic.
- **Deployment:** `infra/fly/runner/machine.json` sets `RUNNER_LIFECYCLE_ENABLED=true`. `infra/fly/deploy.mjs` sets the runner's `COMMIT_SHA` to its image-label version, including `-dirty`. Nothing was deployed.
- `design.md` sections 4.2, 4.3 and 8 record the routes, outcomes, error codes, flag, lifetime origin and version source. `05_runner_lifecycle.md` lists the inputs task 05 must handle.
