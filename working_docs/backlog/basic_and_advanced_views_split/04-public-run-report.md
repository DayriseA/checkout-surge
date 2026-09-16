# Task 04 — Public run report

Status: Done (2026-09-16) · Depends on: [Task 03](03-watch-experience.md) · Next: [Task 05](05-demo-and-custom-builder.md)

## Outcome

The public saved report explains the outcome immediately, including meaningful failure and performance qualifications. Full configuration and technical evidence remain available in Advanced. The authenticated report keeps its existing detailed interface.

## Read first

- [Design contract](design-contract.md), public report allocation and data boundaries; [W06–W10, W15–W18 and H03](state-coverage.md).
- `apps/web/src/app/run-history/[runId]/page.tsx`.
- `apps/web/src/app/components/run-history-detail.tsx` (public and shared helpers; admin is a regression boundary).
- `components/gold-signals.tsx`, `transport-observation.tsx`, `run-conclusion.tsx` and task 02's summary.
- `lib/presentation/run-result-presentation.ts`, `public-vocabulary.ts`, `format.ts`.

## Work

1. Complete the public reading order: scenario/date/explicit overall duration → shared verdict and caveats → final stock/order counts → “What happened” and short chronological recap → next actions. Put an existing public-safe failure reason and action (`publicFailureExplanation`) beside the result, rather than below all measurements. Rewrite the page's introductory copy in the same plain vocabulary.
2. Keep a small scenario recap in Basic: buyers or planned attempts, initial stock and the experiment's defining behavior such as duplicates. Clearly identify simulation. Remove the full four-column configuration block from Basic.
3. Build a concise recap from existing timeline/evidence when available: traffic arrived, stock was reserved, orders reached their recorded outcome. Do not manufacture timestamps, durations, traffic completion or successful confirmation when evidence is partial. Missing timelines must not erase the canonical result.
4. Assemble Advanced sections containing **all** current public configuration, four signal timelines and accessible samples, invariant and reconciliation proof, transport/HTTP/delivery measurements, server reservation target evaluation, ERP attempt observations, lifecycle timestamps and final inventory, identifiers and queue names. Group by question and avoid unnecessary repetition; preserving detail does not require keeping the old layout.
5. Make the Basic delivery/speed caveat's “View technical measurements” action switch this page to Advanced through task 01's helper, reveal the target section and move focus there. Preserve bounds and explain distinct populations in the detailed measurement section.
6. Handle operator stop timing honestly: acceptance-to-stop is not cleanup completion. Retain an incomplete/unknown cleanup qualification where supplied; complete lifecycle timestamps can remain Advanced.
7. Make missing/unavailable public reports concise and actionable, keeping IDs secondary. Preserve `notFound()` behavior and public-safe error mapping. Keep the route's authenticated read selection, admin filters/actions and protected detail unchanged.

## Acceptance criteria

- Basic answers what happened without configuration, invariant equations, p95 or UUID reading as prerequisites.
- The 10k-style combination of successful orders and failed reservation target is represented without hiding either verdict; qualified measurements remain qualified.
- Counts, failure/incomplete/oversell messages and exact run identity agree with Watch for the same saved evidence in both modes.
- Every existing public report content family in the design contract remains reachable in Advanced. Recorded bounds and lifecycle timing meanings are unchanged.
- The report is not marked stale because it is immutable; missing chart evidence does not become fabricated data.
- Authenticated report rendering, filters, deletion controls and protected fields behave as before.

## Validation

Update/run `run-history.test.ts`, `run-result-presentation.test.ts`, `transport-observation.test.ts`, `gold-signals.test.ts`, `not-found.test.tsx`, `auth-rendering.test.tsx`, and directly affected `run-diagnostics.test.tsx` cases. Add mode assertions around actual public report fixtures, including failed/qualified target and missing timeline, plus contextual Advanced focus behavior. Keep admin checks on their existing variant. Run common formatting/type checks.

Inspect a real saved public result in Basic and Advanced at desktop and narrow widths. Verify summary-first order, long configuration wrapping and readable technical chart/table overflow.

## Handoff

Record the locations of retained technical content and any public-only component extraction. Suggested commit subject: `feat(web): lead public reports with outcomes and caveats`.

## Completion notes

- Public report route (`apps/web/src/app/run-history/[runId]/page.tsx`): the header now reads scenario name, "Saved run report for a checkout simulation.", date and an explicitly labeled duration ("Overall duration:" or "Acceptance-to-stop duration:" for operator stops), then the outcome pill. The public unavailable branch is a concise "This report is not available" page with the unchanged public-safe `ErrorNotice` mapping, history and demo actions, and the run ID as a small secondary line. `notFound()` for invalid params and 404/`resource_not_found`, the authenticated read selection, admin query parsing, `RunHistoryAdminControls`/`RunHistoryRowControls` and the admin unavailable body (`protectedDetails`) are unchanged.
- Basic reading order in `PublicRunHistoryDetail` (`apps/web/src/app/components/run-history-detail.tsx`, no extraction was needed): `BasicOnly` "Scenario" recap (`scenarioRecap`: traffic mode, buyers or planned attempts, starting units, quantity per checkout when > 1, duplicate attempts, forced outage / failure rate, plus a one-line simulation statement) → `PublicRunConclusion` (verdict, concise sentence, `publicFailureExplanation` reason and action beside the verdict, caveats, contextual "View technical measurements") → "Final stock and orders" tiles from `derivePublicRunSummary(...).counts` (unknown renders "—") → "What happened" (`runRecap`) → "Back to run history" / "Choose another scenario". The former four-column configuration block, bottom failure section and `<details>` technical block are gone from Basic.
- `runRecap` only formats existing evidence: traffic start/end lines depend on which of `run.trafficStartedAt`/`trafficEndedAt` exist ("start and end were not recorded" otherwise), "Checkout attempts" wording for steady traffic, reserved units / unique reservations / sold-out attempts and confirmed / failed / awaiting orders from the canonical summary, "Run ended" or "Operator stop decision" from `finalizedAt`, and for operator stops the cleanup completion time or an explicit incomplete/unknown cleanup qualification (W15). A missing `runSignalTimelineSummary` leaves the counts intact; `GoldSignals` keeps reporting the absence without fabricated samples.
- Advanced groups (`AdvancedOnly`, mounted across switches): `#report-advanced-scenario` (full traffic/inventory/simulated ERP/backpressure settings, run UUID, capture timestamp, logical/physical queue names), `#report-advanced-consistency` (the `PublicRunConclusionProof` narration, `ReconciliationStatus`, invariant expressions with actual/expected values; the proof now accepts a `targetId` and renders a "Consistency" heading when one is supplied), `#report-advanced-signals` (four timelines and accessible samples), `#report-advanced-measurements` (delivery quality pill, `TransportObservationSection` with transport/HTTP accounting, reservation target evaluation and bounds, simulated ERP attempt and latency facts), `#report-advanced-lifecycle` (lifecycle timestamps, operator stop / acceptance-to-stop / reset completion facts, final inventory and outcome evidence). Bounds and lifecycle label meanings are unchanged.
- Contextual reveal: `PublicRunConclusion` takes optional `consistencyTargetId` and `measurementsTargetId`; with the latter it renders a `RevealAdvancedLink` "View technical measurements" whenever `derivePublicRunSummary(...).hasMeasurementCaveat` is true (new summary field: any transport/reply-observation, delivery or speed-target caveat). Watch passes no target ids and is unchanged.
- Tests (`apps/web/test/run-history.test.ts`): Basic keeps verdict, failed-target caveat and canonical counts visible while settings, UUID, invariant expressions, signals and the `≤` bound stay mounted but hidden (fixture without timeline summary); reveal-and-focus of the measurements section from a qualified target and from incomplete replies with complete delivery and a passing target; operator stop without traffic timestamps keeps guidance, the honest recap and cleanup qualification; unavailable public report copy, actions and secondary run ID; existing admin and 404 assertions retained. `apps/web/test/public-run-summary.test.tsx` covers the measurement-caveat classification. Covers W06–W10, W15–W18 and H03 on the report surface.
- Validation: focused suites (run-history, run-result-presentation, transport-observation, gold-signals, not-found, auth-rendering, run-diagnostics, public-run-summary, page-view, watch-narrative: 10 files, 160 tests) and the full web unit suite (47 files, 799 tests) green; `biome check` clean on touched files; `pnpm --filter web type-check` and `pnpm type-check:test` green. Browser inspection of a real saved result at desktop and narrow widths was not possible here and is left to task 08.
