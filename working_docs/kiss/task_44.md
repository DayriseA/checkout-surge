# Task 44 — Make scope and caveats one concise authoritative page

## Execution context

- **Position:** 44/45; Phase 7 documentation cleanup.
- **Dependencies:** The existing scope classifications are the source of truth. Any product reclassification requires a separate explicit decision and is out of scope for this task.
- **Standalone:** Keep `docs/scope_and_caveats.md` as the single concise, discoverable authority for accepted project boundary, intentional non-goals, current caveats, and genuinely deferred decisions; remove administrative governance metadata.
- **Checklist / working record:** Primary ownership is `docs/scope_and_caveats.md` and links/tests that refer to it. Preserve domain ownership by linking to detailed rationale rather than copying it. Record classification comparison, removed metadata, updated links/tests, and verification below.

## Why

The scope page is valuable as a stable product boundary, but owners, status taxonomy, review dates, expiry triggers, periodic obligations, and same-change rules turn a small reference document into a governance system.

## Required outcome

Rewrite the page concisely without changing any product classification. Keep short evidence links where useful, link outward to domain rationale, remove duplicated technical explanation, and update references/tests to the retained authority.

## Concrete scope and paths

- `docs/scope_and_caveats.md`.
- Markdown/docs links, navigation, and tests that assert scope-document location or content.

Retain the page rather than moving it into the README. Preserve classifications such as accepted local reference topology, intended resilience guarantees, intentional non-goals, and deferred product decisions exactly unless a separately approved task changed them. Remove owner fields, status taxonomy, last-reviewed information, review/expiry triggers, periodic-review obligations, and same-change governance text. Keep concise evidence links that let a reader verify a classification; link to domain documents (for example, the project description or design evidence) instead of reproducing their rationale.

## Retained behaviour and non-goals

Retain one discoverable scope/non-goals authority and short actionable caveats. Do not alter scope, merge the page into README, invent a new policy/governance taxonomy, or rewrite detailed domain rationale in this document.

## Acceptance

- [ ] `docs/scope_and_caveats.md` remains the single concise authoritative scope page.
- [ ] Product classifications are unchanged, with an explicit comparison recorded.
- [ ] Owner/status/review/expiry/periodic/same-change governance metadata is removed.
- [ ] Evidence links are concise and domain rationale is linked rather than duplicated.
- [ ] Links and relevant documentation tests are updated.

## Focused verification

Run `rg -n 'scope_and_caveats|Scope and Caveats' README.md docs working_docs package.json` and manually resolve every retained local Markdown target, then run `git diff --check`. Run a repository link checker only if one actually exists at implementation time; do not invent a new tool for this small page. Manually compare classifications before and after. No composition or characterization lane is relevant or authorized by default.

## Working record

Pending — concise rewrite, classification comparison, links/tests, and verification remain to be recorded.
