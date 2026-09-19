# 01 — Define contracts and acceptance fixtures

## Handoff

- Status: Pending.
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

- [ ] Add shared schemas/types for the operational reasons, closed failure vocabulary/categories, distinct ERP-call identity, processing generation, administrative-stop evidence, and engine-policy identity. Preserve stable order/idempotency identity and correlation lineage separately from delivery identity.
- [ ] Define recognized ERP outcomes: `429 erp_capacity_exceeded`; recognized `503` outage/injected-error codes; connection failure; timeout/uncertain result; explicit permanent rejection; intervention. `401`/`403` block a scope, malformed protocol or identity contradiction blocks an order, and unknown codes are intervention rather than invented business rejection. The current mock emits no permanent business rejection; only an explicitly declared shared code may ever acquire that meaning.
- [ ] Define lookup results `succeeded | rejected | unknown`, canonical identity/result, and replay metadata as the `x-erp-replayed: true` response header, not a JSON field. `unknown` is not evidence of no effect.
- [ ] Define estimator input/output, explanatory versus conservative duration, assumptions, bottleneck, policy/estimator version, effective ceiling, decision, fingerprint, structured `estimate_stale` rejection with fresh preview, accepted estimate snapshot, and over-estimate/over-ceiling observations. Keep estimator logic out of contracts.
- [ ] Define the predefined, versioned admin profile shape: identity, base configuration, ordered finite segments, recovery to base, and durable anchor at acceptance plus start delay. Do not add a public profile editor or public outage capability.
- [ ] Inventory every consumer of `retryPolicy`, `maxAttempts`, `initialBackoffMs`, recovery-publication limits, `drainTimeoutSeconds`, `business_drain_timeout`, circuit settings, `requestTimeoutMs`, lifecycle terminal guards, and run-sale TTL assumptions. Add the concrete owner/test mapping to [the execution index](index.md) as implementation-time evidence.
- [ ] Add named deterministic fixtures: original incident (25 requests/s, 60 seconds, 1,500 attempts, 888 stock, quantity 1, ERP 10/s and 250 ms, concurrency 5, no injected error/outage), low capacity, finite outage, latency increase, duplicate attempts, and the existing `surge-10k` preset. Keep production runtime resources out of fixtures.
- [ ] Record calibration criteria before choosing constants: incident 888 confirmations/notifications under 240 s on the documented local runtime; stable 10/s fixture at least 8 confirmations/s and at most 5% capacity responses in a stable 60 s window; at most one outage probe/scope per 5 s after opening, excluding already-dispatched calls; exact accounting. Constants remain provisional until task 20 and explicit user approval.

## Runnable boundary and non-goals

Introduce contracts additively where later consumers are not ready. Do not make a new field required across a live boundary until its producer and readers are updated in the same runnable slice. Do not activate the scheduler, remove working controls piecemeal, add a migration for historic incident data, or advertise the final guarantee. Task 12 owns final retirement of scenario-level engine knobs.

## Acceptance and validation

- [ ] Contract tests distinguish all reachable operational and terminal cases; malformed/unknown ERP responses cannot become business rejection by default.
- [ ] Seeded scenario contracts continue to parse, public caps remain unchanged, and historic snapshots have an explicit read-only compatibility strategy.
- [ ] Fixtures contain exact expected counts, not only eventual-success assertions. Each changed behavior has an owner and intended test boundary.
- [ ] Run focused contracts/consumer tests, `pnpm test:unit`, and `pnpm type-check`. Use `pnpm test:infra:up` before any necessary API/integration lane.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md) before editing and self-review before completion. Keep routes thin, infrastructure in composition roots, and all artifacts in English. Format only touched supported files with `pnpm exec biome check --write <files>` and verify with `pnpm exec biome check <files>`. Use the documented Linux/Dev Container path; do not run composition/characterization suites or mutate the user's reference runtime. Report actual checks, skipped checks, and deviations. A deviation from D01–D14 requires an explicit user decision, not an agent-selected substitute.

## Completion handoff

Deliver the runnable contract/fixture slice and consumer map. Record schema exports, fixture locations, provisional policy parameters, checks, and any narrow temporary compatibility code that later tasks must remove. Next: [02 — durable persistence](02_add_durable_control_and_attempt_persistence.md).
