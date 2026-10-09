# 16c — Redis Claims and Known Limits

**Design:** none · **Depends on:** none

## Goal

The demo's texts claim only what it shows: what the Redis layer and the order queue buy at its scale, and what it cannot show.

## Context

- Split from 16b on 2026-10-09.
- The comparative runs study measured no speed gain from the Redis layer at the demo's scale (measurements in `../redis_and_order_queue_proof/design.md`, section 2).
  - The single API process is the bottleneck, and a sold-out answer costs PostgreSQL little.
  - What Redis measurably buys: it keeps turned-away buyers off the database. PostgreSQL was 7–9 % busy with Redis against 50–63 % without, for the same answers.
  - The order queue, which lives in Redis, is what keeps buyers from waiting on the ERP.

## Scope

Owner decisions of 2026-10-09.

- **Redis claims.** Reword every sentence that claims or implies a speed gain from Redis. Line numbers as of `ed347fb5`.
  - **Contradicted:**
    - `apps/web/src/app/page.tsx:216-217` ("The stock decision is fast for every buyer") and `:222-223` ("would make every buyer, turned-away buyers included, wait for it");
    - `working_docs/project_description.md:15` ("high-speed Redis layer") and `:37` (the Problem);
    - `working_docs/delivery_constraints.md:10` (ms-level p95 for the fast path, not met under a burst).
  - **To complete:** `working_docs/project_description.md:39`, the Benefit: Redis also keeps turned-away buyers off the database.
  - **Softenings to consider:**
    - `page.tsx:183` ("a fast in-memory decision"), `:210` (the section heading), `:482`, `:531` ("Redis fast path"), `:654`;
    - `README.md:3` (the measured burst absorption comes from the order queue);
    - `docs/architecture.md:72` and `:176`;
    - `docs/core_business_entities.md:717, 810`.
  - **Still accurate:** "answered from Redis alone, without touching the database", and successful buyers waiting longer (consider "usually").
- **"Known limits" section.** A short, separate section at the very end of the overview page, for transparency and the curious, not put forward.
  - What the demo cannot show at its scale, and why: one API process, a local database, a single machine, so no speed gain from Redis is visible.
  - The planned later work, without dates or details: a comparison with and without the Redis layer and with and without the order queue, several API processes, and the database at a realistic distance.
  - Distinct from "What a production system should add", which describes industry practice, and from "What limits a run, and what makes it fail", which explains run outcomes. No repetition of either: today "One API process" (`page.tsx:391-395`) and the "several API instances" production item (`:310-312`) touch the same ground.

## Out of Scope

- Run-start and run-failure messages (16b).

## Done When

- The owner has reviewed the reworded claims and the known-limits section.

## Open Points

- None. Settled with the owner (2026-10-09):
  - **Softenings:** apply them all, on the page, the README and the docs, replacing "fast" with what Redis does ("in-memory", "keeps turned-away buyers off the database").
  - **Heading:** "Redis makes the atomic scarcity decision" stays; only the sentences under it change.
  - **Section:** "Known limits of this demo". "One API process" stays in "What limits a run" because it explains run outcomes. The new section says what the demo cannot show and why, and refers to that passage without repeating its figures.

## Working Notes

_None yet._
