# Backlog tracking

Tasks are listed in their intended execution order.
Replace `⬜` with `✅` when a task is complete. Optional `⏳` for work in progress.

✅ [Task 01: Add an automated cross-service composition test (and the frozen-behavior characterization suite)](./task_01.md)

✅ [Task 02: Build a durable PostgreSQL-to-BullMQ order-dispatch handoff (transactional outbox or autonomous scanner)](./task_02.md)

✅ [Task 03: Add autonomous reconciliation for pending Redis holds after run eligibility closes](./task_03.md)

✅ [Task 04: Give ERP results a durable persistence/idempotency boundary so orders cannot be stranded `processing`](./task_04.md)

✅ [Task 05: Fence all run lifecycle transitions with compare-and-set (late start acknowledgement can resurrect a terminal run)](./task_05.md)

✅ [Task 06: Make admin reset a fenced terminal transition (no admission or job cleanup after the summary is written)](./task_06.md)

✅ [Task 07: Enforce the single-active-run invariant at the database level](./task_07.md)

✅ [Task 08: Adopt ports-and-adapters seams in the lifecycle services](./task_08.md)

✅ [Task 09: Make load-completion delivery durably owned (outbox with idempotent acknowledgement, or an API traffic watchdog)](./task_09.md)

✅ [Task 10: Replace the per-request PostgreSQL eligibility gate with a Redis-first, fail-closed projection and streamline accepted-path persistence](./task_10.md)

✅ [Task 11: Remove default control-plane credentials and unnecessary published ports from the Docker Compose runtime](./task_11.md)

✅ [Task 12: Stop writing a false durable pending marker when concurrent idempotent requests race the insert](./task_12.md)

✅ [Task 13: Make idempotent replays faithful: acceptance-shaped response, no terminal-state leak, stable outcome label](./task_13.md)

✅ [Task 14: Close the concurrent-duplicate window in mock-ERP confirmation idempotency](./task_14.md)

✅ [Task 15: Scope the ERP circuit breaker per run (and honor snapshot breaker thresholds)](./task_15.md)

✅ [Task 16: Fix notification recovery: retained failed jobs deduplicate the scanner's re-adds](./task_16.md)

✅ [Task 17: Apply run-scoped concurrency, retry policy, and backpressure at the queue boundary](./task_17.md)

✅ [Task 18: Restore the public run-start trust boundary: service-token channel, verifiable visitor identity, non-burning budgets](./task_18.md)

✅ [Task 19: Add resource limits to public dashboard reads and SSE connections](./task_19.md)

✅ [Task 20: Harden the admin session end-to-end: rate-limited constant-time passphrase check, `Secure` cookie, CSRF posture](./task_20.md)

✅ [Task 21: Reuse the durable terminal inventory snapshot at finalization instead of a live Redis re-read](./task_21.md)

✅ [Task 21 follow-up: Make traffic-completion enrichment first-write authoritative and safe to finalize](./task_21_followup.md)

✅ [Task 22: Enforce run–sale-offer ownership after guarded insertion](./task_22.md)

✅ [Task 23: Validate seeded runtime policy through the shared contract (and make reruns repair bad rows)](./task_23.md)

✅ [Task 24: Make documented environment overrides real: wire compose vars to their consumers and re-validate hard caps at boot](./task_24.md)

✅ [Task 25: Fix the test-database reset guard and reset determinism](./task_25.md)

✅ [Task 26: Decompose the monolithic dashboard and admin-console components](./task_26.md)

⬜ [Task 27: Complete the live dashboard gold signals: publish inventory and queue updates and promote latency/failure rate](./task_27.md)

⬜ [Task 28: Scope dashboard state to the current run (new-run events must not relabel prior-scope projections)](./task_28.md)

⬜ [Task 29: Add an event watermark so out-of-order live events cannot regress dashboard state](./task_29.md)

⬜ [Task 30: Aggregate streamed k6 samples into real windowed rates before presenting them](./task_30.md)

⬜ [Task 31: Fix old-run cleanup: respect generated-run ownership and delete the run's Redis namespaces](./task_31.md)

⬜ [Task 32: Make the load smoke prove business completion and clean up through a targeted, owned API](./task_32.md)

⬜ [Task 33: Add load-run cancellation, real readiness probes, and richer diagnostics to the orchestrator](./task_33.md)

⬜ [Task 34: Complete the admin reset workflow: traffic abort, ERP chaos reset, live dashboard clear, multi-service reset client](./task_34.md)

⬜ [Task 35: Eliminate the React hydration error (#418) on fresh dashboard loads](./task_35.md)

⬜ [Task 36: Fix stale-state preset duplication in the admin console (empty slug duplicates from previous value)](./task_36.md)

⬜ [Task 37: Add a delete/archive path for admin-created presets](./task_37.md)

⬜ [Task 38: Preserve the canonical error envelope and correlation ID through the web BFF and routine logs](./task_38.md)

⬜ [Task 39: Fix rejected-buy classification: stop forcing sold-out, add the missing decision vocabulary](./task_39.md)

⬜ [Task 40: Give the API ownership of delivery-quality classification and reconcile k6 counters against durable evidence](./task_40.md)

⬜ [Task 41: Restore buy outcome headers and tighten the k6 request script (discard bodies, quantity source, correlation header)](./task_41.md)

⬜ [Task 42: Use k6 summary-export for terminal reports and make a real-k6 test lane mandatory](./task_42.md)

⬜ [Task 43: Fix steady-arrival VU sizing defaults, cap derived VUs, and add `gracefulStop`](./task_43.md)

⬜ [Task 44: Bound the live observability cost profile: sold-out aggregate signal, batched metric publishes, cheaper outcome recomputation](./task_44.md)

⬜ [Task 45: Isolate metric-ingestion failures from pub/sub fan-out](./task_45.md)

⬜ [Task 46: Tighten the dashboard recovery read model: drop the catalog-offer fallback, make the shape self-describing](./task_46.md)

⬜ [Task 47: Emit per-order realtime transitions and per-confirmed-order consistency-lag metrics](./task_47.md)

⬜ [Task 48: Record a terminal marker on the final ERP attempt](./task_48.md)

⬜ [Task 49: Replace fixed-second TPS buckets in the mock ERP with a sliding one-second window](./task_49.md)

⬜ [Task 50: Health-gate the upper compose graph (web and proxy must wait on healthy dependencies)](./task_50.md)

⬜ [Task 51: Deepen the non-mutating smoke's SSE check to observe an actual frame](./task_51.md)

⬜ [Task 52: Add the public order-status lookup endpoint](./task_52.md)

⬜ [Task 53: Add database lifecycle/timestamp CHECK constraints and attribution-agreement guards](./task_53.md)

⬜ [Task 54: Add composite indexes matching run-scoped filters plus chronological sort](./task_54.md)

⬜ [Task 55: Restore Drizzle snapshot metadata and clean up hand-authored trigger SQL](./task_55.md)

⬜ [Task 56: Fix accepted-idempotency TTL lifecycle: promotion must tolerate expiry and refresh the replay window](./task_56.md)

⬜ [Task 57: Type the persisted JSON columns against shared contracts](./task_57.md)

⬜ [Task 58: Reconcile the realtime event and k6 metric vocabulary with the shared domain model](./task_58.md)

⬜ [Task 59: Raise recent-inventory-event retention to reference parity](./task_59.md)

⬜ [Task 60: Separate public and operator surfaces in the web UI and add confirmation flows to destructive actions](./task_60.md)

⬜ [Task 61: Reflect authenticated admin state consistently across admin surfaces](./task_61.md)

⬜ [Task 62: Fix contradictory empty-state copy on out-of-range run-history pages](./task_62.md)

⬜ [Task 63: Render public-safe error states for malformed run-history routes](./task_63.md)

⬜ [Task 64: Route browser SSE through a web-owned proxy and remove the public direct-API override](./task_64.md)

⬜ [Task 65: Add active retry to recovery-read failures in the dashboard](./task_65.md)

⬜ [Task 66: Tighten the public run-history detail DTO](./task_66.md)

⬜ [Task 67: Make the root test lanes honest: include all unit suites in watch, cover high-risk suites in coverage, enforce a floor](./task_67.md)

⬜ [Task 68: Fix and gate the test-source type-check command](./task_68.md)

⬜ [Task 69: Adapt the design docs and README to implementation reality and correct overstated status/access claims](./task_69.md)

⬜ [Task 70: Harden startup reconciliation with per-run failure isolation and an eligibility self-expiry backstop](./task_70.md)

⬜ [Task 71: Single-source the vocabulary: derive DB enums from contract enums and add transition helpers](./task_71.md)

⬜ [Task 72: Govern machine-readable error codes in the shared contract](./task_72.md)

⬜ [Task 73: Adopt donor SSE gateway mechanics (heartbeat, retry directive, proxy-buffering header, bounded queues)](./task_73.md)

⬜ [Task 74: Port donor hard-property and interleaving test cases](./task_74.md)

⬜ [Task 75: Harden runtime images: non-root users, per-service packaging, smaller production images](./task_75.md)

⬜ [Task 76: Centralize declared non-goals and live caveats in one auditable scoping page](./task_76.md)

⬜ [Task 77: Bind internal traffic ingestion to the accepted run](./task_77.md)

⬜ [Task 78: Enforce lifecycle coherence in boundary DTOs with discriminated unions](./task_78.md)

⬜ [Task 79: Bound process-local run state (mock-ERP ledger, run semaphores)](./task_79.md)

⬜ [Task 80: Scope the infra-only shutdown command to the infra services](./task_80.md)

⬜ [Task 81: Compute the smoke's budget-cleanup window at consumption time](./task_81.md)
