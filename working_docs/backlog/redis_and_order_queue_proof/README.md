# Redis and Order Queue Proof Backlog

Work breakdown for live comparative runs: what the order queue and the Redis layer each buy, shown on fixed presets at the demo's scale.

- [design.md](design.md) is the working design for this backlog. It holds the founding study, the owner's decisions so far and the open points. Tasks point to its sections instead of restating them. Choices that pass the inclusion test of `docs/decisions/README.md` are recorded in `docs/decisions/`, in its format.
- Each numbered file is one task and its working document.
- This backlog starts when the hosted deployment backlog (`../hosted_deployment/`) is done.

## Rules

- **Order.** Tasks are handled in numeric order. A task whose dependencies are done can be pulled forward. Tasks 03 to 06 start only after the owner's go at the task 02 checkpoint.
- **Notes stay in the task.** Findings, measurements, costs and the choices made with their reasons go into the task's own "Working notes" section, never into another task or into `design.md`.
- **Decisions stay in the design.** When a task changes or refines a decision, update `design.md` in the same change.
- **Open points are not decided alone.** A choice that changes the owner's decisions, the fairness rules (design section 5) or production goes to the owner's review list below instead. Smaller choices are made and recorded in the task notes.
- **Status lives here only,** in the table below: `todo`, `in progress` or `done`.

## Autonomous Work

The project is meant to be run by an AI agent working alone on the owner's laptop. Design section 6 is binding. In short:

- **Fly.io:**
  - Only the `playground` organization (slug `playground-416`), and every command names its app or organization.
  - Never touch `checkout-surge-core`, `checkout-surge-runner`, `checkout-surge-gate`, or any app outside `playground`.
  - Machines are stopped or destroyed when not in use.
- **Git:** only the project's own branches. Never push to or merge into `dev` or `main`.
- **Secrets:** generated for the proof environment. Never read the production secrets.
- **Repository rules:** `AGENTS.md` applies, including never opening `working_docs/deferred/`.
- **Stop and report to the owner** in these cases:
  - an action that would touch production;
  - the task 02 checkpoint;
  - a result that puts the project in question.

## Owner's Review List

Choices waiting for the owner, added by the agent with the task, the options and its recommendation.

- **Task 02 checkpoint — GO received (2026-10-11).** The owner authorized autonomous continuation after the completed [feasibility report](02_feasibility_checkpoint.md#working-notes), including commits on the project's branches. Tasks 03–06 can proceed with the report's disclosed caveats. Production changes remain subject to the review boundary below.
- **Public demonstration clarified (2026-10-11).** The owner wants one visible immutable public preset/start button showing both benefits, with no visitor configuration. Internally it runs two fixed matched workloads: Redis versus PostgreSQL and queued versus inline ERP, four normal child runs in total. The agent owns sequencing/reset: one public-budget and exclusive reservation, a total 600-second estimated occupancy ceiling and the existing 900-second hard cleanup grace anchored to demonstration acceptance, with all four summaries retained. Production intervention still waits for final review.
- **Final production review.** The agent prepares and validates the complete demonstration in the proof environment, then presents its behavior, measurements and costs. Production rollout remains subject to the owner's final review; infrastructure questions do not block autonomous implementation.

## Tasks

| # | Task | Depends on | Status |
| :-- | :-- | :-- | :-- |
| 01 | [Proof environment](01_proof_environment.md) | hosted deployment backlog done | done |
| 02 | [Feasibility checkpoint](02_feasibility_checkpoint.md) | 01 | done |
| 03 | [Multi-process API](03_multi_process_api.md) | 02, owner's go | in progress |
| 04 | [Store distance](04_store_distance.md) | 02, owner's go | in progress |
| 05 | [Mode without Redis](05_mode_without_redis.md) | 02, owner's go | in progress |
| 06 | [Mode without the order queue](06_mode_without_order_queue.md) | 02, owner's go | in progress |
| 07 | [Comparative presets and load generator](07_comparative_presets.md) | 03–06 | in progress |
| 08 | [Comparative runs](08_comparative_runs.md) | 07 | in progress |
| 09 | [Narrative and decisions](09_narrative.md) | 08 | todo |
| 10 | [Production rollout](10_production_rollout.md) | 09 | todo |
