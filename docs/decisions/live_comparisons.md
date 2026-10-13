# Live Comparisons - Decision Log

Decisions and accepted limits of the live comparisons. The entry format, statuses, and the rule for reviewers are in the [README](README.md).

**Context for every entry.** Two fixed presets each run one workload twice, as two chained runs, with one architecture choice switched: the queue comparison runs without the order queue in its second run, and the Redis comparison runs with the stock decision and the order queue in PostgreSQL. They show visitors what each choice buys, measured live at the demo's scale. A run's mode is a property of the run.

## Index

| ID | Decision |
| :-- | :-- |
| [LC-01](#lc-01-a-comparison-switches-one-choice-and-keeps-every-protection) | A comparison switches one choice and keeps every protection |
| [LC-02](#lc-02-without-the-order-queue-a-buyers-deadline-never-fails-an-order) | Without the order queue, a buyer's deadline never fails an order |
| [LC-03](#lc-03-the-modes-run-only-in-two-fixed-presets-as-two-chained-runs-in-a-fixed-order) | The modes run only in two fixed presets, as two chained runs in a fixed order |
| [LC-04](#lc-04-the-stores-stay-on-the-apis-machine-with-no-simulated-distance) | The stores stay on the API's Machine, with no simulated distance |
| [LC-05](#lc-05-the-redis-comparison-claims-the-databases-load-not-speed) | The Redis comparison claims the database's load, not speed |

### LC-01 A comparison switches one choice and keeps every protection

- **Status:** accepted
- **Date:** 2026-10-12
- **Context:** A comparison convinces an informed reviewer only if its alternative is a design someone would ship. An earlier throwaway baseline skipped idempotency, the run fence and the bookkeeping, so its faster winners measured the cost of the demo's safety work, not the choice.
- **Decision:**
  - Both runs of a pair use the same Machines, preset, API processes, connection pools and protections: idempotency, the run fence, the bookkeeping, the reservation and order recorded before "yes", and the same order lifecycle and teardown.
  - The PostgreSQL mode is a standard design: one stock row, a conditional decrement, and a read-only check first. A winner commits its rows, its queue job and the decrement in one transaction on a reserved connection, as the Redis mode's persistence does.
  - A sold-out answer writes nothing synchronously, in any mode; live counters are batched.
  - Without the order queue, the request waits for the same worker's confirmation instead of calling the ERP itself, so the ERP client and its pacing stay single.
  - The figures compare equal groups (all winners, or all buyers), and a difference is claimed only when every measured pair agrees.
- **Consequences:** The PostgreSQL mode is not tuned past a standard design, so a specialist could make it somewhat faster. The alternative modes' code paths exist only for the comparisons.
- **Rejected alternatives:**
  - A lean baseline without the protections: it measures the protections, not the choice.
  - A sold-out answer that updates a counter row: every rejection queued behind that row, an artifact of the implementation.
  - The Redis mode's two-phase flow (holds, promotion, pending-persistence recovery) in the PostgreSQL mode: it guards a gap between two stores that does not exist inside one database.
  - A polling loop per waiting request: hundreds of loops on a small pool starved the worker's dispatch. Waiting requests share one batched check per interval.
- **Code:** `apps/api/src/services/postgres-stock-buy-service.ts`, `synchronous-confirmation-buy-service.ts` and `order-confirmation-waiter.ts`.

### LC-02 Without the order queue, a buyer's deadline never fails an order

- **Status:** accepted
- **Date:** 2026-10-12
- **Context:** Without the order queue, a winner's request stays open until the back office has confirmed the order, which can outlast a client's patience.
- **Decision:** At a deadline counted from the request's arrival, or when the run ends, the request gets the queued mode's own "secured, not yet confirmed" answer, and the order is confirmed later as usual. The wait never touches the order.
- **Consequences:** The comparison shows that the buyer pays for the back office's pace, not that the system breaks. On the preset, the last winner is answered well before the deadline, so that answer is covered by tests only.
- **Rejected alternatives:**
  - Failing the order when the buyer stops waiting: it would show a failure the design does not have.
  - Calling the ERP inside the buy request: a second ERP client and pacing, and a replay rule for a call that a timed-out request abandons.
- **Code:** `apps/api/src/services/order-confirmation-waiter.ts`.

### LC-03 The modes run only in two fixed presets, as two chained runs in a fixed order

- **Status:** accepted
- **Date:** 2026-10-12
- **Context:** A mode in custom runs would need the capacity admission model to cover it, and an ordinary run must never change because the comparisons exist.
- **Decision:**
  - A mode is set only by a comparison preset; a start with a configuration override is refused, and custom runs never carry a mode.
  - One start runs the two modes as two chained runs in the same slot, charged once to the visitor's budget. Each run keeps its own ceiling, automatic reset and report.
  - The order is fixed, with the demo as built first, so visitors see the familiar system first. The visitor-facing texts disclose it.
  - Ordinary runs, the production topology and the capacity values (`CAPACITY_*`) are unchanged; the admission estimator has no model of the modes.
- **Consequences:**
  - The second run finds a warmer system. The measured gaps dwarf that effect, but the first comparison after a wake is slower in both runs.
  - Visitors cannot try the modes on other workloads.
- **Rejected alternatives:**
  - The modes in custom runs: every mode would need its own capacity calibration.
  - A parent run with child runs: more lifecycle states, for no visitor benefit.
  - An alternating or random order: visitors could not tell which run is which in advance, and the order effect is small against the gaps.
- **Code:** `apps/api/src/services/comparison-runs.ts`; the `comparison` column of the seeded presets in `packages/db/src/seed-presets.ts`.

### LC-04 The stores stay on the API's Machine, with no simulated distance

- **Status:** accepted
- **Date:** 2026-10-12
- **Context:** In production, PostgreSQL and Redis sit a network hop away from the API. In the hosted demo, they share the core Machine with it.
- **Decision:** No store distance, real or simulated. The visitor-facing texts state that the stores share the API's Machine, and what a real distance would change.
- **Consequences:** Every answer is faster than it would be with remote stores, in both modes. A turned-away buyer makes exactly one store round trip in either mode, so a distance would add about the same to every answer without changing what the comparison shows.
- **Rejected alternatives:**
  - A separate Machine for the stores: it changes the production topology for every run.
  - A simulated latency: it adds the same delay to both modes, and one more artificial condition to explain.

### LC-05 The Redis comparison claims the database's load, not speed

- **Status:** accepted
- **Date:** 2026-10-13
- **Context:** At the demo's scale, the API processes rather than the database bound how fast buyers are answered, and a winner pays the Redis decision plus the same database work. What Redis measurably buys here is keeping turned-away buyers off the database.
- **Decision:**
  - The preset is a realistic spike, many buyers for a few hundred units, served in both runs by the buy-only pool ([HD-63](hosted_deployment.md#hd-63-a-buy-only-api-pool-serves-only-the-redis-comparison-one-process-keeps-every-other-duty)).
  - The headline is PostgreSQL's transactions and time in queries over the selling window, from the run's start until every buyer is answered. Waits are shown as figures, never claimed.
  - The window closes when the runner reports every buyer answered, without waiting for PostgreSQL's next statistics flush, so up to its last second of database work is left out, mostly the PostgreSQL mode's: the figures understate the gap.
- **Consequences:** Visitors see no speed gain for Redis; the texts say when one would appear: several API instances sharing a database, a remote database behind a small pool, or a database busy with other work. Redis's own single-thread ceiling is not measured.
- **Rejected alternatives:**
  - A stock of one unit: larger ratios, but it hides the stock contention and the order work of a real sale.
  - Steady arrivals at a high rate: the PostgreSQL run drops buyers, which biases its waits and fails the run.
  - Claiming response times: they did not agree across measured pairs.
- **Code:** `packages/db/src/store-load.ts`; the Redis comparison rows in `apps/web/src/app/components/comparison-panel.tsx`.
