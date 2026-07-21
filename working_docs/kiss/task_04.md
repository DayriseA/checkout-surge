# Task 04 — Make verification evidence reproducible

## Execution context

Task 4 of 45. Phase 0: establish a trusted baseline. Primary ownership boundary: surviving verification records, focused regressions, and package-command documentation. Dependencies: tasks 01–03 provide behavior and a green type gate whose evidence this task must accurately record; do not claim them complete until verified. This record is standalone. Apply the quality checklist by keeping coverage at its behavior boundary and reporting tests actually run.

## Why this task exists

Current evidence contains unchecked acceptance boxes, a promised transition-race regression not recorded in its promised form, no automated Watch-plus-Preview regression, an untracked screenshot reference, and an incorrect remediation command. The real package script is `maintenance:remediate-terminal-pending`.

## Required outcome

Reconcile surviving claims, tests, and documentation with reproducible evidence. Add focused non-composition regressions only where behavioral coverage is genuinely missing. Remove or qualify unsupported completion claims and artifact references.

## Scope and implementation guidance

Verify current paths before editing because the checkout may drift. Inspect surviving `working_docs/`, `docs/`, package scripts in `package.json`, and dashboard browser tests including `apps/web/test/dashboard-phase6.test.ts`, `apps/web/test/dashboard-hooks.test.tsx`, `apps/web/test/dashboard-recovery-ui.test.ts`, and `apps/web/test/dashboard-control-surface.test.ts`. The review-and-fixes documents are intentionally being deleted: do not recreate or resurrect absent documents. Record the transition-race regression in a discoverable focused test or accurately qualified record; add automated Watch-plus-Preview coverage if absent. Correct references to `maintenance:remediate-terminal-pending`, and remove untracked screenshot claims rather than inventing artifacts.

## Retained behavior and non-goals

Retain truthful historical evidence that is still supported. Do not add governance machinery, replace accurate focused tests with broad end-to-end lanes, or run composition/characterization as ordinary proof.

## Acceptance criteria

- [x] Surviving status claims match checked acceptance evidence or are qualified/removed.
- [x] The transition-race regression is present in a reproducible focused form.
- [x] Automated Watch-plus-Preview behavior is covered or an explicit supported limitation is recorded.
- [x] No surviving claim references an untracked screenshot as evidence.
- [x] The remediation command name is exactly `maintenance:remediate-terminal-pending`.
- [x] Intentionally deleted review-and-fixes documents are not restored.

## Verification

Run the focused web/API tests added or cited and inspect `pnpm run`/`package.json` for the command name. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record exact evidence locations and commands.

## Working record

- Status: completed
- Completed scope: Reconciled Task 03's completed status with its acceptance checklist after independently inspecting its focused test-only repairs and rerunning the full root type gate. Preserved the exact t0 start → t1 idle recovery → t2 event coverage in `dashboard-phase6.test.ts` and its single-flight browser-hook convergence proof in `dashboard-hooks.test.tsx`. Made the existing bounded sustained mixed-event hook regression explicitly discoverable as Watch with the Preview 1k preset shape (1,000 buyers and 250 stock); no duplicate test or new harness was added. Confirmed there is no tracked or untracked screenshot artifact and no surviving claim uses one as evidence. Confirmed the incident remediation command in the root package script and both surviving documentation references. Confirmed no `working_docs/review-and-fixes` files or directory survive.
- Decisions: The Watch-plus-Preview evidence is intentionally focused browser-hook automation, not a live deployed-runtime, composition, or 1,000-request execution proof. The existing test exercises bounded mixed-event reconciliation, terminal convergence, recent-order/lag caps, and the 30-second trailing read using a Preview 1k-shaped frozen run snapshot; broad E2E/composition coverage remains outside this task. No `docs/` page changed because runtime behavior, supported scope, and operator commands were already accurate; changing documentation solely for a test-fixture clarification would create drift rather than prevent it. Historical verification text in Task 03 was left intact.
- Verification: `pnpm --filter web exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.config.ts test/dashboard-phase6.test.ts test/dashboard-hooks.test.tsx test/dashboard-recovery-ui.test.ts test/dashboard-control-surface.test.ts` passed 4 files / 69 tests. `pnpm type-check` passed from the repository root with 11/11 Turbo tasks followed by the full `tsconfig.test.json` check. `pnpm run | rg -n -C 1 'maintenance:remediate-terminal-pending'` printed the exact script name and implementation path. Repository searches found no tracked/untracked `temp.png`, screenshot artifact, or surviving review-and-fixes path; the only screenshot mentions are historical problem statements in the audit and this task, not evidence claims. Composition and characterization tests were not run, per repository guidance.
- Follow-up: The live deployed-runtime Watch-plus-Preview path remains outside this focused evidence task and is not claimed as verified here.
