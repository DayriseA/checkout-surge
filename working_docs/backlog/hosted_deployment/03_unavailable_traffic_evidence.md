# 03 — Unavailable Traffic Evidence

**Design:** section 4.3, last item · **Depends on:** none

## Goal

Traffic counters that have no k6 report behind them are shown as unknown, never as zeros.

## Scope

- **Contracts:** traffic counters can be explicitly unknown.
- **Persistence:** run summaries store unknown counters.
- **API:** `syntheticFailedTrafficSummary` (`apps/api/src/services/traffic-delivery-plan.ts`) and its callers separate two cases:
  - no traffic was started, so zeros are true;
  - traffic may have happened without a report, so counters are unknown. This covers admin and automatic resets during traffic.
- **Web:** the run report displays unavailable evidence.

## Out of Scope

- The `load_generator_lost` failure reason and its detection (task 06).

## Done When

- An admin or automatic reset during traffic produces a report with unavailable counters.
- A failure before traffic start still reports true zeros.
- Contract and service tests cover both cases.

## Open Points

- None.

## Working Notes

**Summary:**

- `@checkout-surge/contracts`: keep configured planned attempts known; permit explicitly null observed transport counts and HTTP outcomes, with all-known/all-unknown invariants. Completion reports still require measured counts. Stored delivery iteration counters may be null. Result reconciliation treats unavailable generator evidence as incomplete.
- `@checkout-surge/db`: existing non-null JSONB summary objects already support null members, and typed persistence inherits shared contracts. No SQL baseline, migration metadata, or snapshot change is needed. API tests insert/read unavailable summaries through the reviewed baseline and Run History parser.
- `apps/api`: synthetic summaries require explicit no-start or unavailable evidence. Serialize initial starts and starting-intent reconciliation through the existing maintenance authority. Preserve reported finalization evidence during resets; synthesize unknown evidence otherwise, including ambiguous starting runs and automatic resets.
- `apps/web`: show unavailable counters and coverage without deriving zeros; qualify missing reports in public/admin reset reports and generator measurement presentation.

**Rule:**

True zeros require affirmative no-start evidence: setup fails before the initial start is dispatched, or the first gateway dispatch receives a definitive HTTP 4xx rejection. The same process-local authority encloses durable intent creation, setup, dispatch, and failure recording; starting reconciliation obtains that authority before listing candidates, so it cannot dispatch a competing replay during these failures. Other unexpected gateway failures synthesize unknown counters; ambiguous outcomes already remain starting for reconciliation.

An admin or automatic reset without a persisted completion/finalization report always records unknown observed transport counts, HTTP counters/failure rate, and generator iteration totals. Neither `starting`, a missing start timestamp, empty durable business outcomes, nor `no_current_run` abort confirmation proves that no traffic previously occurred. Persisted report evidence remains unchanged when present. Planned requests and accepted configuration remain known. Empty request-arrival summaries remain an absence of observation and are presented as unavailable, using the existing observed-arrivals guard.

**Decisions to review:**

- Reuse the existing process-local maintenance authority for initial starts and reconciliation, including candidate discovery. This relies on the documented single API process ownership boundary; distributed start coordination is outside this task.
- Unknown transport counts are all null together; known counts retain both reconciliation equations. HTTP counters and failure rate are also all null together, with no measured latency when unavailable.
- Keep the existing JSONB baseline and snapshot unchanged because their shape already stores null members. No migration scheme or historical summary rewriting is introduced.
- Keep reset delivery status `failed` as the terminal workflow outcome; it does not claim a measured shortfall when counts are unknown.

**Questions for the owner:**

None.

**Documentation impact:**

Needed follow-up updates only (not edited in this task):

- `docs/load_generation_metrics_streaming.md`: nullable stored counters, exact no-start evidence rule, reset evidence, and shared initial-start/reconciliation serialization.
- `docs/architecture.md`: process-local authority now also encloses initial starts and starting reconciliation.
- `docs/automated_testing_infrastructure.md`: new unavailable-evidence contract, persistence/history, reset presentation, and setup/replay race coverage.

**Validation:**

Commands use `pnpm_config_verify_deps_before_run=false` and `TURBO_ENV_MODE=loose` to use the preinstalled dependency tree across Turbo children. Without these environment settings, pnpm's automatic dependency verification tries to create an unavailable home-directory store. No repository pnpm configuration was changed.

- `pnpm exec biome check --write <all touched TypeScript/TSX files>`: passed; 27 files checked, no lint errors. Log: `/tmp/rung2-biome-final.log`.
- `pnpm type-check`: passed all 11 Turbo tasks and the root test-source compiler after the final production and test edits. Log: `/tmp/rung2-types-final.log`.
- `pnpm test:unit`: passed 1,501 Vitest tests across 123 files, plus 67 Node script/environment tests. Log: `/tmp/rung2-unit-final.log`.
- `pnpm test:infra:up`: passed; isolated PostgreSQL and Redis containers became healthy. Log: `/tmp/rung2-infra.log`.
- `pnpm test`: passed all unit, API, and integration lanes; API had 337 tests across 20 files; integration had 192 tests across 17 files (DB 82, worker 103, mock ERP 7). Log: `/tmp/rung2-full-final.log`. The final dashboard fallback guard was subsequently verified by the full unit rerun and type-check; the subsequent ambiguous-start test rewrite was verified by the final API rerun.
- `pnpm test:api`: final rerun passed 337 tests across 20 files. Log: `/tmp/rung2-api-final.log`.
- `git diff --check`: passed.
- `pnpm test:infra:down`: passed after review; removed only the dedicated test containers and volumes.
- Independent `orchestrate` review: no actionable findings. Implementation landed at rung 2 (`gpt-6.1-sol`, medium); review used `gpt-6.1-sol`, xhigh. The main agent's final diff review also passed.

The first full test attempt exposed three old maintenance expectations for reset synthetic zeros; those expectations now assert unknown evidence, and the full rerun passed. Existing web tests emit a jsdom navigation-not-implemented diagnostic while passing. No composition or characterization tests were run.

**Integration (2026-10-03):**

Merged on `integrate/03` after review; owner decisions applied there:

- When traffic counts are unknown, the web shows neither the delivery pill (admin header, public "Delivery quality") nor the "Delivery failed" caveat; the unavailable-evidence text is enough. Web-only: the API still classifies the delivery status as `failed`.
- The traffic execution gateway owns the definitive-start-rejection rule: it throws `TrafficStartRejectedError` for a 4xx start answer, and `demo-run-service.ts` checks that class instead of reading `error.details.statusCode`.
- One web helper (`apps/web/src/app/lib/presentation/traffic-evidence.ts`) holds the unknown-counts check and its wording for every surface.
- `trafficHttpSummarySchema` reuses the measured schema's `failedRequests` equation instead of duplicating it.
- Documentation updated: `design.md` 4.3, `docs/load_generation_metrics_streaming.md`, `docs/architecture.md`, `docs/automated_testing_infrastructure.md`, and inputs for tasks 05, 06 and 14.
- DB-backed API and integration tests are pending a cloud run before `dev` is updated.

### Cloud verification (2026-10-03)

The integrated state (`dev` plus this task and its integration follow-ups) passed on Linux: `pnpm type-check`, `pnpm lint`, `pnpm test:unit` (1,547 tests), `pnpm test:api` (337 tests) and `pnpm test:integration` (192 tests), with the isolated PostgreSQL and Redis test infrastructure.
