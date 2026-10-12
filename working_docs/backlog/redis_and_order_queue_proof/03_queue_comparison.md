# 03 — Queue Comparison

**Design:** sections 3.1, 4, 5 · **Depends on:** 01

## Goal

A visitor starts one fixed preset and sees, side by side on the same workload, what the order queue buys: with the queue, every winner hears "yes" within seconds while the ERP confirms at its own pace; without it, winners wait their turn at the ERP's pace. Nothing is lost and the ERP is not faster either way.

## Scope

- **Mode without the order queue (synchronous confirmation):**
  - The request takes the normal reservation path, with the same protections and the same durable record, then waits for the worker's confirmation of its order instead of answering `202`. The worker and its ERP pacing are unchanged.
  - On confirmation: `200 order_confirmed`. At the deadline: an honest "still being confirmed" answer, and the order completes later as usual. A reset or the automatic reset ends every wait.
  - Waiting requests share one notification channel or one batched check per interval; no per-request polling loop.
  - The deadline is a documented constant, chosen when the preset is tuned.
- **Comparison preset plumbing**, reused by task 04:
  - A preset-only field selects the comparison. Custom runs, public or admin, can never carry a mode.
  - One preset start runs the two modes as two chained runs in the same run slot, linked to each other. The visitor's budget is charged once; each run keeps its own occupancy ceiling and automatic reset, and the pair fits the 600 s ceiling.
  - Comparison runs stay out of public aggregates and capacity calibration.
- **Side-by-side panel** on the watch page and in run history, comparing equal cohorts: time to answer for all winners, time until every buyer was answered, winners answered "confirmed" against "still being confirmed", orders confirmed by the ERP, and the ERP's pace. A short text states the honest takeaway.
- **Preset:** start from the checkpoint's 5,000-buyer spike, stock 500, ERP 100 ms and 20 TPS, on the ordinary topology (one API process is enough: the effect is bound by the ERP).
- **Measurement** in the proof environment as in design section 5, recorded in the working notes.

## Out of Scope

- Several API processes, store distance and the mode without Redis (task 04).
- Any change to ordinary runs, production topology or `CAPACITY_*` values.

## Done When

- The preset runs end to end in the proof environment, both runs complete, every order is confirmed, and the panel reads clearly.
- The measured pairs agree, and the results are in the working notes.
- Tests cover the new behavior at the right boundaries (service rules, the waiting mechanism, chaining, the contract).
- **Owner checkpoint A:** the owner sees the comparison live and validates it, or asks for changes.

## Size Budget

About 900 production lines and 600 test lines. Going beyond is recorded and explained in the notes first.

## Working Notes

### Arbitrations (supervisor, 2026-10-12)

- **Plan:** approved.
- **Deadline:** 45 s from request arrival.
- **Deadline and reset answer:** the unchanged `202 reservation_secured`.
- **Run order:** fixed, demo first. Pair 1 is discarded and the order is disclosed (design §5 updated).
- **Preset:** `queue-comparison`, admin-only until checkpoint A.
- **Budget:** about 940 production lines, measurement scripts included.
- **Added requirements:**
  - The waiting route holds a request only when the run's mode is `synchronous_confirmation`. It learns the mode from the run row that the reservation path already reads, with no extra query.
  - Watch follows the visitor from run 1 to run 2.
  - The panel reads as one comparison of two runs.

### Plan (2026-10-12; approved, kept current during implementation)

**Exposure of `/buy` (checked).** It is not public.
- The gate reaches only the core's Caddy (`infra/caddy/Caddyfile.fly`), which sends `/dashboard/events` to the API and everything else to the web.
- The web proxies no buy route.
- The API listens on the private network (6PN) only, where the runner reaches it.

The waiting route still waits only when the run is a `synchronous_confirmation` run. That mode comes from the `demo_runs` row that the winner's admission lock already reads (`PostgresBuyPersistence.withRunAdmissionLock`). Any other request is answered exactly as `/buy` answers it, at once.

**Waiting mechanism.** The waiting route calls `ReserveOrderService.reserveInRun`: the unchanged reservation (the Redis decision, the durable rows and the BullMQ job, with the locks and the reserved connection released), returned with the run's mode as the admission lock read it. Then a winner of a `synchronous_confirmation` run waits in a new per-process `OrderConfirmationWaiter`.
- Waiters are a map `orderId → {runId, deadlineAt, resolve}`. One timer runs only while waiters exist. Every 250 ms it reads all waiters at once: `orders` joined with `demo_runs`, `id = any($ids)`. The tick is single-flight.
- A confirmed order resolves with its `confirmed_at`. A missing order (purged), a terminal run (reset, automatic reset or failure) or a passed deadline resolves "not confirmed". `close()` releases every waiter at shutdown. The worker is unchanged.
- **No existing notification path is reused.** The dashboard dirty signal carries no order ID and is lossy pub/sub. The notification-queue events would tie the API to the worker's queue. Both would still need a deadline sweep and a run check. A durable read cannot miss a confirmation that lands before the waiter registers.
- **Cost at 500 waiters:**
  - no pooled connection is held while waiting;
  - one query of up to 500 IDs every 250 ms, about 160 per run (the archive ran about 10⁴ statements/s);
  - 500 idle sockets (k6 already holds one per VU) and about 2–5 MB of heap;
  - at most 250 ms added to waits of 0–35 s (disclosed).

**Answers.**
- **Confirmed:** `200 order_confirmed`, ported: the reservation, plus the order with `status: "confirmed"` and `confirmedAt`.
- **Not confirmed in time** (deadline or reset): the unchanged `202 reservation_secured`, which is the queued mode's own answer ("secured; being confirmed"). The order is untouched and completes later. A `failed` order (unreachable on the preset) also gets it at the deadline, as a queued buyer would. Pending-persistence answers and rejections return at once.
- **k6:**
  - expected statuses 200, 202 and 409;
  - accepted = `200 order_confirmed` or the existing 202 outcomes;
  - new counters `checkout_order_confirmed` and `checkout_reservation_pending_persistence` (review F2);
  - one wall-latency Trend per outcome (accepted, sold out) with count, average, p95 and **max**, ported from `94f7ee1d`.
  - The contract gains optional `httpSummary.buyerWallLatencySummary` and `confirmedResponses`; an unknown value stays null.
- **Deadline: 45 s from request arrival** (a contracts constant).
  - The preset needs at least 26.3 s (500 orders at 0.95 × 20/s) and realizes about 30–36 s. 45 s keeps the result set by the ERP's pace, not by this parameter.
  - A request lasts at most about 45.3 s: 15 s under k6's 60 s timeout, and inside the spike's 80 s `maxDuration`.
  - If drains come near 45 s, tune the preset's stock, not the deadline.

**Mode selection.**
- **Preset:** a preset-only column `demo_presets.comparison` (`order_queue`), written by the seed only. Save, duplicate and copy-to-custom write their columns one by one, so none of them copies it. Starting a comparison preset with a `configOverride` is refused (`preset_operation_not_allowed`). No custom run, public or admin, can therefore carry a mode.
- **Run:** `demo_runs.comparison_mode` (`demo` or `synchronous_confirmation`), plus `comparison_first_run_id` on the second run (unique; on delete set null). Neither is in the config snapshot, so the runner contract, estimator and admission are untouched.
- **Routing:**
  - At its two start sites (start, startup replay), the API passes the runner `apiBaseUrl = <api>/synchronous-confirmation` for that mode.
  - It registers `POST /synchronous-confirmation/buy`, bound to the waiting service. k6 still posts to `${apiBaseUrl}/buy`.
  - There is no per-request lookup. Task 04 reuses this selector.

**Chaining.**
- **Run 1:** the normal start path (visitor check, budget, admission), with `comparison_mode = demo`.
- **Run 2:** on each lifecycle poll tick, after `finalizeReadyRuns`, `startDueComparisonPartner()` runs under the maintenance authority.
  - **Due when** (review F3): the last run to finish is a `completed` run in the comparison's first mode, finalized less than 60 s ago, and no run has been created since. There must also be no nonterminal run.
  - **What it does:** it inserts run 2 with the same preset, snapshot and operator mode, the other mode and the link. It then runs the extracted tail of the start path (`launchAcceptedRun`), with no budget and no visitor check.
- **Slot:** the same predicate holds the slot, so any other start meanwhile gets `run_conflict` / `active_run_exists`.
- **Failures:** a failed or reset run 1 gets no partner. A failed start of run 2 is an ordinary failed run.
- **Per-run lifecycle:** each run keeps its own `startedAt`, ceiling and automatic reset. There is no parent and no new state.
- **Pair fit:** the estimate is 121 s per run (80 + 26.3 + 15), so 242 s for the pair, under 600 s. A test asserts it on the seeded preset.
- **Order: demo first.** Visitors see the familiar system first. Any warm-up cost falls on the queued mode, which is conservative for the claim.
- **Exclusions:** there are no cross-run public aggregates (history and ERP summaries are per run). Calibration uses the `custom` preset with overrides, which comparison presets refuse. Nothing else needs excluding.

**Panel.** A `ComparisonPanel` shows on Watch below the run conclusion, and on the history detail of either run.
- It reads both public run reports (`readComparison`, shared by Watch and history), finding the partner through the new `run.comparison {mode, partnerRunId}`, or through the live run's `comparison.firstRunId`. On Watch it reads again whenever the live run changes status.
- Watch follows the visitor: when the live run's `firstRunId` is the visitor's run, Watch tracks the live run as the visitor's own. The panel titles itself "One comparison, two runs" and labels its columns "Run 1 of 2" and "Run 2 of 2".
- Unknown data reads "Not recorded", and a partner not yet run or still running is stated. No winner is computed.
- History rows show the mode.
- **After the review:**
  - The panel shows for every viewer of a live comparison run (F9).
  - It says "No second run was started." when none will come, and "Report not available." for a read error (F5).
  - The admin UI estimates and starts a comparison preset with its slug alone, with the run values locked (F1).

| Row (equal cohorts) | Source |
| :-- | :-- |
| Winners' time to answer: average and p95, all winners | k6 accepted cohort |
| Every buyer answered within (longest single wait) | max of the accepted and sold-out cohort maxima |
| Winners told "confirmed" / "secured, not yet confirmed" | `confirmedResponses`, `accepted − confirmed` |
| Buyers without an expected answer | `transportFailures + unexpectedResponses` |
| Orders confirmed (failed) by the ERP | durable business outcome |
| ERP pace against the declared limit | confirmed ÷ (arrival window + `convergenceDurationSeconds`); `erpConfig.maxTps` |
| Slowest order, from secured to confirmed | `confirmationConvergence.maxLagMs` |

The takeaway shows only when both runs completed with every buyer answered as expected, every order confirmed and none failed, and ERP paces within 10 % of each other (review F2). Its deadline sentence counts `accepted − confirmed − pending persistence`, the waits that really ended at the deadline:

> Same buyers, stock and ERP limit. Both runs confirmed {n} orders at about {pace}/s: the queue does not make the back office faster. With the queue, every winner heard back within {a}; without it, each winner waited for their turn at the ERP, up to {b}. [{k} winners stopped waiting at 45 s and were told their order was still being confirmed; it was confirmed later like the others.] The queue moves the wait from the buyer to the back office.

One line discloses the mechanism: the request stays open while the same worker confirms at the ERP's pace.

**Measurement (design §5).**
- The capacity script gains `{label, presetSlug}` entries. For each, it starts once, waits for both terminal details, and appends two records with the mode and a `pairId` (the first run's id; review F7). It then tears both runs down, the first run first (F3).
- 5 starts, with pair 1 discarded as warm-up.
- Per mode, report the median and min–max of:
  - winners' average and p95;
  - the longest wait;
  - the confirmed and deadline answers;
  - the orders confirmed;
  - the ERP pace;
  - the slowest lag.
- Also report the range of per-pair ratios, and claim the gap only if all 4 pairs agree.
- One `scripts/comparison-analysis.mjs` turns the JSONL into a markdown table. Machines and sizes are recorded here.

**Changes** (production lines / test lines; tests at boundaries only):

Plan against actual net lines (git diff from `aea8ef8a`, comments and blank lines included, generated Drizzle snapshot excluded):

| Item | Prod plan | Prod actual | Test plan | Test actual |
| :-- | --: | --: | --: | --: |
| Contracts: `order_confirmed`, deadline, HTTP cohorts and confirmed count, comparison fields | 80 | 70 | 30 | – |
| DB: 3 enum columns (`schema.ts`, baseline SQL); seeded `queue-comparison` | 45 | 50 | – | 6 |
| API waiter and Postgres reader | 100 | 122 | 100 | 88 |
| API waiting service, route, server; run mode from the admission lock (added requirement: 41) | 50 | 100 | 100 | 76 |
| API chaining (override refusal, modes, `launchAcceptedRun`, partner start, slot predicate, target URL, poll, shutdown) | 170 | 198 | 145 | 223 |
| API reads: snapshot, history and preset mapping | 35 | 20 | – | 7 |
| Runner: k6 script and parser | 85 | 69 | 50 | 15 |
| Web: panel, presentation, Watch follow and history wiring, labels | 260 | 333 | 70 | 104 |
| Scripts: capacity entries and analysis | 115 | 131 | 30 | 61 |
| **Total** | **~940** | **1,093** | **~525** | **580** |

Docs: 9 lines (k6 classification, comparison runs). The production total is 153 lines (16 %) over the plan's budget. The supervisor accepted it as is (see Implementation).

**Risks.**
- The proof core's drain may approach 45 s (the archived hosted queued run's last confirmation came at about 47 s). Measure it first, and tune the stock if needed.
- The baseline SQL is edited. As the project convention requires (HD-05, HD-48), the proof core is installed fresh. **For task 06:** production must deploy this work with `node infra/fly/deploy.mjs all --fresh-core` before the merge to `main`. That wipes the hosted run history and admin edits.
- The 5 s poll plus the runner boot leave a gap of about 10–35 s between the two runs; Watch labels it.
- An API restart during run 2 drops the waiting connections, as it would for any run.

**Open questions (supervisor or owner).**
1. Deadline: 45 s (recommended), or 30 s? At 30 s the preset shows "still being confirmed" for roughly the last 20–30 % of winners, but that share is set by the parameter.
2. Should the deadline answer reuse `202 reservation_secured` (recommended), rather than a new outcome?
3. A fixed chain order gives AB pairs, not ABBA (design §5). Accept this with pair 1 discarded and the order disclosed (recommended)? The alternative is to alternate the first mode on each start: about 10 lines, true ABBA, but visitors see either order.
4. Is the `queue-comparison` slug OK, admin-only until checkpoint A (design §7 default)?

### Implementation (2026-10-12)

**Commits** on `claude/redis-queue-comparisons`, pushed:
- `d6639d37` feat(db): seed a queue comparison preset and record each run's mode
- `b59d9e74` feat(load): measure each buyer's wait per outcome and count confirmed answers
- `d59c5f1d` feat(api): chain a comparison's two runs and let winners wait without the queue
- `483c4bd4` feat(web): show a queue comparison as one report of two runs
- `fa919e21` feat(scripts): measure comparison pairs with the capacity script
- `18986caa` test(api): stamp the simulated confirmation after the order's queue time
- `27d04a99` test(db): count the seeded queue comparison preset

**Validation.**
- **Dev container:** `pnpm type-check` and `pnpm test:unit` pass.
- **Fly test runner** (`cs-test-runner`, isolated PostgreSQL and Redis):
  - Every unit suite passes.
  - `test:api` passes: 364 tests, including the chaining and waiting integration tests.
  - `test:integration` passes: db 82, worker 103, mock-erp 7.
  - Two test-only fixes along the way:
    - the simulated confirmation is now stamped after the order's queue time, which a check constraint enforces;
    - the seeded preset count rose to 11.

**Budget stop.** Production lines came to 1,093 against the accepted ~940; the table above has the breakdown. Where it grew:
- The web panel and its wiring took 73 more lines than planned. A seven-row, two-column report with its unknown states, the shared read, and Watch following the visitor take more lines than the estimate allowed.
- The added requirement to read the run's mode from the admission lock took 41 lines. The mode goes through `ReserveOrderService`'s return paths and the persistence lock.
- Chaining, the waiter and the scripts each took 16–28 lines more than planned, mostly doc comments and type declarations.

**Supervisor's decision:** 1,093 lines accepted as is, with no trimming.

### Live end-to-end run (proof environment, 2026-10-12)

- **Deploy.** `node infra/fly/proof.mjs deploy --fresh-core` at `70a03a38`. The first wake through the gate reinstalled the core fresh, on new core Machine `871473b0632e78`.
- **The pair**, started as an admin through the API, each run `completed-successfully`:

| | Run 1 `f28c7826`, with the queue | Run 2 `c024483d`, without the queue |
| :-- | --: | --: |
| Requests completed / failed | 5,000 / 0 | 5,000 / 0 |
| Winners answered "confirmed" / "secured, still being confirmed" | 0 / 500 | 500 / 0 |
| Winners' wait, average / p95 | 2.9 s / 4.2 s | 14.5 s / 26.3 s |
| Every buyer answered within | 5.4 s | 27.8 s |
| Orders confirmed (failed) | 500 (0) | 500 (0) |
| ERP pace (limit 20/s) | about 17/s | about 18/s |
| Slowest order, secured to confirmed | 29.1 s | 27.0 s |

- **Chaining.** Run 1 finalized at 17:18:48.3 and run 2 was accepted 0.3 s later, in the same lifecycle tick. The pair held the slot for 76 s, from 17:18:07 to 17:19:23.5. Run 2 finalized as soon as its traffic ended, since every order was already confirmed.
- **No deadline answer.** The last winner waited 27.8 s, so no wait reached the 45 s deadline.
- **Panel**, checked in the built-in browser as a visitor:
  - Watch, opened on run 1, followed run 2 by itself; the accepted run ID switched to run 2.
  - The panel showed "Run 1 in progress / Run 2 not started yet", then run 1's facts with run 2 in progress, then both runs with the takeaway.
  - The same panel appears on both run reports, and history lists both runs with their mode.


### Measurement (proof environment, 2026-10-12, design §5)

- **Setup:** 5 starts of `queue-comparison` with `scripts/capacity-measurement.mjs`, run inside the proof core's API container from 17:20 to 17:28 UTC.
- **Order:** fixed (with the queue first), so pairs are AB; pair 1 is discarded as warm-up.
- **Every run** completed: 5,000 of 5,000 requests, 0 failed, 500 accepted, 4,500 sold out, 500 of 500 orders confirmed, 0 failed.
- **Summary** from `scripts/comparison-analysis.mjs`, pairs 2–5, median (min–max):

| Metric | With the queue | Without the queue | Ratio without/with | Pairs |
| :-- | --: | --: | --: | :-- |
| Winners' average wait | 2.02 s (1.75–2.14) | 14.15 s (13.75–14.54) | 7.1 (6.7–7.9) | all higher without the queue |
| Winners' p95 wait | 3.23 s (2.95–3.37) | 26.07 s (25.78–26.93) | 8.2 (7.7–8.7) | all higher without the queue |
| Every buyer answered within | 4.83 s (4.70–5.07) | 27.34 s (26.99–28.49) | 5.6 (5.4–6.1) | all higher without the queue |
| Winners told "confirmed" | 0 | 500 | – | – |
| Winners told "secured, still being confirmed" | 500 | 0 | – | no deadline answer in any run |
| Orders confirmed | 500 | 500 | 1 | all equal |
| ERP pace | 18.1/s (18.0–18.3) | 18.3/s (17.6–18.5) | 1.0 | equal within 4 % |
| Slowest order, secured to confirmed | 27.1 s (27.0–27.3) | 27.0 s (25.8–28.1) | 1.0 | equal within 9 % |

- **Warm-up pair 1** fell in the same ranges: winners' p95 3.9 s against 27.0 s.
- **The claim holds in every pair.** Winners wait 7–9 times longer without the queue, at p95 and on average. The ERP confirms every order at the same pace either way, and the back office's own time (slowest order about 27 s) is the same in both modes. Only who waits for it changes.
- **Against the checkpoint:** the archived checkpoint measured winner p95 at 2.3 s against 33.7 s, on a different topology. Here the drain is shorter (about 27 s against 35 s) because the realized ERP pace is about 18/s.
- **Chaining defect found during the series (review F3).** After the capacity script tore down pair 4, the lifecycle poll started two unrequested runs without the queue, `8e1be680` at 17:25:23 and `fec42da1` at 17:25:58.
  - **Cause:** deleting pair 4's second run made its first run look unpaired again; deleting that first run then nulled the link of the new run, which in turn looked like a first run.
  - **Effect on the data:** pair 5 waited for the slot, then ran normally. The unrequested runs did not overlap any measured run.
  - Both runs are left in the proof history. The fix (below) requires the comparison's first mode and no later run.

### Review fixes (2026-10-12)

The supervisor's arbitration on the independent review (`scratchpad/review/task03-code-review.md`). Each finding was checked against the code first.

- **F1, admin UI could not start the preset:** confirmed and fixed. The UI now sends `{ presetSlug }` alone for a comparison preset and locks its run values. Tested in the web (the request body) and in the API (estimate and start with that shape).
- **F2, takeaway checked nothing:** fixed. The takeaway is gated (see Panel). The row that called transport failures "winners" now reads "Buyers without an expected answer".
- **F3, a deleted link re-armed chaining:** confirmed live during the measurement, then fixed as above. The capacity script now tears the first run down first.
  - **Residual:** an operator who deletes a second run within 60 s of its first run's finalization re-arms that first run once. The new second run is correctly linked to it, so the pair stays consistent.
- **F4, waiter at shutdown and on a slow read:** fixed. After shutdown begins, `wait()` answers at once, and deadlines are settled on every tick, even during a slow read.
- **F5, panel showed pending forever:** fixed (see Panel).
- **F7, analysis paired by label:** fixed. Pairs are matched by `pairId`, with the label as a fallback for older records, and a null count stays unknown.
- **F8, duplicated preset kept the comparison text:** fixed. A duplicated comparison preset gets a neutral description.
- **F9, spectators saw no panel:** on `dev`, spectators do see a terminal run's conclusion, so the panel now shows for any live comparison run.
- **Simplifications:**
  - The route alone validates the response.
  - The unused `now` options are gone.
  - The history page passes its own report instead of reading it twice.
- **New tests:**
  - the startup replay reaching the waiting route;
  - the deadline's margin under k6's request timeout;
  - Watch following run 1 to run 2;
  - the admin request shape;
  - "No second run was started.";
  - a slow read and a wait after shutdown.
- **Not done, per the arbitration:** F6, merging the service into the waiter, sharing metric definitions between the script and the panel.
- **Commits:**
  - `503cffc5` fix(api): chain only a comparison's latest first run and harden the wait
  - `953f5cd8` fix(web): state the comparison's takeaway only when the data shows it
  - `3740a0ce` fix(scripts): pair comparison records by start and tear the first run down first
  - `91c7fa56` fix(api): judge a due second run by what was created after the first run finished. The first version ordered by creation time, which ties under a fixed test clock.
- **Validation:**
  - Dev container: `pnpm type-check` and `pnpm test:unit` pass.
  - Fly test runner: `pnpm test` passes in full: every unit suite, `test:api` 365, and `test:integration` (db 82, worker 103, mock-erp 7).
- **Re-verification on the proof environment** (deployed at `6c926f46`, no schema change, so no fresh core):
  - The pair was estimated, then started with `{ presetSlug: "queue-comparison" }`, the admin UI's request shape. The estimate was `admitted`.
  - Run 1 `d40887bb` (with the queue): winners' wait 2.6 s average and 3.8 s p95; every buyer answered within 5.4 s; 500 of 500 orders confirmed; about 17/s.
  - Run 2 `57c941e2` (without the queue): 14.6 s and 26.5 s; every buyer answered within 28.0 s; 500 confirmed answers and 0 deadline answers; 500 of 500 orders confirmed; about 18/s.
  - The panel and takeaway read correctly on Watch, seen as a spectator, and on both run reports.
  - No run followed the pair.
  - **Not done:** starting from the admin UI itself. The proof admin sign-in needs the passphrase typed into a public site, which this agent may not do. The owner should sign in and press Start for checkpoint A.

**Sizes after the fixes:** 1,197 production lines (+104), 710 test lines (+130), 9 lines of docs.

**Machines:** every proof Machine is stopped: core `871473b0632e78`, runner `89663dc6ed09e8`, gate `822090c7037938` and guard `e822636c56e428` (still scheduled hourly). The test runner `859726b4e16938` is stopped too.

### Checkpoint A summary

**What was built.**
- **A preset:** `queue-comparison`, admin-only, Surge 5k shape (5,000 buyers, 500 units, ERP 100 ms and 20/s). One start runs it twice in the same slot, with the order queue first, then without it. The budget is charged once, and each run keeps its own ceiling and automatic reset.
- **The mode without the queue:** a winner's request stays open until the same worker has the order confirmed by the ERP at the ERP's pace. It gets `200 order_confirmed`. After 45 s it would get the queued mode's own `202`, and the order would still be confirmed later. The worker, the ERP client and their pacing are unchanged.
- **The panel:** one panel on Watch and on both run reports, comparing all winners of each run, with unknown facts shown as unknown. A takeaway is shown only when the data supports it.

**What the measured pairs show** (proof environment, 4 pairs after a warm-up pair, median and min–max):
- **Winners' wait:**
  - With the queue: 2.0 s average and 3.2 s p95 (2.95–3.37 s).
  - Without it: 14.2 s average and 26.1 s p95 (25.8–26.9 s).
  - Without the queue they wait 8.2 times longer at p95 (7.7–8.7), and every pair agrees.
- **Every buyer answered within:** 4.8 s with the queue, 27.3 s without.
- **Orders:** 500 of 500 confirmed in every run, none failed.
- **ERP pace:** 18.1/s and 18.3/s.
- **Slowest order, secured to confirmed:** about 27 s in both modes.

**Visitor takeaway.** Same buyers, same stock, same ERP limit. The ERP confirms every order at the same pace either way, so the queue does not make the back office faster. With the queue, every buyer has an answer within about 5 s. Without it, each winner waits for their turn at the ERP, up to about 28 s. The queue moves the wait from the buyer to the back office.

**Sizes:** 1,197 production lines, 710 test lines, 9 lines of docs. The plan budgeted ~940 and ~525: 1,093 production lines were accepted before the review, and the review fixes added the rest.

**Decision asked.** Validate the comparison live: sign in on `https://cs-proof-gate.fly.dev/admin`, start "Queue comparison", and watch both runs. Then decide whether it becomes public. **Recommendation:** validate and make it public with task 05's texts. The effect is large, stable in every pair, and stated without exaggeration.

**Open points:**
- No deadline answer occurred on the preset (the last winner waited about 28 s), so the "still being confirmed" path is shown in tests only.
- The fixed run order (with the queue first) is disclosed in the panel text.
- Two unrequested runs from the F3 defect (`8e1be680`, `fec42da1`) remain in the proof history.
- Production needs a fresh core for this schema (task 06).

