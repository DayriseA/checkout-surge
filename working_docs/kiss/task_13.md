# Task 13 — Remove legacy persisted-JSON normalizers

## Execution context

Task 13 of 45, Phase 3. Depends on task 09's disposable-data policy and should follow task 12 when a baseline removes historical storage. This standalone record assigns primary ownership to shared contracts and the persistence adapters that decode their JSON; routes only surface validated results. Apply the checklist's package-boundary rule: `@checkout-surge/contracts` owns public shapes and `@checkout-surge/db` owns typed JSON boundaries.

## Why

Runtime readers translate old persisted JSON and load-journal shapes even though the pre-release data has no compatibility promise. Each translation adds a second representation and masks malformed retained data.

## Required outcome

Accept only current persisted JSON and journal shapes. Delete legacy normalizers, compatibility reads, and historical translations in traffic transport helpers, API finalization/maintenance/history/binding flows, DB typed JSON handling, and `migrateLegacyExecutionJournal`. Preserve the current strict single-slot journal and its current delivery behavior; only its legacy-shape preprocessing is removed here. Invalid current data must fail clearly with contextual validation errors. Do not create a temporary compatibility mode.

## Scope and concrete current paths

- `packages/contracts/src/load.ts`, `traffic-transport-counts.ts`, `demo.ts`, and tests.
- `packages/db/src/json.ts`, schema typed-JSON columns, persistence tests, and migration baseline as applicable.
- API traffic completion binding/enrichment, `demo-run-finalization-service.ts`, `demo-maintenance-service.ts`, `run-history-service.ts`, recovery and parser callers under `apps/api/src/services/`.
- Load orchestrator parser/report and durable journal paths under `apps/load-orchestrator/src/`; inspect actual names before editing.

## Retained behavior and non-goals

Keep validation of the one current shape, clear operator-visible failures, current traffic/business outcomes, and durable recovery guarantees. Do not redesign the canonical transport model before task 15 or change K6 durable journal ownership/retry behavior reserved for task 34. Removing legacy journal migration is required; removing the current journal is not. No fallback reader, silent coercion, or old-field defaulting remains.

## Acceptance

- [x] Contract and typed-JSON decoders accept only current shapes and report invalid data clearly.
- [x] Legacy normalizers/translators and their fixture-only success cases are deleted; focused rejection cases prove old shapes no longer pass.
- [x] Finalization, maintenance, history, binding, and parser paths use the same current representation.
- [x] Current transport semantics and current K6 journal delivery remain intact while every old-shape preprocessor, including the journal migration, is removed.
- [x] Relevant contracts, persistence, and service tests prove current-shape success and invalid-shape failure.

## Focused verification

Run `pnpm --filter @checkout-surge/contracts test:unit`, `pnpm --filter @checkout-surge/db test:unit`, and focused API/load-orchestrator tests matching changed files; then run affected package type-checks. Run DB integration typed-JSON tests if the DB boundary changes. Do not run composition or characterization suites.

## Working record

- Status: complete.
- Removed contract compatibility: Deleted `normalizeLegacyTrafficHttpSummaryJson`, `normalizeLegacyTrafficDeliverySummaryJson`, `normalizeLegacyApiRequestLifecycleSummaryJson`, and `normalizeLegacyLoadRunDiagnosticsSummaryJson` from the transport-count contract module, plus the unused compatibility evidence schema. No contract export or runtime caller remains. The persisted delivery schema now requires every current nullable/diagnostic field explicitly instead of supplying missing-field defaults. Retired successful inputs are HTTP/delivery `emittedRequests`, delivery `unstartedIterations` and `requestShortfall`, completed-only request lifecycle summaries, and diagnostics `terminalMetricSources.emittedRequests`.
- Removed journal compatibility: Deleted `migrateLegacyExecutionJournal` and all request-plan reconstruction, timestamp-only/missing-terminal-evidence diagnostics hydration, empty/p95-only timing translation, terminal-source defaults, and transport/lifecycle preprocessing. `FileExecutionStore` still owns exactly one atomic fsynced-and-renamed journal slot and its accepted/executing/completion-pending/completed persistence transitions. `K6Runner` and the surrounding orchestration retain process ownership, bounded cancellation, and completion delivery/retry. Journal reads use materialized-state request and completion schemas, so persisted fields that have wire defaults remain required in `execution.json`; malformed JSON or schema data throws `ExecutionJournalReadError` with the durable path and field issues.
- Persisted demo-run boundaries: Current incoming completion evidence still receives API-derived delivery classification before persistence. Redelivery validates current HTTP, delivery, timing, real diagnostics, and lifecycle JSON before exact comparison and no longer falls back to raw equality after a failed parse. API finalization, admin reset, retry-policy lookup, dashboard recovery, and public/admin run history use explicit materialized parsers for persisted accepted configuration, business outcomes, terminal inventory, and completion evidence; the worker's run-config reader applies the same strict materialized accepted-snapshot schema. Wire schemas retain request defaults, but these affected demo-run-state and journal readers do not use them to repair stored data. Errors identify the demo run, finalization, run-summary row, or journal and affected field. Current dashboard rows require `startedAt` and `saleOfferId`; contextual reader failures are logged and recovery degrades to its documented no-scope response rather than projecting compatibility state.
- DB typed JSON: `demo_run_finalizations` Drizzle JSON declarations now use `HttpTimingBreakdownSummary`, `RealLoadRunDiagnosticsSummary`, and `TrafficCompletionApiRequestLifecycleSummary` in addition to the already typed HTTP/delivery summaries. This is compile-time typing only; API boundaries still perform runtime validation because PostgreSQL JSON/raw SQL cannot be made safe by a TypeScript annotation. Terminal run-summary diagnostics/lifecycle fields remain generic because API-owned synthetic failure and accounting annotations are legitimate current variants.
- Deferred couplings: Task 15 still owns removal of duplicated current `httpSummary`, `trafficDeliverySummary`, and `apiRequestLifecycleSummary` facts and any transport-equation redesign. Task 34 still owns simplifying the current durable journal/process-delivery authority. This task retained both current representations and the durable journal/redelivery mechanism without adding a compatibility mode.
- Verification: `pnpm --filter @checkout-surge/contracts test:unit` passed 111 tests; `pnpm --filter @checkout-surge/db test:unit` passed 54 tests; the final `pnpm --filter load-orchestrator test:focused:service` run passed 91 tests, including missing materialized request/completion fields; and the four follow-up API files passed 88 tests for history/config/business/inventory context, dashboard recovery, independently invalid diagnostics/lifecycle, and admin reset. The earlier seven affected API files passed together with 169 tests. The focused worker run-config reader integration file passed 3 tests, including valid current state and rejection of a missing wire-defaultable stored field with run/path context. `pnpm --filter @checkout-surge/db test:integration` passed 81 tests, and the current-shape typed-JSON file passed again alone after the final schema tightening. Contracts were rebuilt before the final cross-package test pass. Contracts, DB (including boundary), API, load-orchestrator, and worker type-checks passed; root test-source type-check passed; affected package lint and focused Biome checks passed; `git diff --check` passed. Focused searches found no retired normalizer/migration/helper names outside planning records; retired field literals remain only in explicit schema-rejection tests.
- Verification notes: One early API command used an ineffective argument separator and attempted the whole API suite before test infrastructure was started. A later accidental parallel launch of two database-reset suites produced reset/deadlock interference; both suites passed when rerun sequentially, which is the supported test pattern. These were harness invocation errors, not product failures. `pnpm test:composition` and `pnpm test:characterization` were not run by instruction.
