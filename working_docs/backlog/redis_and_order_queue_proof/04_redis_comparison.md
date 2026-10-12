# 04 — Redis Comparison

**Design:** sections 2.3, 3.1, 4, 5 · **Depends on:** 03

## Goal

A visitor starts one fixed preset and sees, side by side on the same workload, what the Redis layer buys: Redis decides the stock and turns buyers away without touching PostgreSQL, so the database's load stays low while the same answers are given.

## Scope

- **Mode without Redis:**
  - PostgreSQL decides the stock in one round trip. A sold-out answer writes nothing synchronously; its count is batched like the demo mode's counters.
  - A winner's stock decrement, order and delivery row commit in one transaction.
  - The order queue lives in PostgreSQL (a job table claimed with `FOR UPDATE SKIP LOCKED`), with a pickup latency comparable to BullMQ's.
  - The same idempotency, run fence, bookkeeping, live counters and teardown as the demo mode. Redis still carries notifications and the live feed; the label says "stock decision and order queue in PostgreSQL".
- **Comparison conditions, for comparison runs only:**
  - Two or three buy-only API processes. One control process keeps every single-owner duty, so HD-11 holds; HD-51 is amended, not superseded.
  - The same simulated latency to PostgreSQL and Redis, stated as a simulation.
  - Ordinary runs keep their path and topology.
- **Database load capture** from PostgreSQL's own statistics or in-app counters, shown in the panel built by task 03: database work per turned-away buyer, and response times only if stable.
- **Preset:** start from the checkpoint's 1,000 arrivals/s for 10 s, stock 1.
- **Measurement** in the proof environment as in design section 5, recorded in the working notes.

## Out of Scope

- Slimming the Lua script, production topology changes, `CAPACITY_*` recalibration.

## Done When

- The preset runs end to end in the proof environment with the same answers and protections in both modes, and the panel reads clearly.
- The measured pairs agree, and the results are in the working notes.
- Tests cover the new behavior at the right boundaries, including that sold-out answers do not serialize.
- **Owner checkpoint B:** the owner validates the comparison, or asks for changes.

## Size Budget

About 1,100 production lines and 700 test lines. Going beyond is recorded and explained in the notes first.

## Working Notes

_None yet._
