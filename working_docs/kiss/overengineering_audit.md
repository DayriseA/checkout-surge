# Consolidated overengineering and maintainability audit

Date: 2026-07-20

Baseline: `ai/gpt-5.5` (`01f71e4`)

Audited head: `review-and-fixes` (`037b790`)

This report recommends simplification work but does not propose reverting whole backlog commits: most commits mix a valuable outcome with an implementation that can be reduced.

## Executive verdict

The current branch is a valuable but substantially over-hardened reference implementation. It should not be rolled back wholesale. The atomic reservation path, durable business records, queue buffering, ERP backpressure, idempotent replay, run lifecycle, load generation, and the four dashboard gold signals are the point of the project and have earned meaningful resilience work.

The material overengineering is concentrated around that core:

1. multi-replica and production-grade coordination in a topology whose explicit boundary is a single local reference runtime;
2. several representations of the same fact followed by validators, migrations, and tests that keep the copies synchronized;
3. compatibility machinery for disposable, pre-release data without an explicit compatibility promise;
4. multiple reconcilers, locks, journals, and remediation paths for small crash windows and one-time incidents;
5. a dashboard whose realtime deltas and authoritative recovery snapshots require a complex mixed client-update protocol;
6. generalized test-reset, cleanup, security, and verification subsystems that exceed the needs of the demo; and
7. continued growth inside already oversized ownership boundaries.

The appropriate target is not merely fewer lines. It is fewer authorities, fewer state machines, fewer compatibility modes, and fewer copies of each fact. The simplification effort should preserve behavior at the project boundary while deleting internal mechanisms that exist only to support other unnecessary mechanisms.

Before broad simplification, close the live correctness and verification gaps documented below. Refactoring from a known-green behavioral baseline will make deletion safer and will prevent existing defects from being mistaken for simplification regressions.

## Scope and decision rule

The recommendations use the current documented product boundary:

- k6 generates synthetic buyers that call the API directly; there is no customer storefront;
- Redis owns the scarcity-sensitive reservation decision;
- PostgreSQL owns durable business records;
- BullMQ buffers the slow ERP path;
- the dashboard demonstrates request surge, queue depth, inventory drain, consistency lag, and run outcomes;
- public and admin surfaces start, observe, recover, and clean up local demo runs; and
- hosted packaging, horizontal coordination, and production operational hardening remain explicit non-goals until a concrete deployment model is accepted.

Ordinary security, bounded dependency calls, deterministic cleanup, and recovery of core durable business work are still required. The non-goals do not justify fragile happy-path-only code. They do mean that a mechanism should not be retained solely because a future multi-replica deployment might need it.

For each candidate, use this decision rule:

1. Does it protect an observed behavior or a guarantee explicitly required by the project description? (`working_docs/project_description.md`)
2. Is it the smallest authority that can protect that guarantee in the accepted topology?
3. Does it introduce a second representation, fallback mode, or recovery protocol whose own failures must then be reconciled?
4. Can the same outcome be obtained by narrowing the contract or rebuilding disposable state?

## Consolidated evidence

Independent source-line counts differ slightly because they used different file/category boundaries, but the growth pattern is stable:

| Signal | Consolidated reading |
| --- | --- |
| Non-test TypeScript/TSX/MJS growth | Approximately +77% |
| Test-code growth | Approximately +174% |
| Test-to-source ratio | Grew from about 0.90 to about 1.39 |
| Full Git diff | 505 files, +115,416 / -7,619 lines, including generated metadata and working documents |
| Commits after the baseline | 92 commits |
| Functional-surface growth | Much smaller than the growth in hardening, reconciliation, accounting, testing, and tooling |

Generated Drizzle snapshots and backlog documents explain a large part of the raw repository growth and should not be treated as handwritten cognitive complexity. The handwritten growth is nevertheless substantial and is concentrated in large owners:

| Area | Evidence highlighted by the audits |
| --- | --- |
| Run orchestration | `demo-run-service.ts` is 1,820 lines and owns metrics, traffic execution, presets, policy, lifecycle, ingestion, and completion |
| Maintenance/finalization | `demo-maintenance-service.ts` grew to 852 lines; `demo-run-finalization-service.ts` to 615 lines |
| API composition | `apps/api/src/index.ts` grew substantially and contains per-request resource/lifecycle construction and readiness implementations |
| Dashboard state | `dashboard-state.ts` is 770 lines of scope, watermark, replay, deduplication, and recovery reconciliation |
| Contracts | `load.ts` and `demo.ts` grew around duplicate accounting, lifecycle variants, diagnostics, and cross-field validation |
| Load orchestration | `K6Runner` is 894 lines; its parser and durable journal add overlapping evidence and delivery paths |
| Tests/tooling | Test code grew faster than production code; verification scripts, meta-tests, and root commands form a large secondary product surface |

These numbers are indicators, not deletion goals. A small but essential durability boundary is better than a shorter unreliable implementation; a large optional compatibility or coordination subsystem is not justified by line count alone.

## Correctness and evidence gaps to address first

These live correctness and evidence gaps should be handled before structural simplification.

### C1. Idle Watch can miss a newly started run indefinitely

Severity: high

An idle recovery can capture a timestamp after `startRun()` captures the run's `startedAt` but before the run commits and publishes its starting/active event. The dashboard then classifies the valid new-run event as older than the recovery snapshot. Because idle Watch does not poll, it has no guaranteed convergence path.

Recommended correction: when a coherent nonterminal new-run event cannot safely establish local scope, request one coalesced authoritative recovery instead of discarding it. Add the deterministic `start t0 -> idle recovery t1 -> commit/event t2` reducer regression. Do not broadly loosen stale-run protection.

### C2. Terminal finalization can hold a PostgreSQL fence during an unbounded Redis wait

Severity: high

The terminal Redis inventory read correctly occurs inside the terminal database fence to avoid a known pre-fence race, but the underlying Redis command has no bound. A stalled call can retain the transaction and advisory lock indefinitely.

Recommended correction: keep the coherent in-fence read, add a bounded/cancellable Redis operation, and verify that timeout releases the transaction and lock.

### C3. The advertised root type-check gate is red

Severity: medium

Production package checks pass, but the root `pnpm type-check` fails in test-source checking with 20 reported errors. A required gate that is predictably red cannot distinguish new failures from accepted debt.

Recommended correction: repair the narrow test typing defects and require future records to report the full root command result.

### C4. Some follow-up verification claims are not reproducible

The audits identified unchecked acceptance boxes, a promised transition-race test that is not present in the documented form, no automated Watch-plus-Preview regression, a reference to an untracked screenshot, and one incorrect remediation command name.

Recommended correction: reconcile the issue records with actual tests and commands. Do not add replacement process machinery; make the existing evidence accurate.

## Consolidated findings

### F1. Coordination exceeds the accepted topology

Impact: high; simplification risk: medium

The repository contains Redis-backed deployment-wide worker admission, dashboard-recovery accounting, and admin-login limiting/edge attestation, while the accepted topology has one local reference runtime and excludes horizontal coordination. It also contains several advisory-lock mechanisms, promise-chain mutexes, rate limiters, and batch gates whose combined authority is difficult to reason about.

Recommended simplification:

- use the worker/BullMQ concurrency ceiling plus a bounded process-local, per-run admission boundary;
- retain SSE connection caps, deadlines, cancellation, and a small local recovery concurrency/budget;
- retain HMAC session integrity, HttpOnly/strict cookie behavior, constant-time secret comparison, exact Origin/CSRF protection, and uniform login failures;
- replace the Redis login limiter with a bounded local limiter only if the runtime is explicitly single-instance; and
- defer replica leases and edge-attestation coordination until a hosted scaling/routing model is accepted.

Multi-replica operation not intended, and the code and scope should not silently support different products.

### F2. Undefined compatibility policy leaks legacy handling into normal paths

Impact: high; simplification risk: low if all retained data is disposable, high otherwise

The repository is pre-release and has described local data as disposable, but normal runtime code preserves historical database JSON and load-journal shapes. Fifteen migrations and their generated snapshots, multiple legacy normalizers, compatibility reads across finalization and maintenance, and a 99-line policy hydration migration all reflect an unstated promise to retain old local volumes.

The public runtime policy also stores environment-owned hard caps beside mutable policy and then overlays the environment values at read time. This duplicates authority and contributed directly to compatibility work.

Recommended decision:

As no external environment must retain data, provide one intentional wipe, squash the pre-release migration chain, remove legacy journal/JSON normalizers, persist only mutable policy, and merge environment caps at the API DTO boundary.

Generated migration metadata is not itself a design flaw. Retaining an unnecessary pre-release history is the problem.

### F3. Transport, outcome, and vocabulary models duplicate the same facts

Impact: high; simplification risk: medium

Traffic completion repeats transport counts across `httpSummary`, `trafficDeliverySummary`, and `apiRequestLifecycleSummary`, then validates that the copies agree. Producers, persistence, redelivery, compatibility code, and tests all pay for the duplication. The `apiRequestLifecycleSummary` name is especially misleading because its evidence comes from the k6 client rather than API-server instrumentation.

The same pattern appears in overlapping buy-outcome vocabularies, mechanically duplicated error codes, single-value enums/tables, repeated snapshot mappers, and database triggers that revalidate attribution already encoded elsewhere.

Keep these equations and make them canonical:

```text
planned = started + unstarted
started = completed + interrupted
```

Recommended simplification:

- define one canonical transport-attempt evidence object;
- keep HTTP response/outcome/timing as a projection that does not copy transport totals;
- derive delivery-quality and dashboard labels from canonical transport evidence plus durable business counts;
- remove the supposed API lifecycle copy unless server-side receipt/completion evidence is added;
- converge overlapping outcome/error vocabulary around distinctions that change behavior or UI; and
- prefer ordinary keys, foreign keys, and row-local checks over bidirectional trigger validation where they express the same invariant.

Do this after the compatibility decision so legacy fields can be removed rather than translated yet again.

### F4. The recovery mesh is larger than the failure model warrants

Impact: high; simplification risk: medium/high

The Redis reservation core is surrounded by pending-persistence indexes and Lua scripts, a mirrored PostgreSQL table, a reconciler, a remediation service, a target-specific CLI/runbook, completion-enrichment repair, finalization polling, worker scanners, failed-set ingestion, and terminal recovery sweeps. Several follow-up bugs occurred inside this machinery.

Some recovery remains essential. A Redis hold whose PostgreSQL write was interrupted is a real handoff failure in the project's central path, and durable PostgreSQL-to-BullMQ dispatch is part of the resilience claim. The current number of independently scheduled repair authorities is not automatically necessary.

Accepted direction:

- retain one bounded, observable, idempotent, run-scoped repair path for interrupted Redis-to-PostgreSQL reservation persistence, with one owner for discovery, retry scheduling, and resolution;
- retain durable queued-order dispatch recovery and terminal finalization;
- remove the incident-specific remediation service, hard-coded script, exports, tests, and runbook after the two recorded cases are explicitly resolved or abandoned and their evidence archived;
- remove global indexes, classifications, reconcilers, and schedulers that the single repair path does not require; and
- keep reset as an explicit operator escape hatch for an unrecoverable run, not the normal recovery strategy.

### F5. Dashboard delivery mixes incremental events with authoritative projection recovery

Impact: high; simplification risk: high

The system does not publish one SSE event for every raw API request. Raw load observations are already reduced into one-second request-rate, mean-latency, and failure-rate samples before they reach the API. Inventory and queue publishers coalesce dirty scopes, and business outcomes are published as cumulative replacement snapshots on a short cadence. These are appropriate server-side projection boundaries and should be retained.

The remaining problem is that the SSE fan-out forwards every canonical dashboard event it receives as a separate frame without transport-level coalescing, while producers use several granularities. Aggregate samples, replacement snapshots, lifecycle updates, and individual advisory order-status/lag events share the stream. The browser incrementally reduces these messages but treats the HTTP recovery snapshot as authoritative. Supporting those two update mechanisms requires scope classification, event-time and per-metric watermarks, lifecycle ranks, deduplication, bounded buffers, recovery-window coalescing, replay, and terminal exceptions. Repeated tasks and Issues 05/09 repaired interactions in this model, while C1 shows a remaining race.

This is not a conflict between two equally authoritative truth sources: recovery is already intended to be authoritative and SSE advisory. It is a mixed client-update protocol whose event volume and state-reconstruction logic are more complicated than the dashboard requires. Dashboard delivery should scale primarily with the number of active projection scopes and the chosen display cadence, not with raw request or order volume.

Accepted target:

- make one server-owned dashboard projection per run/offer scope the authoritative UI model;
- use the same projection contract and revision semantics for live delivery and HTTP recovery;
- publish small full-replacement projections over SSE at a measured, bounded cadence, starting from the existing sub-second/one-second aggregation windows rather than exposing raw occurrences;
- give every projection a scope identifier and monotonically increasing revision so the browser only replaces its state with a newer complete projection;
- coalesce by both time and work: publish by a maximum-latency deadline, publish sooner after a meaningful work threshold where useful, and force an immediate projection publication for lifecycle or terminal transitions;
- retain the existing one-second load aggregation and coalesced inventory, queue, and business-outcome publication rather than rebuilding them;
- remove individual per-order status/lag messages as a separate realtime state protocol; if the demo retains a recent-activity panel, carry an explicitly sampled/rate-limited and bounded collection in the same projection, with durable order evidence available through a focused diagnostic read;
- under backpressure, retain only the latest pending replaceable projection per scope instead of queueing obsolete intermediate projections; and
- retain connection caps, heartbeat, cancellation, and bounded fan-out.

If measurement shows that the complete projection is too large to send at the desired cadence, use a small revisioned invalidation event followed by an atomic snapshot read instead. Select that as the normal protocol rather than maintaining both snapshot streaming and incremental state reconstruction. Do not add a retained event-replay system: missed advisory updates should be repaired by reading the latest projection.

This must be staged. First pin current gold-signal, terminal-convergence, new-run, reconnect, and slow-consumer behavior and measure message volume under representative load. Then introduce the revisioned projection, switch the browser to atomic replacement, verify that quiet periods cannot strand the final update, and only then delete incremental reducers, per-metric watermarks, recovery buffers, and replay categories. Deleting those guards while the current mixed protocol remains would reintroduce stale-event failures.

The completed design should satisfy these acceptance properties:

- ordinary dashboard message volume is bounded by active scopes and publication cadence rather than raw request count;
- the browser's state is the highest complete revision it has accepted, without reconstructing authoritative totals from advisory events;
- terminal and lifecycle changes converge immediately even when traffic becomes quiet;
- reconnect and dropped-message recovery require one current projection read, not event replay; and
- detailed operational evidence remains durable and queryable without being broadcast to every dashboard client.

### F6. Test reset and demo cleanup became generalized infrastructure products

Impact: medium/high; simplification risk: medium

The destructive reset fix correctly added fail-closed target protection, but it also created a catalog fingerprinting system covering schema objects, migration state, filesystem and PostgreSQL locks, and a fast truncate-versus-rebuild decision. Maintenance cleanup similarly added replica-aware queue-pause ownership, convergence rescans, and durable teardown receipts.

Recommended simplification:

- keep exact database allowlisting, `NODE_ENV=test`, port checks, connected-database identity verification, and one reliable serialization lock;
- measure unconditional schema rebuild via reviewed migrations and prefer it if acceptable;
- retain terminal/generated ownership checks and retry-visible cleanup failures;
- in the single API maintenance topology, pause queues in `try/finally`, remove exact-run attributable resources, and transactionally delete the durable graph; and
- remove cross-replica pause ownership and schema fingerprinting only after the simpler workflows are measured and proven deterministic.

Destructive safety must not be traded for speed or line-count reduction.

### F7. Oversized owners and production-impossible optional paths obscure the design

Impact: medium/high; simplification risk: low to high by boundary

`DemoRunService`, `K6Runner`, API startup, finalization, and maintenance each own multiple unrelated responsibilities. Several interfaces also expose optional fallbacks that production never constructs, forcing every reader and test to understand modes that do not exist in the runtime.

Recommended cleanup:

- make production-required recovery operation factories, execution stores, and durable claim/failure/resolution methods required;
- use in-memory fakes behind the same required interfaces in tests;
- extract Redis metric persistence and the load HTTP gateway from `DemoRunService`;
- split preset/policy administration from lifecycle/completion without creating a generic service framework;
- extract per-operation resource construction and readiness implementations from `apps/api/src/index.ts` while keeping composition there;
- centralize only truly identical snapshot/projection helpers; and
- represent K6 process lifecycle explicitly while keeping completion delivery state separate.

The aim is smaller ownership boundaries, not a new ports-and-adapters lattice.

### F8. The mock ERP has a production-grade persistence boundary not required by its brief

Impact: medium/high; simplification risk: medium

The mock ERP is intended to simulate latency, capacity, and failure. It currently depends on PostgreSQL for an advisory-locked confirmation ledger and cannot start without the database, even though worker-side `erp_attempts` already owns the durable idempotent business boundary. The database dependency then requires its own readiness behavior and schema.

Accepted decision: use the existing in-memory confirmation ledger in the mock ERP and keep durable idempotency/recovery in the worker. Remove the mock ERP database requirement, ledger table, advisory lock, and database readiness probe together. Do this only after a focused test proves that worker retry/replay cannot create a second durable business outcome when the mock ERP restarts. Restart-stable persistence inside the simulated external ERP is outside the accepted project scope and may be reintroduced only if it is later promoted to an explicit demonstration requirement.

### F9. Load-process supervision contains overlapping recovery paths

Impact: medium; simplification risk: medium/high

The load wrapper contains extensive mutable process state, a multi-stage termination/reap protocol, in-process completion retries, a durable fsynced completion journal, legacy journal migrations, and multiple outcome vocabularies. Process ownership and completion redelivery are important because the wrapper is a separate reference-runtime component, but two retry authorities and pre-release journal archaeology are not.

Accepted direction:

- retain script generation, spawn, summary parsing, bounded cancellation/reaping, and one durable completion-redelivery authority;
- remove the overlapping in-process delivery loop once the durable path owns retries end to end;
- delete retired journal-field migrations under the disposable-data policy;
- reduce execution lifecycle to explicit states and keep delivery state separate; and
- test observable cancellation, reaping, and eventual completion delivery without pinning every internal timer or signal step.

### F10. Tests, tooling, documentation, and dead code form a secondary product surface

Impact: medium; simplification risk: low to medium

The repository has overlapping smoke/health/load/SSE/soak scripts, tests of those scripts, meta-tests for the package command graph and Compose text, many root commands and layers of indirection, oversized test files, dead placeholder scripts, uncalled dashboard/admin paths, and documentation governance beyond the needs of a portfolio reference runtime.

Two constraints are accepted. Do not use a numeric test-line target as an acceptance criterion, and retain `docs/scope_and_caveats.md` with its current product classifications as the single scope/non-goals authority.

Recommended cleanup within those constraints:

- delete confirmed dead routes, predicates, fetches, and placeholder scripts;
- converge on one runtime smoke workflow containing health, SSE, and one representative load scenario;
- keep composition and 10k characterization as explicit opt-in lanes, as required by repository guidance;
- preserve the cheapest authoritative coverage for each required behavior, delete tests with the mechanisms they pin, remove redundant cross-layer cases, and simplify oversized fixtures and harnesses;
- split large suites only when that improves ownership or navigation; splitting alone does not count as simplification; and
- remove owner/status/review metadata, expiry bureaucracy, duplicated rationale, and same-change governance rules from `docs/scope_and_caveats.md`.

Do not target an arbitrary test-line count. Test volume should fall because states and mechanisms were removed, not because assertions were discarded ahead of the design change.

## Resolved divergent opinions and decisions

The following record disagreements or materially different levels of aggressiveness and the decisions that resolve them. The provenance labels are retained so the competing judgments remain clear.

The auditors differed in their overall assessment, so the decisions below evaluate each mechanism against required outcomes and accepted topology rather than adopting either audit's general verdict.

### D1. Pending-persistence recovery: keep one automatic repair path

Status: resolved — adopt the simplified middle-ground design below.

The GPT-5.6-sol ultra audit treats reconciliation of Redis holds interrupted before PostgreSQL persistence as core justified complexity. The Kimi K3 max audit recommends removing much of the pending-persistence organism and allowing terminal orphan cases to be reset.

Decision: retain automatic recovery of Redis reservations whose PostgreSQL persistence was interrupted, but implement it through one bounded, observable, idempotent, run-scoped repair path with one clear owner. Remove global indexes, classifications, additional reconcilers, and schedulers that are not required by that path. Delete the incident-specific remediation subsystem after the recorded cases are explicitly resolved or abandoned and their evidence is archived. Reset remains an explicit operator escape hatch for an unrecoverable run, not the normal correctness strategy.

The happy-path product behavior does not change. After a crash in the Redis-to-PostgreSQL handoff, the runtime should heal automatically instead of silently stranding inventory, presenting unexplained totals, or requiring the user to repeat the demo. This preserves the resilience claim without retaining several overlapping recovery authorities.

The replacement is complete only when:

- an interrupted handoff eventually produces the intended durable record or a visible unresolved failure within a bounded recovery window;
- retrying repair cannot duplicate a business record or apply the inventory decision again;
- run finalization cannot silently report success while a pending-persistence case remains unresolved;
- operators can identify the affected run and the remaining repair state; and
- exactly one component owns discovery, retry scheduling, and resolution of this failure class.

### D2. Mock ERP persistence: use the in-memory confirmation ledger

Status: resolved — adopt the narrower mock ERP design below.

The GPT-5.6-sol ultra audit classifies the durable ERP confirmation/idempotency boundary as justified and says to keep the mock ERP database readiness fix. The Kimi K3 max audit argues that worker-side `erp_attempts` already owns exact-once durability and recommends using the mock ERP's existing in-memory ledger.

Decision: remove PostgreSQL from the mock ERP and use its existing in-memory confirmation ledger. Keep durable business idempotency, accepted-result recovery, and replay protection in the worker's `erp_attempts` boundary. Remove the mock ERP ledger table, advisory lock, database client and configuration, database readiness probe, and mechanism-specific tests and documentation together. Do not retain a dormant PostgreSQL implementation or fallback mode.

The mock ERP exists to simulate latency, TPS limits, and failures. Restart-stable persistence inside that simulated external system is not part of the accepted demonstration, while keeping it creates another database schema, readiness dependency, locking protocol, and idempotency authority. A mock ERP restart may forget its simulated confirmation history; the worker must still prevent that infrastructure detail from creating a second durable business outcome.

The replacement is complete only when:

- the mock ERP starts and reports readiness without PostgreSQL;
- latency, capacity limiting, configured failures, and in-process idempotent replay retain their current observable behavior;
- a focused worker retry/replay test proves that restarting the mock ERP cannot create a second durable business outcome for the same accepted order;
- worker recovery still converges an accepted ERP result after interruption; and
- no mock-ERP database schema, advisory lock, configuration, readiness code, or production-impossible fallback remains.

Reintroduce durable persistence inside the mock ERP only if restart-stable external-ERP idempotency is later added as an explicit project requirement, with its own demonstrated behavior and ownership boundary.

### D3. Dashboard realtime state: adopt one versioned projection

Status: resolved — replace the mixed update protocol before removing its safeguards.

The GPT-5.6-sol ultra audit recommends a staged redesign and warns that deleting watermarks from the current mixed update protocol will reintroduce regressions. The Kimi K3 max audit recommends a much simpler latest-event-wins model plus authoritative rereads.

Decision: adopt the smaller target through the staged migration method. Introduce one server-owned, revisioned dashboard projection shared by live delivery and recovery, migrate the browser to atomic replacement, and only then delete the obsolete watermarks, dedupe, buffering, replay, and incremental reducers. Do not simplify the current reducer in isolation.

Keep the replacement small: one projection contract, one monotonic revision, one coalescing policy, and focused boundary tests—no retained event-replay system or second state protocol.

### D4. Database defense-in-depth: keep a small declarative invariant core

Status: resolved — retain required structural invariants and remove redundant procedural validation.

The GPT-5.6-sol ultra audit keeps row-local lifecycle constraints and suggests replacing trigger mazes with keys where equivalent. The Kimi K3 max audit characterizes most triggers and repeated attribution validation as defense against the repository itself and keeps only a small invariant core.

Decision: keep database constraints that enforce required invariants regardless of writer and remain cheap to understand: primary and foreign keys, uniqueness, the single-nonterminal-run invariant, and basic row-local quantity, window, and state checks. Express ownership and attribution through composite keys or foreign keys wherever those declarative constraints are sufficient. Remove triggers that duplicate service validation, re-query relationships already encoded by keys, or defend only against production-impossible writers.

Apply this rule to each existing procedural constraint during schema simplification: retain a trigger only when it protects a required invariant that cannot be expressed clearly with a key or row-local check and cannot safely belong to the single application owner. Do not preserve trigger machinery merely as generic defense-in-depth, and do not delete the invariant core categorically.

### D5. Load-process lifecycle: keep one bounded owner and one durable completion path

Status: resolved — preserve the user-visible cancellation and completion guarantees with one mechanism each.

The GPT-5.6-sol ultra audit treats load-process cancellation/reaping and durable completion redelivery as justified. The Kimi K3 max audit emphasizes that the runner and its tests pin an oversized signal/retry protocol.

Decision: retain one owner for the k6 child process from launch through exit, including a bounded cancellation procedure that escalates when graceful stopping fails and always observes and cleans up the exited child. Retain one durable redelivery path for the final completion result, with idempotent acceptance so retrying cannot apply the terminal outcome twice. Remove duplicate retry authorities, legacy completion formats, and tests that require incidental signal or retry sequencing.

This protects behavior visible at the product boundary. Cancelling a run must stop its traffic promptly so it cannot continue consuming inventory in the background, and a completed, cancelled, or failed run must eventually reach the correct terminal dashboard state even if final-result delivery is temporarily interrupted. More than one lifecycle or redelivery authority adds races and maintenance cost without improving those guarantees.

The simplification is complete only when:

- cancellation stops traffic within a defined bound and the k6 child cannot remain running or unreaped;
- graceful-stop failure follows one bounded escalation path;
- one authoritative completion result is eventually accepted after transient delivery failure or restart;
- completion retries are idempotent and cannot create conflicting terminal outcomes;
- exactly one component owns child-process lifecycle and exactly one path owns durable completion redelivery; and
- tests assert these externally observable guarantees without pinning an exact internal signal or retry sequence.

### D6. Test suite size: simplify by evidence, not a line quota

Status: resolved — do not impose a numeric test-line quota; deliberately reduce the suite by removing redundant coverage and tests for deleted mechanisms.

The GPT-5.6-sol ultra audit recommends retaining assertions while splitting oversized suites and deleting tests only with simplified mechanisms. The Kimi K3 max audit proposes reducing test code toward 20,000-25,000 lines.

Decision: do not use 20,000-25,000 lines, or any other numeric size target, as an acceptance criterion. Line count is a useful warning signal but is not a measure of behavioral confidence and would reward compressed fixtures or indiscriminate assertion deletion.

The current suite is nevertheless a maintainability surface that requires deliberate simplification. Preserve the cheapest authoritative test for each required behavior, including no-oversell, idempotent replay, durable queue handoff, ERP backoff/circuit breaking, run accounting, gold-signal projection, destructive-target guards, and observed P0/regression cases. Retain coverage at multiple layers only when each layer protects a distinct contract or failure boundary. Delete internal-mechanism tests with the mechanisms they pin, remove redundant cross-layer cases even when production code is otherwise unchanged, and simplify oversized fixtures and harnesses where doing so preserves the same evidence. Splitting a large suite is useful for ownership and navigation but does not by itself count as simplification.

Judge the result by required guarantees remaining covered, required gates staying green, suite runtime and reliability, and reduced maintenance burden. The suite should become materially smaller through those decisions, but no specific final line count is promised. Do not reopen the size-target debate merely because the suite is above or below a proposed number; revisit this decision only if a concrete delivery constraint requires a new testing tradeoff.

### D7. Scope documentation: keep one concise authoritative page

Status: resolved — retain `docs/scope_and_caveats.md` while removing its administrative metadata.

The GPT-5.6-sol ultra audit says the authoritative non-goals index was useful and should remain short. The Kimi K3 max audit recommends folding it into the README and removing its governance taxonomy.

Decision: keep `docs/scope_and_caveats.md` as the single discoverable authority for the accepted project boundary, intentional non-goals, current caveats, and genuinely deferred product decisions. Preserve the existing classifications during this simplification; adding, removing, or reclassifying scope requires an explicit product decision and is not documentation cleanup.

Remove owner fields, status taxonomy, last-reviewed dates, review/expiry triggers, periodic-review obligations, and same-change governance rules. Keep concise evidence links where they help readers verify a classification, but link to domain documents for technical rationale rather than duplicating their explanations. Do not move the page into the README merely to delete a small file.

The cleanup is complete when the repository has one short scope/non-goals authority, its product classifications are unchanged unless separately decided, and maintaining it no longer requires administrative ownership or review metadata.

## What should remain

The following capabilities are aligned with the project goal and should survive simplification, though their implementations may be made smaller:

- atomic, run-scoped Redis reservation with fail-closed eligibility and no overselling;
- deterministic idempotent replay semantics;
- durable business records and one automatic, bounded, run-scoped repair path for interrupted reservation persistence;
- durable PostgreSQL-to-BullMQ dispatch recovery;
- worker backoff, circuit breaking, durable ERP-attempt/idempotency evidence, and accepted-result recovery;
- mock ERP latency, capacity limiting, configured failures, and in-process idempotency without a database dependency;
- a small declarative database invariant core, including the single-nonterminal-run invariant and understandable row-local constraints;
- separation of traffic completion from asynchronous business finalization;
- API-owned error and correlation vocabulary, reduced to meaningful distinctions;
- one revisioned dashboard projection shared by bounded live SSE delivery and HTTP recovery, with heartbeat, cancellation, and connection caps;
- a focused durable per-order status/lag diagnostic, without implying a storefront;
- protected public/admin boundaries with proportionate session, cookie, Origin, and secret-comparison controls;
- the containerized k6 boundary, bounded child-process ownership, and one durable completion-redelivery path;
- independent non-root images;
- behavior-focused tests for the core guarantees and observed regressions, with composition/10k validation left opt-in and no numeric line quota; and
- one concise authoritative `docs/scope_and_caveats.md` without administrative review metadata.

## Prioritized simplification plan

### Phase 0: establish a trusted baseline

1. Fix the idle Watch new-run convergence race.
2. Bound the in-fence Redis read and prove lock release.
3. Repair the 20 test-source type errors.
4. Correct inaccurate issue records and missing focused regressions.

This phase may add a small amount of code/tests. It prevents later deletions from concealing existing defects.

### Phase 1: remove unambiguous residue

1. Explicitly resolve or abandon the two hard-coded remediation cases, archive the outcome, and delete the remediation service, CLI, runbook, exports, and tests.
2. Remove confirmed dead dashboard/admin routes, predicates, unconsumed fetches, and placeholder scripts.
3. Remove production-impossible optional branches and use required interfaces with test fakes.
4. Deduplicate exact projection/status helpers without introducing a generic helper framework.

### Phase 2: make scope decisions that unlock deletion

1. Declare whether any external database volume or load journal must survive upgrades.
2. Enforce the single-instance topology or explicitly accept a multi-replica hosted scope.
3. Decide whether per-order realtime panels materially contribute to the demo.

Record any accepted scope changes briefly in `docs/scope_and_caveats.md`. Do not build a new governance process around them.

### Phase 3: collapse duplicated authorities and facts

1. Squash pre-release migrations and remove legacy normalizers if compatibility is not required.
2. Separate mutable runtime policy from environment hard caps.
3. Create one canonical transport accounting object and remove duplicate persisted/wire summaries.
4. Converge outcome/error vocabulary and replace redundant database triggers with keys/checks where possible.

### Phase 4: reduce coordination and recovery machinery

1. Replace replica-aware worker, recovery, login, and cleanup coordination with bounded mechanisms appropriate to the accepted topology.
2. Replace the pending-persistence recovery mesh with one bounded, observable, idempotent, run-scoped owner while retaining queue-dispatch and finalization guarantees.
3. Replace schema fingerprinting with a measured deterministic reset.
4. Add the focused worker restart/replay regression, then remove the mock ERP ledger table, advisory lock, database client/configuration, and database readiness boundary together.

### Phase 5: repair ownership boundaries

1. Split run lifecycle/completion, metrics, traffic execution, preset/policy administration, and maintenance into focused owners.
2. Extract resource-operation lifecycle and readiness implementations from API composition.
3. Reduce K6 execution to one bounded child-process owner and one durable, idempotent completion-redelivery path; remove duplicate retry authorities and legacy completion formats.
4. Reduce queue maintenance and teardown protocols to the single-authority topology.

Avoid broad rewrites. Each step should delete the replaced path in the same change.

### Phase 6: replace the dashboard update protocol

1. Pin current gold-signal, terminal convergence, reconnect, and new-run behavior at public boundaries.
2. Introduce one revisioned, coalesced projection contract shared by live delivery and recovery.
3. Migrate consumers to atomic projection replacement and remove mixed delta/recovery state.
4. Delete obsolete watermarks, replay categories, per-order realtime fan-out, and their mechanism-specific tests; if Phase 2 retains recent activity, carry only a sampled/rate-limited bounded collection in the shared projection.

### Phase 7: prune the secondary surface

1. Consolidate smoke/health/SSE/load verification commands.
2. Delete mechanism-specific and redundant cross-layer tests while retaining the cheapest authoritative coverage for each required behavior.
3. Simplify oversized fixtures and harnesses; split large suites only where that improves ownership or navigation, and judge the result by coverage, runtime, reliability, and maintenance burden rather than line count.
4. Keep `docs/scope_and_caveats.md` as the concise authoritative scope/non-goals page, preserve its classifications, and remove its administrative ownership, status, review, expiry, and same-change metadata.

Every phase after Phase 0 should show net deletion or a measurable reduction in states, authorities, or supported modes. A cleanup phase should not add a new abstraction framework while leaving the old path in place.

## Backlog and follow-up disposition

The evidence supports an outcome-level triage:

| Disposition | Outcomes |
| --- | --- |
| Keep | Atomic reservation; no-oversell; idempotent replay; automatic recovery of interrupted Redis-to-PostgreSQL reservation persistence; single active run; durable queue handoff; worker backoff/circuit breaker; durable accepted business results; traffic/business completion separation; mock ERP latency/capacity/failure simulation; public/admin boundary; non-root/containerized runtime; one concise scope authority; core gold-signal and 10k opt-in validation |
| Keep but simplify | Pending-persistence repair implementation; worker admission; dashboard projection and recovery admission; admin login limiting; runtime policy; test reset; generated-run cleanup; K6 process ownership and completion redelivery; transport accounting; per-order lag evidence; database lifecycle constraints; migration history; canonical enum vocabulary; test suite and harnesses |
| Remove/defer | Cross-replica leases and attestation without a hosted topology; pre-release legacy normalizers without a compatibility promise; duplicate transport summaries; one-time incident remediation; dead routes/scripts/fetches; separate advisory per-order realtime fan-out; mock ERP PostgreSQL persistence; redundant procedural database validation; duplicate K6 retry authorities and legacy completion formats; scope-document administration metadata |
| Low priority | Small self-describing audit flags, unused retention-size changes, settled vocabulary renames, and planning records with little runtime cost |

All nine follow-up issues described real or plausible behavior under the machinery that existed. Their fixes should not be blindly reverted. Issue 07's accounting correction is proportionate and should remain. Issues 01, 03, 05, and 09 protect observed P0/public-demo behavior. Issues 04, 06, and 08 also reveal where a scope decision can remove the subsystem that made the fix necessary. Issue 02's cancellation remains useful, but its resource lifecycle should move out of API composition and be unified.

## Guidance for future autonomous audit waves

The bloat is a process outcome as much as a coding outcome. Future tasks should be required to state:

1. the observed or explicitly required demo behavior that fails without the change;
2. the accepted topology and failure consequence used to set severity;
3. why the proposed mechanism is the smallest authority that closes the gap;
4. which old path, state, or test will be deleted when the new path lands; and
5. the boundary-level test that proves the outcome without pinning incidental internals.

Do not import a pattern from a donor branch because it scored well in isolation. Re-derive its necessity from the project goal and current non-goals. Budget a deletion pass after every autonomous fix wave and treat net-new states, authorities, compatibility modes, and background loops as costs that require explicit justification.

## Final recommendation

Keep the durability core and simplify the control plane. The desired end state has:

- one accepted runtime topology;
- one compatibility policy;
- one canonical transport/accounting model;
- one authoritative dashboard projection model;
- one bounded owner for each repairable handoff, including interrupted reservation persistence;
- a small declarative database invariant core without redundant procedural validation;
- one bounded k6 child-process owner and one durable completion-redelivery path;
- a mock ERP that simulates external behavior without owning a second durable database boundary;
- required production interfaces without fallback modes that production never uses;
- focused services around lifecycle, policy, metrics, traffic execution, and maintenance;
- a behavior-focused test suite simplified without a numeric line quota; and
- one concise authoritative `docs/scope_and_caveats.md` without administrative governance metadata.

That direction preserves the project's credible resilience story while removing the production-grade coordination, compatibility archaeology, mixed dashboard update protocols, and process surface that currently make the code harder to maintain than the demo requires.
