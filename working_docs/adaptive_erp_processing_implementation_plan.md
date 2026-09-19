# Adaptive ERP Processing and Bounded Demo Admission

Status: proposed implementation plan; no runtime changes are implemented by this document.

Date: 2026-09-19.

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
| [Run configuration](../apps/worker/src/application/run-config.ts) | Sends frozen ERP behavior with each confirmation | Let the mock apply a reproducible changing environment independently of worker adaptation |
| [Run start service](../apps/api/src/services/demo-run-service.ts) | Validates parameter bounds and run budgets | Add an authoritative estimated-duration admission decision |

Some existing tests explicitly require temporary retry exhaustion to fail an order. Those tests encode the old policy and must change with the specification. Passing them is not evidence that the desired resilience property holds.

### 4. Target guarantees

For a finite set of valid accepted orders, provided infrastructure remains recoverable and the ERP eventually provides enough successful processing opportunities:

1. Reservations never exceed allocated stock.
2. Every accepted order remains durably accounted for until confirmation, explicit permanent rejection, or an explicit administrative disposition.
3. Temporary saturation, increased latency, and finite outages do not by themselves cause terminal business failure.
4. More worker capacity does not bypass ERP admission or worsen the business outcome through overload-induced abandonment.
5. Retries do not create duplicate external confirmations or duplicate notifications.
6. A run is not presented as business-complete while orders, uncertain confirmations, required recovery, or notifications remain unresolved.
7. Restarting a supported service preserves outstanding work and does not trigger an uncontrolled retry burst.
8. Capacity adaptation and waiting are visible, including the reason for waiting and the age of outstanding work.

Occasional capacity responses during adaptation remain possible. The guarantee concerns retained work and business outcomes, not the elimination of every transient HTTP error. A permanent ERP rejection, inconsistent identity, or genuine software defect must remain distinguishable and actionable.

### 5. Separate processing resilience from demonstration limits

| Processing engine | Portfolio admission policy |
| --- | --- |
| Adapts to observed ERP responses and latency | Uses the declared scenario to estimate runtime |
| Retains orders across temporary constraints | Rejects experiments expected to occupy the demo too long |
| Uses bounded individual calls and spaced retries | Limits admitted traffic, stock, and accessible chaos controls |
| Completes according to business evidence | Explains the estimated bottleneck and duration before launch |
| Reports a prolonged or blocked workflow | Never injects an arbitrary order-failure deadline |

Use **600 seconds as the initial estimated demo-occupancy ceiling**. Measure occupancy from run acceptance through expected business settlement, including start delay and notifications, rather than only k6 execution. Keep this setting in the effective demo policy with a deployment ceiling, not in worker business logic. Apply it to dashboard-launched presets and custom runs in both public and admin modes. Exceptional diagnostic execution belongs to a protected test/runtime path with explicit isolation; do not add a routine dashboard bypass.

The ten-minute check is a conservative admission estimate, not a promise or an automatic runtime cancellation. An admitted run can exceed it because actual conditions differ. Such a run stays visible and recoverable, with an over-budget indication. Retain the supported one-nonterminal-run rule. Explicit admin reset/cancellation remains the way to release an experiment that cannot complete; its semantics must be truthful about work already accepted externally.

A hard wall-clock termination feature is outside this implementation unless separately specified. It must not be introduced implicitly through a cleanup timer or retry limit.

### 6. Target processing design

#### 6.1 One downstream admission authority

All ERP calls, including retries and reconciliation calls that consume ERP capacity, pass through one worker-owned admission authority for the same downstream capacity scope. In the current isolated mock, this scope can remain the run because the mock applies quotas per run. A real shared ERP credential/quota would require one shared scope across all traffic using it.

Admission combines an adaptive launch rate, evenly paced starts, a bounded in-flight limit, and a shared cooldown. Worker concurrency is a resource ceiling, not permission to exceed the downstream rate. A denied permit schedules a future wake-up without holding a worker slot, database transaction, or connection open.

Start conservatively. Increase the launch rate gradually after stable progress, reduce it promptly on saturation, and honor valid ERP retry guidance. Coalesce feedback from one concurrent rejection wave so that ten simultaneous 429 responses do not apply ten successive rate reductions. Avoid accumulating a large burst allowance during idle or outage periods. After an outage, resume through a limited probe and gradual ramp-up.

Keep the adaptive policy small and deterministic under an injected clock. Establish initial rates, observation windows, reduction factors, and minimum useful probe cadence through tests and calibration, then freeze them as a versioned policy. Do not claim exact capacity discovery or optimal throughput.

The supported runtime still has one worker process. Use that single authority for atomic admission and retain restart-relevant cooldown/work timing durably. A distributed limiter and multiple worker replicas are outside scope; documentation must not imply that independent per-process gates would safely share a quota.

#### 6.2 Explicit outcome classification and durable scheduling

| Outcome | Disposition |
| --- | --- |
| Local admission unavailable | Deferred work; no ERP call and no ERP attempt |
| Capacity rejection | Update pacing/cooldown; retain and reschedule the order |
| Temporary dependency unavailability | Capped backoff with jitter; circuit protection and sparse probes |
| Timeout or response lost after dispatch | Uncertain external outcome; reconcile using the stable business idempotency key |
| Known permanent business rejection | Terminal business failure with an attributable reason |
| Authentication/configuration failure, malformed protocol, or contradictory identity | Visible intervention state; avoid endless hot retries or invented business rejection |
| ERP success followed by local persistence failure | Retain accepted-result recovery ownership and finish local transitions |

Separate three identities: the stable order/ERP idempotency key, queue delivery identity, and individual ERP-call identity. Actual calls must remain auditable even when capacity deferrals do not consume an error budget. Record dispatch intent before an external call so a crash cannot erase the existence of an uncertain attempt.

Extend the existing worker recovery workflow to own deferred downstream work instead of introducing another independent recovery scanner. Persist the next eligible attempt time, waiting reason, and publication ownership. BullMQ supplies wake-ups; PostgreSQL retains the business obligation and recovery intent. Define one scheduling owner per order at each handoff, including initial dispatch, delayed delivery, and recovery publication. Repeated scans or duplicate deliveries must not create overlapping logical work or starve older orders.

Replace order-abandonment limits for transient ERP conditions with operational alerts and durable intervention where necessary. Bound individual work, scan batches, retry frequency, and diagnostic retention. Do not require unbounded memory or unbounded attempt-history growth to retain an unresolved order and its canonical external-success evidence.

#### 6.3 Latency and external idempotency

Distinguish a network request deadline, an expected processing duration, and a genuine business expiry. A network deadline bounds resource use; it does not prove the ERP rejected an order.

Adapt request deadlines conservatively from observed latency within explicit bounds. Repeated timeouts must not produce aggressive overlapping calls. If latency exceeds the maximum deadline, retain uncertainty and use safe reconciliation rather than declaring business failure. A late success must dominate an earlier locally observed timeout.

Persist the mock ERP's idempotency ledger, including immutable request identity and canonical confirmation result, and serialize concurrent duplicate acceptance. Keep this ERP-owned ledger separate from worker success records even if the reference runtime uses the same PostgreSQL service. Define a durable lookup or idempotent replay path for uncertain results. No distributed transaction between worker and ERP is required.

For a future real connector, durable idempotency or an authoritative status lookup is an explicit integration requirement. Exactly-once external effects cannot be inferred solely from the worker's local records.

#### 6.4 Truthful lifecycle and inventory retention

Traffic completion closes new experiment traffic and starts draining; it does not close outstanding processing. An elapsed processing target sets an operational warning. Finalization waits for durable business and notification settlement, or an explicitly defined administrative disposition.

Retain terminal publication/cleanup fencing. Change when terminality is reached rather than bypassing the fence to repair notifications. Active, waiting, and intervention-required work must remain protected from automatic deletion. Recovery queries must not repeatedly select ineligible terminal rows and thereby starve later recoverable work.

Review all time assumptions together: request deadlines, retry/recovery leases, reservation visibility expiry, run-sale eligibility TTL, idempotency retention, maintenance, and finalization. The current seven-day eligibility assumption is coupled to a bounded drain duration. Make long-lived processing independent of an admission-marker expiry; missing/expired markers must remain fail-closed for new buys. Do not reopen a sale when restoring processing state.

The current demo retains expired holds instead of automatically releasing them. Preserve that behavior for accepted work. Payment expiry and a full stock-release/cancellation business workflow remain outside scope.

### 7. Duration estimation and admission

The estimator belongs to an API application service. Shared contracts describe its inputs, result, and rejection details. The web app consumes the API estimate; do not duplicate a second authoritative formula in React or place application estimation logic in the contracts package.

Inputs include traffic shape and start delay, unique planned checkouts, stock and quantity, effective worker concurrency, declared ERP capacity and latency, finite outage/profile segments, error assumptions, and calibrated overhead for adaptation, persistence, and notifications.

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

For changing ERP profiles, integrate an explicit backlog against the declared service-capacity segments or use a documented conservative envelope. Include scheduled downtime once, at its defined place in the timeline. For independent transient errors, `1 / (1 - p)` can inform expected attempt demand, but is not a worst-case duration or a calibrated percentile. Include retry/cooldown costs and measured overhead; do not label a margin a confidence interval without evidence. Permanent outage, 100% permanent transient failure, or a profile with no supported recovery horizon has no admissible finite estimate.

Return an explanatory estimate and a conservative admission value, bottleneck, assumptions, policy/estimator version, ceiling, and allowed/rejected decision. Specify the exact boundary: admit when the conservative value is at most 600 seconds; reject above it. Reject unsupported/unestimable public scenarios with an actionable explanation rather than treating them as zero duration.

At actual start, resolve the authoritative preset/custom snapshot and effective policy and recompute the decision. Do not trust a browser-submitted estimate or stale preview. Reject before creating a run, allocating inventory, starting k6, or consuming the public visitor budget. Persist the accepted estimate and policy identity with the run for later comparison with actual timing. Preserve existing authentication, CSRF protection, hard caps, and one-run admission serialization.

For the incident, `min(10, 5 / 0.25) = 10` confirmations/second and `888 / 10 = 88.8` seconds of ideal service. The corrected scenario should remain admissible under ten minutes. Rejecting it to hide the worker defect is not an acceptable resolution.

### 8. Explicit scope limits

- Keep the existing service topology and queue technology. No new orchestration service or multi-worker deployment is required.
- Preserve the public 10,000-buyer burst target; do not lower traffic to make resilience checks pass.
- Keep the experiment finite and resource-bounded at admission. Indefinite recovery support is not unlimited intake.
- Add only the dynamic ERP profiles needed to prove degradation and recovery. A general chaos platform and public forced-outage controls are out of scope.
- Do not turn this into real payments, customer messaging, stock-release business logic, or a production-readiness claim.
- Preserve legitimate permanent failures and operator intervention. Do not make every error retry forever.
- Do not change or delete the incident's historical records as part of implementing the fix.

## Part II — Locked design decisions

The choices below resolve the questions Part I left open. They are binding for Part III unless the user explicitly reopens one. Identifiers D01–D14 are stable references for reviews, tests, and commit messages. Numeric constants named here are initial values subject to the calibration rules of D14; the structural rules are not.

### 9. Decisions D01–D14

#### D01 — Keep the existing lifecycles; add an operational dimension

**Decision.** Orders keep `queued | processing | confirmed | failed`; runs keep `starting | active | draining | completed | failed`. No lifecycle status is added for waiting, uncertainty, or intervention.

- Every order under downstream processing has exactly one durable control record (D04). It carries the operational situation: waiting reason (`local_admission`, `erp_capacity`, `erp_unavailable`, `uncertain_result`, `intervention_required`, or none), next eligible time, the identity of a dispatched call whose outcome is unknown, and the intervention reason when one applies.
- Run-level views derive from those records: counts of orders waiting by reason, uncertain calls, interventions, oldest outstanding age, plus the elapsed-time indications of D13. The run status itself does not encode them.
- A terminal order failure keeps status `failed` with a closed failure-code vocabulary grouped into two categories: `business_rejection` (a permanent ERP rejection recognized under D03) and `administrative` (D02). Technical problems never terminalize an order; they are intervention situations on a nonterminal order.
- Normal run completion requires: no order in `queued` or `processing`, no unresolved uncertain call, no open intervention, and one notification record per confirmed order. An intervention never counts as "finished enough".
- Reports show confirmed, business-rejected, and administratively disposed orders as separate totals. "Processing finished" does not mean "all orders confirmed".

#### D02 — Reset stops the experiment; it does not undo external effects

**Decision.** Option B. Reset closes buying and traffic, forbids new ERP dispatch, disposes orders that provably have no ERP effect, keeps acquired confirmations and notifications, and reconciles already-dispatched calls before releasing the run.

- Contract statement: *Reset stops the experiment. It does not retroactively cancel its external effects and it does not release reserved stock.*
- Sequence: (1) persist an administrative-stop marker on the nonterminal run and move it to `draining` with traffic status `failed` when traffic had to be aborted; (2) close sale eligibility, abort traffic, and fence dashboard ingestion as today; (3) terminalize every order without a dispatched ERP call and without a recorded ERP outcome as `failed` with an administrative failure code; (4) let the worker's normal recovery path resolve dispatched-but-uncertain calls through D05 without any new business dispatch, and let confirmed outcomes still produce their notification record; (5) once no uncertain call remains, finalization writes `failed` / `admin_reset` with the settled counts.
- The run is not terminal before step 5. The terminal publication fence therefore still admits late notifications of reconciled successes. The one-nonterminal-run rule keeps a successor blocked until step 5.
- The reset HTTP request stays bounded as today. When step 5 is not reached within the request, the response says the reset is in progress and reports disposed, confirmed, and still-uncertain counts; calling reset again resumes the workflow through the existing incomplete-reset pattern.
- The set of calls to reconcile is exactly the set recorded as dispatched without terminal outcome (D04). Reset never guesses.
- Accepted limit: when the ERP cannot answer lookups, reset stays incomplete and visibly so. That is preferred to a reset that looks clean but is not. Option C (moving uncertain obligations into a separate post-closure case file) is rejected for scope.

#### D03 — Explicit resume after intervention; automatic recovery for transient conditions

**Decision.** Option B.

- Automatic recovery classes, no human action: capacity (`429` / `erp_capacity_exceeded`), recognized unavailability (`503` with a recognized code such as `erp_forced_outage` or `erp_injected_error`, connection errors), and request timeouts.
- Intervention classes: authentication or authorization responses (`401`, `403`), malformed protocol (a response body that fails the contract), identity contradiction (`409 erp_idempotency_conflict` from the ERP, or a local `ErpAttemptContradictionError`), and any response code outside the recognized vocabulary. An unknown `4xx` is not a business rejection. An opaque `5xx` after dispatch is not proof of absence of effect.
- Blocking scope: identity contradiction and malformed protocol block only the affected order. Authentication or authorization failure blocks the affected downstream scope (one run, or the catalog). Nothing blocks the whole worker.
- Only a permanent business rejection listed in the shared ERP error vocabulary can terminalize an order as `business_rejection`. The current mock emits none; adding one requires the contract entry first.
- Before any terminal conclusion, the worker resolves an earlier uncertain call for the same order (D05).
- Resume is an authenticated admin control on one order or one scope. It clears the intervention marker and reschedules the existing control record. It never rewrites order identity or the accepted snapshot.

#### D04 — One durable owner per order from the first ERP call

**Decision.** Option B.

- Before its first ERP call, the worker creates or claims the order's single control record, an extension of the existing recovery row with one row per order, in the same transaction as the `queued -> processing` transition. There is no ownerless initial path.
- Control record fields: processing generation, lease expiry, next eligible time, waiting reason, publication ownership, intervention reason, and the identity of the dispatched call, written before the HTTP request is sent.
- BullMQ deliveries (initial, delayed, recovery) are wake-ups only. A delivery whose generation does not match the control record is acknowledged without work. BullMQ `attempts` is 1 for order-process jobs; delivery retries are no longer an error budget.
- The claim is atomic (`SELECT ... FOR UPDATE SKIP LOCKED` or one conditional update). Eligibility (next eligible time reached, lease free or expired, no open intervention) is checked in the selection query and again at execution time before dispatch.
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

#### D06 — Additive-increase / multiplicative-decrease controller with paced starts

**Decision.** Option A.

- Per downstream scope (one run, or the catalog): a target launch rate, evenly spaced starts, and an in-flight ceiling equal to the smaller of the configured concurrency and the policy ceiling. No burst allowance accumulates during idle or outage periods.
- Additive increase after one observation window without capacity responses. Multiplicative decrease on the first capacity response of a wave; further capacity responses inside the same wave window apply no additional reduction.
- Rate floor, rate ceiling, step, reduction factor, window length, and wave window are policy constants (D14).
- `Retry-After` on `429` and `503`: both delay-seconds and HTTP-date forms are parsed. An invalid value falls back to local backoff. A value above the policy maximum sets a capped cooldown and is logged. The mock sends `Retry-After` in delay-seconds form.
- Capacity responses feed pacing only. Recognized unavailability, connection errors, and timeouts feed the availability circuit only. Circuit probes are the only traffic during an outage; probe cadence is a policy constant.
- A locally reused success (local record or D05 lookup) is not evidence of ERP health: it neither closes the circuit nor raises the rate. Feedback from a call dispatched before the latest reduction cannot undo that reduction.
- The controller never reads the run's declared capacity or the profile's future segments. It observes responses only.

#### D07 — Restore safety state after restart; relearn throughput

**Decision.** Option B.

- Persisted: dispatched-call intents (D04), cooldown and circuit-open expiries per scope, next eligible times, intervention markers. Not persisted: learned rate, observation windows, latency samples.
- Startup order: reconcile dispatched calls first (D05), then resume from the initial conservative rate. A still-running persisted cooldown or circuit-open expiry is honored; otherwise the circuit starts closed at the initial rate.
- A missing accepted run snapshot for a run-scoped job is an intervention on that job, never a silent fallback to the catalog scope.
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

#### D10 — Predefined versioned profiles anchored at planned traffic start

**Decision.** Anchor = run acceptance time + configured start delay, both taken from the durable accepted snapshot. Profiles are predefined admin presets, versioned in contracts. No free segment editor.

- A profile is: identity, version, base `erpConfig`, an ordered finite list of segments (offset from anchor, duration, latency / capacity / outage override), and a recovery tail equal to the base.
- The accepted snapshot stores the profile identity (none means constant conditions). The worker transports profile identity, base config, and anchor with each confirmation. The mock resolves the effective conditions when it admits the request, and those conditions stick to that request. The mock persists nothing for profiles; a restart cannot restart the timeline because the anchor is durable in the run snapshot.
- Initial profiles: capacity drop then recovery; finite outage; latency increase then recovery. Admin visibility only; the same profiles serve the acceptance tests. Public presets keep constant conditions and no outage.
- Tests that inject errors use the mock's injectable random source with a fixed seed.
- The worker's controller never receives the segment list.

#### D11 — Conservative admission envelope

**Decision.** Option B for the first version.

- Conservative value = start delay + traffic budget + ERP processing envelope + notification cost + calibrated margins. Traffic budget is `durationSeconds` for constant arrival and `maxDurationSeconds` for buyer spike. ERP envelope = N / r with N = unique acceptable orders (stock, quantity, unique buyers, not duplicated HTTP attempts) and r = min(declared capacity, C / L), L including the overhead floor.
- Profiles: integrate N against the capacity segments from the anchor; downtime is counted once at its place in the timeline.
- Error rate p: expected demand factor 1 / (1 − p) with a policy margin. A p above the policy maximum is unestimable and rejected.
- Sanity check with seeded presets before margins: incident fixture `60 + 888 / 10 = 148.8 s`; `surge-10k` `120 + 1000 / 250 = 124 s`. Both stay admissible with margins.
- The explanatory estimate may show the overlapped ideal; the admission decision uses the conservative value only.

#### D12 — Preview fingerprint with explicit re-confirmation

**Decision.** Option B.

- The preview response carries a fingerprint: a hash of the resolved snapshot, policy version, estimator version, and effective ceiling. The dashboard sends back the fingerprint it displayed.
- At start, after admission serialization, the API recomputes. A fingerprint mismatch returns a structured `estimate_stale` rejection carrying the fresh preview, before any side effect. A start request without a fingerprint (tooling, tests) gets no stale check; the recomputation alone decides.
- Web: only a preview matching the current inputs is rendered; the start button is disabled while a preview is pending. The preview endpoint uses the existing bounded public/admin access model, is rate limited like other reads, and creates no state, run slot, or budget consumption.

#### D13 — Versioned engine policy; presets keep scenario parameters only

**Decision.** Option B.

- Removed from presets, accepted snapshots, forms, readers, and the load-orchestrator journal: `retryPolicy` (`maxAttempts`, `initialBackoffMs`), `drainTimeoutSeconds`, `circuitBreakerFailureThreshold`, `circuitBreakerResetTimeoutMs`, and `erpConfig.requestTimeoutMs`.
- Kept: traffic, inventory (`startingStock`, `quantityPerCheckout`, `reservationHoldMinutes`), ERP latency, capacity, error rate, forced outage (admin), profile identity, `orderProcessConcurrency`, and `pendingPersistenceRetryAfterSeconds`, which belongs to reservation persistence and is unrelated to this work.
- Engine constants live in a versioned worker policy; its version is persisted with each run. None of them is editable from the dashboard.
- Persisted snapshots of earlier runs may still contain retired fields. History readers accept and ignore them; the incident's records are neither migrated nor rewritten.
- Run timing indications: *over accepted estimate* and *over occupancy ceiling*. Neither terminalizes the run. The 300-second drain timeout and `business_drain_timeout` disappear entirely.

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
- Deliverable: a calibration report with environment, fixture, measured value per target, chosen constants, and policy/estimator versions. The user approves the frozen constants before Phase 8 closes and before documentation advertises the guarantee.
- The throughput and pressure targets pull in opposite directions by design; the report explains the chosen trade-off rather than silently favoring one.

## Part III — Implementation plan

### 10. Sequencing and delivery rules

Implement the phases below in order, allowing tests/specification work to precede the associated code. Each phase must leave the repository runnable and carry its own focused validation. Do not advertise the full new guarantee until all acceptance gates pass. Coordinate schema/contract changes with all affected consumers in the same runnable slice.

All checkboxes below represent planned work, not completed work.

Before each phase, apply [the quality checklist](../docs/quality_checklists.md), identify its ownership boundary, and inspect the current code because this plan is a baseline rather than a substitute for implementation-time review. Part II decisions are binding; an implementation that needs to deviate from one must stop and obtain an explicit user decision rather than reinterpret it. Keep routes thin and instantiate infrastructure only in composition roots.

### Phase 1 — Define contracts and acceptance fixtures

**Ownership:** shared contracts and the application-service boundaries that consume them.

- [ ] Record the target outcome classification, durable scheduling ownership, and traffic/business/administrative completion semantics.
- [ ] Specify waiting/intervention reasons and distinguish observed ERP failures from terminal order outcomes. Prefer existing lifecycle states plus explicit operational reasons where sufficient.
- [ ] Define the ERP-call identity and uncertain-result lifecycle separately from BullMQ delivery counters.
- [ ] Define the estimator response, admission rejection, effective 600-second policy, accepted estimate snapshot, and over-budget observation.
- [ ] Inventory uses of `maxAttempts`, `drainTimeoutSeconds`, `requestTimeoutMs`, recovery attempt limits, run status, and terminal publication guards; identify every consumer requiring coordinated changes.
- [ ] Add a named fixture reproducing the incident configuration and small deterministic fixtures for low capacity, latency change, and finite outage.
- [ ] Document the policy defaults to calibrate and their measurable acceptance criteria before selecting constants.

**Validation / exit:** contract tests cover valid public/API-reachable states and the new distinctions; existing seeded scenario contracts still parse. An implementation checklist maps every changed behavior to an owning service and test. No public capability expansion is accidentally introduced.

### Phase 2 — Retain downstream work and make retries safe

**Depends on:** Phase 1. **Ownership:** worker application services/persistence, mock ERP application/persistence, DB schema.

- [ ] Introduce durable per-call identities and dispatch intent; update ERP attempt persistence and diagnostics so multiple calls cannot collide after a non-budget-consuming deferral.
- [ ] Implement explicit capacity, availability, uncertain, permanent-rejection, and intervention dispositions in the client/handler boundary.
- [ ] Extend the existing recovery workflow to retain deferred ERP work, due time, and reason. Eliminate exhaustion-to-business-failure for the specified transient classes.
- [ ] Specify and implement atomic ownership transfer between an ordinary delivery and recovery; reconcile crashes before/after durable scheduling and before/after queue publication.
- [ ] Preserve accepted ERP results across local persistence failure. Reconcile uncertainty before concluding failure or issuing unsafe duplicate work.
- [ ] Persist the mock ERP's canonical confirmation ledger and request identity. Ensure concurrent duplicate requests and process restarts return the same confirmation.
- [ ] Ensure recovery publication limits cannot silently become a second ERP failure budget. Retain operational escalation for actual persistence/identity defects.
- [ ] Preserve correlation lineage and keep canonical success/idempotency evidence for as long as unresolved work can reference it.

**Validation / exit:** more transient failures than the former four-attempt limit still converge after recovery; permanent rejection remains terminal; delayed replay does not produce an attempt-identity contradiction. Integration tests cover queue redelivery, crash windows, ERP success followed by lost response, worker restart, and mock ERP restart without duplicate effects.

### Phase 3 — Implement adaptive ERP admission

**Depends on:** Phase 2. **Ownership:** worker application services and BullMQ adapter.

- [ ] Extend/replace concurrency-only admission with one paced rate/concurrency/cooldown decision before actual ERP dispatch.
- [ ] Route initial attempts, retries, and applicable reconciliation calls through that authority; successful local-result reuse should not spend an ERP-call permit.
- [ ] Schedule denied work without held connections or sleeping active jobs. Bound deferred-job wake-ups and avoid starvation/retry storms.
- [ ] Implement gradual recovery, prompt capacity reduction, rejection-wave coalescing, and limited outage probes. Keep 429 capacity feedback separate from breaker outage accounting.
- [ ] Add and consume valid `Retry-After` information; use safe local backoff when absent or invalid. Respect cooldowns without trusting arbitrary unbounded resource allocation.
- [ ] Handle increasing latency with the in-flight ceiling and bounded adaptive request deadlines. Do not convert missed network deadlines into permanent rejection.
- [ ] Restore conservative controller behavior and durable cooldowns after restart. Preserve scope isolation without multiplying an actual shared quota.

**Validation / exit:** deterministic clock-based tests prove pacing, bounded concurrent calls, cooldown, stable recovery, and no repeated reduction per rejection wave. Real Redis/BullMQ tests prove deferral, progress, and no busy wake-up loop. Low-capacity scenarios produce identical business outcomes at different supported worker concurrency settings.

### Phase 4 — Align run completion, recovery, and maintenance

**Depends on:** Phases 1–3. **Ownership:** API finalization/maintenance services, worker recovery adapters, DB/Redis lifecycle helpers.

- [ ] Replace automatic business-drain failure with an elapsed-target warning while work remains recoverable.
- [ ] Keep traffic outcome evidence distinct from business settlement; retain final reports only at genuine settlement or explicit administrative disposition.
- [ ] Keep order, accepted-result, and notification recovery enabled throughout draining. Require one notification record per confirmed order before normal completion.
- [ ] Preserve terminal publication locks and exact cleanup fencing. Ensure normal finalization cannot race a still-required publication.
- [ ] Update admin reset/cancellation to describe partial external effects truthfully and settle or explicitly retain uncertain active calls. Never reopen buying or report undone ERP success without a compensation mechanism.
- [ ] Exclude permanently ineligible terminal work from repeated recovery selection without hiding unresolved active/intervention work.
- [ ] Remove lifecycle dependence on the fixed drain timeout and audit eligibility TTL, inventory/idempotency retention, recovery leases, and cleanup selection. Keep expired admission state fail-closed.
- [ ] Retain one-nonterminal-run admission, expose prolonged/intervention state, and prevent retention cleanup from deleting unfinished obligations.

**Validation / exit:** advancing beyond the former 300-second deadline leaves an unfinished run recoverable; completing late orders records all notifications before finalization. Tests cover finalization/publication races, reset with in-flight work, retention exclusion, and long-lived state/expiry boundaries. The immutable final report matches settled durable records.

### Phase 5 — Add reproducible changing ERP conditions

**Depends on:** Phases 2–4. **Ownership:** mock ERP application services, scenario contracts and runtime test setup.

- [ ] Add a minimal finite profile of timed latency/capacity/outage segments, with a defined initial state and recovery tail.
- [ ] Persist the scenario identity and time anchor so a service restart does not restart the experiment's timeline accidentally.
- [ ] Have the mock resolve effective conditions from that profile. Workers may transport scenario identity/setup data but must not read the future profile to choose live admission rates.
- [ ] Preserve constant-scenario behavior and existing public control restrictions. Keep outage profiles in protected verification/admin scope as appropriate.
- [ ] Expose enough scenario evidence to correlate observed adaptation with the injected change without exposing hidden future conditions to the controller.

**Validation / exit:** a declared capacity decrease and recovery change the mock during the same run; adaptation works without a worker configuration change. Profile boundaries and restart behavior are deterministic under test. Baseline preset behavior remains unchanged.

### Phase 6 — Enforce estimated-duration admission

**Depends on:** Phases 3–5 and their initial measurements. **Ownership:** API estimation/run-start/policy services and shared contracts.

- [ ] Implement the small pure estimation model described in Section 7, behind the API-owned estimator service.
- [ ] Handle both current traffic modes, duplicates, stock/quantity, latency floor, effective concurrency, finite profiles, transient-error assumptions, and notification/adaptation overhead.
- [ ] Calibrate a conservative admission margin against observed corrected-runtime scenarios. Record assumptions and limitations; do not claim unsupported probabilistic guarantees.
- [ ] Add the 600-second initial policy and its deployment ceiling through the existing effective-policy boundary; keep unrelated run-start and parameter budgets intact.
- [ ] Expose an authenticated/bounded estimate preview using the existing public/admin access model. Prevent previews from reserving visitor starts or creating runtime state.
- [ ] Recompute against authoritative configuration at start, reject before side effects, and persist the accepted estimate/version with successful starts.
- [ ] Add structured rejections with estimated duration, ceiling, bottleneck, and useful adjustment guidance. Define stale-preview behavior explicitly.

**Validation / exit:** test just-below/equal/just-above policy boundaries, unestimable profiles, duplicate attempts, zero accepted stock, and changed policy/preset between preview and start. Rejected starts create no run/inventory/k6 work and consume no public start budget. The incident fixture remains admissible. Existing public surge presets remain available with supported calibrated estimates.

### Phase 7 — Explain admission and runtime progression in the dashboard

**Depends on:** Phases 4 and 6. **Ownership:** web presentation/components, API projection services and contracts.

- [ ] Show estimated duration, identified bottleneck, and the demo limit before launch; make rejected configurations actionable.
- [ ] Handle asynchronous preview results without allowing stale responses to overwrite newer inputs. Retain authoritative API rejection handling even when the button was enabled.
- [ ] Show observed confirmation rate, controller pacing, bounded in-flight work, outstanding work, oldest outstanding age, waiting reason, and cooldown/probe state.
- [ ] Present over-budget draining as continued processing, with last progress and administrative recovery access where authorized.
- [ ] Distinguish traffic finished, business processing ongoing, intervention required, administrative cancellation, and actual settled result.
- [ ] Store/display estimated versus actual completion timing in history. Keep final notification/order counts coherent and preserve existing bounded public reads and SSE recovery.

**Validation / exit:** component/API tests cover allowed/rejected/stale preview, slow progress, finite outage, intervention, and late completion. Browser verification demonstrates one accepted low-capacity run and one budget rejection. No customer storefront or per-order public feed is added.

### Phase 8 — Prove the narrative and update authoritative documentation

**Depends on:** Phases 1–7. **Ownership:** boundary tests, runtime verification tooling, documentation.

- [ ] Implement the acceptance matrix below with deterministic tests for policy/timing and isolated infrastructure tests for durable boundaries.
- [ ] Add focused runtime verification for the original incident and changing conditions; retain exact generated-run cleanup and attributable failures.
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
| Capacity drops and later recovers | Prompt rate reduction, gradual recovery, bounded retry pressure, no starved accepted orders |
| Latency increases beyond the initial request deadline | Uncertainty retained, no duplicate external effect, successful eventual reconciliation |
| Finite ERP outage | Sparse probes/backoff during outage, automatic resumed processing, no invented permanent rejection |
| ERP accepts but response is lost; ERP and worker restart | One canonical confirmation, one confirmed order, one notification |
| Persistence or queue publication fails around retry handoff | Durable recovery intent survives; no lost obligation or competing schedule owners |
| Work exceeds the old drain deadline or accepted estimate | Visible nonterminal processing/over-budget status; late notifications remain possible; final report produced at settlement |
| Actual permanent rejection or invalid identity | Explicit terminal rejection or retained intervention as classified; no blind endless retry |
| Estimate exceeds 600 seconds or is unsupported | Actionable start rejection, no run/stock allocation/traffic, no burned visitor budget |
| Duplicate-attempt scenario | Estimator uses unique possible orders; downstream effects and notifications are unique |
| Admin reset/cleanup races with a call or publication | Truthful disposition; terminal fence preserved; no deleted active obligation or false rollback of ERP success |
| Long-lived run crosses cached eligibility/hold timing | No accidental reopening or stock release; accepted work remains attributable and recoverable |
| Standard presets and zero-chaos smoke | Existing accounting, API responsiveness, stock invariants, history, notification, and SSE behavior preserved |

Use small finite workloads and injected clocks for most cases. Test timeout/warning semantics without making every test wait five or ten real minutes. Use real database, queue, and service restart tests where persistence boundaries are the behavior under test. Do not confuse a verification harness timeout with an application business deadline.

### 12. Validation commands and environment discipline

Format only touched supported files with `pnpm exec biome check --write <files>` and verify with `pnpm exec biome check <files>`. Biome may ignore Markdown; in that case, inspect the document and its local links directly without imposing manual line-width wrapping.

For implementation phases, run relevant focused tests, then `pnpm type-check` and the affected unit/API/integration lanes. Infrastructure-backed verification uses isolated test resources: `pnpm test:infra:up`, then the relevant test command or `pnpm test`. Follow the documented Linux/Dev Container execution path for application services and tests; Windows remains the Docker host.

Do not run `pnpm test:composition` or `pnpm test:characterization` unless explicitly requested. Runtime smoke/reset can mutate a current run, so do not use the user's active reference runtime as an unannounced test fixture. Prefer an isolated verification runtime; preserve incident evidence before any intentional runtime rebuild.

Schema work must follow the repository's pre-release baseline policy in [local development](../docs/local_development.md): regenerate and review the baseline artifacts together, preserve required custom SQL, and validate the isolated test migration. Do not add a compatibility migration or silently wipe the user's reference data.

On Windows, before project commands in each new PowerShell process:

```powershell
$taskSavedPath = $env:PATH
Remove-Item Env:PATH -ErrorAction SilentlyContinue
Remove-Item Env:Path -ErrorAction SilentlyContinue
$env:Path = $taskSavedPath
```

Verify command resolution before reporting a missing dependency. Do not modify persistent environment variables.

### 13. Completion checklist

- [ ] The incident configuration succeeds through notifications with the corrected engine and remains admissible.
- [ ] Temporary ERP constraints extend waiting rather than deterministically abandon valid accepted orders.
- [ ] More supported worker concurrency preserves business correctness and downstream protection.
- [ ] External success, uncertainty, scheduling, and restart behavior have durable, tested ownership.
- [ ] Ten-minute admission is enforced by the API; a runtime overrun is not a business failure.
- [ ] Run settlement, history, publication fencing, and cleanup agree about outstanding work.
- [ ] The estimator is calibrated, explainable, versioned, and separate from live worker adaptation.
- [ ] Dynamic conditions and restart scenarios demonstrate the claim beyond favorable presets.
- [ ] Resource/retention bounds preserve unresolved obligations and required idempotency evidence.
- [ ] All project artifacts are in English, relevant checks are reported, and the final quality checklist is satisfied.
