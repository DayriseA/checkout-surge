# Issue 09 — Active Watch traffic self-exhausts recovery admission and can assemble incoherent completion outcomes

## Classification

- Priority: P1
- Status: Implemented and verified on 2026-07-20 with focused tests, isolated PostgreSQL integration, and live Preview 1k run `4860d5d2-1cf6-4b75-8b07-adf78d5f0054` observed through Watch
- Affected path: Watch realtime recovery, dashboard completion outcomes, active-run UI availability
- Audit run: Preview 1k run `3575d3a8-e5c2-4bcd-b715-9efdec026175`, summary `327598aa-ef7b-4cd5-a3c2-a989d04bbd60`
- Screenshot correlation: `b8fae91b-965d-4db0-b6fc-e53286d62692`

## Issue observed

Starting Preview 1k succeeded, but the open Watch page temporarily presented the runtime as unavailable:

- API readiness remained `ok` for PostgreSQL, Redis, and the order-processing queue.
- Recovery displayed `Live sync issue` and scheduled repeated ten-second retries.
- Recovery and Request Surge both displayed `Dashboard recovery request rate exceeded`, HTTP `429`, with the same correlation ID.
- Inventory and other recovery-derived panels lost their current data while the error was active.
- The errors disappeared without operator action after the recovery rate-limit window rolled over.

This was not a failed run. The durable history records `completed` after 12.678 seconds with:

- 1,000 planned, started, and completed requests;
- zero interrupted, unstarted, dropped, unexpected, or failed requests;
- 250 accepted reservations, confirmed orders, and recorded notifications;
- 750 sold-out responses;
- zero queued, processing, retrying, or pending-persistence work at finalization.

All eight reference services remained healthy with zero restarts. The product execution path was functional, but its primary live-observation surface became temporarily unavailable during the successful run.

## Runtime evidence

The configured recovery allowance is 12 requests per visitor in a fixed 60-second window. Within the `13:18:00` UTC window, the same signed visitor session made three successful recovery reads before the run and nine more successful reads after the run started. The next read exhausted the visitor budget.

| UTC time | Observation |
| --- | --- |
| `13:18:30.228` | Preview 1k started. |
| `13:18:31`–`13:18:34` | Watch issued nine successful recovery reads while active traffic produced SSE events. Several reads followed the previous response by only tens of milliseconds. |
| `13:18:34.977` | The next recovery read was rejected with `reason=source_rate` and HTTP `429`. |
| `13:18:42.906` | The backend run completed successfully while Watch still reported a sync failure. |
| `13:18:45.004` | Automatic retry received HTTP `429`. |
| `13:18:55.036` | Automatic retry received HTTP `429`; this is the correlation shown in `working_docs/temp.png`. |
| `13:19:05.060` | The next retry succeeded after the fixed limiter window changed, and the visible error disappeared. |

The two red `Unavailable` presentations in the screenshot are not independent backend failures. `RecoveryStatusPanel` and `RequestSurgePanel` render the same unavailable `BackendRead`, which is why their HTTP status and correlation ID are identical.

The API also logged two separate warnings during the run at approximately `13:18:32.290` and `13:18:34.408`:

```text
projection=dashboard_completion_outcomes
Dashboard recovery projection unavailable.

orderStatus=processing
displayStatus=notification_recorded
notificationRecordedAt=<timestamp>
```

The strict completion-outcome contract rejected that combination because a processing order may only display `processing`, `delayed`, or `retrying` and must not carry `notificationRecordedAt`.

## Identified causes

### 1. Every event overlapping recovery can create another immediate recovery

`OperatorDashboard` requests authoritative recovery whenever the SSE connection opens. In `useDashboardRecovery`, all SSE events received while that request is in flight are discarded and set `eventDiscardedRef`, regardless of event type or whether the event requires authoritative recovery.

After a successful recovery, the hook clears the in-flight request and immediately starts another recovery when the discarded-event marker is set. The follow-up is itself a new recovery window. If another event arrives while that follow-up is running, it schedules another immediate follow-up. Active runs publish frequent order-transition, consistency-lag, inventory, queue, lifecycle, and traffic-metric events, so the chain can continue for as long as recovery latency overlaps the event stream:

```text
recovery 1 -> event overlaps -> recovery 2 -> event overlaps -> recovery 3 -> ...
```

The coordinator prevents concurrent recovery requests, but it does not bound the number or cadence of serialized requests. A high-volume event stream therefore turns the recovery correctness mechanism into a request generator and deterministically collides with the API protection intended to reject abusive callers.

The temporary `429` then replaces the previously available recovery state in `dashboardStateReducer`. Watch discards its last valid snapshot, resets recovery-derived advisory state, and renders the same failure in multiple panels. This magnifies a transient synchronization failure into an apparently broken dashboard.

### 2. Completion outcomes combine different PostgreSQL snapshots

`readRecentCompletionOutcomes` first selects order rows, then performs separate latest-notification and latest-ERP-attempt queries for every selected order. Under PostgreSQL's normal statement-level `READ COMMITTED` behavior, those queries need not observe the same database snapshot.

The worker correctly permits notification recording only after an order is confirmed, but the projection reader can interleave with those durable transitions:

1. The order query observes an order as `processing`.
2. The worker confirms the order and subsequently records its notification.
3. The later notification query observes the newly recorded notification.
4. The reader combines the stale processing order with the newer notification.
5. `deriveCompletionOutcomeStatus` selects `notification_recorded` whenever a notification exists and includes `notificationRecordedAt`.
6. `completionOutcomeSchema` correctly rejects the lifecycle-incoherent result.

`DashboardRecoveryService` catches the projection exception through `readSafely`, logs a warning, and substitutes an empty `recentCompletionOutcomes` array. Recovery can still return HTTP `200`, but the completion-outcome panel temporarily loses valid data and the contract violation is visible in API logs.

## Backlog and review provenance

The first defect is rooted in the Task 26 requirement to discard events during recovery and request exactly one serialized follow-up. The implementation satisfies that local rule, but neither the requirement nor its tests define a bound across consecutive recovery windows. Existing hook and browser tests inject an event into the first deferred request, assert a second request, and stop producing events before the second request runs. They do not model a continuous stream where every follow-up also overlaps an event.

Issue 03 legitimately removed Compose probes from the recovery path, introduced signed per-visitor identity, and added bounded failure retries. Its live recovery soak is intentionally idle, and its deterministic retry test covers `429` followed by `200 idle`. It therefore proved the earlier probe-induced exhaustion was fixed but did not cover active Watch traffic self-exhausting the same visitor budget. The Issue 03 statement that recovery avoids request storms is not established for active runs.

The second defect follows Task 78's valid contract hardening. That task assumed completion-outcome producers were already coherent and strengthened the boundary schema without adapting the multi-query projection reader. Static contract fixtures and the existing DB integration fixture contain already-coherent rows, so they cannot expose the cross-statement confirmation/notification race. Task 78 also records that Docker-backed integration suites were unavailable during its verification.

These are two localized observation-layer regressions rather than evidence that load execution or durable business processing failed:

- Task 26 specified a locally correct but systemically unbounded recovery rule, and later verification did not exercise it under sustained events.
- Task 78 introduced appropriate validation but missed a concurrency inconsistency in a production DTO assembler.

## Recommended fixes

### A. Make realtime recovery event-aware and bounded

1. Replace the unconditional discarded-event marker with reason-aware reconciliation. Ordinary order and metric events must not automatically request an authoritative snapshot solely because they arrived during a recovery.
2. Buffer or coalesce events received during recovery and replay eligible events through the existing scope and watermark reducer after the authoritative snapshot is applied. Bound retained events by the existing per-projection/per-order policies rather than keeping an unbounded raw queue.
3. Reserve a trailing authoritative recovery for events that genuinely require it, such as an accepted new-run scope or a matching lifecycle transition that cannot be safely reconciled from the event. Multiple such signals within one recovery generation should coalesce.
4. Define an overall cadence or recovery-generation boundary so an event arriving during the trailing recovery cannot recursively create an unlimited sequence. The required invariant is that continuous SSE traffic cannot cause continuous recovery reads; recovery request volume must be bounded independently of event volume.
5. Preserve Issue 05's terminal-transition convergence. A terminal signal racing a stale recovery must still produce an authoritative read, but high-volume advisory events must not multiply that read.
6. Keep the API per-source and global recovery limits intact. Raising or removing the 12-per-visitor limit would hide the client defect and weaken abuse protection.
7. As defense in depth, consider returning the actual remaining fixed-window delay in `Retry-After` rather than the constant ten-second value. This would avoid repeated known-to-fail retries, but it is not a substitute for fixing the request chain.

### B. Preserve last-known-good Watch data across transient sync failures

1. Model the latest successful recovery snapshot separately from the current refresh error/status.
2. When Watch already has an authoritative snapshot, a later `429` or `503` should retain that data, mark it stale or synchronization-degraded, and display one clear recovery warning.
3. Initial public or admin recovery failure may still block safety-sensitive start decisions until an authoritative state is known. Do not reuse the Watch last-known-good presentation rule to weaken run-start gating.
4. Avoid rendering one recovery failure as multiple independent panel failures. Panels may show stale/no-new-data indicators while a shared synchronization banner owns the transport error and correlation ID.

### C. Make completion-outcome assembly snapshot-consistent

1. Read each order, its latest notification, and its latest ERP attempt from one statement-level PostgreSQL snapshot, preferably using a single query with joins or lateral subqueries. This also removes the current per-order N+1 query pattern.
2. Derive notification presentation only from a row whose observed order state is confirmed. Do not weaken `completionOutcomeSchema` to admit processing orders with notification metadata.
3. If a single-query projection is not practical, use an explicit snapshot-consistent transaction for the complete read and keep all queries on the same transaction/session. A simple retry or post-hoc schema catch is not sufficient unless it guarantees a coherent returned DTO.
4. Keep `DashboardRecoveryService`'s per-projection degradation behavior so one optional panel cannot fail the entire recovery response, but ensure the normal active-run path no longer reaches that degradation for valid concurrent transitions.

### D. Add tests at the affected boundaries

1. Add a hook-level sustained-event test where an event arrives during every recovery response. Assert that request count remains bounded and does not grow once per event or once per completed read.
2. Add browser-level coverage with a high-volume mix of order, metric, scope, and terminal events. Assert that Watch retains valid state, requests only the bounded authoritative reads, and still converges to terminal state.
3. Add a live reference-runtime regression that keeps Watch connected through Preview 1k and inspects recovery decisions across the full run. It must fail on any visitor `source_rate` rejection caused by the standard UI workflow.
4. Add a deterministic DB concurrency test that pauses completion-outcome assembly after observing a processing order, confirms the order and records its notification, then resumes. The reader must return a contract-valid coherent outcome without logging projection degradation.
5. Add a regression proving a failed refresh preserves the last successful Watch snapshot while exposing the sync problem separately.
6. Retain the existing Issue 03 idle soak and Issue 05 terminal-overlap regressions; the fix must satisfy both rather than trading one convergence problem for another.

## Acceptance criteria

- [ ] A standard Preview 1k run with Watch open produces no browser-induced `dashboard_recovery_rate_limited`, `source_rate`, or `global_rate` recovery decision.
- [ ] Recovery request count remains bounded under a continuous valid SSE stream and stays comfortably below the default 12-per-visitor window without relying on a higher configured allowance.
- [ ] New-run and terminal transitions still converge through authoritative recovery, including the Issue 05 stale-recovery/terminal-event overlap.
- [ ] A transient recovery failure does not erase an already available Watch snapshot or present one HTTP failure as multiple independent backend outages.
- [ ] Initial recovery failure continues to block public/admin run starts where authoritative state is required.
- [ ] Completion-outcome reads remain valid during concurrent processing-to-confirmed and notification-recorded transitions.
- [ ] The reference API no longer logs `dashboard_completion_outcomes` schema warnings during Preview 1k.
- [ ] Strict lifecycle contracts and existing API recovery admission limits remain unchanged.
- [ ] Durable run summary, traffic accounting, business outcomes, and service health remain equivalent to the successful audit run.
- [ ] Focused web hook/browser tests, DB integration tests, the Issue 03 recovery soak, and the active-run runtime regression pass.

## Scope guard

Restore reliable observation of the existing run. Do not redesign the dashboard, replace SSE, raise or remove recovery admission limits, relax lifecycle contracts, change load-generation semantics, or alter reservation, queue, ERP, notification, finalization, or history behavior unless a narrowly required compatibility correction is proven at the affected boundary.
