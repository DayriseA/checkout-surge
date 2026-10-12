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

_None yet._
