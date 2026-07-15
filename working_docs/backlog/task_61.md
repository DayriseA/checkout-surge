# Task 61: Reflect authenticated admin state consistently across admin surfaces

## Execution context

- **Execution order:** This is task 61 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P3
- **Area:** web / admin UX
- **Source:** browser testing (low, confirmed)
- **Solved elsewhere:** n/a — branch-specific UI state bug; overlaps entry 60's surface work.
- **Locations:** `/admin` page shell; `/run-history` cleanup panel

After signing in, protected sections become usable but the page still shows "access required" wording, and `/run-history` keeps showing the passphrase field and Sign In button. Operators cannot tell whether their session is valid and are invited to re-enter the passphrase around destructive controls.

## Implementation record (2026-07-15)

### Status

Completed by Task 60 on commit `93ce47a` (`feat(web): separate public and admin controls`); no additional production-code change was required.

### Completed scope and decisions

- The server validates the existing HttpOnly admin-session cookie before rendering auth-dependent surfaces. Anonymous `/admin` requests render only the sign-in experience, while authenticated requests render the Admin heading and protected controls without access-required or passphrase wording.
- `/run-history` remains publicly readable, but the server mounts history selection and deletion controls only for an authenticated admin. The cleanup component no longer owns a passphrase field or Sign In button.
- Successful sign-in, sign-out, and expired-session handling refresh the server-rendered route instead of relying on client-only authentication state. Authenticated global navigation exposes Admin and Sign out, giving operators a consistent visible session indication.
- Existing `/api/admin/**` session authorization remains the security boundary; conditional rendering is presentation-layer defense in depth.
- Task 60 intentionally owned these same Admin and Run History surfaces and recorded this browser-reported bug as overlapping scope. Closing this task as subsumed avoids redundant UI state and test implementations.

### Verification

- `pnpm --filter web exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.config.ts test/auth-rendering.test.tsx test/admin-sign-in.test.tsx test/run-history-admin-controls.test.tsx`: 3 files, 12 tests passed.
- Focused rendering coverage proves anonymous Admin markup contains only sign-in, authenticated Admin markup contains no passphrase, public History omits cleanup, and authenticated History includes cleanup.
- Focused client coverage proves sign-in refreshes server state and an expired cleanup session clears destructive state before refreshing to the server-decided view.
- `git diff --check`: passed.
- `pnpm test:composition` and `pnpm test:characterization` were not run per repository instructions.
