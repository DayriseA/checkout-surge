# Task 78: Enforce lifecycle coherence in boundary DTOs with discriminated unions

## Execution context

- **Execution order:** This is task 78 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P4 (hardening note)
- **Area:** contracts
- **Source:** independent review (note; the same weakness was graded a full finding on Opus and GLM)
- **Locations:** `packages/contracts/src/demo.ts:94`, `packages/contracts/src/erp.ts:48`

Snapshot, completion-outcome, and ERP confirmation schemas accept incoherent combinations (success without a confirmation ID; timestamps independent of state). Producers are currently coherent — add discriminated unions and negative tests to keep it that way.

## Implementation record

- **Status:** Complete (2026-07-17).
- **Completed scope:** Replaced the three permissive strict objects with strict discriminated lifecycle unions, added positive coverage for every legal producer shape and negative coverage for incoherent state/metadata combinations, and corrected downstream fixtures/types exposed by the stronger inference.
- **Demo-run decision:** `starting`, `active`, `draining`, and `completed` now carry their producer-owned timestamp requirements and forbid terminal metadata outside terminal states. Failed runs require finalization metadata but retain the three evidenced traffic timestamp shapes: no traffic timestamps for pre-start failure, only a start timestamp for failure/reset during traffic, or both timestamps after traffic completion. A failed run may retain succeeded traffic because business draining can fail after successful traffic.
- **Completion-outcome decision:** Canonical order status discriminates required and forbidden processing/terminal timestamps and allowed display statuses. Notification display state and timestamp must occur together on a confirmed outcome. The contract does not impose new timestamp ordering or ERP-attempt metadata rules that are not guaranteed by this projection boundary.
- **ERP decision:** Success requires a confirmation ID and exact HTTP `200` while forbidding error metadata. Failure requires a `4xx`/`5xx` HTTP status and non-empty error code/message while forbidding a confirmation ID.
- **Documentation:** Updated `docs/core_business_entities.md` with the boundary lifecycle guarantees for demo runs, completion outcomes, and ERP responses.
- **Verification:** `@checkout-surge/contracts` unit tests (111 passed), type-check, lint, and build passed. Production type-checks passed for contracts, DB (including boundary check), API, worker, Mock ERP, and web. Lint passed across all changed TypeScript files. Worker unit tests (91) and Mock ERP unit tests (62) passed. Focused web tests for the affected dashboard/admin fixtures passed (67), and focused API recovery/history tests passed (5). Full web unit execution passed 215 tests but three unrelated UI timing-sensitive tests failed/time out under the concurrent package run; the affected focused rerun passed. API tests requiring local test PostgreSQL/Redis were attempted but could not run because the test services were unavailable (`ECONNREFUSED` on Redis port 6380); the process was stopped after the infrastructure failure was established. Test-source type-check reaches only pre-existing `packages/db/test/unit/vocabulary-parity.test.ts` generic `PgEnum` assignment errors after all Task 78 errors were resolved. Repository-wide formatting remains non-clean on pre-existing sections of several touched files; `git diff --check` passes and the new contract source is formatter-clean, while broad auto-formatting was avoided to keep this task scoped.
- **Skipped checks:** Composition and characterization suites were not run, per repository instructions. Integration suites needing Docker-backed test infrastructure were not started separately.
- **Remaining issues:** No Task 78 implementation issue is known. The unrelated vocabulary-parity test typing failures and unavailable test infrastructure remain outside this task.
