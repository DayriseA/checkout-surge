# 05 — Interface Pass

**Design:** sections 1, 3.1 · **Depends on:** 04

## Goal

The two comparisons read clearly and look finished to a visitor on Watch and in run history.

## Scope

The owner's feedback (2026-10-13, after trying both comparisons on a laptop screen):

- **Everything in the top section.** "Run 1 of 2" (and which mode is running) belongs in the run's header or in its stage track (Preparing, Buyers arriving, Confirming orders, Result), so a visitor sees which run is live without scrolling.
- **The side-by-side view is a third tab** next to the existing ones (Overview, Pipeline). It becomes the active tab when the pair completes, so the live view (charts by default) hands over naturally to the comparison, which suits the frozen end state.
- **No prose that restates the figures.** Remove the long introduction under the comparison's title and the takeaway sentences that repeat the numbers. The figures (with a neutral ratio where useful) speak for themselves; disclosures and how to read the figures move to the detail pages of task 06, reached by a short link.
- **Preset texts are accurate.** The queue comparison's "Detailed assumptions" speak of a slow ERP although its ERP is the standard one (20 orders/s, 100 ms); check every preset's derived texts, the Redis comparison's included.
- Within the existing design system. No new behavior beyond the tab's automatic activation.

## Done When

- **Owner checkpoint C:** the owner validates the interface.

## Open Points

- None.

## Working Notes

### Implementation (2026-10-13)

**What changed.**
- **Header.** A comparison run's identity line ends with its place in the pair and its mode: "Queue comparison · 5,000 buyers · 500 units · Run 1 of 2 · With the order queue". It sits at the top of the run card, beside the stage track, which stays as it was: one more phrase on that line is more compact than a fifth step in the track.
- **Third tab.**
  - A comparison run's card has the tabs Overview, Pipeline and Comparison. As before, Pipeline ends with the run.
  - The Comparison tab holds the same two-column report, read again at each status change. It is there during the whole pair: run 1's figures, with run 2 in progress or not started.
  - It becomes the active tab when run 2 reaches its result (completed or failed), unless the visitor chose a tab during run 2. A visitor who opens Watch after the pair ended lands on it.
  - For a comparison run, the tabs show on every screen and each view shows alone. Ordinary runs keep the overview and the board side by side on a tall, wide screen.
  - When Watch shows the visitor's saved comparison run without its live card (another run is live, or none), the comparison stays a card, now right under "Your result".
- **Prose removed.** Both introductions, the "One comparison, two runs" eyebrow and both takeaways, with their gating code (`comparisonTakeaway`, `redisComparisonTakeaway`, `settledCleanly`, the facts only they read) and their tests. The titles are one line: "With and without the order queue, on the same workload" and "Stock decided in Redis, then in PostgreSQL, on the same workload".
- **Neutral multiples.** Run 2's waits, load figures, ERP pace and slowest order also read as multiples of run 1's, for example "15.3 s / 27.4 s ×4.7 / ×5.3 vs run 1". A multiple shows only when both runs' figures are known. Answer counts are not compared, and nothing is coloured.
- **Run history** keeps the comparison card under the report's header, for either run.
- **Preset texts.**
  - The queue comparison's focus `downstream_capacity` ("A slow ERP sets the pace; orders wait in the queue") became `confirmation_wait`: "Without the queue, each winner waits for the ERP to confirm". Its card now reads "Detailed assumptions: The order backlog grows, then drains · Without the queue, each winner waits for the ERP to confirm".
  - Every other preset's derived texts ("What happens" and "Detailed assumptions", both from `outcomeFocus`) were checked against its configuration, and are accurate. The Redis comparison's ("Stock depletes without overselling · The final evidence remains available") holds in both runs, so it is unchanged.
  - A seed test keeps the slow-ERP wording to presets that slow the ERP below the standard one.
- **One status line:** run 2's "Starts when run 1 completes." became "Starts after run 1.", since it also shows in the gap after run 1 completed.

**Files** (`00bafe5f`, `d3c0f559`):
- `apps/web/src/app/components/operator-dashboard.tsx`, `comparison-panel.tsx`, `lib/presentation/comparison.ts`, `lib/presentation/public-vocabulary.ts`, `run-history/[runId]/page.tsx`;
- `packages/db/src/seed-presets.ts`;
- tests: `browser-workflows.test.ts` (the tab's activation, and a choice made during run 2), `watch-narrative.test.tsx` (the header), `run-history.test.ts` (figures, multiples, unknown values), `public-vocabulary.test.ts`, and `packages/db/test/unit/seed-presets.test.ts`.

**Size** (against `cd3ee73a`): production +242/−259 lines, so net −17; tests +105/−48, so net +57.

**Validation.**
- **Dev container:** `pnpm type-check`, web unit tests (797), db unit tests (50), and Biome on the touched files all pass.
- **Fly test runner:** the full `pnpm test` passes at `d3c0f559`: every unit suite, `test:api` 382, and integration (db 82, worker 109, mock-erp 7). The first attempt failed on one unrelated admin test, `shares a recovered runtime policy with dirty preset validation`, which timed out at 5.5 s against its 5 s limit under the runner's parallel load; alone it takes about 2.2 s. The rerun passed.

**Proof environment** (deployed at `d3c0f559`, no fresh core: the schema is unchanged; the seed applied the new preset text at the wake):
- **`/demo`:** the queue comparison's card reads the new "Detailed assumptions"; the Redis comparison's is unchanged.
- **Watch bundle:** it carries the new tab ("Run view", "side by side") and the multiples ("vs run 1"), and none of the removed texts.
- **Queue comparison, started as a public visitor** (cold start; runs `5a36eb9f`, `75e6e022`): both runs completed, with 500 orders confirmed each. Both reports show the comparison: winners' wait 3.2 s / 5.1 s against 15.3 s / 27.4 s (×4.7 / ×5.3), every buyer answered within 10 s against 28.9 s (×2.9), ERP pace ×1.1, slowest order ×0.9.
- **Redis comparison, started as a public visitor** (runs `1fae5d0e`, `3f5b5da7`): both runs completed, with 500 secured and 9,500 turned away each. Both reports show the comparison: transactions 4,746 against 11,217 (×2.4), CPU ×1.9, query time ×6.2, winners ×1.0 / ×1.0, turned-away buyers ×1.2 / ×1.1.
- **Not verified without a browser:** the header line, the tab bar and the tab's automatic activation on the live page. Watch renders them on the client; the web tests cover them. They are left to the owner's visual review.
- **Observed in passing, not investigated** (a code path this task did not touch): my 3-second public recovery reads came back three times without a current run while a pair was running. Once with no run during the queue comparison's run 2 traffic, and twice with an error payload during the Redis comparison's run 2 surge.
- Every proof Machine was stopped at the end: core, runner, gate and guard.

**Left for task 06.**
- The short "how to read this comparison" link from the comparison to the detail page.
- The disclosures that left the panel:
  - **Queue comparison:** the 45 s deadline answer, and that run 1 is always the queue run.
  - **Redis comparison:** the same protections in run 2; Redis still carrying the live counters and the notifications; whole-database statistics over the selling window; the two buy-only processes; the shared core Machine; and that run 1 is always the Redis run.

**Not done, for the supervisor.** Task 04's risks said that task 05 would label the technical "Physical order queue" panel. That panel reads BullMQ only, so it shows an empty queue during a PostgreSQL-mode run. It is outside the owner's feedback, so it was left as is. Its caption already says "Live BullMQ counts".
