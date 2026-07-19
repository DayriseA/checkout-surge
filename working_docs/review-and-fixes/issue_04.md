# Issue 04 — Terminal runs can strand Redis pending-persistence records permanently

## Classification

- Priority: P1
- Status: Fix implemented and regression-tested; live stale-record remediation pending
- Affected path: Accepted inventory durability, reconciliation, run finalization, subsequent restarts
- Related trigger: `issue_01.md`

## Resolution status (2026-07-19)

Terminal pending-persistence recovery now converges without reopening admission:

- The reconciler classifies each pre-admitted hold from exact durable reservation/order evidence while holding the run's shared terminal-transition lock. A matching durable order is promoted through the deterministic downstream job path; a hold with no durable order is definitively reversed; conflicting or unreadable evidence remains retryable and is never guessed away.
- Reconciliation bookkeeping is durable-first, and Redis cleanup keeps the per-sale pending ZSET, pending hash, and global pending index consistent. Deferred records are rescored in both indexes so one blocked record cannot repeatedly starve later work.
- The API periodically reconciles the global pending index in addition to finalizer-triggered bounded pages. Fresh reconciler and finalizer instances are covered to prove restart convergence for a backlog larger than the default 100-record page.
- Terminal summary preparation now runs behind the exclusive terminal fence. It rereads durable outcomes and Redis inventory through the locked workflow, refuses to terminalize while pending persistence remains, fails closed on malformed traffic-boundary evidence, and refuses a summary when Redis and durable sold-out totals disagree.
- Timeout classification uses persisted traffic-completion evidence rather than process-local reconciliation history, so a restart does not erase the reason a run remained blocked.
- `pnpm remediate:terminal-pending-persistence` provides a dry-run-first audit for the two observed stale targets. It checks run ownership, exact global-index membership, companion hold state, durable evidence, and idempotency records before `--apply`; unsafe or truncated evidence blocks mutation. A repeated successful apply is a no-op.
- Architecture, inventory, runtime-topology, local-development, entity, metrics-streaming, and remediation documentation now describe the terminal fence, convergence invariant, summary evidence, and safe operational sequence.

Coverage added or updated:

- A real Redis/PostgreSQL restart regression creates 125 pending records, processes the first bounded page, uses fresh service instances for the remainder, and verifies 125 unique deterministic enqueues plus empty per-sale and global pending structures.
- Terminal durable-order promotion, Redis-only reversal, repeated reconciliation, finalization races, malformed boundary evidence, sold-out disagreement, and a max-one-connection pre-fence commit are covered.
- Remediation coverage exercises mixed durable/reversal records, exact global-index anomalies, malformed or mismatched idempotency evidence, successful apply, inventory restoration exactly once, and repeated no-op execution.
- Database integration coverage verifies atomic deferral rescoring across the per-sale and global indexes.

Verification completed:

- Four focused API suites passed 80 tests, including the real restart, fencing, and remediation regressions.
- The targeted database integration test passed.
- All 11 production type-check tasks and the repository test-source type-check passed.
- Repository lint checked 411 files successfully, and staged diff validation passed.
- The prohibited composition and characterization suites were not run.

The live remediation command has not been run against the audited reference data. The documented procedure keeps the API stopped while deploying the corrected code, running dry-run and apply audits, confirming a clean repeat dry-run, and only then restarting background reconciliation.

## Issue observed

Two failed terminal runs currently retain pending-persistence state in the audited reference runtime:

- run `8da8a364-00ed-4732-8e03-399e17b9db4d`, sale `e38749c5-3550-4dee-977a-8718374adec1`: 49 pending ZSET entries and 49 pending hashes;
- run `598023fd-b68b-46c2-bf24-d13d0096a39f`, sale `5bbdecb8-f7c9-4358-8d96-4e66a60c3723`: 49 pending ZSET entries and 49 pending hashes;
- global `inventory:pending-persistence-index`: 98 entries in total.

Both corresponding runs are already terminal. PostgreSQL has no pending rows for these records, and every API restart logs that reconciliation is blocked because the run is terminal and the records remain retryable.

For the fresh audited Preview run, Redis initially held 250 accepted pending records. After the API restart, one record had persisted before the failure and bounded reconciliation passes processed 200 more. Finalization then marked the run failed while 49 records remained. Those records can no longer enter the reconciliation callback, so the state does not converge.

This violates the core inventory narrative: accepted holds must become durable business records or be definitively reversed. A terminal label must not freeze an ambiguous accepted state indefinitely.

## How to reproduce

1. Create more pending-persistence records for a run than one reconciler batch can process (the current default batch maximum is 100).
2. Allow run finalization to reach its timeout/failure path while records remain.
3. Let another reconciliation interval run, or restart the API.
4. Inspect the per-sale pending ZSET/hash keys and the global pending index.

The run is rejected as terminal before individual pending records reach the reconciliation/compensation logic, and the keys survive every retry.

## Identified cause

The finalizer and reconciler use incompatible terminal-state assumptions:

- the pending reconciler reads at most 100 records per bounded pass (`apps/api/src/services/pending-persistence-reconciler.ts`);
- record-level reconciliation contains logic to persist/promote an admitted hold or reverse/compensate it;
- however, the whole record operation is wrapped by run admission locking;
- PostgreSQL admission rejects a terminal run before invoking the record callback, so record-level terminal compensation is unreachable for leftovers;
- the finalizer can transition a run to failed after its drain timeout even when pending-persistence work still exists (`apps/api/src/services/demo-run-finalization-service.ts`).

The result is a one-way gate: finalization is allowed to overtake bounded recovery, but recovery is not allowed to clean up after finalization.

## Recommended actions

1. Define the terminalization invariant explicitly: before a run becomes terminal, every pre-admitted Redis hold must either have a durable reservation/order and deterministic downstream disposition, or be idempotently reversed.
2. Change finalization to drain all pending pages before the terminal transition, or atomically hand remaining records to a terminal-safe cleanup state that the reconciler is authorized to process. Do not silently ignore a partial page.
3. Let terminal cleanup classify records that were admitted before the terminal fence without reopening admission for new buys.
4. Make persist/promote and reversal paths idempotent so repeated reconciliation, process restart, or a race with the last normal pass is safe.
5. Keep the per-sale pending key, hash records, and global index consistent as one logical cleanup operation.
6. After deploying the corrected invariant, provide a one-time, auditable remediation for the 98 existing stale records. Classify each record from durable PostgreSQL/Redis evidence before deleting or reversing it; do not blindly delete the keys.

## Acceptance criteria

- [x] A run with more than 100 pending records can time out/restart and still converge every record. The 125-record real-infrastructure regression completes across fresh reconciler and finalizer instances.
- [x] After convergence, the per-sale pending ZSET, pending hashes, and global pending index contain no entries for the terminal run. Restart and remediation coverage assert all three structures are empty.
- [x] Each accepted hold is represented by the intended durable reservation/order path or by one definitive inventory reversal. Terminal cleanup requires exact durable evidence before choosing either disposition.
- [x] Re-running cleanup is a no-op and does not duplicate reservations, jobs, orders, or inventory. Reconciliation and remediation repeat-execution coverage verifies deterministic enqueue and exactly-once reversal behavior.
- [x] No new purchase can be admitted after the terminal fence. Cleanup uses shared terminal-safe classification for existing holds without weakening normal terminal admission rejection.
- [x] Terminal inventory and run summaries agree with the final durable outcomes. Final summary preparation uses fresh locked reads and fails closed on pending work, malformed evidence, or Redis/durable sold-out disagreement.
- [x] API restart no longer leaves terminal records indefinitely retryable. Fresh-instance coverage proves the remaining global backlog is rediscovered and converged.

## Scope guard

The goal is deterministic cleanup of existing inventory semantics. It does not require a new workflow engine or a new user-visible feature.
