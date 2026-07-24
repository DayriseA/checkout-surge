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

- [x] `docs/scope_and_caveats.md` remains the single concise authoritative scope page.
- [x] Product classifications are unchanged, with an explicit comparison recorded.
- [x] Owner/status/review/expiry/periodic/same-change governance metadata is removed.
- [x] Evidence links are concise and domain rationale is linked rather than duplicated.
- [x] Links and relevant documentation tests are updated.

## Focused verification

Run `rg -n 'scope_and_caveats|Scope and Caveats' README.md docs working_docs package.json` and manually resolve every retained local Markdown target, then run `git diff --check`. Run a repository link checker only if one actually exists at implementation time; do not invent a new tool for this small page. Manually compare classifications before and after. No composition or characterization lane is relevant or authorized by default.

## Working record

Completed narrowly as a documentation-only change. `docs/scope_and_caveats.md` remains the authority and links to domain owners for rationale and operating detail.

### Classification comparison

| Classification | Before | After |
| :-- | :-- | :-- |
| Intentional non-goals | 5: production commerce identity and payment-grade security; payment authorization, customer cancellation, payment-timeout release, and automatic hold-expiry reconciliation; separate per-order realtime feeds, recent-activity panels, and customer order tracking; hosted deployment packaging, horizontal load coordination, and production operational hardening; in-place upgrades for legacy pre-release local data shapes | The same 5 items, with the accepted local topology, no-storefront/aggregate-dashboard boundary, current-shape durability, and retained diagnostics unchanged |
| Current/live caveats | 2: local and 10k validation is environment-dependent and is not hosted benchmark evidence; host-native load-orchestrator runs require a separately available k6 executable | The same 2 caveats and mitigations/evidence, without per-row status or expiry metadata |
| Deferred decisions | 4: physical dead-letter queue topology; customer/account model; payment and reservation-release design; external notification-provider integration | The same 4 decisions, still unfrozen and unscheduled |

No item was added, removed, moved between classifications, or otherwise reclassified.

### Removed administration and duplicated rationale

- Removed owner/source fields, the `active`/`partially mitigated`/`resolved` status taxonomy, last-reviewed dates, reconsideration/review/expiry/decision triggers, periodic stale-entry review, and same-change governance.
- Replaced long rationale cells with short boundary statements and links to the existing access, inventory, dashboard, domain, runtime, and local-development authorities.
- Introduced no replacement taxonomy, governance mechanism, ownership field, or review obligation.

### Changed references

- Updated the README documentation index to describe the retained authority without review metadata.
- Updated `docs/admin_access_protection.md`, `docs/runtime_topology.md`, `docs/core_business_entities.md`, `docs/local_development.md`, and `docs/redis_inventory_hot_path.md` so their scope links no longer promise status, expiry, reconsideration, review, or decision-trigger metadata.
- No documentation test asserted this content or location, so no test needed updating.

### Verification

- `rg -n 'scope_and_caveats|Scope and Caveats' README.md docs working_docs package.json`: passed; every retained reference was inspected and points to the retained page or its current headings.
- Manual local-link resolution: passed for all 8 unique Markdown files and 16 linked headings involved in the retained incoming and outgoing references.
- Existing documentation/link checker: skipped because no link checker exists in the repository scripts or dependencies.
- `git diff --check`: passed.
- Composition and characterization lanes: skipped because this documentation-only task does not authorize or require them.

### Final checklist review

- Scope remained limited to the authoritative page, references that described removed metadata, and this working record.
- The Phase 7 documentation boundary and all 5/2/4 product classifications were preserved.
- No runtime, application, contract, package, test behavior, or ownership boundary changed.
- Relevant validation was run; no applicable automated test or existing link-check lane was available.
