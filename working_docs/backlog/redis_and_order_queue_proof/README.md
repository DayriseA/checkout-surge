# Redis and Order Queue Proof Backlog

Work breakdown for live comparative runs: what the order queue and the Redis layer each buy, shown on two fixed presets at the demo's scale.

- [design.md](design.md) is the working design for this backlog. It holds the founding study, the owner's decisions and the open points. Tasks point to its sections instead of restating them. Choices that pass the inclusion test of `docs/decisions/README.md` are recorded in `docs/decisions/`, in its format.
- [review_2026-10-12.md](review_2026-10-12.md) records why the first implementation was archived and the traps to avoid. Read it before tasks 03 and 04.
- Each numbered file is one task and its working document.

## Rules

- **Order.** Tasks are handled in numeric order. A task whose dependencies are done can be pulled forward.
- **Notes stay in the task.** Findings, measurements, costs and the choices made with their reasons go into the task's own "Working notes" section, never into another task or into `design.md`.
- **Decisions stay in the design.** When a task changes or refines a decision, update `design.md` in the same change.
- **Open points are not decided alone.** A choice that changes the owner's decisions, the fairness rules (design section 5) or production goes to the owner's review list below instead. Smaller choices are made and recorded in the task notes. Never record a decision as the owner's unless the owner stated it.
- **Proportion.** Each task has a size budget; going beyond it is explained in the notes first. Measurement follows design section 5 and builds no collectors, ledgers or frozen protocols. Prefer the simplest design that is fair; a senior reviewer must not find it overcomplicated.
- **Owner checkpoints** (A: queue comparison, B: Redis comparison, C: interface, D: texts) are one-page summaries: what was done, what it shows, the decision asked and a recommendation. Work after a checkpoint waits for the owner's answer.
- **Status lives here only,** in the table below: `todo`, `in progress` or `done`.

## Autonomous Work

Design section 6 is binding. In short:

- **Fly.io:**
  - Only the `playground` organization (slug `playground-416`), and every command names its app or organization.
  - Never touch `checkout-surge-core`, `checkout-surge-runner`, `checkout-surge-gate`, or any app outside `playground`.
  - Machines are stopped or destroyed when not in use.
- **Git:** work on `claude/redis-queue-comparisons`. Never push to or merge into `dev` or `main`. The archived branch `codex/redis-order-queue-feasibility` is read only, as a source to port from.
- **Tests:** never on the owner's Windows host; the dev container for small runs, the Fly test runner for heavy suites.
- **Secrets:** generated for the proof environment. Never read the production secrets.
- **Repository rules:** `AGENTS.md` applies, including never opening `working_docs/deferred/`.
- **Stop and report to the owner** in these cases:
  - an action that would touch production;
  - an owner checkpoint;
  - a result that puts the project in question.

## Owner's Review List

Choices waiting for the owner, added with the task, the options and a recommendation.

- **Buy-only pool on the production core (task 04, checkpoint B).** The Redis comparison needs 2 buy-only API processes: one process was pinned in both modes on the realistic preset. On merge, the core Machine gains an `api-buy` container: about 3 idle Node processes and 4 Redis connections outside comparison runs, and up to about 2 cores and 20 more PostgreSQL connections during a Redis comparison (total still under 100). Ordinary runs, the queue comparison, boot, the gate, the guard, recovery and idle stop are unaffected; HD-51 is amended for comparison runs (task 06). Options: accept the pool; or drop the Redis comparison's pool and present it with one process, whose waits then mostly measure the API. Recommendation: accept.

## Tasks

| # | Task | Depends on | Status |
| :-- | :-- | :-- | :-- |
| 01 | [Proof environment](01_proof_environment.md) | hosted deployment backlog done | done |
| 02 | [Feasibility checkpoint](02_feasibility_checkpoint.md) | 01 | done |
| 03 | [Queue comparison](03_queue_comparison.md), owner checkpoint A | 01 | done |
| 04 | [Redis comparison](04_redis_comparison.md), owner checkpoint B | 03 | in progress |
| 05 | [Interface pass](05_interface_pass.md), owner checkpoint C | 04 | todo |
| 06 | [Narrative and decisions](06_narrative.md), owner checkpoint D | 05 | todo |
| 07 | [Production rollout](07_production_rollout.md) | 06 | todo |
