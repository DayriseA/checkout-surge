# 15d — Narrative and Visitor Explanations

**Design:** section 1.2 · **Depends on:** 15b; its figures come from 15c

## Goal

The demo tells an accurate story: it models the purchase system behind a waiting room, explains what it demonstrates and what it simplifies, and explains what limits a run and why it would fail.

## Scope

- **Visitor-facing explanations.** Enrich the informative sections (`apps/web/src/app/page.tsx`, `apps/web/src/app/demo/page.tsx`, preset texts) with what 13a and 15a found:
  - the single API process's capacity;
  - buyer spike against constant arrival (new against reused connections);
  - why a slow ERP fills the queue without slowing purchases;
  - the effect of stock;
  - what makes a run fail.
  - Figures come from measurements; the text explains the mechanisms.

- **Narrative reframe** (owner decision, 2026-10-08).
  - **The framing.** The demo models the purchase system behind a virtual waiting room. Its traffic is what the waiting room lets through in an interval, which is why the system is calibrated and refuses runs it cannot absorb.
    - Constant arrival is the waiting room's steady outflow.
    - A buyer spike is a batch released at once.
  - **The real journey,** explained but not modelled:
    1. a waiting room;
    2. a fast in-memory decision that turns losers away;
    3. a temporary hold, then payment;
    4. the durable order;
    5. asynchronous fulfilment and notifications.
  - **What the demo demonstrates:**
    - the in-memory stock decision in Redis: losers are turned away without touching the database;
    - idempotency;
    - asynchronous processing that protects a slow downstream system (queue, rate limit, circuit breaker);
    - no overselling.
  - **The simplification, stated as one:** there is no hold or payment step, so a winner's reservation is the order, and the API records it durably before confirming it.
  - **What a production system would add:** a waiting room, holds with expiry and payment, several API instances, bot protection.
  - **Audit first.** A read-only audit of every visitor-facing text, the README and `docs/` lists the claims that contradict this framing or the actual behavior: for example, that the buyer's answer comes from Redis alone. This task then corrects them.
- **Figures** (owner decision, 2026-10-08): quote Fly's measured figures in the text, labelled as measurements of the hosted demo; do not read them from the API.

## Out of Scope

- Public limits and capacity values (15c), comparative runs (task 21), gate pages (task 16).

## Done When

- The audit's findings are corrected, and the narrative, the explanations and the "what production adds" section are approved by the owner.

## Open Points

- None.

## Working Notes

_None yet._
