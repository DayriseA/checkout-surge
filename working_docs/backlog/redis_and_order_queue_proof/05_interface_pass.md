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
- **Recovery reads without the live run:** three of my 3-second public reads came back without the run. These are explained under "Supervisor follow-ups" below: no defect.
- Every proof Machine was stopped at the end: core, runner, gate and guard. The core and the gate were started again afterwards, at 07:05–07:06, not by me (probably the supervisor's visual check), and were left running.

**Left for task 06.**
- The short "how to read this comparison" link from the comparison to the detail page.
- The disclosures that left the panel:
  - **Queue comparison:** the 45 s deadline answer, and that run 1 is always the queue run.
  - **Redis comparison:** the same protections in run 2; Redis still carrying the live counters and the notifications; whole-database statistics over the selling window; the two buy-only processes; the shared core Machine; and that run 1 is always the Redis run.

### Supervisor follow-ups (2026-10-13)

- **"Physical order queue" during the PostgreSQL run.** This panel in the technical details read BullMQ only, so it looked empty while the orders waited in PostgreSQL's queue.
  - For a `postgres` run, the panel now says "In this run the order queue is in PostgreSQL". In place of BullMQ's figures, it shows the run's orders waiting or being confirmed, their oldest wait and the reading's time.
  - These figures come from `runtimeProgress`, which already reaches the browser. In this mode, every order not yet confirmed or failed keeps its queue row until it is settled, so the count is the queue's depth.
  - The change is web only: no new reader and no contract change.
- **Mode labels.** The run history list lowercased the mode label ("stock and order queue in postgresql"). It now prints the label as written, as Watch's header and the comparison already do. No other place lowercases it.
- **Recovery reads that came back without the live run: no defect.**
  - **The errors were my own script's.** The hosted API allows 12 recovery reads per source per minute (`DASHBOARD_RECOVERY_PER_SOURCE_MAX_REQUESTS`). My script read every 3 s, about 20 a minute, so it got 429 `dashboard_recovery_rate_limited` once its budget was spent. Their times match: about 40 s after polling began, and again a minute later. A burst of 13 reads under one visitor cookie confirmed it: 12 × 200, then 429. The script's first version printed any error payload as "no run".
  - **One read was a genuine "no run".** It came at 07:04:33, 4 s after run 2 was finalized (07:04:29), so it was correctly idle.
  - **Neither is a timeout under load or the gap between the runs.**
  - **A visitor's Watch does not flicker.** Live updates come over the SSE stream, and Watch reads the recovery endpoint only when the stream opens or disconnects. A failed read keeps the last-known-good view (`preserveAvailableRecoveryOnFailure`) and retries after `Retry-After`. Once a run ends, the retained terminal run stays on screen.
- **Size:** production +25/−8 lines, tests +26.
- **Validation:** the dev container's checks pass (web unit tests: 799). The full Fly suite passes on the first attempt: `test:api` 382; integration db 82, worker 109, mock-erp 7.
- **Deployed to the proof environment** at `4d28a661`, with no fresh core (the schema is unchanged).
  - The deploy waited for the core, which someone else had woken, to sleep.
  - After a gate wake (no run started), `/demo` shows the queue comparison's new "Detailed assumptions", and the run history list prints the mode labels as written ("Redis comparison · Stock and order queue in PostgreSQL").
  - The core was then stopped; the runner was already stopped. The gate stops itself when idle, and the guard stays scheduled hourly.

### Owner checkpoint C

**Owner checkpoint C: validated on 2026-10-13, with this change.**
- **The change.** The Comparison tab had not opened at the end of the owner's pair, because the owner had clicked Pipeline during the run. The rule is now the simplest one: when run 2 reaches its result, the Comparison tab always becomes active, whatever tab was open before. A visitor who arrives after the pair ended still lands on it, and can switch tabs afterwards.
- **Code.** The per-run choice tracking is gone; one state change on the pair's end remains. The next run starts on the overview again (`2d120b4c`).
- **Test.** The Watch test now clicks Pipeline during run 2, checks that the Comparison tab opens at the result, and that the visitor can then go back to the overview.
- **Validation.** In the dev container, type-check, web unit tests (799) and Biome pass. The full Fly suite passes at `2d120b4c`: `test:api` 382; integration db 82, worker 109, mock-erp 7.
- **Proof environment.**
  - The core and the runner run `2d120b4c`, with no fresh core; the deploy waited for an awake core to sleep.
  - The gate step then failed: the gate Machine, woken by traffic, did not stop within the deploy's 60 s wait. A gate-only redeploy (`deploy.mjs gate --environment infra/fly/proof.json`) updated the gate and the guard.
  - By then another agent had committed `450302c4` and added untracked files, so the gate's version label reads `450302c4-dirty`. Those changes touch `apps/web` only, so the gate image is unchanged in substance, and the version handshake does not compare the gate.
  - The core and the runner are stopped. The gate stops itself when idle.
