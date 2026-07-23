# Task 41 — Consolidate runtime smoke, health, SSE, and bounded-load verification

## Execution context

- **Position:** 41/45; Phase 7, following dashboard protocol convergence.
- **Dependencies:** Retained runtime behaviour, health surface, SSE projection protocol, and representative bounded-load scenario must be stable. Preserve composition and 10k characterization as deliberate opt-in lanes.
- **Standalone:** Provide one understandable routine runtime smoke workflow that proves a local reference runtime is healthy, can stream a dashboard projection, and handles one representative bounded load; delete redundant wrappers rather than adding another command layer.
- **Checklist / working record:** Primary ownership is root verification command/script/documentation consolidation. Runtime routes remain thin and services retain their own logic. Record old/new command map, chosen smoke inputs, deletions, command output, and skipped opt-in lanes below.

## Why

Separate smoke, health, SSE, load, soak, wrapper, meta-test, and Compose-text workflows form a secondary product. A maintainer should be able to run one small, legible verification path without losing the expensive lanes that serve different evidence.

## Required outcome

Converge routine runtime verification on one workflow containing health, dashboard SSE/projection observation, and a representative bounded load. Remove confirmed redundant commands, scripts, wrappers, tests, and documentation while leaving the existing `pnpm test:composition` and `pnpm test:characterization` commands explicitly available but not implicit. Both use the repository's composition-characterization implementation, which contains the 10k scenario; do not invent a third standalone 10k command.

## Concrete scope and paths

- Root `package.json`, workspace package scripts, and any `runtime-smoke*`, health, recovery-soak/load, or `run-in-compose` scripts.
- Root and relevant package tests/docs that describe or mechanically assert the old command graph.
- Runtime smoke fixtures/configuration only when needed for the one workflow.

Choose one command and one implementation path. It must start against the documented local runtime (or validate an already-started documented runtime), verify health/readiness, open/validate an SSE dashboard projection including heartbeat/lifecycle expectations, run one bounded representative load, and report a useful failure location. Reuse existing public interfaces; do not couple the command to private test helpers or create another generalized orchestration framework. Delete redundant aliases/wrappers/soak variants only after mapping them to the retained workflow or an explicit opt-in lane. Preserve `pnpm test:composition` and `pnpm test:characterization` as clearly labelled opt-in commands; document that their shared composition-characterization implementation owns the 10k scenario, and ensure the normal smoke never invokes either.

## Retained behaviour and non-goals

Retain meaningful health checks, bounded load evidence, dashboard delivery verification, and separately valuable recovery/compose/10k coverage. Do not weaken runtime checks into package-text assertions, fold composition into ordinary smoke, or make broad deployment/Compose changes.

## Acceptance

- [x] One documented routine workflow covers health, SSE/projection, and representative bounded load.
- [x] Its inputs, timeout/bounds, and expected output make failures actionable.
- [x] Redundant scripts, wrappers, meta-tests, and docs are removed or mapped to a distinct retained purpose.
- [x] Composition and 10k characterization remain explicit opt-in lanes and are not run by normal smoke.
- [x] No new command graph or generic harness remains alongside the old one.

## Focused verification

Run the retained runtime smoke in the available local environment, plus affected script/unit tests and lint/type checks for changed script code. If services are unavailable, record the exact prerequisite failure. Do not run composition or characterization absent explicit authorization.

## Working record

Completed 2026-07-23.

### Ownership and command map

Routine verification now has one root command and one implementation:

| Before | After |
| :-- | :-- |
| `pnpm health:check` → `run-in-compose.mjs` → `runtime-health-check.mjs` | Removed; readiness is the first stage of `pnpm runtime:smoke`. |
| `pnpm runtime:smoke` → host-only `runtime-smoke.mjs` → health wrapper + SSE helper | `pnpm runtime:smoke` → `run-in-compose.mjs` → the single `runtime-smoke.mjs` implementation. |
| `pnpm runtime:smoke:load` → `run-in-compose.mjs` → `runtime-smoke-load.mjs` → steady plus accepted-burst scenarios | Removed; the accepted burst is the one representative load inside `runtime:smoke`. |
| `pnpm runtime:smoke:load -- --dashboard-delivery-baseline` | Removed with the Task 36–40 projection-volume/size measurement product. |
| `pnpm runtime:soak:recovery` | Retained as a distinct, explicitly opt-in idle recovery regression covering more than two recovery-budget windows. |
| `pnpm test:composition` and `pnpm test:characterization` | Retained exactly as explicit opt-in lanes. Both use `scripts/composition-characterization.mjs`, which alone owns the 10,000-buyer scenario; characterization runs the focused browser workflow first. |

`scripts/run-in-compose.mjs` remains the small shared host-versus-runtime-tools adapter for the genuinely distinct reset, maintenance cleanup, recovery soak, and unified smoke operations. No compatibility alias or alternate smoke implementation remains.

### Selected routine scenario and bounds

- Prerequisite: an already-started and seeded documented reference runtime plus `CONTROL_SERVICE_TOKEN`. The command does not start Compose or migrate data.
- Preflight: the protected API demo reset may terminalize an existing recoverable current run; it intentionally does not reset Mock ERP chaos.
- Load: one admin-authorized `public-custom` buyer spike, 32 buyers, stock 32, quantity 1, no duplicates, zero start delay, 5-second k6 maximum duration, zero ERP latency/error/outage, ERP max TPS 100, and a 2-second ERP request timeout. Admin authorization avoids consuming public visitor/global start budgets during repeat routine checks.
- HTTP bound: 10 seconds per complete request/response body.
- SSE bounds: 5 seconds for the complete `: connected` control frame, 20 seconds for a timestamped heartbeat, and 64 KiB per complete or incomplete frame buffer.
- Run bound: one absolute evidence deadline starts immediately before the load request and is shared by nonterminal SSE, terminal Run History, and completed SSE projection waits. It is traffic duration + configured drain timeout + three finalization polling intervals + 10 seconds, or 330 seconds under the documented defaults. `RUNTIME_SMOKE_RUN_TIMEOUT_MS` is the positive runtime-tools-forwarded override; sequential stages do not each receive a fresh 330-second window.
- SSE evidence: every data frame must parse as the complete `checkout-surge.dashboard-projection` version 1 schema, revisions must increase within a scope, the exact run/sale/correlation lineage must deliver a nonterminal and completed lifecycle projection, and the stream must also deliver connection and heartbeat control frames.
- Terminal evidence: Run History must identify buyer-spike delivery with exactly 32 planned buyers and completed iterations; all 32 transport requests must start and complete without interruption/drop; all 32 reservations must confirm; all 32 notifications must record; sold-out, failed, queue, processing, retry, and pending-persistence outcomes must be zero; and the Redis terminal inventory must report 32 starting/reserved, zero remaining/pending/sold-out. The completed live projection must independently agree on exact 32/32/32 transport, accepted/confirmed/notification business counts, zero failures/blockers/sold-out, allocated/reserved stock 32, remaining/pending zero, and zero sold-out pressure.
- Cleanup: the stream is open before start and carries a unique root correlation. If start acceptance is ambiguous, the smoke allows 5 seconds to recover a coherent matching run/sale projection; a foreign or absent identity authorizes no cleanup. Once exact identity is known, cleanup gets one fresh 30-second absolute budget for terminality observation, any matching reset, request retries, and retry delays. The SSE close itself is bounded at 5 seconds and releases its reader lock after settlement. Teardown validates the first successful HTTP payload's exact run and correlation plus the exact sale offer for a `deleted` outcome, without retrying an invalid success; only transport/non-success request failures retry, at most three attempts.
- Diagnostics: every boundary is named (`health/api`, `dashboard/recovery`, `sse/run_lifecycle`, `load/terminal_history`, `evidence/terminal_projection`, `cleanup/delete_exact_run`, and so on).

### Deletions and documentation

Deleted `runtime-health-check.mjs`, `runtime-smoke-load.mjs`, `runtime-smoke-sse.mjs`, their three mechanism-specific test files, the separate health/load root aliases, the steady routine scenario, public-cookie dependency in runtime-tools, and the projection delivery baseline flag, counters, sampling, size/cadence assertions, and fixtures. Replaced them with focused coverage at the one retained script boundary. Current README, local-development, topology, load/streaming, automated-testing, project-planning, Compose tooling, and root-command documentation now describe the single routine command and distinct opt-in lanes. Historical Task 36–40 working records retain their exact past command/results as history; they are not current command guidance.

### Verification

- `pnpm --filter @checkout-surge/contracts build && node --test scripts/runtime-smoke.test.mjs scripts/run-in-compose.test.mjs scripts/runtime-recovery-soak.test.mjs scripts/runtime-image-contract.test.mjs` — passed, 25 tests in the first focused pass.
- `pnpm test:scripts` — passed after the final SSE revision assertion, 46 tests.
- Initial focused `node --test scripts/runtime-smoke.test.mjs scripts/run-in-compose.test.mjs scripts/runtime-recovery-soak.test.mjs scripts/runtime-image-contract.test.mjs` — passed, 26 tests.
- Post-review pass 1 focused `node --test scripts/runtime-smoke.test.mjs scripts/run-in-compose.test.mjs scripts/runtime-recovery-soak.test.mjs scripts/runtime-image-contract.test.mjs` — passed, 35 tests. The added cases cover bodyless transient teardown retry, non-retriable successful identity mismatch, exact deleted-sale identity, correlated ambiguous-start cleanup, foreign/no-identity refusal, shared deadline exhaustion, strict heartbeat timestamps, pending-reader cancellation/release, and bounded uncooperative-reader close.
- Post-review pass 2 focused `node --test scripts/runtime-smoke.test.mjs scripts/run-in-compose.test.mjs scripts/runtime-recovery-soak.test.mjs scripts/runtime-image-contract.test.mjs` — passed, 38 tests. Mutation cases reject contradictory Run History buyer plan/completion and sold-out counts plus completed-projection transport, business failure/sold-out, allocation, and sold-out-pressure evidence. Cleanup diagnostics distinguish the exact-cleanup deadline from the shared run deadline and report the actual attempted teardown-request count.
- `docker compose config --quiet` — passed with the retained runtime-tools profile and `RUNTIME_SMOKE_RUN_TIMEOUT_MS` forwarding.
- Root command inventory printed exactly `runtime:smoke` and the distinct `runtime:soak:recovery` for names containing smoke/health/soak; no separate health or load-smoke alias remained.
- `pnpm type-check` — passed all 11 Turbo production/build tasks and `type-check:test`.
- `pnpm lint` — passed, 422 files.
- Focused `pnpm exec biome check` for the changed MJS test/script files passed in the initial pass; the post-review smoke script and focused test were formatted and checked again.
- `pnpm format:check` — the changed smoke files pass, but the repository-wide command remains red only on the untouched import order in `apps/api/src/runtime/pending-persistence-operation-factory.ts`. Task 40 deliberately restored that pre-existing order, so Task 41 did not make an unrelated formatting edit.
- `git diff --check` — passed.
- `pnpm runtime:setup` — could not prepare the existing named-volume runtime: migration validation rejected the stored pre-current active policy because it contains the removed `deploymentHardCaps` key. The documented remedy is the intentional wipe-and-rebuild workflow, but this task explicitly forbids wiping volumes.
- `pnpm runtime:smoke` — ran once and failed at the expected named prerequisite stage, `failed health/api: fetch failed (ECONNREFUSED)`, because the incompatible existing volume prevented setup and no API reference runtime was running. No runtime result was fabricated.
- `pnpm runtime:down` — stopped and removed only the PostgreSQL/Redis containers and network started by the failed setup attempt while preserving the named volumes.
- `pnpm test:composition` and `pnpm test:characterization` — explicitly not run. They remain slow, Docker-dependent opt-in lanes and the task/repository instructions prohibit invoking them without authorization.

### Final self-review

- The change is confined to the runtime verification command/script/test/documentation boundary plus one narrowly required runtime-tools timeout forwarding/removal of the obsolete public-cookie input.
- Public HTTP/SSE contracts and protected exact teardown are reused; no route, application service, persistence adapter, shared contract, generalized orchestration framework, or deployment topology was added.
- The routine smoke does not invoke composition, characterization, or any 10,000-buyer scenario.
- Recovery soak, reset, and maintenance remain distinct operations rather than aliases for the routine smoke.
- A successful teardown response is an assertion boundary, not retry input; an ambiguous start can authorize cleanup only from the unique correlated projection already observed on the open stream.
- Sequential run-evidence waits consume one absolute deadline, while exact cleanup and SSE shutdown have separate small safety bounds. Failure aggregation retains the primary verification error alongside SSE-close and exact-cleanup diagnostics.
- The zero-chaos accepted burst is proved independently at immutable history and completed live-projection boundaries; transport, buyer-delivery, business, inventory, and sold-out evidence cannot contradict the exact 32-buyer claim while still passing.
