# 03 — Multi-Process API

**Design:** section 3 · **Depends on:** 02, after the owner's go

## Goal

The API runs correctly as several processes on one core, so that it is no longer the first bottleneck.

## Context

- HD-51 kept one API process.
- HD-11 serializes runner operations and run starts in-process, and is correct only under the single-process contract.

## Scope

- **Inventory every single-process assumption:** runner operations, run starts and reconciliation, resets, live streams, in-process pacing or state.
- Make each of them safe across processes.
- Supersede HD-51 and update HD-11 in the decision log.
- Recalibrate the capacity values and the admission model for the new topology (`CAPACITY_*`, `docs/capacity_measurement.md`).

## Done When

- Every run kind works with several API processes in the proof environment, and the capacity is recalibrated.

## Open Points

- The number of processes, which task 02 provides.

## Working Notes

### Slice 03A — Explicit API ownership (2026-10-11)

The first implementation slice introduces three explicit API roles. `combined` remains the default and preserves the existing single-process topology. A split topology has exactly one `control` API and a fixed pool of `buyer` APIs. The proof will configure three buyer processes separately; no production or reference topology is changed in this slice.

The control API retains the existing maintenance authority rather than replacing it with distributed locking. Buyer APIs expose only health, buy, and an authenticated timing-flush endpoint. Run control, runner callbacks, admin operations, dashboard recovery, SSE, and idle activity must reach the sole control API. The two API server factories share HTTP error handling, correlation, CORS, and failure logging.

| Existing single-process assumption | Ownership in the split topology |
| --- | --- |
| Run admission and initialization, runner boot, starting-run replay | Control; the existing PostgreSQL admission lock and nonterminal uniqueness remain additional fences, not substitutes for workflow ownership |
| Runner operation queue and latest boot run ID | Control; no buyer constructs runner/Fly clients |
| Startup reconciliation, finalization polling, runner-loss monitoring | Control only |
| Explicit and automatic reset, queue maintenance, retention and teardown | Control only; existing durable fences retained |
| Idle deadline, activity reporting, countdown and stop checks | Control only; all activity/status traffic routes there |
| SSE clients, per-source/total limits, heartbeat and backpressure | Control only |
| Dashboard recovery request budgets/concurrency and projection-build coalescing | Control only |
| Redis projection dirty signals | Buyers continue publishing through Redis; control alone subscribes and builds/fans out projections |
| Stock decisions, idempotency and accepted order persistence | Shared Redis and PostgreSQL; existing atomic operations and run admission fences retained |
| Pending-persistence discovery, attempts, retry budget and direct-attempt coalescing | Control only; buyer retries use a bounded authenticated internal HTTP call outside any PostgreSQL admission lock |
| Buyer timing buffers | Local asynchronous batching remains; control flushes fixed peers before entering the terminal PostgreSQL fence |
| Buyer dirty-signal batching and queue-refresh timers | Local producer coalescing remains safe; the authoritative dashboard projection stays shared/control-owned |
| Readiness, listener backlog and graceful shutdown | Per process; buyer shutdown drains HTTP before flushing producer schedulers and closing stores/queue resources |
| Worker ERP protection and scanner state | One worker runtime remains; no worker scaling in this task |
| Traffic execution slot, pacing and completion journal | One load-orchestrator remains; callbacks reach control and buys reach the buyer pool |
| Capacity/admission constants and per-process connection pools | Not recalibrated yet; measure the final proof topology before changing capacity values |

The internal recovery endpoint authenticates with the existing control token and validates the original secured hold and idempotency key before delegating to the sole owner. It does not introduce another recovery scheduler or a generic RPC layer. The owner still reads its Redis cursor and applies its existing exact recovery rules.

Timing completeness is advisory and cannot fail business finalization. Before dispatching a newly accepted run, control captures the configured buyers' boot identities and timing-merge failure generations. Before finalization/reset captures timing evidence, it asks those peers to drain active buys for that run and flush buffered observations. These HTTP calls occur before the exclusive terminal admission fence. Missing peers, missing baseline after control restart, changed buyer boot identities, and a failure generation that increased during the run produce the existing unknown timing summary, with a warning. Control retains only the current accepted run's advisory record, justified by the one-nonterminal-run invariant; a new acceptance retires the previous completed or startup-failed run's record. Each buyer retains one monotonic failure counter, without retaining failed run IDs. A past run's merge failure cannot invalidate a clean later baseline, and a lost sample cannot become complete on a retry. Redis batching stays asynchronous; no awaited Redis operation is added per buy request.

### Validation and remaining work

- The API unit suite passed: 38 files, 369 tests, including authenticated peer routes, buyer surface restrictions, request drain, timing baseline/restart/failure behavior and role configuration.
- A separate integration check passed with one real control process, two real buyer processes, and isolated PostgreSQL/Redis: simultaneous same-key pending retries produced one durable order, independent buys shared the remaining stock, sold-out behavior agreed, buyer control/dashboard routes were absent, and authenticated peer flushes succeeded. The test seeds a pending hold directly; it does not simulate a network failure during initial persistence.
- The full API suite passed: 21 files, 361 tests, including the separate-process integration check and existing run-start/reconciliation, reset, finalization, queue, persistence and timing tests. The adjusted peer-surface unit file passed again (4 tests). `pnpm type-check` passed all production packages and test types. Touched TypeScript files passed Biome formatting/lint; `git diff --check` passed. Composition, characterization, full reference-runtime and hosted runs were not executed in this source-only slice.
- Independent review identified unbounded advisory timing records across ordinary runs. The bounded-state correction passed the expanded focused peer-boundary tests (6 tests), including repeated completed/startup-failed runs and merge-loss honesty across retries and later clean runs. The actual multi-process integration check passed again with the revised private timing protocol (1 test); impacted API and workspace test types, touched-file Biome and whitespace checks passed. The previously green full API suite was not repeated for this focused correction.
- The follow-up timing race correction latches observed boot/merge loss for the current acceptance and evaluates completeness after the local timing fence finishes. A deferred-response regression reproduced an older successful flush overwriting a newer loss observation, including a fence already in flight; all 7 focused peer-boundary tests passed after the fix, and a clean later acceptance still restores complete timing evidence. API production types, workspace test types, touched-file Biome and whitespace checks passed; infrastructure/full suites were not repeated for this advisory-only fix.
- No Fly mutations or production/reference topology edits occurred. Dedicated local validation infrastructure used the `checkout-surge-task03-test` Compose project without host ports. The Dev Container was detached before the dedicated test containers, volumes and network were removed.
- Remaining Task03 work: deploy the explicit proof routing with three buyers, validate every run kind and full runner/reset/idle/SSE lifecycle in that topology, inject buyer/control restarts during live runs, recalibrate capacity/admission values, and update HD-51/HD-11 and topology documentation once the topology is enabled. This slice does not mark Task03 done or supersede production decisions.

### Slice 03B — Proof-only native k6 evidence capture (2026-10-11)

The runner can opt into `PROOF_K6_CAPTURE_DIR`; the default runtime remains unchanged. Capture adds a second native k6 JSON output while preserving the actual k6 PID, cancellation and stdout parser. Unique execution directories retain the exact generated scenario, accepted request and execution plan, raw metrics, summary, explicitly bounded stderr diagnostics, and an atomic file-size/SHA-256 manifest with run/boot identity and child-close time. Hashing and export do not extend the reported proof k6 completion time. No wrapper, stream tee, artifact HTTP API, extra Docker target or infrastructure change was introduced.

Before completion publication can trigger runner shutdown, the operator downloads the proof runner/container files, verifies the exact manifest and writes its digest to `ack.sha256`. The bounded wait defaults to 120 seconds and cannot exceed 300 seconds. Capture failure or missing/mismatched ACK fails closed before publication and preserves evidence; the operator must account for it and abort/reset the cell before proceeding. Cancellation and shutdown bypass ACK waiting, retain partial evidence and continue signalling the actual k6 child through the existing SIGTERM/SIGKILL deadlines. Raw metric/summary/report reconciliation, untruncated stderr and generator headroom remain operator eligibility gates; neither hashes nor exit zero establish completeness. The capacity procedure documents this checkpoint and why immediate automatic report teardown is unsuitable when reports must also be exported.

Validation ran serially as `codespace` in Dev Container `ec7cb4a0ff2b`: the focused proof capture, existing supervisor and runner-control files passed (3 files, 120 tests); the impacted load-orchestrator production type-check passed; touched TypeScript passed Biome formatting/lint. Capture tests cover native output arguments, real child PID, exact file hashes and ACK, timeout/missing evidence, child-close timing independent of export, cancellation during an exited child's ACK barrier and forced termination of a running child. No hosted load, Fly mutation, image build, full composition, characterization or reference-runtime run occurred. Hosted export/ACK validation, final proof topology, all-run-kind lifecycle checks and capacity/admission recalibration remain outstanding; Task03 remains in progress.

The capture review identified a rejection-ownership race when k6 exits before the executing-journal write settles. The runner now owns the supervisor's completion outcome immediately, before journal I/O. Preparation failure aborts an exited child's capture/ACK operation and settles that owned outcome before persisting its failure. A two-case gated-journal regression covers early capture rejection and journal failure during the ACK barrier, including retained partial evidence and no later ACK timeout. The same three focused files passed again (122 tests), with impacted load-orchestrator production types and touched-file Biome passing. Global test types were not run while the disjoint topology slice was in progress; generic nonabortable filesystem metadata stalls remain outside this bounded acknowledgement mechanism.

The joined workspace test-type check subsequently passed after three capture configuration fixtures received the required `NODE_ENV: "test"` input. The six proof-capture tests and touched fixture's Biome check passed again; no runtime behavior changed.
