# Task 01 — Repair idle Watch new-run convergence race

## Execution context

Task 1 of 45. Phase 0: establish a trusted baseline. Primary ownership boundary: the browser dashboard state reducer and recovery hook. Dependencies: none; this is the first correctness repair and must land before dashboard-protocol simplification. This record is standalone: it defines the defect and required proof without relying on any other planning document. Follow the quality checklist: keep the browser boundary focused, do not move infrastructure construction into it, add coverage at the reducer/hook boundary, and record actual verification.

## Why this task exists

There is a deterministic race: `startRun()` captures a new run's `startedAt` at t0; an idle Watch recovery completes at t1; then the start commits and its lifecycle event arrives at t2. The valid nonterminal event can be older than `recoveredAt`, so current stale-event protection discards it. An idle Watch does not poll, leaving the UI stranded indefinitely.

## Required outcome

When a coherent nonterminal event for a new run cannot safely establish scope because it predates the current recovery watermark, request one coalesced authoritative recovery. Do not broadly relax stale-event protection or accept arbitrary older events.

## Scope and implementation guidance

Inspect and verify current paths before editing because the checkout may drift: `apps/web/src/app/lib/dashboard-state.ts`, `apps/web/src/app/components/realtime/use-dashboard-recovery.ts`, `apps/web/test/dashboard-phase6.test.ts`, `apps/web/test/dashboard-hooks.test.tsx`, and relevant browser/recovery tests such as `apps/web/test/dashboard-recovery-ui.test.ts`. Preserve the existing recovery coalescing authority. Add a deterministic reducer-level regression encoding t0 start timestamp → t1 idle recovery → t2 commit/event, plus hook/browser coverage if needed to prove the recovery request actually converges.

## Retained behavior and non-goals

Retain strict protection against stale events from prior runs, current terminal handling, and bounded/coalesced recovery. This task does not redesign SSE, add polling, loosen all watermark comparisons, or begin the later revisioned-projection migration.

## Acceptance criteria

- [ ] The exact t0/t1/t2 race is represented by a focused regression.
- [ ] A coherent nonterminal new-run event that is too old for `recoveredAt` triggers exactly one coalesced authoritative recovery.
- [ ] The recovered new run becomes visible without idle polling.
- [ ] Stale events from an older run remain rejected.
- [ ] Routes and server composition are unchanged.

## Verification

Run focused web tests, for example `pnpm --filter web test:unit -- test/dashboard-phase6.test.ts test/dashboard-hooks.test.tsx test/dashboard-recovery-ui.test.ts`, adapting filenames if the checkout has moved them. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record the exact command and result.

## Working record

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none
