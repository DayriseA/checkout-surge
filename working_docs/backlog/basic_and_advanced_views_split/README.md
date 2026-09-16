# Basic and Advanced public views — implementation handoffs

Status: **In progress. Task 01 is done; tasks 02–08 are planned.**

Prepared on 2026-09-16 against checkout `bcd3c5ce`. This backlog turns the accepted public UX report into eight sequential implementation tasks on one feature branch. The finished experience defaults to Basic, preserves the same outcome and material warnings in both modes, and makes the existing public technical detail available in Advanced.

## How to execute

1. Read [the product and implementation contract](design-contract.md), [the state coverage matrix](state-coverage.md), the current `AGENTS.md`, and `docs/quality_checklists.md` before implementing the first task.
2. Implement tasks **01 → 08** in order on the current feature branch; each task assumes its predecessors are complete. Tasks 05, 06 and 07 only depend on 01 and 02 and may run in parallel after 02 if merge conflicts on shared presentation files are managed. Do not merge partially converted public pages as a finished feature.
3. Read each handoff's source entry points against the actual branch. Paths and function names are navigation aids, not instructions to preserve obsolete component boundaries. Keep changes within `apps/web` and directly relevant documentation/tests.
4. Complete each task's focused validation before continuing. Record its completion notes in that task document: changes, checks and results, deliberate deviations, remaining issues, and the commit reference if committed. Update the table below from Planned to Complete only when its acceptance criteria pass.
5. Finish with task 08's integrated browser review and automated gate. Do not use a passing unit suite as evidence that the visual hierarchy is correct.

All persisted implementation, tests, copy, and handoff notes are in English.

## Sequence

| Order | Handoff | Dependency | Result | Status |
| --- | --- | --- | --- | --- |
| 01 | [Per-page public view control](01-public-view-foundation.md) | None | One accessible per-page view control, cookie-persisted and server-rendered, absent from admin surfaces | Done |
| 02 | [Shared result summary and essential warnings](02-result-summary-and-warnings.md) | 01 | One public summary vocabulary and consistent result/qualification display | Done |
| 03 | [Watch lifecycle and technical disclosure](03-watch-experience.md) | 02 | Scenario, phase, stock and order progress first; exact-run identity and recovery preserved | Done (2026-09-16) |
| 04 | [Public run report](04-public-run-report.md) | 03 | A readable result and explanation before its complete technical evidence | Planned |
| 05 | [Demo chooser and custom builder](05-demo-and-custom-builder.md) | 04 | A clear first action, concise presets, and an Advanced builder that retains work | Planned |
| 06 | [Public run history](06-public-run-history.md) | 05 | Compact, meaningful rows with unchanged pagination and authenticated controls | Planned |
| 07 | [About and public recovery language](07-about-and-recovery.md) | 06 | A conceptual explanation and consistent public error/recovery messages | Planned |
| 08 | [Integrated visual, accessibility and regression review](08-integration-and-validation.md) | 07 | A verified complete journey at desktop and narrow widths, with delivery evidence | Planned |

The order follows the report's priority: foundation, Watch/results, entry/discovery, then final integration. Each task delivers working code and its own tests. Task 08 closes integration and visual gaps; it is not a deferred testing phase for the preceding tasks.

## References and authority

- [Design contract](design-contract.md): binding product decisions, route scope, content allocation, data limits, implementation boundaries and common verification rules.
- [State coverage](state-coverage.md): required branches and their task owners. This is a coverage checklist, not a demand for every possible cross-product of modes and states.
- Optional local reference: [standalone UX report](../../ui-ux_observations/index.html). Its directory is locally excluded from Git at the user's request. Keep it excluded; do not copy its screenshots or embedded HTML into this backlog or force-add it.
- The report's chapter anchors are `#concept`, `#demo`, `#watch`, `#history`, `#result`, `#about`, `#states`, and `#delivery`. It supplies visual context while available. **These handoffs contain the requirements needed to finish without it.**
- Repository authorities: [quality checklist](../../../docs/quality_checklists.md), [scope](../../../docs/scope_and_caveats.md), [frontend ownership](../../../docs/repository_layout.md), [testing](../../../docs/automated_testing_infrastructure.md), [runtime instructions](../../../docs/local_development.md), [public/admin protection](../../../docs/admin_access_protection.md).

If a later source change makes a requirement impossible with current public data, document the exact missing input and preserve truthful unavailable wording. Do not expand backend contracts, invent a value, or quietly reduce this backlog's scope.

## Definition of the finished feature

- First visits use Basic. Each page keeps its own choice across reloads through a cookie the server reads, so neither mode flashes; switching does not restart a run, a live subscription, a draft, or report lookup.
- Demo, Watch, public history, public report and About follow the reading orders in the design contract. Watch Basic keeps the four gold signals visible as a compact strip and fits a laptop viewport. The application is not styled to resemble the audit document; reuse the app's visual language with clearer hierarchy.
- Business results, missing evidence, failures, oversell, freshness, and available delivery/performance qualifications remain truthful in both views.
- Advanced preserves all existing public technical content and its measurement boundaries. Admin and authenticated history/report variants retain their existing behavior.
- State coverage, responsive presentation, keyboard/focus behavior and focused regressions are verified; unresolved failures are recorded rather than marked complete.

## Handoff completion format

Append a short `Completion notes` section to each implemented task with: status/date, changed boundaries, validation commands and outcomes, browser observations where applicable, deviations with reasons, unresolved issues, and next task. Do not mark planned checks as executed. Keep the resulting backlog useful to the next implementer without relying on conversation history.
