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

- [ ] Surviving status claims match checked acceptance evidence or are qualified/removed.
- [ ] The transition-race regression is present in a reproducible focused form.
- [ ] Automated Watch-plus-Preview behavior is covered or an explicit supported limitation is recorded.
- [ ] No surviving claim references an untracked screenshot as evidence.
- [ ] The remediation command name is exactly `maintenance:remediate-terminal-pending`.
- [ ] Intentionally deleted review-and-fixes documents are not restored.

## Verification

Run the focused web/API tests added or cited and inspect `pnpm run`/`package.json` for the command name. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record exact evidence locations and commands.

## Working record

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none
