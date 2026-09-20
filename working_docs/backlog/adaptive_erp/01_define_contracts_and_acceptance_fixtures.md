# 01 — Define contracts and acceptance fixtures

## Handoff

- Status: Completed (contracts, fixtures, consumer inventory, and calibration criteria; runtime behavior unchanged).
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 01 of 21. Prerequisite: none; inspect the current branch before editing.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 1, sections 4–8 and 11, decisions D01–D14. Decomposition baseline: commit `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: shared contracts, acceptance fixtures, and the boundaries consuming those contracts.

## Objective and fixed rules

Establish the vocabulary and executable fixtures for a resilient asynchronous checkout without switching the runtime to an incomplete workflow. Redis still owns atomic reservations, PostgreSQL owns durable obligations, BullMQ supplies wake-ups, and the API never waits for ERP processing.

Keep order statuses `queued | processing | confirmed | failed` and run statuses `starting | active | draining | completed | failed`. Waiting, uncertainty, and intervention are operational dimensions, not new lifecycle statuses. Waiting reasons are `local_admission`, `erp_capacity`, `erp_unavailable`, `uncertain_result`, `intervention_required`, or none. Terminal failure categories are `business_rejection` and `administrative`; technical failures are not terminal business outcomes.

The live controller observes responses, never declared ERP capacity or future profile segments. The API estimator does use declared scenario conditions. The initial occupancy ceiling is 600 seconds, inclusive, from acceptance through expected settlement. This is run-start admission, not a new `/buy` backlog gate and not an order expiry. Existing public 10,000-buyer bursts remain supported.

## Repository entry points

Inspect `packages/contracts/src/{erp,lifecycle,entities,queue,demo,run-result,run-signals,public-runtime-policy-validation,testing,index}.ts`, their tests, `packages/db/src/schema.ts`, `apps/worker/src/application/{run-config,order-process-job-handler,order-recovery-scanner}.ts`, and `apps/api/src/services/{demo-run-service,demo-run-finalization-service,public-runtime-policy-service}.ts`. Include web drafts/presentation and the load-orchestrator journal in the consumer inventory. New modules belong beside the owner they serve; do not create a general framework.

## Implementation work

- [x] Add shared schemas/types for the operational reasons, closed failure vocabulary/categories, distinct ERP-call identity, processing generation, administrative-stop evidence, and engine-policy identity. Preserve stable order/idempotency identity and correlation lineage separately from delivery identity.
- [x] Define recognized ERP outcomes: `429 erp_capacity_exceeded`; recognized `503` outage/injected-error codes; connection failure; timeout/uncertain result; explicit permanent rejection; intervention. `401`/`403` block a scope, malformed protocol or identity contradiction blocks an order, and unknown codes are intervention rather than invented business rejection. The current mock emits no permanent business rejection; only an explicitly declared shared code may ever acquire that meaning.
- [x] Define lookup results `succeeded | rejected | unknown`, canonical identity/result, and replay metadata as the `x-erp-replayed: true` response header, not a JSON field. `unknown` is not evidence of no effect.
- [x] Define estimator input/output, explanatory versus conservative duration, assumptions, bottleneck, policy/estimator version, effective ceiling, decision, fingerprint, structured `estimate_stale` rejection with fresh preview, accepted estimate snapshot, and over-estimate/over-ceiling observations. Keep estimator logic out of contracts.
- [x] Define the predefined, versioned admin profile shape: identity, base configuration, ordered finite segments, recovery to base, and durable anchor at acceptance plus start delay. Do not add a public profile editor or public outage capability.
- [x] Inventory every consumer of `retryPolicy`, `maxAttempts`, `initialBackoffMs`, recovery-publication limits, `drainTimeoutSeconds`, `business_drain_timeout`, circuit settings, `requestTimeoutMs`, lifecycle terminal guards, and run-sale TTL assumptions. Add the concrete owner/test mapping to [the execution index](index.md) as implementation-time evidence.
- [x] Add named deterministic fixtures: original incident (25 requests/s, 60 seconds, 1,500 attempts, 888 stock, quantity 1, ERP 10/s and 250 ms, concurrency 5, no injected error/outage), low capacity, finite outage, latency increase, duplicate attempts, and the existing `surge-10k` preset. Keep production runtime resources out of fixtures.
- [x] Record calibration criteria before choosing constants: incident 888 confirmations/notifications under 240 s on the documented local runtime; stable 10/s fixture at least 8 confirmations/s and at most 5% capacity responses in a stable 60 s window; at most one outage probe/scope per 5 s after opening, excluding already-dispatched calls; exact accounting. Constants remain provisional until task 20 and explicit user approval.

## Runnable boundary and non-goals

Introduce contracts additively where later consumers are not ready. Do not make a new field required across a live boundary until its producer and readers are updated in the same runnable slice. Do not activate the scheduler, remove working controls piecemeal, add a migration for historic incident data, or advertise the final guarantee. Task 14 owns final retirement of scenario-level engine knobs.

## Acceptance and validation

- [x] Contract tests distinguish all reachable operational and terminal cases; malformed/unknown ERP responses cannot become business rejection by default.
- [x] Seeded scenario contracts continue to parse, public caps remain unchanged, and historic snapshots have an explicit read-only compatibility strategy.
- [x] Fixtures contain exact expected counts, not only eventual-success assertions. Each changed behavior has an owner and intended test boundary.
- [x] Run focused contracts/consumer tests, `pnpm test:unit`, and `pnpm type-check`. Use `pnpm test:infra:up` before any necessary API/integration lane.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md) before editing and self-review before completion. Keep routes thin, infrastructure in composition roots, and all artifacts in English. Format only touched supported files with `pnpm exec biome check --write <files>` and verify with `pnpm exec biome check <files>`. Use the documented Linux/Dev Container path; do not run composition/characterization suites or mutate the user's reference runtime. Report actual checks, skipped checks, and deviations. A deviation from D01–D14 requires an explicit user decision, not an agent-selected substitute.

## Completion handoff

Deliver the runnable contract/fixture slice and consumer map. Record schema exports, fixture locations, provisional policy parameters, checks, and any narrow temporary compatibility code that later tasks must remove. Next: [02 — durable persistence](02_add_durable_control_and_attempt_persistence.md).

## Completion notes

### Schema exports (all additive, none required on a live boundary)

- `packages/contracts/src/lifecycle.ts` (extended): `orderWaitingReasonValues`/`orderWaitingReasonSchema`, `orderFailureCategoryValues`/`orderFailureCategorySchema`, `administrativeOrderFailureCodeValues`/`administrativeOrderFailureCodeSchema`.
- `packages/contracts/src/erp-outcomes.ts` (new): `erpErrorCodeValues`/`erpErrorCodeSchema` (`erp_capacity_exceeded`, `erp_forced_outage`, `erp_injected_error`, `erp_idempotency_conflict`), `erpPermanentRejectionCodeValues`/`erpPermanentRejectionCodeSchema` (declared empty), `erpOutcomeDispositionValues`/`erpOutcomeDispositionSchema`, `recognizedErpErrorCodeDispositions` (pure data mapping), `erpLookupStatusValues`/`erpLookupStatusSchema`, `erpLookupIdentitySchema`, `erpLookupResultSchema` (terminal branches carry the immutable identity; the `unknown` branch carries only its status and at most the queried idempotency key, per D05), `erpLookupResponseSchema`, `erpReplayedResponseHeaderName`/`erpReplayedResponseHeaderValue`.
- `packages/contracts/src/processing-control.ts` (new): `erpCallIdSchema`, `erpCallReferenceSchema`, `processingGenerationSchema`, `administrativeStopEvidenceSchema`, `enginePolicyIdentitySchema`.
- `packages/contracts/src/erp-profile.ts` (new): `erpProfileIdentitySchema`, `erpProfileSegmentOverrideSchema`, `erpProfileSegmentSchema`, `erpProfileSchema` (strictly increasing offsets, at least one finite segment, `recoveryToBase: true`), `erpProfileAnchorSchema`.
- `packages/contracts/src/estimate.ts` (new): `estimatedDemoOccupancyCeilingSeconds` (600, provisional), `estimatorInputSchema` (includes the declared base `declaredErpForcedOutage` flag), `estimatorBottleneckValues`, `estimateAssumptionSchema`, `estimatorDecisionValues`, `estimatorUnestimableReasonValues`/`estimatorUnestimableReasonSchema` (`declared_permanent_outage`, `error_rate_above_policy_maximum`, `unsupported_scenario`), `estimatorResultSchema` (an estimable result carries both durations and is `admitted` if and only if the conservative duration is at most the effective ceiling; an unestimable result is always `rejected` with a reason and no duration figures), `estimateFingerprintSchema`, `estimatePreviewSchema`, `estimateStaleRejectionSchema`, `acceptedEstimateSnapshotSchema` (records only a within-ceiling, admitted estimate), `estimateObservationKindValues`, `estimateObservationSchema`.
- All of the above are exported through `packages/contracts/src/index.ts` exactly like the existing modules. No estimator/controller/classifier logic was added; the only mapping table is the pure data object `recognizedErpErrorCodeDispositions`.

### Fixture locations and expected counts

Named deterministic fixtures live in `packages/contracts/src/acceptance-fixtures.ts`, re-exported through the existing `@checkout-surge/contracts/testing` entry point from `packages/contracts/src/testing.ts`:

- `originalIncidentFixture()` — constant 25 req/s × 60 s (1,500 attempts), stock 888, quantity 1, ERP 10/s at 250 ms, concurrency 5, no chaos; expected 888 accepted reservations, 612 sold-out responses, 888 confirmations, 888 notifications, 0 terminal failures.
- `lowCapacityFixture()` — 10 req/s × 60 s, stock 300, ERP 2/s at 200 ms; expected 300 accepted, 300 sold-out, 300 confirmations/notifications, 0 terminal failures.
- `finiteOutageFixture()` — buyer spike of 200, stock 200, ERP 200/s at 1000 ms (service rate min(200, 5/1.0) = 5/s; ideal completion 200/5 = 40 s), plus admin-scope profile `finite-outage-recovery` (outage from 10 s for 30 s, opening with 150 orders outstanding, recovery to base at 40 s); expected 200 accepted, 0 sold-out, 200 confirmations/notifications, 0 terminal failures.
- `latencyIncreaseFixture()` — constant 20 req/s × 30 s (600 attempts), stock 600, ERP 10/s at 250 ms (service 10/s vs 20/s arrivals, so work is continuously outstanding), plus admin-scope profile `latency-increase-recovery` (latency 3000 ms from 15 s for 30 s — beyond the 2000 ms initial request deadline — recovery to base); expected 600 accepted, 0 sold-out, 600 confirmations/notifications, 0 terminal failures.
- `duplicateAttemptsFixture()` — 200 buyers each clicking twice (400 emitted attempts), stock 200; expected 200 accepted, 0 sold-out, 200 duplicate idempotent replays, 200 confirmations/notifications, 0 terminal failures.
- `surge10kPresetReferenceFixture()` — reference to the existing seeded public `surge-10k` preset by slug (configuration deliberately not copied); expected 10,000 attempts, 1,000 accepted, 9,000 sold-out, 1,000 confirmations/notifications, 0 terminal failures.

Fixture scenario configs parse with `acceptedRunConfigSnapshotSchema`; profiles parse with `erpProfileSchema`. No fixture contains URLs, connection strings, or clients. Timings and policy constants are absent from expected values.

### Provisional policy parameters

D14 calibration criteria, the sanity envelopes (`60 + 888/10 = 148.8 s`, `120 + 1000/250 = 124 s`), and the list of provisional policy parameters are recorded in [calibration criteria](calibration_criteria.md), linked from the execution index. The only policy-shaped constant exported by contracts is `estimatedDemoOccupancyCeilingSeconds = 600` (inclusive, provisional).

### Snapshot compatibility strategy (D13)

History readers accept and ignore retired fields; nothing is migrated or rewritten. This slice adds no field to any existing schema, so no reader changed. Contract test `packages/contracts/test/acceptance-fixtures.test.ts` ("still parses the legacy accepted snapshot shape with retired engine fields") proves that an accepted snapshot carrying `retryPolicy`, `drainTimeoutSeconds`, `circuitBreakerFailureThreshold`/`circuitBreakerResetTimeoutMs`, and `erpConfig.requestTimeoutMs` (and no new field) still parses with `acceptedRunConfigSnapshotSchema`. Task 14 must keep readers tolerant when it removes those fields from new snapshots.

### `idempotency_conflict` naming gap

The mock ERP emits the literal `idempotency_conflict` without the `erp_` prefix in `apps/mock-erp/src/server.ts` (409), while contracts declare the closed vocabulary name `erp_idempotency_conflict` (D03). The mock was intentionally not modified in this task. Until task 03/04 aligns the emitted code with the shared vocabulary, the unprefixed code falls under "unknown code → intervention", which is the safe disposition; the prefixed declared code maps to `intervention_required` in `recognizedErpErrorCodeDispositions`.

### Temporary compatibility code for later tasks to remove

- No shim, alias, or dual-read path was introduced; all exports are purely additive.
- The fixture configs in `acceptance-fixtures.ts` (`backpressureConfig()` and `erpConfig.requestTimeoutMs`) still carry the retired engine knobs with their current seed values, only because `acceptedRunConfigSnapshotSchema` requires them today. Task 14 must drop them from the fixtures when it retires those fields.
- The declared-empty `erpPermanentRejectionCodeValues` list is the intended mechanism (not a placeholder to delete): task 03/04 adds a member there before any rejection code acquires business-rejection meaning.

### Checks actually run (Linux/Dev Container, repo root)

- `pnpm exec biome check --write <13 touched contracts files>` — fixed formatting in 6 files; follow-up `pnpm exec biome check <same 13 files>` — clean ("Checked 13 files … No fixes applied"). Markdown is not biome-checked; documents were reviewed directly.
- `pnpm --filter @checkout-surge/contracts test:unit` — 9 test files, 197 tests passed after the review fixes.
- `pnpm test:unit` — environment-safety lane passed (7/7); the `test:scripts` lane fails with 3 pre-existing failures in `scripts/runtime-smoke.test.mjs` (SSE DashboardProjection parsing, "Invalid input: expected 4"). These failures reproduce identically on the unmodified tree (verified by stashing this task's changes, rebuilding, and rerunning: 19 pass / 3 fail on clean HEAD), so they pre-date task 01 and are unrelated to it. Because that lane aborts the chain, the workspace vitest lane was run directly: `pnpm exec turbo run test:unit` — 10/10 tasks successful (contracts 192, api, worker 85, db 55, mock-erp 59, load-orchestrator 177, web 788 tests passed).
- `pnpm type-check` — successful (11/11 tasks, including `tsconfig.test.json`).
- Skipped: `pnpm test:api`, `pnpm test:integration`, `pnpm test:infra:up` (no consumer changed in this slice), and per instructions `pnpm test:composition`/`pnpm test:characterization`.

### Conflicts with D01–D14 or the checklist

None. No deviation required a user decision.
