# AGENTS CONTEXT & GUIDELINES

## Required Workflow

- Before starting work involving brainstorming, planning, implementing or refactoring, read `working_docs/quality_checklists.md`. This is NOT relevant for simple read-only tasks.
- Use the checklist to identify the intended ownership boundary, phase scope, and relevant tests before editing.
- Before handing work back, review the change against the final self-review checklist in that document.
- If a task conflicts with the checklist, prefer the checklist by default and call out the conflict clearly to obtain explicit user instructions about it.

## Code Standards

- Good adherence to SOLID principles, DRY, KISS, etc.
- Use meaningful, descriptive names. Readability avoids technical debt.
- Aim for small, single-purpose functions / methods.

## Miscellaneous

- Do not force character length limit per line for markdown (*.md) files.
- Do not run `pnpm test:composition` or `pnpm test:characterization` unless explicitly asked; they are super slow and require a functioning Docker daemon.
