# AGENTS CONTEXT & GUIDELINES

## Required Workflow

- Before starting work involving brainstorming, planning, implementing or refactoring, read `docs/quality_checklists.md`. This is NOT relevant for simple read-only tasks.
- Use the checklist to identify the intended ownership boundary, phase scope, and relevant tests before editing.
- Before handing work back, review the change against the final self-review checklist in that document.
- If a task conflicts with the checklist, prefer the checklist by default and call out the conflict clearly to obtain explicit user instructions about it.
- Settled decisions, accepted risks and arbitrated review findings live in `docs/decisions/`. When reviewing, check them first: re-raise an accepted entry only with new evidence, citing its ID. Record new decisions there.

## Guidelines

### Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No "flexibility" or "configurability" that wasn't requested.
- No abstractions for single-use code.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- If you notice unrelated dead code, mention it in your summary - don't delete it without approval.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code without approval.

The test: Every changed line should trace directly to the user's request.

### Code Standards

- Strong adherence to SOLID, DRY, KISS, YAGNI. Principles ensuring good code maintainability and readability
- Use meaningful, descriptive names. Readability avoids technical debt.
- Aim for small, single-purpose functions / methods.

### Testing policy

Test the happy path plus edge cases that are reachable through the public API. Before writing a test, ask "can a caller actually trigger this state in the current codebase?" If not, skip it. Do not test: 
- unreachable code paths, 
- invalid inputs already prevented by types or upstream validation,
- framework/stdlib behavior,
- speculative future requirements,
- states the current producers never emit, even if a contract or type allows them (make the contract match the producer instead),
- styling (CSS or Tailwind classes, design tokens).

Prefer fewer, meaningful tests over exhaustive coverage.  

### Validation (formatting / linting / type-checking / tests)

From the repo root:

- Format and fix lint on touched files: `pnpm exec biome check --write <files>`
- Check formatting and lint without writing: `pnpm exec biome check <files>` (whole workspace: `pnpm format:check`, `pnpm lint`)
- Check types: `pnpm type-check`
- Run tests without infrastructure: `pnpm test:unit`
- Run the full default suite: `pnpm test:infra:up` then `pnpm test` (API and integration tests need the isolated Docker PostgreSQL/Redis)
- Narrower scopes: `pnpm test:api`, `pnpm test:integration`, or `pnpm --filter <package> test:unit`
- Do not run `pnpm test:composition` or `pnpm test:characterization` unless explicitly asked; they are super slow and require a functioning Docker daemon.

Before handing back code changes, format only the files touched by the task, then run the relevant checks. Report pre-existing lint issues rather than silently suppressing them.

### Miscellaneous

- Do not force character length limit per line for markdown (*.md) files.
- Human–AI interactions may use any language (french, english, etc...), but all project artifacts (including code, comments, documentation, and other persisted content) must be written in English.
