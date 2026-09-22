# Adaptive ERP Processing and Bounded Demo Admission

Status: proposed implementation plan; no runtime changes are implemented by this document.

Date: 2026-09-19.

Execution update (2026-09-21): follow the backlog's [current runtime and evidence rules](backlog/adaptive_erp/index.md#common-guardrails-and-reporting). Development data is disposable; the reference runtime may be wiped and reused for isolated verification. Neither the original machine nor historical run rows are prerequisites. Preserve fixture definitions and exported verification results, and document the current measurement environment. Numeric targets and the calibration approval gate remain unchanged. The backlog index records delivered task status and superseding execution decisions.

## Part I — Context, problem, and intended design

### 1. Why this work is necessary

Checkout-Surge demonstrates how a limited-inventory checkout can absorb a request surge while a slower downstream system processes accepted orders asynchronously. Its portfolio narrative is resilience under pressure: fast reservations, no overselling, controlled downstream pressure, and observable eventual business completion.

The foundations remain appropriate: Redis provides atomic inventory decisions, PostgreSQL retains business records, BullMQ carries asynchronous work, and workers communicate with the mock ERP. The API must remain independent of ERP response times.

The missing guarantee is that temporary downstream constraints should primarily increase waiting time. They should not deterministically turn valid accepted orders into failures because the worker has more available processing capacity than the ERP.

The portfolio also needs practical limits. A visitor should not monopolize the shared demonstration with a scenario expected to take hours. These two requirements are compatible: the processing engine retains work and adapts; the demonstration applies a separate admission policy before accepting an experiment.

Relevant existing documents:

- [Project description](project_description.md)
- [Delivery constraints](delivery_constraints.md)
- [Architecture](../docs/architecture.md)
- [Scope and caveats](../docs/scope_and_caveats.md)
- [Inventory ownership and stale holds](../docs/redis_inventory_hot_path.md)
- [Required quality checklist](../docs/quality_checklists.md)

### 2. Incident that exposed the gap

Investigation reference: run `c04798ff-042f-43cf-b5ed-4ba48132aa80`, started on 2026-09-18 at 21:15:53 UTC. The following evidence was read from persisted run, attempt, order, summary, and notification records; the investigation did not modify the runtime.

| Parameter | Accepted value |
| --- | --- |
| Traffic | 25 requests/second for 60 seconds; 1,500 planned attempts |
| Inventory | 888 units; one unit per checkout |
| ERP capacity | 10 confirmations/second |
| ERP latency | 250 ms |
| Injected errors / forced outage | 0% / disabled |
| Per-run worker concurrency | 5 |
| Retry limit | 4 attempts |
| Circuit breaker | 5 consecutive counted failures; 10-second reset window |
| Business drain timeout | 300 seconds after traffic completion |

All 1,500 requests completed: 888 reservations were accepted and 612 requests received the expected sold-out response. There were no transport failures or unexpected checkout responses. HTTP p95 latency was approximately 15 ms.

The worker could issue calls faster than the ERP's 10/s capacity. ERP capacity rejections (`429 erp_capacity_exceeded`) counted toward the circuit breaker's failure threshold. Persisted attempts show repeated groups of roughly ten confirmations followed by capacity rejections and approximately ten seconds without ERP calls. Useful throughput fell to approximately 0.9 confirmations/second.

| Observation | Confirmed orders | Failed orders | Unfinished orders | Recorded notifications |
| --- | ---: | ---: | ---: | ---: |
| Run finalization at 21:21:54 UTC | 330 | 1 | 557 | 330 |
| Subsequent investigation after order processing settled | 824 | 64 | 0 | 330 |

The run was finalized with `business_drain_timeout`. Existing queued work continued afterward, but the generated-run publication fence rejected new notifications for the now-terminal run. The 64 failed orders exhausted their retries on capacity rejections. The immutable history retained the earlier snapshot.

Successful presets did not establish the missing guarantee: the public surge presets used ERP capacities of 200–250/s, above their workers' usual throughput. A successful earlier custom run used a capacity of 100/s. These were favorable configurations for the current admission mechanism.

### 3. Current implementation boundaries and problems

| Boundary / code | Current behavior | Required change |
| --- | --- | --- |
| [Worker admission](../apps/worker/src/application/order-process-admission.ts) | Limits concurrent handlers | Control request cadence as well as concurrent calls |
| [ERP client](../apps/worker/src/application/erp-confirmation-client.ts) | Groups 429, timeouts, and other temporary failures under retryability; uses a fixed request deadline | Classify capacity, availability, uncertain outcomes, and permanent rejection separately |
| [Order handler](../apps/worker/src/application/order-process-job-handler.ts) | Exhausted temporary errors can terminally fail an order | Preserve accepted work through temporary downstream constraints |
| [Queue consumer](../apps/worker/src/queue/bullmq-order-process-consumer.ts) | Circuit-open and admission deferrals preserve the delivery attempt budget; other failures consume it | Separate scheduling, delivery, and actual ERP-call accounting |
| [ERP attempt persistence](../apps/worker/src/persistence/postgres-erp-attempt-persistence.ts) | Identifies attempts by order, delivery, and attempt number | Give every actual ERP call its own durable identity, independent of delivery retries |
| [Order recovery](../apps/worker/src/application/order-recovery-scanner.ts) | Owns durable technical recovery with a bounded publication-attempt policy | Provide one durable owner for retryable downstream work without a hidden business-abandonment limit |
| [Finalization](../apps/api/src/services/demo-run-finalization-service.ts) | Can finalize while business work remains after a timeout | Separate elapsed-time warnings from actual business completion |
| [Publication fence](../apps/worker/src/persistence/postgres-generated-run-publication-fence.ts) | Rejects publication for terminal runs | Preserve this protection while preventing premature terminalization |
| [Mock ERP confirmation](../apps/mock-erp/src/application/confirmation-service.ts) | Successful idempotency ledger is process-local | Persist external confirmation identity for restart and lost-response verification |
| [Run start service](../apps/api/src/services/demo-run-service.ts) | Validates parameter bounds and run budgets | Add an authoritative estimated-duration admission decision |

Some existing tests explicitly require temporary retry exhaustion to fail an order. Those tests encode the old policy and must change with the specification. Passing them is not evidence that the desired resilience property holds.

### 4. Target guarantees

For a finite set of valid accepted orders, provided infrastructure remains recoverable and the ERP eventually provides enough successful processing opportunities:

1. Reservations never exceed allocated stock.
2. Every accepted order remains durably accounted for until confirmation or an explicit terminal failure (permanent rejection or non-transient technical error). The only other exit is a reset, which deliberately discards the whole experiment (D02, D10).
3. Temporary saturation, increased latency, and finite outages do not by themselves cause terminal business failure.
4. More worker capacity does not bypass ERP admission or worsen the business outcome through overload-induced abandonment.
5. Retries do not create duplicate external confirmations or duplicate notifications.
6. A run is not presented as business-complete while orders, uncertain confirmations, required recovery, or notifications remain unresolved.
7. Restarting a supported service preserves outstanding work and does not trigger an uncontrolled retry burst.
8. A slow run is visibly still progressing: outstanding work, its age, the observed confirmation rate, and one downstream status are shown.

Occasional capacity responses during adaptation remain possible. The guarantee concerns retained work and business outcomes, not the elimination of every transient HTTP error. A permanent ERP rejection, inconsistent identity, or other non-transient error terminally fails the affected order with an attributable reason; it never blocks the run.

### 5. Separate processing resilience from demonstration limits

| Processing engine | Portfolio admission policy |
| --- | --- |
| Adapts to observed ERP responses and latency | Uses the declared scenario to estimate runtime |
| Retains orders across temporary constraints | Rejects experiments expected to occupy the demo too long |
| Uses bounded individual calls and spaced retries | Limits admitted traffic, stock, and accessible chaos controls |
| Completes according to business evidence | Explains the estimated bottleneck and duration before launch |
| Reports a prolonged workflow | Never injects an arbitrary order-failure deadline; frees the demo with a whole-run automatic reset |

Use **600 seconds as the initial estimated demo-occupancy ceiling**. Measure occupancy from run acceptance through expected business settlement, including start delay and notifications, rather than only k6 execution. Keep this setting in the effective demo policy with a deployment ceiling, not in worker business logic. Apply it to dashboard-launched presets and custom runs in both public and admin modes, with no bypass. The estimate is an internal admission mechanism: the dashboard says whether a configuration is allowed and why not, and shows nothing about it once the run is accepted.

The ten-minute check is a conservative admission estimate, and an admitted run can exceed it because actual conditions differ. The hard limit is separate: a run still nonterminal 900 seconds after acceptance is reset automatically to free the demo (D10). Between 600 and 900 seconds the run is in a grace period, and only then does the dashboard warn that the reset is coming. Retain the supported one-nonterminal-run rule. Reset, whether automatic or triggered by an admin, is destructive by design: it stops everything, discards the run's internal data, and returns the demo to a ready state as fast as possible (D02).

The automatic reset is the only wall-clock termination. It acts on the whole run, never on individual orders, and no other deadline may be introduced implicitly through a cleanup timer or retry limit.

### 6. Target processing design

#### 6.1 One downstream admission authority

The API owns the order-process queue's native global rate and concurrency limits, derived from the accepted snapshot before traffic starts. Without an active run, the queue uses the shared catalog default. Dispatch uses small native bursts in windows of at least 20 ms, with a provisional 5% margin and a proven worst-case sliding-second bound. Task 17b replaces the original learned-rate design under revised D06.

All ERP calls, including retries and reconciliation replays, retain worker-owned resilience admission for the same downstream scope. The controller retains cooldowns, bounded in-flight work, availability probes, and adaptive request deadlines. A capacity response pauses future queue delivery natively for Retry-After and durably defers the affected order. There is no custom pacing denial, launch-rate ramp, or rejection-wave reduction. Availability still opens its own circuit and admits at most one probe per scope every five seconds; a fresh successful probe resumes the configured rate.

The supported runtime has one worker process. PostgreSQL retains restart-relevant cooldown and work timing. API startup reapplies configured limits; worker restart reuses Redis queue metadata without writing it or gating startup on API readiness. The metadata-loss residual and integer-window throughput trade-off are documented in task 17b and `docs/architecture.md`. Multiple worker replicas remain outside the supported topology.

#### 6.2 Explicit outcome classification and durable scheduling

| Outcome | Disposition |
| --- | --- |
| Local admission unavailable | Deferred work; no ERP call and no ERP attempt |
| Capacity rejection | Pause native queue delivery, persist cooldown, retain and reschedule the order |
| Temporary dependency unavailability | Capped backoff with jitter; circuit protection and sparse probes |
| Timeout or response lost after dispatch | Uncertain external outcome; reconcile using the stable business idempotency key |
| Known permanent business rejection | Terminal business failure with an attributable reason |
| Authentication/configuration failure, malformed protocol, contradictory identity, or unrecognized response | Terminal technical failure of the order with an attributable reason; no retry and no blocked run (D03) |
| ERP success followed by local persistence failure | Retain accepted-result recovery ownership and finish local transitions |

Separate three identities: the stable order/ERP idempotency key, queue delivery identity, and individual ERP-call identity. Actual calls must remain auditable even when capacity deferrals do not consume an error budget. Record dispatch intent before an external call so a crash cannot erase the existence of an uncertain attempt.

Extend the existing worker recovery workflow to own deferred downstream work instead of introducing another independent recovery scanner. Persist the next eligible attempt time, waiting reason, and publication ownership. BullMQ supplies wake-ups; PostgreSQL retains the business obligation and recovery intent. Define one scheduling owner per order at each handoff, including initial dispatch, delayed delivery, and recovery publication. Repeated scans or duplicate deliveries must not create overlapping logical work or starve older orders.

Remove order-abandonment limits for transient ERP conditions only; non-transient errors fail the order at once (D03). Bound individual work, scan batches, retry frequency, and diagnostic retention. Do not require unbounded memory or unbounded attempt-history growth to retain an unresolved order and its canonical external-success evidence.

#### 6.3 Latency and external idempotency

Distinguish a network request deadline, an expected processing duration, and a genuine business expiry. A network deadline bounds resource use; it does not prove the ERP rejected an order.

Adapt request deadlines conservatively from observed latency within explicit bounds. Repeated timeouts must not produce aggressive overlapping calls. If latency exceeds the maximum deadline, retain uncertainty and use safe reconciliation rather than declaring business failure. A late success must dominate an earlier locally observed timeout.

Persist the mock ERP's idempotency ledger, including immutable request identity and canonical confirmation result, and serialize concurrent duplicate acceptance. Keep this ERP-owned ledger separate from worker success records even if the reference runtime uses the same PostgreSQL service. Define a durable lookup or idempotent replay path for uncertain results. No distributed transaction between worker and ERP is required.

For a future real connector, durable idempotency or an authoritative status lookup is an explicit integration requirement. Exactly-once external effects cannot be inferred solely from the worker's local records.

#### 6.4 Truthful lifecycle and inventory retention

Traffic completion closes new experiment traffic and starts draining; it does not close outstanding processing. An elapsed processing target sets an operational warning. Finalization waits for durable business and notification settlement. A reset is the only path that ends a run without settlement (D02, D10).

Retain terminal publication/cleanup fencing. Change when terminality is reached rather than bypassing the fence to repair notifications. Active and waiting work must remain protected from retention cleanup and exact teardown; only a reset (D02, D10) discards it. Recovery queries must not repeatedly select ineligible terminal rows and thereby starve later recoverable work.

Review all time assumptions together: request deadlines, retry/recovery leases, reservation visibility expiry, run-sale eligibility TTL, idempotency retention, maintenance, and finalization. The current seven-day eligibility assumption is coupled to a bounded drain duration. Make long-lived processing independent of an admission-marker expiry; missing/expired markers must remain fail-closed for new buys. Do not reopen a sale when restoring processing state.

The current demo retains expired holds instead of automatically releasing them. Preserve that behavior for accepted work. Payment expiry and a full stock-release/cancellation business workflow remain outside scope.

### 7. Duration estimation and admission

The estimator belongs to an API application service. Shared contracts describe its inputs, result, and rejection details. The web app consumes the API estimate; do not duplicate a second authoritative formula in React or place application estimation logic in the contracts package.

Inputs include traffic shape and start delay, unique planned checkouts, stock and quantity, effective worker concurrency, declared ERP capacity and latency, error assumptions, and calibrated overhead for adaptation, persistence, and notifications.

For the elementary no-error, constant-capacity case:

```text
N = maximum unique orders that can be accepted by this scenario
C = minimum of per-run and deployed worker concurrency
L = effective call latency in seconds, including a nonzero overhead floor
r = min(declared ERP capacity, C / L)

ideal overlapped duration ≈ start delay + max(traffic duration, N / r)
```

The overlap formula is an explanatory approximation for burst/regular arrivals, not a universal bound. The admission estimate must handle the actual accepted traffic shape and completion tail. A conservative starting envelope can place the remaining processing after traffic; refine overlap only where the estimator models arrivals explicitly. This favors a small auditable model over an elaborate simulation framework.

Compute `N` from unique checkout intent, quantity, and available stock, not emitted HTTP count: duplicate/idempotency scenarios do not create one ERP confirmation per HTTP response. Account for partial stock quantities, zero accepted orders, zero configured latency, and the worker's actual deployment ceiling.

For independent transient errors, `1 / (1 - p)` can inform expected attempt demand, but is not a worst-case duration or a calibrated percentile. Include retry/cooldown costs and measured overhead; do not label a margin a confidence interval without evidence. A forced outage or 100% permanent transient failure has no admissible finite estimate.

Return an explanatory estimate and a conservative admission value, bottleneck, assumptions, policy/estimator version, ceiling, and allowed/rejected decision. Specify the exact boundary: admit when the conservative value is at most 600 seconds; reject above it. Reject unsupported/unestimable public scenarios with an actionable explanation rather than treating them as zero duration.

At actual start, resolve the authoritative preset/custom snapshot and effective policy and recompute the decision. That recomputation is the only authority; a preview is advisory and nothing the browser submits about it is trusted (D12). Reject before creating a run, allocating inventory, starting k6, or consuming the public visitor budget. The estimate is not persisted with the run. Preserve existing authentication, CSRF protection, hard caps, and one-run admission serialization.

For the incident, `min(10, 5 / 0.25) = 10` confirmations/second and `888 / 10 = 88.8` seconds of ideal service. The corrected scenario should remain admissible under ten minutes. Rejecting it to hide the worker defect is not an acceptable resolution.

### 8. Explicit scope limits

- Keep the existing service topology and queue technology. No new orchestration service or multi-worker deployment is required.
- Preserve the public 10,000-buyer burst target; do not lower traffic to make resilience checks pass.
- Keep the experiment finite and resource-bounded at admission. Indefinite recovery support is not unlimited intake.
- Add no dynamic ERP profile feature. Accepted run snapshots override global chaos controls. Verify outage by stopping/starting mock-erp, latency beyond the initial deadline with a stable high-latency snapshot, and capacity decrease/recovery only through the existing `resolveConfig` seam in an in-process integration test with real PostgreSQL, Redis and BullMQ. Capacity changes are not reachable in Compose because the mock honors the accepted snapshot. A general chaos platform and public forced-outage controls are out of scope.
- Do not turn this into real payments, customer messaging, stock-release business logic, or a production-readiness claim.
- Preserve legitimate terminal failures. Only the transient classes of D03 are retried; do not make every error retry forever, and do not park orders for an operator.
- Reproduce the incident from the versioned acceptance fixture; historical development rows may be discarded under the current runtime rules. Preserve recorded measurements as historical evidence.

## Part II — Locked design decisions

The choices below resolve the questions Part I left open. They are binding for Part III unless the user explicitly reopens one. Identifiers D01–D14 are stable references for reviews, tests, and commit messages. Numeric constants named here are initial values subject to the calibration rules of D14; the structural rules are not.

### 9. Decisions D01–D14

#### D01 — Keep the existing lifecycles; add an operational dimension

**Decision.** Orders keep `queued | processing | confirmed | failed`; runs keep `starting | active | draining | completed | failed`. No lifecycle status is added for waiting or uncertainty.

- Every order under downstream processing has exactly one durable control record (D04). It carries the operational situation: waiting reason (`local_admission`, `erp_capacity`, `erp_unavailable`, `uncertain_result`, or none), next eligible time, and the identity of a dispatched call whose outcome is unknown.
- Run-level views derive from those records: outstanding orders, oldest outstanding age, and one downstream status (D13). The run status itself does not encode them.
- A terminal order failure keeps status `failed` with a closed failure-code vocabulary grouped into two categories: `business_rejection` (a permanent ERP rejection recognized under D03) and `technical` (a non-transient error under D03). Transient conditions never terminalize an order. A reset does not terminalize orders either; it deletes them (D02).
- Normal run completion requires: no order in `queued` or `processing`, no unresolved uncertain call, and one notification record per confirmed order. A failed order, whatever its category, never blocks completion.
- Reports show confirmed, business-rejected, and technically failed orders as separate totals. "Processing finished" does not mean "all orders confirmed". A reset run keeps status `failed` with reason `admin_reset` or `auto_reset`; "cancelled" is a presentation label, not a lifecycle status.

#### D02 — Reset is destructive and fast

**Decision.** Reset stops everything and returns the demo to a ready state as fast as possible. It does not reconcile, preserve, or settle the interrupted run's work. It deletes the run's internal data and keeps one basic history line.

- Contract statement: *Reset discards the experiment. Whatever the run had in flight is lost on purpose.* This is a demonstration against a mock ERP; no external effect deserves protection from a reset, and a reset never waits on the ERP.
- Sequence: (1) claim the nonterminal run as terminal `failed` with reason `admin_reset` (or `auto_reset` when triggered by D10) and traffic status `failed`; the existing terminal-run exclusions then fence worker dispatch, recovery, and publication; (2) close sale eligibility, abort traffic, and fence dashboard ingestion as today; (3) clean the run's queue jobs within the existing bounded wait; (4) write the run's history summary from a plain count of the durable rows as they stand; (5) delete the run's internal data: orders, reservations, pending persistence, order events, control records, dispatched-call intents, ERP attempts, mock ERP ledger rows, notifications, sold-out counts, finalization evidence, run-scoped resilience state, and the run's Redis state; (6) clear shared dashboard and ERP resilience state as today.
- What remains is the run row, its summary row, and its closed generated sale offer, which stays as one inert row so existing references remain valid. History lists the run with its id, preset, dates, and the counts captured at step 4, labelled as cancelled by admin reset or by automatic reset. Its detail view states that the run's data was discarded.
- The terminal claim is the stop. There is no separate stop marker, no in-progress reset state, no disposition counts, and no administrative terminalization of individual orders.
- Outstanding work never blocks a reset: queued or processing orders, unresolved dispatched calls, and missing notifications are deleted with everything else. The guard that protects outstanding work applies to retention and exact teardown only (section 6.4), never to reset.
- A worker call still in flight when the rows disappear fails cleanly: it recreates no row and records no notification. The terminal fence stays intact.
- The reset HTTP request stays bounded as today and is idempotent. A reset interrupted by an infrastructure failure is finished by calling reset again through the existing incomplete-reset pattern. A successor run can start as soon as reset returns.

#### D03 — Automatic recovery for transient conditions; any other error fails the order

**Decision.** Transient conditions recover without human action. Any other error terminally fails the affected order at once, as a real integration would, and the run carries on. No order is parked for an operator; there is no intervention state and no resume control.

- Automatic recovery classes, no human action: capacity (`429` / `erp_capacity_exceeded`), recognized unavailability (`503` with a recognized code such as `erp_forced_outage` or `erp_injected_error`, connection errors), request timeouts, and an opaque `5xx` after dispatch, which is an uncertain result (D05) rather than proof of absence of effect.
- Technical failure classes: authentication or authorization responses (`401`, `403`), malformed protocol (a response body that fails the contract), identity contradiction (`409 erp_idempotency_conflict` from the ERP, or a local `ErpAttemptContradictionError`), a missing accepted run snapshot, and any `4xx` outside the recognized vocabulary. The order becomes `failed` with category `technical` and a code naming the cause. An unknown `4xx` is not a business rejection.
- Scope: a technical failure affects only the order that met it. Nothing blocks a scope, a run, or the worker, and these failures feed neither pacing nor the availability circuit.
- Only a permanent business rejection listed in the shared ERP error vocabulary can terminalize an order as `business_rejection`. The current mock emits none; adding one requires the contract entry first.
- Before any terminal conclusion, the worker resolves an earlier uncertain call for the same order (D05).

#### D04 — One durable owner per order from the first ERP call

**Decision.** Option B.

- Before its first ERP call, the worker creates or claims the order's single control record, an extension of the existing recovery row with one row per order, in the same transaction as the `queued -> processing` transition. There is no ownerless initial path.
- Control record fields: processing generation, lease expiry, next eligible time, waiting reason, publication ownership, and the identity of the dispatched call, written before the HTTP request is sent.
- BullMQ deliveries (initial, delayed, recovery) are wake-ups only. A delivery whose generation does not match the control record is acknowledged without work. BullMQ `attempts` is 1 for order-process jobs; delivery retries are no longer an error budget.
- The claim is atomic (`SELECT ... FOR UPDATE SKIP LOCKED` or one conditional update). Eligibility (next eligible time reached, lease free or expired) is checked in the selection query and again at execution time before dispatch.
- Selection orders eligible work by next eligible time, then by order creation time, and applies the batch limit after eligibility filtering. New buys get no priority over retries. This replaces the current selection, which ignores `nextAttemptAt` for `pending` rows.
- An expired lease permits a new claim; it does not mean the earlier call had no effect. The new owner first resolves any recorded dispatched call (D05).

#### D05 — Durable ERP ledger, status lookup, idempotent replay

**Decision.** Option B, simplified: the ledger stores terminal outcomes only. There is no persisted "in progress" state to recover after a crash.

- The mock ERP persists, per idempotency key, the immutable identity (order, public order id, reservation, sale offer, run, quantity) and the canonical terminal result: a success with its confirmation id, or a permanent rejection. Transient outcomes (capacity, unavailability, injected errors) are not stored. A unique constraint on the key serializes concurrent first processing: the loser of the insert returns the winner's row. No transaction stays open across simulated latency.
- `GET /confirmations/:idempotencyKey` returns `succeeded` with the canonical result, `rejected` with the permanent rejection, or `unknown`. `unknown` means "no terminal record": never received, still processing, or lost. It is not proof of absence of effect. The lookup does not consume the mock's TPS quota and does not apply chaos latency or injected errors.
- Worker rule for an uncertain call: lookup first. `succeeded` or `rejected` adopts the canonical result without spending an ERP-call permit. `unknown` leads to an idempotent replay of `POST /confirmations` with the same key through normal admission (D06); the replay is the reconciliation.
- A replay that returns a stored result is flagged by a response header (`x-erp-replayed: true`), never inside the JSON body, so exact comparisons of canonical results stay valid.
- Lookups have a small dedicated in-flight limit and respect the availability circuit, but neither rate pacing nor capacity cooldown, so reconciliation is never starved by the protection it serves.
- The ledger lives in tables owned by the mock ERP. The worker reaches it only over HTTP, even when both use the same PostgreSQL server.
- Same-process duplicate requests keep sharing the running promise, as today.

#### D06 — Dispatch at the declared ERP capacity through the queue's native rate limit (revised 2026-09-21)

**Revision (user decision, 2026-09-21).** The original D06 below is superseded. It made the worker discover the ERP's capacity from responses alone, starting at 2 launches/s, and its custom pacing and deferral path capped real throughput near one launch per second (diagnosis summarized in task 17b). The demo now follows the common industry case: the downstream limit is known and published, as it is for mainstream ERP and SaaS APIs, so the client is configured with it. Tasks 07 and 09 implemented the original decision; task [17b](backlog/adaptive_erp/17b_pace_erp_dispatch_at_declared_capacity.md) replaces that part.

- The accepted run's declared ERP capacity is the dispatch rate. It is enforced by the order-process queue's native rate limit (BullMQ global rate limit), evenly spaced, from the first second; the per-run concurrency is enforced by the queue's native global concurrency. No learned rate, observation window, additive step, reduction factor, rate floor or rate ceiling remains.
- A small safety margin below the declared capacity is the only pacing constant (D14).
- A capacity response (`429`) pauses queue delivery natively for the `Retry-After` duration, is never an order failure and never consumes a retry budget. `Retry-After` parsing, the capped maximum and the local fallback are unchanged from the original text.
- Unchanged from the original text: recognized unavailability, connection errors and timeouts feed the availability circuit only; circuit probes are the only traffic during an outage, at the policy cadence; a locally reused success is not evidence of ERP health.
- When the downstream limit is unknown or variable, an adaptive client-side limiter (for example the adaptive retry mode of the AWS SDKs) is the appropriate technique. The demo deliberately does not implement it; the dashboard's About section says so.

**Original decision (superseded).** Option A.

- Per downstream scope (one run, or the catalog): a target launch rate, evenly spaced starts, and an in-flight ceiling equal to the smaller of the configured concurrency and the policy ceiling. No burst allowance accumulates during idle or outage periods.
- Additive increase after one observation window without capacity responses. Multiplicative decrease on the first capacity response of a wave; further capacity responses inside the same wave window apply no additional reduction.
- Rate floor, rate ceiling, step, reduction factor, window length, and wave window are policy constants (D14).
- `Retry-After` on `429` and `503`: both delay-seconds and HTTP-date forms are parsed. An invalid value falls back to local backoff. A value above the policy maximum sets a capped cooldown and is logged. The mock sends `Retry-After` in delay-seconds form.
- Capacity responses feed pacing only. Recognized unavailability, connection errors, and timeouts feed the availability circuit only. Circuit probes are the only traffic during an outage; probe cadence is a policy constant.
- A locally reused success (local record or D05 lookup) is not evidence of ERP health: it neither closes the circuit nor raises the rate. Feedback from a call dispatched before the latest reduction cannot undo that reduction.
- The controller never reads the run's declared capacity. It observes responses only.

#### D07 — Restore safety state and retain declared-capacity queue limits after restart

**Decision.** Option B. Revised with D06 (2026-09-21): there is no learned rate to relearn. After a restart the queue limits are re-applied from the accepted run snapshot, and the persisted cooldown and circuit expiries below are honored as before.

- Persisted: dispatched-call intents (D04), cooldown and circuit-open expiries per scope, next eligible times, and native queue limits in Redis. Not persisted: latency samples. Learned-rate and observation-window state no longer exist.
- Startup order: reconcile dispatched calls first (D05), then resume under the declared-capacity queue limits. A still-running persisted cooldown or circuit-open expiry is honored; otherwise the circuit starts closed. Task 17b clarification: API startup reapplies configured limits; worker restart reuses Redis metadata without writing limits or gating startup. The existing finalization poll reapplies current limits even without a draining run; metadata loss or a failed terminal limit write is healed on its next successful tick (default five seconds, plus I/O latency), without failing a committed terminal transition; persisted cooldowns and durable deferral still retain saturation responses safely.
- A missing accepted run snapshot for a run-scoped job is a technical failure of that order (D03), never a silent fallback to the catalog scope.
- One authority per real quota: `run:<id>` and `catalog`. A worker-wide in-flight cap applies on top.

#### D08 — Bounded adaptive deadline from an observed latency window

**Decision.** Option A.

- Deadline = clamp(percentile(window) × factor + margin, minimum, maximum). Initial deadline, window size, percentile, factor, minimum, and maximum are policy constants (D14). The maximum must be at least the deployment's largest allowed ERP latency plus the margin; the worker verifies this at startup.
- Timeouts are censored observations counted at the deadline value, so the deadline can still grow after timeouts. Replayed and lookup responses are excluded from the window.
- At the maximum deadline the call is uncertain (D05). No parallel confirmation for the same order is ever started to "catch up".

#### D09 — Bounded per-order history plus cumulative aggregates

**Decision.** Option B, with 32 retained ERP attempts per order as the initial constant.

- When an attempt is inserted beyond the retention count, the same transaction deletes the oldest non-canonical attempts of that order. Never deleted: the canonical success row, a permanent-rejection row, and any attempt referenced by an unresolved dispatched call.
- `erp.attempt.*` order events follow the same per-order bound. Lifecycle events are unaffected.
- Per-order counters by category (capacity, unavailable, timeout, permanent) update idempotently per attempt identity, so a redelivery never counts twice.
- Final deletion stays with the existing generated-run cleanup. There is no time-based purge of unresolved work.

#### D10 — Automatic reset 900 seconds after acceptance

**Decision.** A run that is still nonterminal 900 seconds after its durable acceptance time is reset automatically, so no run can monopolize the shared demo. Admission still uses the 600-second estimate (D11); the 300 seconds between the two are a grace period.

- The automatic reset runs the same destructive workflow as the admin reset (D02), with reason `auto_reset`. It needs no admin session and applies to public and admin runs alike.
- The deadline derives from the durable acceptance timestamp, so it survives an API restart. A run already past its deadline at startup is reset then. The check is a small periodic API application service wired in the composition root; it holds no timer per run.
- The 900-second limit is one exported constant next to the occupancy ceiling. It is not editable from the dashboard and is not a worker concern.
- From 600 seconds after acceptance, and only then, the dashboard tells the viewer that the run is in its grace period and will be reset at the deadline to free the demo, with the remaining time. Nothing about the deadline is shown before that.
- The deadline acts on the whole run. It never fails individual orders and adds no retry limit.

#### D11 — Conservative admission envelope

**Decision.** Option B for the first version.

- Conservative value = start delay + traffic budget + ERP processing envelope + notification cost + calibrated margins. Traffic budget is `durationSeconds` for constant arrival and `maxDurationSeconds` for buyer spike. ERP envelope = N / r with N = unique acceptable orders (stock, quantity, unique buyers, not duplicated HTTP attempts) and r = min(declared capacity, C / L), L including the overhead floor.
- Error rate p: expected demand factor 1 / (1 − p) with a policy margin. A p above the policy maximum is unestimable and rejected.
- Sanity check with seeded presets before margins: incident fixture `60 + 888 / 10 = 148.8 s`; `surge-10k` `120 + 1000 / 250 = 124 s`. Both stay admissible with margins.
- The explanatory estimate may show the overlapped ideal; the admission decision uses the conservative value only.

#### D12 — The start-time recomputation is the only authority

**Decision.** The API recomputes the estimate at start and that result alone decides. A preview is advisory.

- The preview endpoint resolves the same scenario and policy as start, uses the existing bounded public/admin access model, is rate limited like other reads, and creates no state, run slot, or budget consumption.
- At start, after admission serialization, the API resolves the authoritative snapshot and effective policy and recomputes. Above the ceiling or unestimable, it rejects before any side effect with the structured reason. There is no preview fingerprint, no stale-preview rejection, and no re-confirmation step; nothing the browser submits about an estimate is read.
- Web: only a preview matching the current inputs is rendered, and the start button is disabled while a preview is pending or rejected. The dashboard shows whether the configuration is allowed and, when it is not, the estimated duration, the bottleneck, the limit, and what to adjust.
- The estimate is not persisted with the run and is not shown during the run or in history.

#### D13 — Versioned engine policy; presets keep scenario parameters only

**Decision.** Option B.

- Removed from presets, accepted snapshots, forms, readers, and the load-orchestrator journal: `retryPolicy` (`maxAttempts`, `initialBackoffMs`), `drainTimeoutSeconds`, `circuitBreakerFailureThreshold`, `circuitBreakerResetTimeoutMs`, and `erpConfig.requestTimeoutMs`.
- Kept: traffic, inventory (`startingStock`, `quantityPerCheckout`, `reservationHoldMinutes`), ERP latency, capacity, error rate, forced outage (admin), `orderProcessConcurrency`, and `pendingPersistenceRetryAfterSeconds`, which belongs to reservation persistence and is unrelated to this work.
- Engine constants live in a versioned worker policy; its version is persisted with each run. None of them is editable from the dashboard.
- Persisted snapshots of earlier runs may still contain retired fields. History readers accept and ignore them; prove compatibility with old-format test fixtures rather than requiring historical development rows.
- Runtime view: outstanding orders, oldest outstanding age, observed confirmation rate, and one downstream status (`nominal`, `erp_limiting`, or `erp_unavailable`). Controller internals (in-flight ceiling, cooldown, probes) and per-reason waiting counts are not projected. The only run timing indication is the grace-period notice of D10. The 300-second drain timeout and `business_drain_timeout` disappear entirely.

#### D14 — Bounded calibration against pre-approved criteria

**Decision.** Option B, with a final approval gate.

| Domain | Target |
| --- | --- |
| Accounting | Acceptance-matrix totals exact; zero tolerance for duplicates or saturation-induced abandonment |
| Original incident | 888 confirmations and 888 notifications; settlement under 240 s on the documented local reference runtime |
| Stabilized throughput | Long fixture at 10/s capacity, 250 ms latency, concurrency 5: at least 8 confirmations/s after stabilization |
| Stabilized pressure | Same fixture without injected errors: at most 5% capacity responses over a stable 60 s window |
| Outage | After the circuit opens: at most one probe per scope every 5 s, excluding already-dispatched calls |
| Estimator | Public presets and incident admissible; estimate error measured on fixtures and reported without a confidence-interval claim |

- Calibration may adjust policy constants only. It may not change the algorithm, weaken a target, or suppress errors to pass.
- Deliverable: a calibration report with environment, fixture, measured value per target, chosen constants, and policy/estimator versions. The user approves the frozen constants before Phase 7 closes and before documentation advertises the guarantee.
- The throughput and pressure targets pull in opposite directions by design; the report explains the chosen trade-off rather than silently favoring one.

**Revised by the project owner on 2026-09-22.** The calibration report and the explicit approval gate are dropped. A recap of the changes, validation results and any remaining issues is sufficient for routine task handoff. Any separately required owner decisions still apply. Fitting constants to one developer machine is not a deliverable: task 20 verifies the code-bound targets above (accounting, incident counts, throughput, pressure, outage probes) on a clean runtime, the host-dependent estimator allowances become environment-configurable with the current values as defaults (task 21), and a documented procedure lets a deployment re-measure them on its own host (task 22). The incident settlement time and the estimate error are recorded as local observations, not gates. The "constants only, never algorithms or targets" rule stands.

## Part III — Implementation plan

### 10. Sequencing and delivery rules

Implement the phases below in order, allowing tests/specification work to precede the associated code. Each phase must leave the repository runnable and carry its own focused validation. Do not advertise the full new guarantee until all acceptance gates pass. Coordinate schema/contract changes with all affected consumers in the same runnable slice.

All checkboxes below represent planned work, not completed work.

Before each phase, apply [the quality checklist](../docs/quality_checklists.md), identify its ownership boundary, and inspect the current code because this plan is a baseline rather than a substitute for implementation-time review. Part II decisions are binding; an implementation that needs to deviate from one must stop and obtain an explicit user decision rather than reinterpret it. Keep routes thin and instantiate infrastructure only in composition roots.

### Phase 1 — Define contracts and acceptance fixtures

**Ownership:** shared contracts and the application-service boundaries that consume them.

- [ ] Record the target outcome classification, durable scheduling ownership, and traffic and business completion semantics, plus the destructive reset contract.
- [ ] Specify waiting reasons and the two terminal failure categories, and distinguish observed transient ERP failures from terminal order outcomes. Prefer existing lifecycle states plus explicit operational reasons where sufficient.
- [ ] Define the ERP-call identity and uncertain-result lifecycle separately from BullMQ delivery counters.
- [ ] Define the estimator response, admission rejection, effective 600-second policy, and the 900-second automatic reset deadline.
- [ ] Inventory uses of `maxAttempts`, `drainTimeoutSeconds`, `requestTimeoutMs`, recovery attempt limits, run status, and terminal publication guards; identify every consumer requiring coordinated changes.
- [ ] Add a named fixture reproducing the incident configuration and small deterministic fixtures for low capacity, latency beyond the initial deadline using a stable snapshot, and finite outage using mock-erp stop/start. Accepted snapshots override global chaos controls; capacity decrease/recovery belongs to an in-process `resolveConfig` integration test with real PostgreSQL, Redis and BullMQ.
- [ ] Document the policy defaults to calibrate and their measurable acceptance criteria before selecting constants.

**Validation / exit:** contract tests cover valid public/API-reachable states and the new distinctions; existing seeded scenario contracts still parse. An implementation checklist maps every changed behavior to an owning service and test. No public capability expansion is accidentally introduced.

### Phase 2 — Retain downstream work and make retries safe

**Depends on:** Phase 1. **Ownership:** worker application services/persistence, mock ERP application/persistence, DB schema.

- [ ] Introduce durable per-call identities and dispatch intent; update ERP attempt persistence and diagnostics so multiple calls cannot collide after a non-budget-consuming deferral.
- [ ] Implement explicit capacity, availability, uncertain, permanent-rejection, and technical-failure dispositions in the client/handler boundary.
- [ ] Extend the existing recovery workflow to retain deferred ERP work, due time, and reason. Eliminate exhaustion-to-business-failure for the specified transient classes.
- [ ] Specify and implement atomic ownership transfer between an ordinary delivery and recovery; reconcile crashes before/after durable scheduling and before/after queue publication.
- [ ] Preserve accepted ERP results across local persistence failure. Reconcile uncertainty before concluding failure or issuing unsafe duplicate work.
- [ ] Persist the mock ERP's canonical confirmation ledger and request identity. Ensure concurrent duplicate requests and process restarts return the same confirmation.
- [ ] Ensure recovery publication limits cannot silently become a second ERP failure budget. Identity defects fail the order as a technical failure (D03).
- [ ] Preserve correlation lineage and keep canonical success/idempotency evidence for as long as unresolved work can reference it.

**Validation / exit:** more transient failures than the former four-attempt limit still converge after recovery; permanent rejection remains terminal; delayed replay does not produce an attempt-identity contradiction. Integration tests cover queue redelivery, crash windows, ERP success followed by lost response, worker restart, and mock ERP restart without duplicate effects.

### Phase 3 — Implement declared-capacity dispatch and ERP resilience (revised by task 17b)

**Depends on:** Phase 2. **Ownership:** API queue-limit lifecycle, worker application services, and BullMQ adapters.

- [ ] Apply native queue rate/concurrency limits from the accepted snapshot before traffic, and restore catalog defaults at terminality/reset.
- [ ] Route initial attempts, retries, and applicable reconciliation calls through that authority; successful local-result reuse should not spend an ERP-call permit.
- [ ] Schedule denied work without held connections or sleeping active jobs. Bound deferred-job wake-ups and avoid starvation/retry storms.
- [ ] Pause queue delivery on 429 and resume at the configured rate after cooldown. Keep capacity feedback separate from availability accounting and retain limited outage probes.
- [ ] Add and consume valid `Retry-After` information; use safe local backoff when absent or invalid. Respect cooldowns without trusting arbitrary unbounded resource allocation.
- [ ] Handle increasing latency with the in-flight ceiling and bounded adaptive request deadlines. Do not convert missed network deadlines into permanent rejection.
- [ ] Restore durable cooldowns after restart, reapply configured limits on API startup, and reuse retained queue metadata on worker restart. Preserve scope isolation without multiplying an actual shared quota.

**Validation / exit:** deterministic clock-based tests prove bounded concurrent calls, cooldown, and circuit safety. Real Redis/BullMQ tests prove evenly spaced dispatch from the first second, backlog-independent throughput, native pause/resume, restart retention, terminal/reset defaults, and durable recovery. Low-capacity scenarios produce identical business outcomes at different supported worker concurrency settings.

### Phase 4 — Align run completion, recovery, and maintenance

**Depends on:** Phases 1–3. **Ownership:** API finalization/maintenance services, worker recovery adapters, DB/Redis lifecycle helpers.

- [ ] Replace automatic business-drain failure with an elapsed-target warning while work remains recoverable.
- [ ] Keep traffic outcome evidence distinct from business settlement; retain final reports only at genuine settlement. An admin reset writes only its basic history line (D02).
- [ ] Keep order, accepted-result, and notification recovery enabled throughout draining. Require one notification record per confirmed order before normal completion.
- [ ] Preserve terminal publication locks and exact cleanup fencing. Ensure normal finalization cannot race a still-required publication.
- [ ] Make reset destructive and fast (D02): stop the run, keep one basic history line, delete the run's internal data regardless of outstanding work, and never wait on the ERP. Never reopen buying.
- [ ] Reset automatically any run still nonterminal 900 seconds after acceptance, through the same workflow (D10).
- [ ] Exclude permanently ineligible terminal work from repeated recovery selection without hiding unresolved active work.
- [ ] Remove lifecycle dependence on the fixed drain timeout and audit eligibility TTL, inventory/idempotency retention, recovery leases, and cleanup selection. Keep expired admission state fail-closed.
- [ ] Retain one-nonterminal-run admission and prevent retention cleanup and exact teardown from deleting unfinished obligations. Only a reset discards them.

**Validation / exit:** advancing beyond the former 300-second deadline leaves an unfinished run recoverable; completing late orders records all notifications before finalization. Tests cover finalization/publication races, destructive reset with in-flight work, the automatic reset deadline under an injected clock, retention exclusion, and long-lived state/expiry boundaries. The immutable final report matches settled durable records.

### Phase 5 — Enforce estimated-duration admission

**Depends on:** Phases 3–4 and their initial measurements. **Ownership:** API estimation/run-start/policy services and shared contracts.

- [ ] Implement the small pure estimation model described in Section 7, behind the API-owned estimator service.
- [ ] Handle both current traffic modes, duplicates, stock/quantity, latency floor, effective concurrency, transient-error assumptions, and notification/adaptation overhead.
- [ ] Calibrate a conservative admission margin against observed corrected-runtime scenarios. Record assumptions and limitations; do not claim unsupported probabilistic guarantees.
- [ ] Add the 600-second initial policy and its deployment ceiling through the existing effective-policy boundary, for public and admin modes alike; keep unrelated run-start and parameter budgets intact.
- [ ] Expose an authenticated/bounded estimate preview using the existing public/admin access model. Prevent previews from reserving visitor starts or creating runtime state.
- [ ] Recompute against authoritative configuration at start and reject before side effects (D12). Do not persist the estimate.
- [ ] Add structured rejections with estimated duration, ceiling, bottleneck, and useful adjustment guidance.

**Validation / exit:** test just-below/equal/just-above policy boundaries, unestimable scenarios, duplicate attempts, zero accepted stock, and a preset changed between preview and start. Rejected starts create no run/inventory/k6 work and consume no public start budget. The incident fixture remains admissible. Existing public surge presets remain available with supported calibrated estimates.

### Phase 6 — Explain admission and runtime progression in the dashboard

**Depends on:** Phases 4 and 5. **Ownership:** web presentation/components, API projection services and contracts.

- [ ] Before launch, show whether the configuration is allowed; when it is rejected, show the estimated duration, bottleneck, limit, and what to adjust.
- [ ] Handle asynchronous preview results without allowing a late response for older inputs to overwrite newer ones. Retain authoritative API rejection handling even when the button was enabled.
- [ ] Show outstanding work, oldest outstanding age, observed confirmation rate, and one downstream status (D13). Do not project controller internals or per-reason counts.
- [ ] From 600 seconds after acceptance only, show the grace-period notice with the time left before the automatic reset (D10).
- [ ] Distinguish traffic finished, business processing ongoing, a run cancelled by admin or automatic reset, and actual settled result. Show confirmed, business-rejected, and technically failed totals separately.
- [ ] Keep final notification/order counts coherent and preserve existing bounded public reads and SSE recovery.

**Validation / exit:** component/API tests cover allowed/rejected preview, out-of-order preview responses, slow progress, finite outage, the grace notice appearing only after 600 seconds, and late completion. Browser verification demonstrates one accepted low-capacity run and one budget rejection. No customer storefront or per-order public feed is added.

### Phase 7 — Prove the narrative and update authoritative documentation

**Depends on:** Phases 1–6. **Ownership:** boundary tests, runtime verification tooling, documentation.

- [ ] Implement the acceptance matrix below with deterministic tests for policy/timing and isolated infrastructure tests for durable boundaries.
- [ ] Add focused runtime verification for the original incident, actual mock-erp stop/start outages, and stable latency exceeding the initial deadline; retain exact generated-run cleanup and attributable failures. Accepted snapshots override global chaos controls. Verify capacity decrease/recovery only in-process through the existing `resolveConfig` seam with real PostgreSQL, Redis and BullMQ, and mark it blocked in Compose because the mock honors the accepted snapshot.
- [ ] Keep routine verification short. Separate explicitly invoked long-running resilience experiments from the ordinary smoke path; do not silently enlarge composition/characterization suites.
- [ ] Measure completion, progress, pacing, 429 pressure, restart behavior, and estimate error. A run that eventually finishes by hammering the ERP does not pass.
- [ ] Update README, architecture, lifecycle/entity documentation, scope/caveats, local configuration reference, project description, and delivery constraints to describe the implemented guarantee and its limits.
- [ ] Publish reproducible local evidence with environment, scenario, expected/actual counts, timing, controller policy version, and estimator version. Do not present it as a hosted production benchmark.

**Validation / exit:** all acceptance gates pass; docs, schemas, implementation, and tests agree. No favorable-preset-only QA conclusion remains as the evidence for adaptive resilience.

### 11. Acceptance matrix

| Scenario | Required evidence |
| --- | --- |
| Original incident: 1,500 attempts, 888 stock, ERP 10/s and 250 ms | 888 unique reservations, 612 sold-out responses, 888 confirmations, 888 notifications, zero saturation-induced terminal orders; admissible under the demo estimate policy |
| Same downstream conditions at several supported worker concurrency levels | Same business totals; ERP call rate/in-flight limits respected; no additional terminal errors from more worker capacity |
| Low ERP capacity and sufficient finite stock | Backlog retained and demonstrably draining; no exhaustion failure after the old attempt budget |
| Capacity drops and later recovers | Native Retry-After pauses, return to configured declared rate, bounded retry pressure, no starved accepted orders |
| Latency increases beyond the initial request deadline | Uncertainty retained, no duplicate external effect, successful eventual reconciliation |
| Finite ERP outage | Sparse probes/backoff during outage, automatic resumed processing, no invented permanent rejection |
| ERP accepts but response is lost; ERP and worker restart | One canonical confirmation, one confirmed order, one notification |
| Persistence or queue publication fails around retry handoff | Durable recovery intent survives; no lost obligation or competing schedule owners |
| Work exceeds the old drain deadline | Visible nonterminal processing; late notifications remain possible; final report produced at settlement |
| Run still nonterminal 900 seconds after acceptance | Grace notice shown from 600 seconds only; automatic destructive reset at the deadline, including after an API restart; one basic `auto_reset` history line; a successor can start |
| Permanent rejection, authentication failure, malformed response, or invalid identity | The order fails terminally with the right category and code; no retry; other orders and the run carry on to normal completion |
| Estimate exceeds 600 seconds or is unsupported | Actionable start rejection, no run/stock allocation/traffic, no burned visitor budget |
| Duplicate-attempt scenario | Estimator uses unique possible orders; downstream effects and notifications are unique |
| Admin reset or cleanup races with a call or publication | Reset completes without waiting on the ERP, purges the run's data, keeps one basic `admin_reset` history line, and a late worker write recreates nothing; retention and exact teardown never delete unfinished obligations; terminal fence preserved |
| Long-lived run crosses cached eligibility/hold timing | No accidental reopening or stock release; accepted work remains attributable and recoverable |
| Standard presets and zero-chaos smoke | Existing accounting, API responsiveness, stock invariants, history, notification, and SSE behavior preserved |

Use small finite workloads and injected clocks for most cases. Test timeout/warning semantics without making every test wait five or ten real minutes. Use real database, queue, and service restart tests where persistence boundaries are the behavior under test. Do not confuse a verification harness timeout with an application business deadline.

### 12. Validation commands and environment discipline

Format only touched supported files with `pnpm exec biome check --write <files>` and verify with `pnpm exec biome check <files>`. Biome may ignore Markdown; in that case, inspect the document and its local links directly without imposing manual line-width wrapping.

For implementation phases, run relevant focused tests, then `pnpm type-check` and the affected unit/API/integration lanes. Infrastructure-backed verification uses isolated test resources: `pnpm test:infra:up`, then the relevant test command or `pnpm test`. Follow the documented Linux/Dev Container execution path for application services and tests; Windows remains the Docker host.

Do not run `pnpm test:composition` or `pnpm test:characterization` unless explicitly requested. Identify the selected runtime/resources and avoid interference with concurrent work. The disposable development reference runtime may be wiped and used for isolated verification. Preserve unfinished obligations during recovery assertions, then export diagnostics and the actual verification result before reset/teardown; cleanup cannot convert failure into success.

Schema work follows the superseding incremental-migration decision in the [backlog guardrails](backlog/adaptive_erp/index.md#common-guardrails-and-reporting), with the requested final squash owned by task 21. Preserve required custom SQL and validate isolated migrations against empty and fixture-populated databases. Development database contents need not be preserved.

### 13. Completion checklist

- [ ] The incident configuration succeeds through notifications with the corrected engine and remains admissible.
- [ ] Temporary ERP constraints extend waiting rather than deterministically abandon valid accepted orders.
- [ ] More supported worker concurrency preserves business correctness and downstream protection.
- [ ] External success, uncertainty, scheduling, and restart behavior have durable, tested ownership.
- [ ] Ten-minute admission is enforced by the API; a runtime overrun fails no order, and the automatic reset frees the demo at 900 seconds.
- [ ] Run settlement, history, publication fencing, and cleanup agree about outstanding work.
- [ ] The estimator is calibrated, explainable, versioned, and separate from live worker adaptation.
- [ ] Conditions changed during a run and restart scenarios demonstrate the claim beyond favorable presets.
- [ ] Resource/retention bounds preserve unresolved obligations and required idempotency evidence.
- [ ] All project artifacts are in English, relevant checks are reported, and the final quality checklist is satisfied.
