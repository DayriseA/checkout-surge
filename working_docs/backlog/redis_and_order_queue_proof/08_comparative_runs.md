# 08 — Comparative Runs

**Design:** sections 1, 3 · **Depends on:** 07

## Goal

A visitor starts one fixed comparison and sees two matched pairs of runs side by side.

## Scope

- Chain four child runs under one comparison reservation, the occupancy ceiling and the automatic reset.
- A side-by-side report, in run history and on the watch page.
- A run that fails by design reads as the expected result, not as a broken demo, and stays out of public aggregates and capacity calibration.

## Done When

- A comparison runs end to end in the proof environment, and its report reads clearly to a visitor.

## Open Points

- What the report shows, and how runs that fail by design read (design section 7).

## Working Notes

### Public comparison presentation

One fixed public start card begins the parent comparison without visitor configuration. The ordinary preset and custom flows remain separate. Watch links accept one comparison identity or one ordinary accepted-run identity, never both. The saved comparison uses the same parent-owned view, with the four ordinary reports linked in their fixed matched pairs.

The stock pair reports sold-out reply wall latency; the order-processing pair reports accepted reply wall latency. Each timing retains its recorded sample count. Unique reservations and durable confirmed, failed and pending order counts are shown separately from HTTP replies, which can include replays. Missing timing or durable evidence stays unknown rather than becoming zero. No automatic winner or expected failure is inferred.

Parent reads use a single-flight, budget-spaced poll with Retry-After and bounded failure retries. Last-known results remain visible during read failures. Live updates are scoped to the current child and their transport is removed on child changes or parent termination. A terminal child does not complete its parent. Failed cleanup remains pending until the parent records its terminal result; normal completion makes no final reset claim. Comparison children keep their public and admin reports and parent links; individual selection/deletion is unavailable, including select-all targets.

The first validation pass began at 20:05:49 UTC on 2026-10-11 in the existing Dev Container. Checks ran serially with a 1,536 MiB Node heap cap, one Vitest worker and file parallelism disabled; no infrastructure or application build was started. New strict optional-property, tuple-index and fixture-narrowing type errors were corrected. The focused suite initially found an invalid-link recovery-copy regression and a new test that counted framework timers; the original recovery navigation was restored, and the test now checks continued parent polling and unmount behavior. Both affected files then passed again.

Final web production types and workspace test types passed. Across the focused checks, all 197 unique tests in ten files passed, including 22 new cases for comparison start, query boundaries, paired evidence, parent transport lifecycle and protected child history. The unchanged custom-form browser test still prints its existing React async-act warning while passing. Touched-file Biome and whitespace checks passed; the validation window ended at 20:09:57 UTC. Hosted calibration, end-to-end proof runs, repeatability and final narrative review remain pending; no hosted result is claimed by this UI slice.

Independent review identified one accepted correction: a canonical `404 resource_not_found` means the comparison report is missing, including after grouped retention removes it. The shared view now presents absence with history/demo recovery links, and both initial absence and later confirmed removal stop automatic/manual reads and close child live updates. Temporary errors and unverified malformed responses retain bounded retries and last-known results. The comparison getter preserves only the canonical absence status needed by that presentation; the general backend-read framework is unchanged.

Correction review and validation ran from 20:14:30 to 20:16:09 UTC on the same date, with the same serial container limits. Web production types, full workspace test types and all 26 affected comparison tests passed on the first correction pass, including seven new absence/regression cases. Nine touched correction files passed Biome and whitespace checks. Cumulative UI coverage is 204 unique tests, including 29 new cases; unchanged passing suites were not repeated. Independent full review and the narrow correction review were clear. The supervisor then read the complete relevant change and surrounding transport/history boundaries against the final self-review checklist; no further code correction was required. Hosted validation remains pending.

### Current public end-to-end observation and report wording — 2026-10-12

Public parent `bde2626d-5cbe-4b82-ac8c-944a8a9114b0` completed all four fixed stages on source `46eaab3ebf52e4471b7bad277ca89250d97a6e46`, with native capture enabled and four normal settlement certificates. The inline stage correctly retains its failed label and `traffic_outcome_unexpected_responses`: 114 successful replies, 386 unexpected replies, 119 confirmed and 381 failed orders, zero outstanding work. Completion of the comparison is distinct from success of every child. The exact child identities, timings, budget observation and evidence limits are in [Reference Runtime Measurements](../../../docs/reference_runtime_measurements.md#capture-enabled-common-runtime-comparison--2026-10-12). Earlier failed/unknown parents retain their original classifications.

The report explanation now says that named reply timings cover only recorded replies, so visitors must compare sample counts and durable outcomes. It explicitly explains that inline orders can expire or confirm after an unsuccessful buyer reply. The existing failed labels, recorded counts and child-report links remain authoritative; no automatic winner, new metric or visitor control was added. Existing comparison UI tests already cover named wall-time cohorts, unique counts and absence of an invented winner. This text-only correction adds no styling or snapshot test. Final capture-disabled functional validation, repeatability and owner text review remain pending; Task 08 stays in progress.

Validation of this text-only source correction passed touched-file `pnpm exec biome check --write apps/web/src/app/components/comparison-watch.tsx` (no fixes) and `pnpm --filter web type-check` in the existing Dev Container as `codespace`, with a 1,536 MiB Node heap cap. `git diff --check` passed, with an existing line-ending normalization warning on the touched Task 07 Markdown file. The host Docker socket initially refused access; automatic approval review accepted the same bounded container commands. No infrastructure, build or test suite was started, and prior green behavioral suites were not repeated. Final self-review kept the change inside report copy and factual measurement/task notes; status vocabulary, ownership, contracts and calibration values are unchanged.
