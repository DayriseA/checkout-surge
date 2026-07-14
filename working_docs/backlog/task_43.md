# Task 43: Fix steady-arrival VU sizing defaults, cap derived VUs, and add `gracefulStop`

## Execution context

- **Execution order:** This is task 43 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P2
- **Area:** load-orchestrator
- **Source:** comparison (worse)
- **Standalone reference context:** the relevant reference behavior, formulas, limitations, target-specific validation semantics, and focused verification are inlined below; no other repository or branch is required.
- **Locations:** `packages/contracts/src/load.ts`, `apps/load-orchestrator/src/application/k6-script.ts`

Preallocated VUs default to `ceil(rate / 2)` and max VUs to `rate * 2` with no local cap on derived values; API hard-cap validation checks only explicit VU overrides, so derived defaults can exceed deployment caps. Under-provisioned preallocation can make k6 itself the bottleneck for steady runs (the same failure class that sank GLM's demos). Generated scenarios also omit `gracefulStop`.

## Standalone reference findings

### Exact reference sizing and scenario behavior

The useful implementation is `checkout-forge/apps/load-orchestrator/src/k6-script.ts::createConstantArrivalRatePlan()` plus `createK6ScenarioSnippet()`. For a steady-arrival snapshot it first normalizes the scheduled values:

```ts
const durationSeconds = Math.max(1, Math.ceil(trafficConfig.durationSeconds));
const scheduledRate = Math.max(1, Math.ceil(trafficConfig.ratePerSecond));
```

It then resolves automatic VU capacity with a process-local ceiling of `10_000`:

```ts
const automaticPreAllocatedVUs = Math.max(1, Math.min(scheduledRate, 10_000));
const automaticMaxVUs = Math.max(
  automaticPreAllocatedVUs,
  Math.min(Math.max(scheduledRate, Math.ceil(scheduledRate * 2)), 10_000),
);
```

For the positive integer rates accepted by Surge this simplifies to:

- `automaticPreAllocatedVUs = min(ratePerSecond, 10_000)`;
- `automaticMaxVUs = max(automaticPreAllocatedVUs, min(ratePerSecond * 2, 10_000))`.

The reference uses an explicit `preAllocatedVUs` when supplied. With no explicit `maxVUs`, it chooses `max(resolvedPreAllocatedVUs, automaticMaxVUs)`; with an explicit maximum, it chooses `max(resolvedPreAllocatedVUs, explicitMaxVUs)`. Its generated constant-arrival scenario contains `rate`, `timeUnit: "1s"`, `startTime`, `duration`, the two resolved VU values, and `gracefulStop: "5s"`. The buyer-spike `per-vu-iterations` scenario also includes the same explicit five-second `gracefulStop` beside `maxDuration`.

The reference's focused cases establish these automatic results:

| Rate | Duration | Planned attempts | Preallocated VUs | Max VUs |
| ---: | ---: | ---: | ---: | ---: |
| 1,000/s | 1 s | 1,000 | 1,000 | 2,000 |
| 5,000/s | 1 s | 5,000 | 5,000 | 10,000 |
| 10,000/s | 1 s | 10,000 | 10,000 | 10,000 |
| 10,000/s | 3 s | 30,000 | 10,000 | 10,000 |

It separately proves that explicit `3_000`/`5_000` controls are preserved and that explicit preallocation `3_000` with no maximum produces a maximum of at least `3_000`. Script generation asserts the literal `gracefulStop: "5s"`.

### Why rate, duration, and VUs are different quantities

For k6's open-model `constant-arrival-rate` executor, `ratePerSecond` is the number of iterations k6 tries to start each second. A VU is a reusable worker, not one planned request. Approximate concurrency demand is `ratePerSecond * iterationDurationSeconds`; for example, 1,000 iterations/s with an average one-second iteration needs roughly 1,000 concurrently available VUs, while 100 ms iterations may need far fewer. Preallocating one VU per scheduled request/second is therefore a deliberately conservative local default that avoids startup-time VU allocation and reduces the chance that the load generator, rather than Checkout Surge, causes dropped iterations. `maxVUs = 2 * rate` gives k6 headroom when response time rises, bounded by the local 10,000-VU safety ceiling.

`durationSeconds` controls how long new iterations are scheduled and therefore planned traffic (`ratePerSecond * durationSeconds`); it does not multiply the VU pool. A longer run sustains the same concurrency assumption for longer. `gracefulStop: "5s"` adds a bounded window in which already-started iterations may finish after the scheduling duration or buyer-spike maximum. It must not be included in `plannedRequests`, and it must not schedule replacement iterations during that window.

### Reference limitations that must not be copied blindly

The 10,000 ceiling is local and applies only to the reference's automatically calculated values. Explicit preallocation can exceed 10,000, and an omitted max then rises to that explicit preallocation. This is safe there only because an earlier API policy boundary is expected to reject excessive explicit controls. The local ceiling is also a fixed fallback, not awareness of a deployment whose configured cap is lower than 10,000.

The reference also silently repairs `maxVUs < preAllocatedVUs` by raising the maximum. Surge should reject that contradictory explicit input at its contract/policy boundary instead of accepting one snapshot and executing another. Finally, Forge's two top-level controls are independently optional, whereas Surge's established public contract has one optional `k6Vus` object in which both `preAllocatedVus` and `maxVus` are required. Preserve Surge's all-or-nothing override shape and spelling; do not broaden the contract merely to copy Forge's partial-override cases. Map the Surge names to k6's capitalized option names only in the resolved execution plan/scenario.

## Checkout-Surge implementation requirements

### One resolved plan, shared by generation and diagnostics

Extract a small pure steady-arrival resolver at the load-orchestrator application boundary rather than leaving formulas inline in the scenario object. It should return the exact accepted rate, duration, start delay, planned request count, resolved `preAllocatedVUs`, and resolved `maxVUs`. `generateK6Script()` must serialize those values, and the execution-plan diagnostics required by task 33 must consume the same result so a terminal report cannot claim the old `ceil(rate / 2)` capacity while k6 ran with another value.

When `k6Vus` is absent, use the reference automatic formulas with a named local constant such as `maximumAutomaticallyDerivedVUs = 10_000`. When the object is present, preserve both requested values after validating their relationship. Do not cap, raise, or otherwise mutate an explicit override in script generation: policy/contract validation owns rejection, while the local cap is a defense against unsafe derived defaults. Partial override semantics remain out of scope unless the shared contract and every caller are deliberately migrated together.

Surge's Zod traffic schema already requires positive integers, so the reference's `ceil`/minimum normalization is not needed after parsing. Avoid maintaining subtly different rounding behavior in the API and orchestrator. If internal callers can bypass schema parsing, parse the complete `TrafficExecutionStartRequest` at the HTTP boundary and keep the resolver typed to the parsed contract.

### Validation and error semantics

Add a semantic refinement for `k6Vus.maxVus >= k6Vus.preAllocatedVus` in `packages/contracts/src/load.ts`. Attach the issue to `k6Vus.maxVus` (the full request path becomes `configSnapshot.trafficConfig.k6Vus.maxVus`) with a field-specific message such as `maxVus must be greater than or equal to preAllocatedVus.` Keep malformed traffic-start payloads on the existing contract-validation/invalid-request path; do not throw an untyped error from template generation or let k6 discover the contradiction at process start.

`apps/api/src/services/demo-run-service.ts::validateAcceptedRunSnapshot()` currently applies `deployment_preallocated_vus_exceeded` and `deployment_max_vus_exceeded` only when `k6Vus` exists, and applies the analogous `public_preallocated_vus_exceeded` / `public_max_vus_exceeded` errors only to explicit public controls. The automatic 10,000 ceiling closes the default deployment case where the hard limits are 10,000, but it does not magically honor a lower environment-backed deployment cap introduced by task 24. Reuse the same pure resolution rules (or materialize validated resolved controls into the accepted execution request) when comparing derived values to the active deployment caps. Preserve the existing `DemoRunValidationError` codes and HTTP 400 mapping rather than inventing load-orchestrator error vocabulary.

Do not silently clamp an accepted plan to a lower active deployment cap: either resolve it using an explicitly supplied active ceiling before freezing the run, or reject it with the existing preallocated/max-VU cap code. The persisted accepted snapshot, generated scenario, and task-33 execution-plan diagnostics must agree about which values won. Public-custom limits remain a separate policy layer; if automatic values are made subject to those limits as part of this change, use the existing `public_*_vus_exceeded` codes consistently and cover the default public steady-arrival case so a rate-valid request does not become accidentally unusable.

### `gracefulStop` ownership

Add a named five-second value to every generated k6 scenario, not only steady arrival. It belongs in the k6 scenario options beside `duration` or `maxDuration`; it is not a new traffic-contract input, runtime policy knob, dashboard field, diagnostic contract field, or addition to the planned-request formula. Keep it explicit even if k6 currently has a default so generated behavior remains stable across runtime upgrades.

## Focused verification

Extend `apps/load-orchestrator/test/load-orchestrator.test.ts` at the existing generation boundary; no API, database, Redis, worker, browser, application startup, or performance run is needed:

- table-drive automatic steady-arrival cases for rates `1`, `1_000`, `5_000`, `10_000`, and a defensive value above `10_000`; assert preallocation is `min(rate, 10_000)`, max is `min(2 * rate, 10_000)` but never below preallocation, and planned requests remain `rate * duration`;
- prove duration changes planned requests but not VU sizing for the same rate;
- prove explicit `preAllocatedVus`/`maxVus` are serialized unchanged when valid, the existing schema continues to reject a partial `k6Vus` object, and `maxVus < preAllocatedVus` is rejected before generation rather than silently repaired;
- prove automatic values never exceed the named local 10,000 ceiling and exercise the exact boundary immediately below/at/above the point where `rate * 2` reaches it;
- assert both generated executor variants contain `"gracefulStop":"5s"`, while planned-request counts and `duration`/`maxDuration` remain unchanged;
- add contract fixtures that accept equal preallocated/max values and reject `maxVus < preAllocatedVus` at the exact nested path;
- add or update API policy fixtures if derived values are checked against active deployment/public caps, asserting the established error codes and proving a lower configured cap is not bypassed;
- where task 33 has already added execution-plan diagnostics, assert their resolved VU fields exactly match the scenario JSON for automatic and explicit cases.

Keep the existing generated-module syntax/`k6 inspect` coverage, but task 42 owns making the real-k6 lane mandatory. This task needs only focused generation and contract/policy tests and must not run a benchmark to claim that one VU per request/second is universally sufficient.

## Scope and non-goals

This task owns steady-arrival VU default resolution, safe handling of derived values, the explicit preallocated/max relationship, and a fixed `gracefulStop` in generated scenarios. It does not tune hosted benchmark capacity, dynamically estimate VUs from observed latency, change traffic rate/duration/request-count semantics, add a user-configurable graceful-stop field, change k6 summary ingestion (task 42), change delivery classification (task 40), or redesign the public runtime policy/configuration ownership (tasks 23 and 24). Keep API routes thin, keep k6-specific option mapping in the load-orchestrator application layer, and do not add infrastructure clients or start services in tests.

## Implementation record (2026-07-14)

- **Status:** Complete.
- **Implemented:** Added the nested `k6Vus.maxVus >= k6Vus.preAllocatedVus` contract refinement while preserving the strict all-or-nothing override. Added a contracts-owned pure VU resolver with a named 10,000 automatic ceiling. Added a load-orchestrator steady execution-plan resolver consumed by both scenario serialization and existing diagnostics. Automatic deployment-cap validation now uses resolved VUs; explicit-only public-custom VU cap behavior remains unchanged. Synthetic API failure diagnostics use the shared resolver. Both generated scenario modes now set a fixed `gracefulStop: "5s"` without changing planned counts or diagnostic contracts.
- **Ownership decision:** `@checkout-surge/contracts` owns the neutral automatic/explicit VU rule because both API policy/diagnostics and load orchestration consume it. The load-orchestrator application layer owns the full k6 execution plan and k6 option spelling. No API-to-application-package dependency was introduced.
- **Review correction:** Derived deployment-cap fixtures use semantically valid active policies: public-custom VU limits remain within deployment caps, deployment preallocation caps do not exceed deployment max-VU caps, and selected automatic rates isolate the intended preallocation or max-VU violation with exact code and details.
- **Single-source correction:** Script request guarding and returned `plannedRequests` now come directly from the resolved execution plan's `plannedEmittedAttempts`; scenario generation and Task-33 diagnostics already consume that same plan.
- **Documentation:** Updated load-generation behavior, admin access-policy wording, deployment-cap environment variable descriptions, and backlog completion tracking.
- **Verification passed:** `pnpm --filter @checkout-surge/contracts test:unit` (78 tests); `pnpm --filter @checkout-surge/contracts build`; `pnpm --filter load-orchestrator test:api` (87 tests); `pnpm --filter load-orchestrator test:unit` (109 tests); focused API synthetic diagnostics (2 tests); focused API derived-cap service validation (2 passed, 61 skipped by filter); type checks for contracts, load-orchestrator, and API; package lint for contracts, load-orchestrator, and API.
- **Skipped:** `pnpm test:composition` and `pnpm test:characterization` are prohibited for this task. The Docker-backed real-k6 compatibility lane was not run because Task 42 owns that mandatory repository lane and this task explicitly requires focused generation/contract/policy verification; existing compatibility coverage was preserved. No benchmark or application startup was performed.
- **Blockers/follow-up:** None.
