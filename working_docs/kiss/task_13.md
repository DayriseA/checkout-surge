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

- [ ] Contract and typed-JSON decoders accept only current shapes and report invalid data clearly.
- [ ] Legacy normalizers/translators and their fixture-only formats are deleted with their tests.
- [ ] Finalization, maintenance, history, binding, and parser paths use the same current representation.
- [ ] Current transport semantics and current K6 journal delivery remain intact while every old-shape preprocessor, including the journal migration, is removed.
- [ ] Relevant contracts, persistence, and service tests prove current-shape success and invalid-shape failure.

## Focused verification

Run `pnpm --filter @checkout-surge/contracts test:unit`, `pnpm --filter @checkout-surge/db test:unit`, and focused API/load-orchestrator tests matching changed files; then run affected package type-checks. Run DB integration typed-JSON tests if the DB boundary changes. Do not run composition or characterization suites.

## Working record

Pending — list removed legacy shapes, remaining task-15/34 couplings, affected durable data boundaries, commands run, and skipped checks.
