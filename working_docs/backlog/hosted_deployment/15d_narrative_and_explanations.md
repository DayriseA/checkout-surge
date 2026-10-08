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

### Audit (2026-10-08, read-only)

The buy path is described in `docs/architecture.md` "The Buy Path" (lines 72–83).

**apps/web, most misleading first:**

- `page.tsx:173-176` implies buyers never wait on PostgreSQL. Winners do: their order is written before the 202.
- `page.tsx:362-398`, the architecture diagram, has no API→PostgreSQL or API→queue arrow on the winner path.
- `demo/page.tsx:31-36` omits the durable write before the answer; "reaches a confirmed or failed outcome, no orders fail" reads as self-contradictory.
- `run-history-detail.tsx:644-645` and `transport-observation.tsx:295-296` show "Local run note: … share one host" unconditionally, which is false on Fly, where k6 runs on its own Machine.
- `page.tsx:172` and glossary `:511` say "immediately". The decision is fast; the answer is not (Fly surge-10k p95 7.5–13.9 s).
- `page.tsx:53-54, 98, 160-165` (hero, "The flash-sale failure story") present the run as the whole sale, with no waiting room.
- `page.tsx:220-243` ("What is real and what is simulated") never says what is not modelled.
- `page.tsx:314-320` ("Results are environment-dependent") explains neither capacity nor what makes a run fail.
- Glossary `:503-506` and `public-vocabulary.ts:27`: "Reservation hold" collides with the real journey's temporary hold before payment.
- `field-hints.ts:3, 5` use crowd framing; `watch/page.tsx:53`, `operator-dashboard.tsx:552, 910` and `run-history/[runId]/page.tsx:67-68` say "flash sale" (minor).

**Presets (`packages/db/src/seed-presets.ts:49, 69, 89, 109, 129`):** "N buyers rush 500 units" is crowd framing, and the 10k preset carries no latency note.

**README:**

- Line 20 inverts the order and misses the PostgreSQL transaction.
- Line 5 is stale: it says hosted deployment is future work.
- Line 3 needs the framing.

**docs/:**

- `architecture.md:15` omits the PostgreSQL write.
- `architecture.md:5` presents the surge as the sale.
- `architecture.md:100` needs a "bounded by one API process and the pool" caveat.
- `architecture.md:89` has a stale page name.
- `redis_inventory_hot_path.md:101` and `core_business_entities.md:174`: "hold window" reads as a hold step.
- `cross_service_conventions.md:29-34` forbids treating reservation and order as synonyms. Phrase the simplification as "a secured reservation creates its order at once; there is no payment step between them".
- `reference_runtime_measurements.md:3`: the top note seems to cover the October figures too.

**working_docs (the owner's own):**

- `project_description.md:37-38, 45, 83, 85, 102, 114`: losers-only claims, "immediately", "< 1 second", "millisecond-accurate", a stale roadmap.
- `delivery_constraints.md:9, 15`: crowd framing and stale hosted-benchmark wording.

**Where to write:**

- `page.tsx`:
  - a new opening section, "Behind a waiting room", replacing the failure story;
  - "What a production system would add" after "What is real and what is simulated";
  - the Redis paragraph and the diagram rewritten;
  - the capacity and failure explanations in its Limits section.
- Small edits elsewhere: `demo/page.tsx`, hints, presets, the local-run notes, README step 4 and line 5, `architecture.md:5,15`.
- One short README section after the intro.

**Accurate, worth keeping:**

- `capacity-presentation.ts:17-18` and `run-failure-explanation.tsx:207`;
- `field-hints.ts:17, 21`;
- `page.tsx:201-215`, "How a run finishes", "What success means", "Admission and reset";
- `architecture.md:72-83, 153`;
- `reference_runtime_measurements.md` "Mechanism";
- `redis_inventory_hot_path.md:33`, reusable for the production section;
- `scope_and_caveats.md`;
- `delivery_constraints.md:10, 22`.

### Implementation (2026-10-08, uncommitted, awaiting owner review)

- **`page.tsx`:** "Behind a waiting room" replaces the failure story (anchor `#waiting-room`; hero and `/demo` links follow). Redis paragraph rewritten: losers from Redis alone, winners after one PostgreSQL transaction and a queue publish, decision time against answer time. Diagram redrawn: API→Redis for every attempt, API→PostgreSQL and API→queue for winners, worker→PostgreSQL for outcomes; still 7 nodes. New "What a production system would add" after "Real and simulated" (reuses `redis_inventory_hot_path.md:33`). Limits section renamed "What limits a run, and what makes it fail". Glossary: "Reservation hold" redefined, "Reservation versus confirmation" drops "immediately".
- **Figures:** a `hostedMeasurements` constant at the top of `page.tsx` holds `{{FLY_SOLD_OUT_RATE}}`, `{{FLY_ACCEPTED_RATE}}`, `{{FLY_SPIKE_RATE}}`, `{{FLY_SURGE_10K_P95}}`. No other file carries a figure placeholder.
- **Local run notes:** both notes now state both topologies (simpler than threading the environment into `FastReservationEvidence`, which has no `runnerRegion`).
- **Not changed:** `public-vocabulary.ts:27` ("holds past deadline, still reserved") keeps the term, per "redefined, not renamed"; the page title keeps "Flash-sale checkout demo".
- **Beyond the audit list:** the README ASCII architecture diagram showed Redis feeding BullMQ; redrawn with the same correction as the page diagram.
- **Checks:** Biome clean on touched files, `pnpm type-check` green, db unit 47/47, web unit 772/772 (one run hit a timing flake in `admin-controller-state.test.tsx`, passing alone and in the other full run; no admin file touched).
- **Owner retouches (2026-10-08):** the calibration sentence moved to a muted footnote (`*`) in "Behind a waiting room"; "winner/loser" became "buyers who secure a unit / successful buyers" and "buyers turned away / turned-away buyers" in the pedagogical texts; the production heading is now "should add" (anchor `#production` unchanged); the tab title is "Checkout-Surge: the system behind the waiting room of a flash sale". `architecture.md:80, 94, 153` keep "per-loser", "winner's canonical JSON" and "losing path": lines not edited by this task, and 94 is about concurrent ledger inserts, not buyers.
- **Fix pass after the rendering review (2026-10-08):** on visitor pages "hold" now means only the production temporary hold. The glossary entry became "Reservation awaiting its durable record" (anchor `#pending-reservation`), and "How a run finishes", the Drain entry and `public-vocabulary.ts` `expiredReservations` ("reservations past their deadline, still reserved") follow. Docs and code identifiers keep "hold". Other changes: Surge 10k p95 now "between about 8 and 14 seconds", a new production hold bullet, sidebar labels matched to headings, the Redis paragraph split, the footnote reworded and moved, "and none failed" on `/demo`, "realistic" dropped from README, "Buyers are arriving." as the running headline, and "(retried; no order failed)" beside the Failures count in the watch page's "Simulated ERP outcomes" panel.
