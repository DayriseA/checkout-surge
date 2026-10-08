# 15c — Public Limits and Visitor Explanations

**Design:** section 1.2 · **Depends on:** 15b, deployed

## Goal

Visitors can use what the hardware sustains, and the demo explains what limits a run and why it would fail.

## Scope

- **Confirm the capacity values first** (owner decision, 2026-10-08, after the 15b cloud verification). On a 4 vCPU cloud VM, the heaviest run the local public form admits (1,000/s for 10 s, stock 1,000, exactly 80 %) failed: 2,770 requests never sent, p95 13.9 s. The local values were provisional, and the 3 s VU budget was measured with stock 1.
  - **On Fly:** runs at the proposed public limits with stock 1,000.
  - **On a cloud VM:** runs at the local public maximum.
  - Then adjust the `CAPACITY_*` env values, the VU budget included, before raising any limit.
  - Agents' in-container commands on Fly may be refused by the permission system: plan the Fly runs as an owner-run prompt (as for task 18's last check) if needed.
- **Raise the public limits** to the measured values.
  - **Live policy row:** edited from the admin console, by the owner, or by the supervisor with the owner's approval.
  - **Seed:** the `PUBLIC_CUSTOM_*` values in the `setup` container env of `infra/fly/core/machine.json`, since a fresh core seeds the policy from them, and the local seed in `docker-compose.yml`.
  - The caps stay at or above the seed values (design 1.2).
  - Update or withdraw HD-53, whose premise (the default VU allocation) no longer holds.
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

## Out of Scope

- Admission code (15b), a multi-process API (HD-51).
- Comparative runs with and without the Redis layer (task 21).

## Done When

- The public limits are raised to the measured values, live and in the seed.
- The visitor-facing explanations are updated.

## Open Points

- Whether the explanations quote the hosted figures as text, or read the deployment's capacity values from the API (no measured figure is hard-coded in `apps/web` today).

## Working Notes

_None yet._
