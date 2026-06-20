# Load Generation and Metrics Streaming - Decisions & Rationale

This document defines the target load generation and metric streaming behavior. The demo flow should start traffic from API-owned preset run snapshots. The load orchestrator owns k6 execution, but the public/admin product contract is a discriminated traffic config plus generated `runId` and generated `saleOfferId`.

---

## Confirmed Decisions

| Decision Area | Choice | Rationale |
| :-- | :-- | :-- |
| Public/admin traffic model | Preset run snapshots with explicit buyer-spike or steady-arrival traffic mode | Keeps user-facing controls aligned with benchmark intent rather than raw k6 virtual users or ramp stages. |
| Scenario owner | `apps/load-orchestrator` | The load orchestrator owns k6 execution and parameterization; browser clients never create high-volume traffic. |
| Contract source | `@checkout-surge/contracts` demo run and load schemas | Dashboard controls, orchestrator routes, parser output, and run summaries use shared schemas with separate traffic-execution and API-owned run lifecycle vocabulary. |
| Public/admin preset split | Preset visibility, editability, and API policy caps separate public-safe demonstrations from admin-operated experiments | Keeps public controls bounded while still allowing authenticated operators to run focused checks and higher-pressure demos. |
| Purchase behavior | Every preset traffic run targets the API buy endpoint with quantity `1`, generated idempotency keys, generated `runId`, and generated `saleOfferId` | Preserves the limited-inventory benchmark surface, isolates repeated runs, and avoids modeling a customer storefront. |
| k6 wrapper API | Fastify service in `apps/load-orchestrator` | Keeps run control testable with the same HTTP service pattern used by the API gateway. |
| k6 runtime boundary | The reference runtime packages k6 inside the load-orchestrator container | k6 is an external binary, but it belongs to the load-generation service runtime. Host-installed k6 is only a convenience path for host-native development. |
| k6 parameter passing | Generate a temporary k6 script from validated preset traffic snapshots | Avoids shell interpolation risks and keeps run inputs contract-driven. |
| k6 output parsing | Parse JSON point samples for `http_reqs`, `http_req_duration`, and `http_req_failed` | Captures request rate, latency, and failure-rate signals while ignoring unsupported output lines. |
| Metric forwarding | Load orchestrator posts adapted k6 metrics to the API at `/internal/load/metrics` | The API remains the owner of dashboard recovery state and SSE fan-out while k6 execution stays isolated in the load service. |
| Start recovery projection | Load orchestrator must have the API accept the run start and establish the initial dashboard recovery baseline before spawning k6 or returning start success | A browser recovery read must be able to show the new run immediately after a successful dashboard start action, and the API remains authoritative for in-progress conflicts. |
| HTTP versus business outcomes | k6 samples map only to `traffic.scheduled_request_rate`, `traffic.latency`, and `traffic.failure_rate` | Business outcomes remain derived from reservations, orders, ERP attempts, and later notification records. |
| Dashboard run control | The dashboard server starts API-owned demo runs from presets; the API delegates accepted traffic snapshots to `apps/load-orchestrator`; browser recovery reads come from the API via `/api/dashboard/recovery` | This preserves service ownership: UI starts runs through the API lifecycle while k6 execution stays isolated in the load service. |
| Overlap policy | Start buttons are disabled while the API-owned demo run is `starting`, `active`, or `draining`; load starts are accepted only after the API establishes the new recovery baseline | Client-side prevention improves operator clarity, while API start acceptance is the source of truth. |
| Run-summary persistence | The API owns run-summary storage in PostgreSQL; the load orchestrator reports traffic completion and HTTP summaries, then API-owned services write immutable terminal run summaries | This preserves the repository boundary that `apps/load-orchestrator` does not use `@checkout-surge/db`, and keeps demo-run completion tied to run-scoped business outcomes while still recording exceptional terminal failures. |
| Summary split | Stored run summaries keep `httpSummary`, `trafficDeliverySummary`, and `businessOutcomeSummary` separate | This makes k6 response behavior, traffic fidelity, and asynchronous order/ERP completion comparable without conflating their statuses. |
| Traffic delivery quality | The API enriches traffic delivery summaries with `trafficDeliveryStatus` (`complete`, `warning`, `degraded`, or `failed`) | The load orchestrator still reports raw k6 delivery facts; API finalization decides whether under-delivery is warning-level, degraded, or a major traffic-fidelity failure. |
| Live versus history split | Live dashboard recovery is current-run focused and can reconstruct recoverable runs from durable `demo_runs`; `/watch` observes the current run and persisted terminal run summaries are shown on `/run-history` | Historical summaries should not appear as the live current run after reset or reconnect, while durable `starting`, `active`, and `draining` run state must not disappear after API process churn. |

---

## User-Facing Traffic Model

Public and admin preset traffic is modeled as one of two modes:

- `buyer-spike`: `buyerCount`, `duplicateEachBuyerAttempt`, `startDelaySeconds`, and `maxDurationSeconds`.
- `steady-arrival-rate`: `ratePerSecond`, `startDelaySeconds`, `durationSeconds`, and optional advanced k6 VU controls for admin custom runs.

The API validates this shape against environment-backed buyer, emitted-attempt, request-rate, duration, start-delay, and admin VU caps before a run can start. The load orchestrator translates buyer-spike snapshots into k6 `per-vu-iterations` plans and steady-arrival snapshots into k6 `constant-arrival-rate` plans. Raw ramp stages and think time remain implementation details. k6 VU sizing stays automatic for public presets and for admin steady-arrival runs that leave the advanced VU controls blank.

Every preset traffic start includes the API-generated `runId` and generated `saleOfferId`. Those identifiers are included in each buy attempt so the API can validate run sale eligibility without returning to the old fixed active-sale window as the demo lifecycle.

For steady-arrival traffic, `ratePerSecond` means scheduled checkout iterations per second, not new virtual users per second. k6 reuses VUs as workers: if a `/buy` iteration finishes quickly, the same VU can run another later iteration. This does not collapse multiple attempts into one buyer in Checkout-Surge because the generated k6 script derives a unique idempotency key from the global scenario iteration. For example, `50` requests per second for `10` seconds plans `500` unique checkout attempts against the run sale offer; the required VU pool depends on iteration duration and generator capacity, not directly on the `500` planned attempts.

Zero starting stock is a valid preset configuration for sold-out demonstrations. The load orchestrator keeps the accepted-reservation counter for outcome summaries, but k6 traffic correctness is based on the unexpected-response counter staying at zero. A run with only clean `sold_out` responses is therefore valid traffic behavior rather than a failed traffic run.

When a buyer-spike preset enables `duplicateEachBuyerAttempt`, the load orchestrator may report duplicate accepted HTTP responses for the same buyer/idempotency outcome. Terminal business summaries treat complete duplicate buyer-spike deliveries as durable reservation accounting: accepted reservations represent the unique durable reservation count, not the raw accepted response count. Planned-attempt displays keep the full emitted-attempt total and annotate the duplicate-buyer context.

## Dashboard Recovery Model

Dashboard realtime events reach the browser through the API-owned SSE stream at `/dashboard/events`. They are best-effort live feedback, not the browser source of truth after initial load, reconnect, manual refresh, or start/reset controls. The browser uses the same-origin `/api/dashboard/recovery` route, backed by the API `/dashboard/recovery` read, to recover the live snapshot, current demo run, and latest renderable traffic metrics in one operation. The `/watch` route is the focused current-run spectator surface, while `/admin` remains the privileged operator surface. The live stream and recovery read remain public demo observability surfaces; admin sign-in gates privileged controls, not live telemetry.

The API allows only one current demonstration run, but `/dashboard/recovery` is not limited to process-local memory. Recovery can reconstruct durable `starting`, `active`, and `draining` runs from `demo_runs` and returns the run's frozen `configSnapshot` so the dashboard can restore the accepted configuration panel after refresh or reconnect. The load orchestrator owns only traffic execution (`starting`, `active`, `succeeded`, or `failed`); the API maps successful traffic completion to demo-run `draining` and owns final `completed` or `failed` transitions. Terminal dashboard states are sticky for the same run, and finalized recovery timestamps come only from API-owned finalization. Persisted run summaries are immutable historical records; they are not promoted into live recovery state when no current run is tracked.

Within API-owned finalization, successful k6 execution and exact request delivery are distinct. A run can complete with `warning` or `degraded` traffic delivery quality when business invariants pass, while major under-delivery is recorded as `trafficDeliveryStatus: "failed"` and can finalize the run as failed with `traffic_delivery_major_shortfall` after drainable accepted work settles.

On API startup, durable `starting` and `active` runs left behind by a restart are made explicit failed runs with the stable reason `api_restart_interrupted_run`, closed sale eligibility, and immutable history summaries. Durable `draining` runs remain draining so normal finalization can continue. The shared terminal summary writer is also used by normal finalization, admin recovery, traffic-start failure, and initialization-failure paths so every terminal demo run has one summary-backed history record.

Historical run summaries are available through the separate Run History surface. Public users can read paginated summaries, and authenticated admins can delete one, selected visible summaries, or all summaries with explicit confirmation.
