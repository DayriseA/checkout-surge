# Cross-Service Conventions — Decisions & Rationale

This document defines the shared language that every service, contract, and UI surface in Checkout-Surge should use.

The goal is to preserve one canonical vocabulary across the implemented shared contracts, persistence models, observability paths, and UI surfaces.

---

## Confirmed Conventions

| Decision Area | Choice | Rationale |
| :-- | :-- | :-- |
| Vocabulary boundary | Keep reservation language and order language distinct | The project's core UX and architecture depend on fast reservation happening before slow final confirmation. |
| Event naming style | Use lowercase dot notation with domain-first names such as `reservation.secured` | Keeps emitted facts readable, stable, and consistent across logs, queues, and dashboard realtime payloads. |
| Correlation identifier name | Use `correlationId` as the canonical cross-service trace field | This aligns with the logger package and gives one shared thread across API, worker, ERP, and dashboards. |
| Timestamp format | Use ISO 8601 strings with an explicit timezone offset at service boundaries; services should emit UTC `Z` strings | This is explicit, portable, and easy to consume across logs, APIs, dashboard realtime payloads, and UI clients. |
| Error payload baseline | Standardize on a strict shared shape with a closed machine-code vocabulary, `message`, optional `details`, `correlationId`, and `timestamp` | Gives clients a stable contract while rejecting typoed or drifting public error codes. |
| Scope of this document | Define semantics and names; leave exact request/response payload schemas to the contract layer | Keeps this document focused on shared language rather than prematurely freezing every contract detail. |
| Reservation fact | A durable reservation row or Redis hold is secured by construction | The implemented demo has no durable rejected, released, or expired reservation producer, so a copied single-value status would not add meaning. |
| Order lifecycle | `queued`, `processing`, `confirmed`, `failed` | Matches the asynchronous pipeline while keeping business state distinct from retry metadata. |
| Queue naming convention | Use lowercase colon-separated semantic queue names with plural domain names by default; the first canonical queue is `orders:process` | Keeps queue names readable and extensible without overcommitting to future queue topology. |
| Metric naming convention | Use lowercase dot notation and reserve semantic names for benchmark and dashboard signals | Keeps dashboard, backend, and documentation vocabulary aligned to the benchmark story. |

---

## Reservation vs. Order

The repository must preserve a hard distinction between a reservation and an order.

- A reservation is the immediate outcome of the fast stock-hold path.
- An order is the longer-lived business record that progresses through asynchronous processing and ERP confirmation.
- A reservation being secured does not mean the order is already confirmed.
- UI labels, event names, database fields, and logs should avoid treating these concepts as synonyms.

This distinction is one of the central narrative and architecture rules of the project.

---

## Event Naming Convention

The project uses a simple event naming rule:

- lowercase
- dot-separated
- domain first
- fact second

Examples:

- `reservation.secured`
- `order.queued`
- `order.processing`
- `order.confirmed`
- `order.failed`
- `notification.recorded`
- `inventory.updated`
- `erp.attempt.failed`
- `erp.attempt.succeeded`

Avoid:

- mixed casing such as `OrderConfirmed`
- implementation-shaped names such as `processOrderJobStarted`
- UI-specific naming leaking into backend events

---

## Trace and Time Conventions

### Correlation IDs

- `correlationId` is the canonical trace field that must survive across service boundaries.
- The first externally visible request should create or adopt the `correlationId`.
- Logs, queue payloads, HTTP requests between internal services, and dashboard realtime events should propagate it.
- HTTP services use `x-correlation-id` as the transport header. Each inbound boundary normalizes or generates one value, returns it in the response header, and binds it to the request-scoped logger so routine Fastify logs are searchable without repeating the field at every call site.
- A route that promotes a validated body correlation ID must update the response header and request/reply loggers together. Per-request child bindings must not mutate the application logger or retain the previous request's correlation fields.
- Browser-facing Next.js proxy routes create one request context, forward only its normalized correlation ID plus explicitly allow-listed server-owned headers, and preserve the validated backend response correlation ID when reconstructing the browser response.
- Order-scoped correlation IDs, internal order IDs, and raw ERP error/result fields are prohibited on public pages and public projection content. The per-request envelope `correlationId` remains required in responses, headers, and error payloads so the visitor's own request can be traced.

### Timestamps

- Service-boundary timestamps should be expressed as ISO 8601 strings with an explicit timezone offset. Services should emit UTC `Z` strings.
- Timestamp field names should use the `At` suffix for instants, such as `createdAt`, `confirmedAt`, or `occurredAt`.
- Relative durations such as consistency lag should be represented separately from absolute timestamps.

### Presentation timezone, locale, and duration policy

The rules above govern the wire format. This section governs what a person reads on screen. The two are deliberately separate: contracts and persisted records carry exact machine values and never carry locale-formatted strings.

- **Timezone: labelled UTC everywhere, 24-hour clock.** The web application renders every user-facing instant as `2026-08-03 14:32:05 UTC`. A compact `14:32:05 UTC` form exists but is only used where adjacent context already fixes the calendar date, such as a series of samples inside one dated run. The zone label is never omitted. History pages are server-rendered, so viewer-local time cannot be produced deterministically; UTC keeps server rendering and client hydration in agreement about the same instant. Any route-orientation or timezone work elsewhere in the product should adopt this policy rather than introducing a second one.
- **Locale: `en-US` grouping**, applied through one shared `Intl.NumberFormat` instance. Counts, admin summaries, and deployment hard caps all group the same way, so a cap of `100000` reads `100,000`.
- **Durations at human precision.** Below one second, whole milliseconds (`847 ms`). At or above one second, seconds with at most one useful decimal and no trailing `.0` (`28.4 s`, `12 s`). At or above two minutes, minutes and seconds (`2 min 8 s`). At or above one hour, hours and minutes (`1 h 0 min`). Rounding is half-up and is applied before the tier is chosen, so `999.5 ms` reads `1 s`. Raw millisecond precision survives only inside technical-details and diagnostics blocks, and in the sanctioned exemptions listed below.
- **Missing is not zero.** The shared formatters return a sentinel for missing or unusable input so each field chooses its own missing-state wording. A generic formatter must never collapse missing, invalid, and zero into one string.
- **Formatting never carries meaning.** A shared formatter states how long something took; the label states which boundaries were measured. Actual traffic dispatch, configured maximum dispatch time, checkout response, simulated ERP call, drain, convergence, and reservation-to-confirmation stay separately named even though they share a rendering.
- **Overall run duration** spans `startedAt` (run acceptance) to the terminal finalization timestamp, exposed as `endedAt` on a run history summary and `finalizedAt` on a run. Failed runs use the same pair because a failed run still reached a terminal transition. A record missing either boundary has no duration and renders an explicit no-duration state; it is never zero and never back-filled from the configured dispatch limit or any other interval.

Formatting implementation lives in `apps/web/src/app/lib/presentation/format.ts`; the overall run duration itself is derived by the API run-history service and delivered as `overallDurationMs` on run history responses. Components select the correct named measurement and formatter variant; they do not redefine timezone, rounding, or grouping policy.

#### Sanctioned exemptions

These are the only places a surface may render a numeric quantity under its **own** precision rule — a rule defined locally rather than by the shared formatters — or under its own fixed unit instead of the duration tiers. Each is exempt because it is not the kind of thing the shared policy describes, not because the shared policy was inconvenient. Anything not on this list must use the shared formatters; adding to this list is a deliberate decision, not a local convenience.

| Exemption | Where | Why it is not a shared-policy value |
| --- | --- | --- |
| Rates and ratios | `dashboard-panels.tsx` (`formatRate`, `formatFailureSample`, and the non-`ms` branch of `formatMetric`), `gold-signals.tsx` (`formatNumber`), `signal-headlines.ts` (`formatRate`, `formatNumber`), `run-history-detail.tsx` (`formatPercent`) | A rate is a quantity per unit time and a ratio is dimensionless. Neither is a count or an elapsed interval, so both state their own `maximumFractionDigits` and their own unit label rather than inheriting a count formatter's default. `formatMetric` dispatches on the unit a k6 metric sample carries: an `ms` sample is an elapsed measurement and goes through the shared duration policy, while every other unit is a rate or ratio and lands in this exemption. |
| Chart-axis coordinates | `gold-signals.tsx` (`formatAxisSeconds`) | Tick labels and sample rows are read down a column against one another. They must stay in one fixed unit, so tiering them would break the comparison the axis exists to support. |
| Observed histogram bucket bounds | `transport-observation.tsx` (`formatHistogramBoundMilliseconds`; grouping is the shared `formatCount`, only the fixed unit is local) | A bucket edge is a declared technical parameter defining a ladder in fixed millisecond edges. Tiering one edge into seconds while its neighbours stay in milliseconds would hide the unit the ladder is defined in. |
| Diagnostics significant digits, byte scaling, and raw ISO instants | `run-diagnostics.tsx` (`formatDecimal`, `formatDiagnosticBytes`, the raw timestamps inside the collapsed technical block) | A diagnostics block is the technical-details surface the policy above reserves precision for. It supports diagnosis rather than a public summary reading, and byte magnitudes are outside the count/instant/interval vocabulary this policy governs. |

#### Shared formatters with a non-obvious unit choice

These are not exemptions: they define no local precision rule and go through the shared formatters. They are recorded here because the *unit* they render in is a deliberate decision that a reader might otherwise mistake for a missed migration.

| Value | Where | Why this unit rather than a tiered duration |
| --- | --- | --- |
| Observation-window widths | `format.ts` (`formatWindowSeconds` for the value form, `formatWindowSecondsAdjective` for the adjective form) — the shared policy for widths — surfaced by `dashboard-panels.tsx`, `transport-observation.tsx`, and `gold-signals.tsx` | A width is a declared parameter compared against other widths ("trailing 60s" versus "trailing 300s"), not an interval anyone observed, so it stays in one fixed unit. Grouping and rounding are shared; the caller only chooses the grammatical form (`60s` as a value, `60-second` as an adjective), and both forms are defined once in `format.ts` so the three surfaces cannot drift apart. |
| Configured caps and limits | `admin/admin-feature-views.tsx` (`formatCap`, a thin wrapper over the shared `formatCount`) | **The deciding factor is what the value is read against, not who typed it.** Every cap in the public-policy panel is rendered in the same block as the editable field that sets it — the traffic-duration cap sits beside the `Max duration seconds` input — so it must stay in that field's unit to be comparable with the number an operator must enter. The panel contains no tiered durations at all, so nothing there is being spelled two ways. A configured value that instead sits among observed intervals is tiered: `pendingPersistenceRetryAfterSeconds`, `maxDurationSeconds`, `durationSeconds`, and `erpConfig.latencyMs` are all operator-typed too, and all go through the tiered formatter in `run-history-detail.tsx` because there they are read against measured intervals in a run narrative, not against an input field. |
| Configured reservation hold, in minutes | `run-history-detail.tsx` (`Configured hold (minutes)`, through the shared `formatCount`) | The one value the rule above does not decide: the hold appears in the same public `Scenario settings` section as the tiered backpressure guards, so its neighbours do not explain it. It stays native because of its unit. There is no shared minute-native formatter, and the tiered formatter would render a 15-minute hold as `15 min 0 s` under a label that declares minutes; the value is stored, edited (`Hold minutes`), and validated in whole minutes. It therefore reads as a grouped count with the unit in its label. Should a minute-native shared formatter ever exist, this row should be revisited rather than treated as precedent. |

## Dashboard Real-Time Transport

Checkout-Surge uses one complete revisioned browser projection.

- API and worker code publish validated dashboard projection-dirty signals to Redis Pub/Sub.
- The API gateway owns the browser-facing SSE stream at `/dashboard/events` and assembles complete `checkout-surge.dashboard-projection` version 2 frames. The version tracks the projection wire shape from this point forward; version 1 covered several earlier shapes across A03, A04, and A06.
- Dashboard clients receive complete projections over same-origin `EventSource`; no delta or per-order event schema is part of the browser protocol.
- Dashboard observability remains public for the demo; admin access gates only privileged controls.
- Live projections are ephemeral operator feedback, not the durable system of record.
- `/dashboard/recovery` is the authoritative reconnect and refresh path. It returns the same complete projection schema; it is not an event replay feed.

Redis Pub/Sub and SSE are both best-effort delivery paths. If the API gateway is restarting or a dashboard connection drops, a projection may be missed. That is acceptable because persisted PostgreSQL records and API-owned projection readers remain the source of truth. The initial connection, first disconnect error in an outage, later reconnect, manual refresh, and post-control repair share one current-projection HTTP path with at most one read in flight plus one queued batch. A trigger arriving during a read is served by one fresh read started after it settles, and triggers in that window share the fresh read, so every caller awaits an attempt started after its call (the attempt may still fail or be rejected by the comparison rule); unmount discards the queued read. When the browser knows a run/offer scope, it sends the complete paired known-scope query so the read can prefer a current newer run or recover the exact missed terminal. A live projection that races the read is compared atomically when each arrives; neither path buffers or replays the other.

The browser compares revisions only inside one scope. A higher same-scope revision replaces the whole view. Across scopes, it uses only complete projection metadata plus durable run `startedAt`: a newer nonterminal run may replace an older run, a committed projection newer than an idle read handles the C1 start overlap, and a newer authoritative idle projection may clear the current or terminal view. Remembering the last accepted run start prevents a delayed old scope from reviving after idle. A terminal projection can advance only its matching active scope, so a foreign terminal cannot establish another scope. Duplicate/lower revisions, stale scopes, and schema-incoherent candidates are ignored. This is one comparison rule for both live and HTTP delivery, not a second watermark system.

Unavailable reads retain the existing bounded exponential retry policy. Initial loading and public/admin start gating fail closed. Watch keeps its last successful complete projection after a failed read and labels it last-known-good. An accepted live or HTTP projection clears that warning and cancels a scheduled retry. There is no active-run polling loop; immediate lifecycle/terminal publication and connection-triggered current reads provide convergence.

### Public lifecycle, freshness, and outcome

Public presentation keeps three concerns separate:

- Lifecycle describes what the run is doing: `checking availability`, `ready`, `starting`, `accepting checkout attempts`, `processing unique reservations`, `completed successfully`, `completed with order failures`, `completed with unsettled orders`, `completed with oversell`, or `failed`.
- Freshness describes whether the displayed projection can still be called live. It never changes the lifecycle or outcome tone.
- Outcome describes whether terminal durable evidence satisfied the run goal.

Backend run states remain unchanged. The web maps `starting` to starting, active traffic preparation to starting, active traffic delivery to accepting checkout attempts, and `draining` to processing unique reservations. Expected work uses the progress treatment; amber is reserved for anomalies. A completed successful run and an exact sellout with zero oversell use the success treatment.

When a completed run has contradictory authoritative evidence because a non-oversell invariant is broken, it uses the danger presentation labelled `contradictory outcome evidence`; it is never shown as a neutral indeterminate result.

Freshness is delivery-based rather than producer-age-based. `inventory.lastUpdatedAt` is a change time and can remain unchanged after a correct sellout; queue, ERP, and consistency-lag timestamps are observations assembled into the same projection. The projection therefore carries `inventory.observedAt` as the inventory read time while preserving `lastUpdatedAt` as the last inventory change time. Scope is independent of freshness: a current shared-runtime value is not run evidence, and an older edge-triggered breaker state can still be valid.

The browser calls a nonterminal projection live only when the SSE transport is connected, update-producing work for the selected run exists, and the last projection arrived inside the age guard. Update-producing work means the run's pending persistence, queued, processing, or retrying order count is non-zero. Shared BullMQ depth and active counts do not keep another run's surface live. The guard is three times `dashboardLiveUpdateExpectedIntervalMs`: 6 seconds at the current 2-second queue refresh cadence. A connected run with no update-producing work is retained-fresh regardless of projection age. `connecting` and `unsupported` are neutral delivery states; neither is called disconnected or stale, nor described as showing last-known-good values because of a failure. A disconnected transport is disconnected regardless of age. Completed, failed, and no-run projections are final or not applicable and never decay into stale data. Last-known-good values remain visible with their projection update time and an explicit disconnected or stale label.

Terminal outcome precedence is normative: failed run, oversell, indeterminate outcome, failed orders, unsettled orders, then completed successfully. Oversell outranks order failures because it breaks the core stock invariant; indeterminate evidence demotes only non-oversell verdicts. Classification uses durable terminal evidence; notification counts are not order-confirmation evidence.

#### Run result and reconciliation

The durable result model is shared by live completion, history summaries, and public detail. It uses explicit populations: planned checkout attempts; observed responses; accepted responses (including idempotent replays); sold-out rejections recorded by Checkout-Surge; sold-out rejections seen by the load generator; unique reservations secured; orders confirmed; orders failed; reservations pending a durable outcome; and oversold units. An unqualified `accepted` or `sold out` label is not public vocabulary.

Run History derives this canonical result at the service boundary. The compact list carries only its outcome plus fixed comparison facts; its demand and starting-stock intent come from the validated frozen accepted configuration joined in the list read, while result derivation continues to use terminal evidence. Public detail carries the full result proof and is a semantic superset without becoming a wire-level superset. Incomplete evidence and warning-class disagreement receive a visible sanitized status outside the collapsed proof. Detail excludes identifiers and event or row totals that are not required for the public narrative. Malformed run IDs and confirmed public `resource_not_found` responses map to the framework 404 boundary, while upstream and other non-404 failures remain explicit unavailable states.

Starting and remaining stock come from the Redis terminal inventory snapshot. Unique reservations, reserved units (`sum(reservations.quantity)`), sold-out rejections recorded by Checkout-Surge, order counts, and notification counts come from run-filtered PostgreSQL business evidence. Load-generator HTTP and transport counts are proof only. A03's derived `inventoryDrain` is a reservation-row visualization and is deliberately not an invariant input.

The authoritative invariants are:

- `reserved units = starting stock − remaining stock` (evaluated only when Redis holds awaiting persistence are zero and both stores are present);
- `confirmed + failed + pending = unique reservations` (pending is queued plus processing orders; retrying is a subset of processing, and pending-persistence rows are reconciliation evidence rather than unsettled orders);
- `oversold units = 0` (reserved units compared with starting stock).

Missing or partial evidence is never defaulted to zero. Reconciliation classifications have precedence `correctness_failure` > `warning` > `evidence_incomplete` > `expected_population_difference`. Accepted responses may exceed unique reservations when `replayPossible` is true; that is an expected population difference, not oversell. A partial generator view is incomplete evidence, not agreement. Sold-out rejections recorded by Checkout-Surge and sold-out rejections seen by the load generator are separate populations: with complete generator coverage, generator observations at or below recorded rejections are an expected population difference, while generator observations above recorded rejections are a warning. PostgreSQL `pendingPersistenceCount` counts pending rows, while Redis `pendingPersistenceCount` counts holds awaiting persistence; they share a field name but not a meaning, and disagreement is a warning. Outcome and reconciliation severity remain separate: a run can satisfy all outcome invariants while still carrying a reconciliation warning, such as disagreement between those pending-persistence stores.

Inventory presentation requires durable `reservedUnits` before it can claim exact sellout. A depleted active run without that evidence remains `inventory draining`; a completed run uses neutral inventory-specific copy that durable reservation evidence was unavailable for that run.

Public failed runs expose only a bounded failure category. The exact internal reason remains on authenticated admin detail. The shared contracts package derives the result and invariant proof; one web presentation template formats the sentence. Pages render that result and place generator-versus-durable evidence in a collapsed proof.

Missing values use field-specific language:

- `not scheduled` means no future action is planned, such as a circuit probe while the breaker is closed;
- `not yet available` means evidence is expected later;
- `—` means no semantic sentence is needed.

Whether more evidence is expected depends on the producer that owns the missing value, not on the run being terminal. Load-generator evidence — arrival rate, dispatched attempts, dispatch duration, response latency and failure rate, request totals, arrival windows — stops changing when traffic ends, so it is already final while a `draining` run keeps processing reservations and must not be labelled as awaited. Durable processing evidence — inventory, simulated ERP outcomes, reservation-to-confirmation, checkout outcomes — may still arrive until the run reaches `completed` or `failed`. One panel can hold both, and each fact follows its own producer.

Oversell is an authoritative invariant and uses only durable reserved units against the Redis inventory snapshot's starting stock. Without that snapshot, oversell is unknown on every surface; the derived signal timeline supplies the drain visualization, never the oversell comparison.

Every finished run carries a request-arrival summary, including one whose load generator never started a checkout attempt. That empty summary is an absence of observation, so no surface may render its zeros as a measured peak, dispatch duration, or arrival series, and no coverage claim may state that a panel covers evidence it does not have.

Initial dashboard hydration is `loading`, not unavailable. It says checking availability, starts the initial read without retry/backoff presentation, and shows retry controls only after an actual failed read.

Inventory and queue mutations publish only the internal projection-dirty signal. Fresh holds dirty best-effort; replays do not. Sold-out scopes coalesce for 500 ms, while queue inspection repeats every two seconds until drain. The projection service reads the complete inventory and queue values for both SSE and `/dashboard/recovery`.

API and worker business mutation handlers mark the dashboard dirty only after fresh durable changes. The single API process and single worker runtime each own one scheduler that coalesces each `(runId, saleOfferId)` for 500 ms. The projection service reads aggregate business outcomes and consistency lag into the next complete replacement; no aggregate delta contract exists.

The cutover is canonical-only: publishers and consumers deploy together, existing browser tabs must reload, and active k6 processes must be restarted. Legacy wire shapes and singular k6 counters are not normalized, avoiding duplicate aggregate/delta application and counter double counting.

The worker does not publish individual order status or consistency-lag messages. Aggregate run outcomes and aggregate consistency-lag views come from the complete projection, while focused order investigation uses the durable status read or protected Run History.

### Dashboard queue and ERP scope inventory

The public run surface has two structural homes:

- `erp` is a `runErpOutcomeSummary` and is run-owned. Its `runId` and any `latestAttempt.runId` must match the projection scope.
- `systemStatus` is a `sharedRuntimeStatus` and remains available on idle projections. It is never terminal or current-run evidence.

Run-scoped fields:

| Public evidence | Source and meaning | Clock |
| --- | --- | --- |
| Queued / processing backlog | `businessOutcome.queuedOrders` is `accepted_awaiting_first_processing_start`; `processingOrders` and adjacent `retryingOrders` are filtered by `orders.runId`. Retrying remains separate because BullMQ retries can resume after the first processing start. | Complete projection `recoveredAt`; terminal history uses its captured run timeline. |
| Confirmed and failed outcomes | `businessOutcome.confirmedOrders` and `failedOrders` are filtered by the selected `runId`. | Durable event timestamps and projection `recoveredAt`. |
| ERP attempt totals | `erp.recentAttemptCount`, `recentFailureCount`, and `recentTimeoutCount` query retained rows only for `erp_attempts.run_id = scope.runId`; `recentAttemptWindowSeconds` defines the time predicate and `recentAttemptCoverage = retained_history` prevents treating the bounded tail as complete. `cumulativeOutcomeCounts` sums per-order actual-call counters for capacity, unavailability, uncertainty/timeout, and permanent rejection across the full order lifetime. | `erp.observedAt` is the API observation time. |
| Latest ERP attempt | `erp.latestAttempt` is selected only inside the same run predicate. Its status and `finishedAt` cannot be inherited from another or unscoped run. | `latestAttempt.finishedAt` is attempt completion time. |
| Run circuit | `erp.circuit` reads the Redis per-run breaker key. `circuitReadStatus = available` with no snapshot means protection has not yet been exercised and is neutral; `unavailable` means the Redis read failed while independently read PostgreSQL attempt evidence remains visible. State, threshold, failure count, open/probe times, and reset timeout all belong to this run-keyed snapshot. | `circuit.lastChangedAt` is edge-triggered and changes only when run protection opens, probes, or closes. |

Shared-runtime fields:

| Public technical context | Source and meaning | Clock |
| --- | --- | --- |
| Physical queue identity and readiness | `systemStatus.queue.name` and `connectivity` describe the one shared BullMQ queue. | `queue.observedAt` is the queue-inspector poll time. |
| Physical queue work | `depth`; waiting, prioritized, paused, delayed, active, and failed counts; oldest waiting age; failed-job total; and bounded recent failed details include all runs and visitors. BullMQ cannot filter these counts by run without enumerating and truncating jobs. | Polled on the shared dashboard cadence, currently `dashboardLiveUpdateExpectedIntervalMs`. |
| Physical retry pressure | Retrying job count, retry-attempt count, inspected count/limit, and truncation flag are bounded shared-queue telemetry. Gold Signals and run outcomes use `businessOutcome.retryingOrders` instead. | The enclosing `queue.observedAt` poll time. |
| ERP protection verdict | `systemStatus.erpProtection.status` and `reason` derive only from the catalog circuit, circuit-read availability, and shared queue retry pressure. They do not use run attempt failures or timeouts. | `erpProtection.observedAt` is the API observation time. |
| Catalog circuit | State, threshold, consecutive failures, open/probe times, reset timeout, and probe-in-flight state come from the catalog Redis breaker key shared by the runtime. | `circuit.lastChangedAt` is edge-triggered with no scheduled cadence; it can legitimately be hours older than `erpProtection.observedAt` or projection `recoveredAt`. |

The web application displays only the live physical queue counts and retry pressure from these fields (the public Physical order queue panel). The failed-job total, the ERP protection verdict, and the catalog circuit remain API fields; they are not shown publicly and drive no UI verdict.

There are no public unscoped-legacy queue or ERP values. Rows whose nullable `run_id` is absent are excluded from run evidence, and physical BullMQ values are retained only in the explicitly shared system-status area.

The same shared queue numbers intentionally have a different valid use inside the API: the dirty scheduler uses global depth and active counts to decide whether the runtime may still have work to publish. Browser freshness uses only selected-run work. Infrastructure scheduling and public run evidence must not be forced into one scope.

The three dashboard clock names are:

- `recoveredAt`: when the complete API projection was assembled;
- `observedAt`: when a polled/read model was observed;
- `lastChangedAt`: when edge-triggered state last changed.

These clocks need not advance together.

---

## Error Representation

The baseline shared error shape is:

- `code`
- `message`
- `details` optional
- `correlationId`
- `timestamp`

Conventions:

- `code` must be one of the values exported by the shared `@checkout-surge/contracts` error-code schema; unknown or typoed codes are invalid rather than pass-through strings.
- The exported tuple is the sole schema-driving vocabulary for canonical HTTP errors across the API, Mock ERP, load orchestrator, and web BFF. Persistence failure reasons, worker diagnostics, validation-library issue codes, and other non-HTTP discriminators are separate vocabularies and must not be added merely because they also use a field named `code`.
- Public codes describe a client or operator action category. Mechanical validation permutations share `invalid_run_configuration` or `invalid_runtime_policy`; their exact internal violation code and field path belong in `details` when useful.
- Adding a canonical HTTP error code is an intentional shared-contract change: add it once to the exported tuple, keep its lowercase snake-case spelling stable, type the producer with the exported code union, and update contract coverage. Services must not restore an open string schema or introduce a catch-all code to avoid that review.
- Protected load endpoints use `resource_not_found` for an absent accepted run and `traffic_execution_conflict` for a lifecycle or immutable-completion conflict. Exact conflict causes remain structured details. These responses still carry the body correlation ID in the canonical envelope and response header.
- `message` should be concise and human-readable.
- `details` should carry optional structured context, not a second free-form paragraph.
- Errors returned to clients should avoid leaking infrastructure internals unless that information is intentionally part of the user-facing contract.
- The web presentation boundary (`apps/web/src/app/lib/presentation/error-presentation.ts`) maps canonical codes and bounded producer-owned conflict causes (for example, run `active_run_exists` / `reset_incomplete` and preset `slug_in_use` / `not_archivable`) to client-owned headline, explanation, action, and tone. Backend `message`, HTTP status, correlation ID, probe names, and raw details are never automatic public copy. Public server-rendered props and the polling `/api/health/ready` BFF response keep only the mapped inputs they need (`checks: []`); the authenticated admin server read retains bounded readiness probes and mutation diagnostics inside collapsed protected details.
- Authenticated History reads pass an explicit protected disclosure flag while retaining history-specific copy; public History does not. Retry/check callbacks are rendered only for matching mapped action kinds, post-commit list rereads are separate sync diagnostics, and admin page refresh occurs only for the exact `admin_session_required` code (`control_token_required` remains deployment guidance).
- Loading and hydration are neutral checking states outside the error presentation path. Retry timing is shown only when authoritative `retry-after` metadata exists; an expected run conflict directs visitors to Watch rather than presenting infrastructure failure.
- Browser-facing proxy failures use the same full envelope. A backend non-success response is preserved only after strict envelope validation; malformed, non-JSON, unknown-code, or correlation-inconsistent responses become a safe `502 invalid_backend_response` envelope owned by the proxy request.
- The response `x-correlation-id` is the authoritative lookup key. It must agree with any `correlationId` in the response body; a canonical upstream error may recover a missing header from its validated body.
- Protected generated-run teardown requires the control service token (`401` when absent or wrong) and a UUID run parameter (`400` when malformed). It uses the grouped `run_cleanup_conflict` category for non-terminal, outstanding-work, ownership, malformed-target, or active-job conflicts, with the exact conflict reason in `details`. `outstanding_work` means the terminal run still holds a nonterminal order or an unresolved dispatched ERP call; it is reported at inspection, before any queue, Redis, or durable deletion, and that work is never deletion-eligible. Queue, resume, Redis, or database failures return the canonical `5xx` error envelope before the durable identity is deleted; clients repeat the same bodyless DELETE. The sole API maintenance authority serializes local reset, retention, and teardown requests. One exact queue operation pauses only locally unpaused order/notification queues, validates all selected jobs before removal, and attempts every locally required resume in `finally`; pre-existing operator pauses remain untouched. Successful cleanup returns the canonical request `correlationId` and UTC cleanup timestamp, and a later repeat returns `already_absent`. There is no broad drain/clean, adapter lease, convergence rescan, teardown receipt, Redis pause-owner key, foreign-owner conflict, or cross-replica/restart pause adoption.
- Protected admin reset uses one canonical correlation ID across the API-to-load-orchestrator abort. The abort request always includes the selected run ID and caller-supplied `admin_reset` reason. `no_current_run` is idempotent after the durable terminal fence; a current-run mismatch remains `409`. A claimed `failed/admin_reset` run with a null `adminResetCompletedAt` marker blocks subsequent start admission until retry completes. Full success requires bounded queue cleanup, one immutable summary, destructive deletion of the run's internal PostgreSQL and Redis state, and the post-purge completion marker. The run row, summary, closed generated offer, and ownership context remain; retention and exact teardown keep their outstanding-work refusal unchanged.

For operator resets, `finalizedAt` means “Operator stop decision.” The separately exposed `adminResetCompletedAt` means “Work cleanup and history completed,” not full reset success: projection/shared-state cleanup can still fail. Reports name acceptance-to-stop duration and acceptance-to-work-cleanup completion duration separately. Fresh evidence and completion timestamps are obtained after the settlement grace period; legacy missing metadata remains unknown. Real confirmation and notification counts and their reconciliation warning remain unchanged. Reset settlement uses one maximum 5-second wait capped at 25 seconds elapsed (20-second abort allowance, 30-second reset-client response budget, 5-second evidence/response reserve; no shorter configured Caddy/Fastify response deadline). At its deadline, reset removes non-active selected jobs, leaves active locked jobs alone, restores queue availability, and continues; malformed targets and infrastructure/restoration errors stay distinct.


---

## Reservation Fact

The implemented reservation vocabulary has one durable fact: `reservation.secured`. A Redis hold or PostgreSQL reservation row is secured by construction, so neither carries a copied status field.

An unsuccessful stock decision is represented once by the public buy `outcome` and does not create a durable reservation. Release and expiry workflows remain future extensions and must define their vocabulary when they gain real producers and consequences.

---

## Order Lifecycle

The canonical order lifecycle is:

- `queued`
- `processing`
- `confirmed`
- `failed`

Retrying remains a derived processing condition rather than a first-class order state. Retry counts, retry delays, and ERP-attempt history can be represented separately without changing the canonical lifecycle vocabulary.

ERP attempt and `erp.attempt.*` event diagnostics retain 32 ordinary rows per order. Canonical success, permanent rejection, and the attempt referenced by the control record's current `unresolvedErpCallId` are exceptions to pruning. Run-history attempt rows, status totals, and attempt-event timelines carry `retained_history` coverage and the per-order limit; cumulative outcome counters are actual-call totals and exclude status lookups, local result reuse, and admission deferrals. Those counters cover orders processed since durable call accounting was introduced; legacy orders without a durable control record/counters contribute zero and are not backfilled.

The implemented order workflows permit `queued -> processing | failed` and `processing -> confirmed | failed`; `confirmed` and `failed` are terminal. Producers select the explicit event name that describes the transition rather than deriving it through a generic status-to-event helper.

---

## Queue Naming Convention

Queue names follow these rules:

- Use lowercase colon-separated semantic queue names.
- Use plural domain names by default.
- The first canonical queue is `orders:process`.
- When an infrastructure adapter cannot use the semantic name directly, define an explicit physical name beside the semantic constant. The order-processing BullMQ queue uses `orders-process`, while contracts and dashboard metrics continue to expose `orders:process`.
- The notification-recording queue uses semantic `notifications:record`, physical `notifications-record`, and job name `notification.record`.
- Poison order jobs are persisted in the `order_dead_letters` audit table. There is no separate dead-letter BullMQ queue in the current implementation.

---

## Metric Naming Convention

Metric names follow these rules:

- Use lowercase dot notation.
- Prefer semantic names that describe the observed signal rather than tool-specific implementation details.
- Keep the primary metric vocabulary aligned to benchmark and dashboard signals defined in the delivery constraints.

The reserved canonical metric names are:

- `traffic.request_arrival_rate`
- `traffic.response_completion_rate`
- `traffic.attempts_dispatched`

Dashboard traffic metrics also use:

- `traffic.latency`
- `traffic.failure_rate`

`traffic.request_arrival_rate` counts `checkout_attempts_started` points in aligned one-second producer event-time windows. The load script increments that counter immediately before `http.post`, so this is the authoritative public arrival signal. `traffic.attempts_dispatched` is a bounded cumulative progress sample with unit `requests`, emitted while dispatch is still active. `traffic.response_completion_rate` separately counts completed HTTP responses from `http_reqs`; it is never a fallback for request arrival. Arrival and completion rates use `requests_per_second`. `traffic.latency` is the mean in `ms`, and `traffic.failure_rate` is the fraction of valid HTTP failure observations in the same one-second window with unit `ratio`.

### Four Gold Signals

The public causal timeline uses exactly four signals on one elapsed-time axis:

- Request arrival is `checkout_attempts_started` in fixed one-second producer event-time windows. The first attempt is time zero; harness preparation and configured start delay are reported separately.
- Inventory drain is starting stock minus the quantity of secured reservations. Its headline preserves starting stock, remaining stock, depletion time, and the derived oversell invariant.
- Processing backlog is the durable count of accepted orders awaiting their first processing start: orders with `queuedAt` at or before the observation boundary minus orders with `processingAt` at or before it. `peakAtElapsedSeconds` is relative to the first checkout attempt, while `drainDurationSeconds` spans the first queued order through the final return to backlog zero and carries the `first_order_queued_to_final_backlog_zero` boundary discriminator. Live and terminal processing-backlog series use this durable run-owned definition. Physical BullMQ depth remains shared system-status context because it includes waiting, prioritized, paused, delayed, and retry work across all runs. ERP retries can re-enter BullMQ after `processingAt` is set, so the run-owned retrying-order count is shown beside the durable backlog rather than folded into it.
- Confirmation convergence is cumulative confirmed orders, with cumulative settled outcomes shown separately when failures exist. Reservation-to-confirmation lag remains `orders.confirmedAt − reservations.securedAt` over confirmed orders only and is always accompanied by failed and pending counts.

PostgreSQL terminal derivation retains 120 buckets from the first checkout attempt through a terminal timeline boundary: the later of checkout dispatch completion or the latest retained reservation/order activity. If neither boundary is strictly after the first attempt, the producer arrival-window duration supplies the minimum terminal span. That boundary is not labelled as a settled outcome because a partial run may still have pending work, and dispatch can end after all accepted work has settled. The derived bucket width is stored. Exact backlog peaks are derived from the ordered event stream before bucketing, so a peak that rises and drains inside one bucket is not lost. This fixed-count terminal policy intentionally differs from request arrival’s fixed one-second producer windows: PostgreSQL can re-bucket durable rows after completion, while producer-emitted arrival evidence cannot. A live browser buffer instead measures elapsed time from its first retained projection and restarts on reload; it does not claim that its local zero is the first checkout attempt.

---

## Summary

This document establishes a single shared vocabulary for the repository:

- keep reservation and order semantics distinct,
- keep lifecycle names aligned across contracts and schemas,
- use consistent naming for events, queues, metrics, timestamps, correlation IDs, and error payloads,
- preserve a short semantic reference that later work can build on without redefining core terms.
