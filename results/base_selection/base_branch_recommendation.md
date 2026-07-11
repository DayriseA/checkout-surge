# Base-branch selection for Checkout-Surge consolidation

Decision date: 2026-07-11  
Decision status: current recommendation  
Recommended base: `ai/gpt-5.5` / `dev/gpt` at `01f71e4ab3a23b27be522393d2c7d5de4a303cef`  
Primary donor: `ai/opus-4.8` / `dev/opus` at `6d2585646ea94fc357aab10769ff805314e0d396`  
Selective donor: `ai/glm-5.2` / `dev/glm` at `c07e0de15be815d84419a1c2abd2967f72de0463`

## Executive decision

Use the GPT-5.5 implementation as the base for the next consolidation branch. Treat Opus-4.8 as the primary architectural and testing donor, and GLM-5.2 as a selective donor for bounded subsystems and patterns.

This is a base-selection decision, not a declaration that GPT-5.5 is production-ready or globally superior. GPT still has serious failure-path, lifecycle, durability, and deployment defects. Its advantage is narrower and more consequential: it is the implementation with the strongest evidence that the representative product workflow is already joined up. A user can start a meaningful surge run, see the buy and asynchronous processing pipeline operate, and reach terminal history with the expected outcome. Preserving that working vertical slice reduces integration uncertainty while the known structural defects are hardened.

Opus has the best unweighted verdict balance against the reference and contains many of the strongest individual design choices. Its unfavorable findings, however, cluster at the product's defining seam: reliable completion delivery, lifecycle transition ordering, terminal accounting, and durable summary creation. Small custom runs have completed in stored browser testing, but representative runs can remain unfinished under race- or load-sensitive conditions. Selecting Opus would therefore begin with a stabilization program before feature consolidation could safely resume.

GLM's visible demo failures are partly explained by a relatively local load-generation capacity problem, but fixing that symptom would reveal the largest residual high-severity repair surface across API activation, completion delivery, finalization, worker resilience, Redis admission, queue handoff, and ERP idempotency.

The recommended order is therefore:

1. **GPT-5.5 — base:** preserve and harden the demonstrated integrated workflow.
2. **Opus-4.8 — primary donor:** port selected architecture, recovery, metrics, packaging, and test ideas.
3. **GLM-5.2 — selective donor:** port contracts, frontend, SSE, correlation, governance, and selected Redis ideas after auditing their documented edge cases.

## Decision question

The question is not which implementation accumulated the largest number of favorable comparisons with Checkout-Forge. It is:

> Which current branch minimizes the risk and scope of reaching a trustworthy consolidation branch while preserving the best available implementation ideas from all three agents?

The decision weights five lenses:

1. **Representative end-to-end viability:** can the product demonstrate the burst, asynchronous processing, draining, finalization, and durable-history workflow it exists to demonstrate?
2. **Defect severity and location:** do defects sit on secondary surfaces, on partial-failure paths, or on the normal lifecycle's critical path?
3. **Repair radius:** can a defect be corrected within a bounded module, or does it require coordinated protocol and schema changes across services?
4. **Donor compatibility:** can strengths from another implementation be ported through existing boundaries without replacing the base's execution model?
5. **Evidence quality:** is a claim supported by a fixed-reviewer audit, fixed-comparer report, browser observation, direct code reading, or a later human observation?

## Evidence and limitations

This synthesis uses the following evidence:

- The fixed-comparer reports in `results/comparison_vs_base/` and their structured `C{n}` entries.
- The fixed-reviewer post-fix audits in `results/independent_review/`.
- The post-fix browser-use reports in `results/browser_use_testing/`.
- Read-only inspection of the three current implementation worktrees.
- The user's later representative runtime observations, including a successful GPT 10k spike and persistent failures on comparable GLM and Opus runs.

No runtimes or test suites were started for this base-selection review. Code-level root causes are therefore reasoned from the stored reports and current source, while the later human observations provide the strongest available evidence about representative runtime behavior.

One evidence conflict must remain explicit. The Opus browser report records small public custom runs that finalized and persisted history, while later representative testing reports that no meaningful Opus run truly completes. These claims are compatible: the implementation has race- and delivery-sensitive completion paths that small runs can traverse successfully while larger or differently timed runs become stranded. The synthesis does not claim that Opus can never complete any run.

Browser finding totals are also not direct quality scores. The three sessions covered different flows and scales. Their highest value here is behavioral evidence and root-cause correlation, not raw counting.

## Why the raw comparison net is insufficient

The comparison totals are:

| Candidate | Better | Same | Worse | Missing | Unknown | Net better − worse |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| GPT-5.5 | 19 | 43 | 53 | 1 | 1 | −34 |
| GLM-5.2 | 23 | 34 | 36 | 1 | 0 | −13 |
| Opus-4.8 | 32 | 59 | 29 | 1 | 0 | +3 |

Those verdicts are valuable, but their net is not a base-selection score:

- Every topic has equal weight. A documentation or UI improvement counts the same as losing the only completion message that can make a run finalizable.
- Reports have different topic counts and segmentation: 117 GPT entries, 94 GLM entries, and 121 Opus entries.
- Each branch is compared with Forge, not directly with the other branches.
- Breadth and polish are rewarded even when the implementation's normal deployed composition has a lifecycle gap.
- The reports describe topic-level capability, not the cost of changing the branch into a consolidation base.

The fixed-reviewer audit provides a second, more comparable lens:

| Candidate | High | Medium | Low | Total findings |
| --- | ---: | ---: | ---: | ---: |
| GPT-5.5 | 6 | 25 | 7 | 38 |
| Opus-4.8 | 6 | 30 | 8 | 44 |
| GLM-5.2 | 9 | 36 | 9 | 54 |

Even those counts require interpretation. GPT and Opus both have six high-severity findings, but Opus's high findings include the sole normal completion transition and non-atomic terminal accounting. GPT's high findings are also serious, but more of them concern crash windows, partial failures, races, and deployment safety around a demonstrated happy path.

## Candidate 1 — GPT-5.5 as the base

### Why GPT is the lowest-risk integration base

GPT has the strongest evidence of a coherent vertical slice. Stored browser testing covered public and admin starts, active and draining states, sold-out behavior, terminal summaries, and run-history detail. Later human testing adds the decisive representative-scale observation: a 10k spike can run through to the expected completion.

The branch connects Redis admission, durable reservation and order persistence, BullMQ handoff, ERP processing, notification follow-up, draining and finalization, SSE recovery, and terminal history. The orchestration is visible in `apps/api/src/services/reserve-order-service.ts:152-269`.

Several GPT choices are worth preserving:

- The initial Redis hold enters pending-persistence tracking immediately, and promotion removes it atomically (`gpt-5.5:C24`).
- Eligible retries can persist the original secured hold without decrementing stock again (`gpt-5.5:C25`).
- Deterministic order job IDs and replay reassertion make some queue/promotion partial states recoverable (`gpt-5.5:C38`).
- Terminal history uses a shared writer, an advisory lock, an allowed-state claim, and idempotent insertion (`gpt-5.5:C49`).
- The circuit breaker admits a single half-open probe and cooperates with delayed jobs (`gpt-5.5:C55`).
- Notification recovery scanning provides a real post-confirmation repair mechanism (`gpt-5.5:C60`).
- Worker payload validation and reuse of successful ERP attempts improve redelivery behavior (`gpt-5.5:C62`).
- Worker shutdown awaits and aggregates closure work (`gpt-5.5:C63`).
- Readiness actively probes required dependencies rather than reporting process liveness alone (`gpt-5.5:C96`).

The independent audit also reports the smallest total finding set: 38 findings, with six high severity.

### GPT systemic issues that must be fixed first

#### 1. Durable PostgreSQL-to-BullMQ handoff is missing

The reservation, queued order, and initial events commit before queue publication. If enqueue fails or the process dies in that window, recovery depends on a later request with the same idempotency key. A buyer who never retries leaves a durable queued order with no job, and the run can drain until timeout (`gpt-5.5:ir-F2`; `apps/api/src/services/reserve-order-service.ts:246-264`).

This needs a transactional outbox or an autonomous scanner for undispatched queued orders. The repair spans a migration, API publishing/reconciliation, and finalization semantics, but it is one coherent ownership problem.

#### 2. Pending Redis holds cannot recover after traffic closes

A failed PostgreSQL write can leave a real stock-consuming Redis hold. The current healing path is another `/buy` request, but generated-run gating happens before replay reconciliation. Once traffic completion closes eligibility, no client retry can reach that repair path (`gpt-5.5:ir-F1`; `apps/api/src/services/reserve-order-service.ts:159-235`).

The correct fix is an autonomous, idempotent reconciler that operates after admission closes without admitting new purchases. This concern should be designed together with the order-dispatch outbox rather than patched as another route exception.

#### 3. ERP-result persistence ambiguity can strand processing orders

ERP-attempt persistence failures are always retried through a finite BullMQ attempt budget without guaranteeing a terminal business transition. PostgreSQL failure after an ERP result can therefore exhaust delivery attempts while the order remains `processing` (`gpt-5.5:ir-F11`; `apps/worker/src/application/order-process-job-handler.ts:136-170`).

The consolidation needs a durable ERP-result/idempotency boundary and explicit recovery ownership for externally successful but locally incomplete work.

#### 4. Lifecycle transitions are not fully fenced

A late load-orchestrator acknowledgement can overwrite a draining or terminal run back to `active` because the update is not conditioned on the expected prior state (`gpt-5.5:ir-F16`; `apps/api/src/services/demo-run-service.ts:822-842`). Admin reset can also write an immutable failed summary before admission is closed, allowing later business state to be admitted and then omitted or deleted (`gpt-5.5:ir-F17`).

Lifecycle changes need compare-and-set transitions and a shared admission/terminal fence.

#### 5. Load completion is not durably owned

Completion delivery uses bounded retry but ultimately logs and discards the only handoff before deleting its work directory. A sufficiently long outage can strand the run (`gpt-5.5:ir-F18`; `apps/load-orchestrator/src/application/k6-runner.ts:198-244`).

Use a durable completion outbox with idempotent acknowledgement, or an API watchdog that can reconcile execution evidence independently.

#### 6. The surge loser path still touches PostgreSQL

Generated-run requests perform a PostgreSQL eligibility query before reaching Redis. That includes sold-out losers, undermining the intended Redis-first burst shape (`gpt-5.5:ir-F5`; `gpt-5.5:C32`). The observed 10k success makes this a known scalability and architecture risk rather than proof of current failure.

Port or design a fail-closed Redis eligibility projection, but couple it to the lifecycle fence so speed does not reintroduce late-buy races.

#### 7. Default control credentials are deployment blockers

The reference composition boots with checked-in fallback control, admin, and session secrets (`gpt-5.5:ir-F21`). This is locally fixable compared with the durability work, but it must be resolved before any public deployment.

### GPT issues that should not disqualify the base

The browser report identifies a hydration error, raw validation output for malformed history IDs, stale admin-auth wording, contradictory pagination copy, stale duplicate-form state, and missing preset deletion. The comparison also identifies numerous DTO, metric, frontend, database-index, migration-metadata, test-command, and documentation gaps.

These issues matter, but most can be corrected incrementally behind existing boundaries. They explain much of GPT's unfavorable raw verdict count without requiring replacement of the execution model.

### GPT repair-radius assessment

- **High but coherent:** durable handoffs, autonomous reconciliation, and lifecycle fencing.
- **Medium:** load completion, Redis eligibility, ERP-result recovery, and security hardening.
- **Low to medium:** UI, metrics, DTOs, indexes, checks, tests, operational commands, and documentation.

The key decision advantage is that this work hardens a demonstrated execution chain.

## Candidate 2 — Opus-4.8 as the primary donor

### Why Opus's favorable score is real

Opus has 32 better, 59 same, and 29 worse verdicts against Forge. Its strengths are substantial:

- Strong Redis idempotency and crash-consistency design (`opus-4.8:C21`).
- Redis-resilient pending sentinels and durable reconciliation (`opus-4.8:C24`, `C25`).
- An idempotent compensating reversal for non-retryable durable rejection (`opus-4.8:C26`).
- Broad hot-path hard-property testing (`opus-4.8:C33`).
- Better run-start provisioning failure handling and startup reconciliation (`opus-4.8:C39`, `C44`).
- Clean ports-and-adapters lifecycle decomposition with narrow interfaces, injected clocks, and testable collaborators (`opus-4.8:C49`).
- Valuable circuit-breaker, at-least-once, notification, worker-runtime, and SSE patterns (`opus-4.8:C53`, `C54`, `C55`, `C58`, `C59`).
- Bounded, windowed load-metric aggregation (`opus-4.8:C68`).
- Strong reverse-proxy and image construction (`opus-4.8:C97`, `C98`).
- More extensive hard-property and system-oriented test coverage (`opus-4.8:C109`).

Those qualities make Opus the richest donor branch.

### Why Opus should not be the base

#### 1. Completion delivery is a single lossy cross-service message

After k6 exits, the orchestrator sends one completion callback with a five-second timeout. Network failures and non-2xx responses are logged and swallowed (`apps/load-orchestrator/src/services/traffic-run-service.ts:124-136`; `traffic-reporter.ts:44-126`). Only that callback moves the API run to `draining`, and the finalizer scans only draining runs (`apps/api/src/services/load-completion-ingest.ts:59-71`; `finalization-store.ts:86-96`).

A transient failure at the end of a burst can therefore leave the run `active` indefinitely, block future runs, and prevent summary creation (`opus-4.8:ir-F3`; `opus-4.8:C69`). API saturation at precisely the terminal moment makes this particularly relevant to a surge product.

Repair requires a durable outbox/retry protocol or independent API reconciliation. This is cross-service protocol work, not a one-line retry adjustment.

#### 2. Fast completion can be overwritten back to active

The start service delegates background traffic before unconditionally marking the run active. A sufficiently fast run can complete and move to `draining`, then be regressed to `active` because `markActive` updates by ID without requiring `starting` (`apps/api/src/services/run-start-service.ts:248-259`; `postgres-run-store.ts:78-87`; `opus-4.8:ir-F19`).

This individual race is locally fixable with compare-and-set, but it demonstrates that the deployed lifecycle protocol is not coherently fenced.

#### 3. Terminal status and durable history can diverge permanently

Opus commits terminal status before writing the immutable summary. If summary creation fails, the poller cannot retry because it only selects draining runs. The implementation guarantees at most one summary, not exactly one summary for every terminal run (`opus-4.8:ir-F1`; `opus-4.8:C43`; `apps/api/src/services/run-finalization-service.ts:132-147`).

Terminalization also closes eligibility after summary capture, and the stock Lua script does not re-check eligibility. Concurrent late buys can therefore be excluded from immutable terminal accounting.

Fixing this requires a recoverable terminal workflow or transaction covering lifecycle claim, sale closure, and summary ownership.

#### 4. Finalization truth is weaker even when it runs

The settled gate checks a narrower subset of business work and does not reconcile accepted-response accounting with durable reservations and orders. Timeout can force terminalization with unresolved work (`opus-4.8:C42`; `apps/api/src/services/run-finalization-service.ts:172-184`). Pending reconciliation materializes audit records but does not resolve the underlying holds.

#### 5. Queue and worker failure windows remain structural

Queue producers can hang indefinitely on broker loss; rejected enqueue after durable commit has no outbox or scanner (`opus-4.8:ir-F5`). Overlapping BullMQ deliveries update by order ID without an expected-state predicate, allowing a stale delivery to overwrite a terminal result (`opus-4.8:ir-F6`). A non-ERP error during a half-open probe can wedge the circuit breaker (`opus-4.8:ir-F4`).

#### 6. Representative resilience behavior is not fully applied

The earlier self-audit found that run-scoped ERP behavior and backpressure were frozen but not actually applied. A flagship surge can therefore use default fast ERP behavior instead of demonstrating the intended downstream-resilience scenario. Correcting this reaches across the run snapshot, API-to-worker payload, ERP request contract, and worker concurrency design.

### Opus evidence qualification

The browser report records small custom runs with constrained buyers, stock, and duration that finalized and appeared in history. That evidence prevents the absolute claim that no Opus run can complete. It does not prove representative reliability. The lossy completion callback, fast-run state regression, and non-atomic summary workflow explain why success can depend on timing and scale.

### Opus donor strategy

Port behavior and regression tests rather than merging whole subsystems. Opus's schema, contracts, and lifecycle model differ substantially from GPT. The best imports are:

- Ports/adapters decomposition and focused test seams.
- Bounded load-metric aggregation.
- Pending-sentinel and compensating-reversal concepts, adapted to fully resolve holds.
- Circuit-breaker and notification patterns after applying the independent audit corrections.
- SSE/backpressure techniques.
- Packaging, proxy, image, and test-infrastructure improvements.

## Candidate 3 — GLM-5.2 as a selective donor

### Why the visible GLM demo failure is partly local

Browser testing observed every non-idempotency run as failed, normally delivering only 6–18%, while the Idempotency Check 200 sample completed.

The load configuration explains much of that symptom:

- Preview requests 1,000 RPS for one second (`packages/db/src/seed-data.ts:81-99`).
- Automatic steady capacity is capped at 50 preallocated and 100 maximum VUs (`apps/load-orchestrator/src/app/k6/script-generator.ts:50-58`).
- The 5k and 10k per-VU spikes have a one-second maximum duration with no meaningful graceful completion window (`seed-data.ts:102-143`; `script-generator.ts:73-158`).
- Response bodies are retained, increasing generator overhead.
- Delivery below 50% is deliberately graded failed (`packages/contracts/src/run-summary.ts:340-401`).

Correcting seed duration, VU sizing, body discard, and graceful stopping is a small-to-medium repair. It may make normal demos green. It would not resolve GLM's broader base suitability.

### GLM systemic issues after the demo-green patch

#### 1. The start handshake is ordered backwards

The API delegates to the load orchestrator before committing durable `active` state and Redis eligibility. The orchestrator starts background execution before returning acceptance, so zero-delay traffic can reach `/buy` before the run is buyable (`glm-5.2:ir-F1`; `apps/api/src/app/services/demo-run-start-service.ts:435-483`; `traffic-execution-service.ts:293-311`).

A correct repair requires a two-phase prepare, activate, and release protocol across services.

#### 2. Completion delivery is one-shot and non-durable

A single failed completion POST leaves a run `active` indefinitely because only completion ingestion moves it to `draining`, and finalization polls only draining runs (`glm-5.2:ir-F5`; `glm-5.2:C55`). This requires the same class of durable completion ownership needed elsewhere.

#### 3. Draining and terminal admission are not fenced

Fresh buys can remain eligible during draining and race final settlement. Redis eligibility is only cleared after summary creation, and failed cleanup is swallowed without a retry owner (`glm-5.2:ir-F2`).

#### 4. Secured holds can become invisible

Post-gate ownership lookup and pending-sentinel failures can escape as HTTP 500 after stock has already been decremented, without a durable or visible pending obligation (`glm-5.2:ir-F3`). Finalization can then omit a real secured unit.

#### 5. Timeout can certify unsettled business work

Once drain timeout expires, terminal status is derived from traffic delivery even if orders remain queued, processing, or pending persistence. The immutable summary can permanently certify stale business state (`glm-5.2:ir-F6`).

#### 6. Worker resilience violates the intended business semantics

An open circuit is treated as a terminal failure, permanently failing buffered orders that should wait for recovery (`glm-5.2:ir-F7`). A crash after external ERP success but before durable attempt recording can redeliver the same confirmation without an idempotency barrier (`glm-5.2:ir-F8`).

#### 7. The hot path adds avoidable pressure and weak evidence

Every sold-out request awaits a realtime publication, contradicting the bounded loser-path design. k6 emits insufficient outcome and dropped-work metrics, while broad 409 classification can count lifecycle and attribution failures as expected traffic.

### GLM repair-radius assessment

- **Small to medium:** make the seeded load generator capable of delivering the configured envelope.
- **Large and cross-cutting:** activation protocol, completion ownership, lifecycle fencing, pending obligations, finalization truth, worker buffering, ERP idempotency, and queue recovery.

The visible symptom is easier to fix than it first appears; the trustworthy-product repair surface is the largest of the three candidates.

### GLM donor strategy

Useful bounded donor ideas include:

- Canonical vocabulary, transition helpers, shared errors, and realtime contracts (`glm-5.2:C2`, `C3`, `C6`, `C7`).
- Atomic Redis reservation and selected replay/pending visibility ideas (`glm-5.2:C18`, `C19`, `C22`, `C26`), after correcting eligibility ordering and crash gaps.
- SSE fan-out and queue/readiness projections (`glm-5.2:C46`, `C48`).
- Frontend server-component, pure-reducer, small-island decomposition and uniform degraded reads (`glm-5.2:C64`, `C65`).
- Auth/session enforcement, visitor budgets, reverse-proxy and container patterns (`glm-5.2:C67`, `C69`, `C75`, `C76`).
- Test-infrastructure safety, correlation plumbing, and implementation audit trail (`glm-5.2:C82`, `C91`, `C93`).

Frontend strengths must be evaluated against its thinner surface: public custom is missing, and history/admin functionality is less complete.

## Cross-candidate decision matrix

| Lens | GPT-5.5 | Opus-4.8 | GLM-5.2 |
| --- | --- | --- | --- |
| Representative runtime evidence | Strongest; successful meaningful runs including reported 10k spike | Small custom runs can finish, representative completion is unreliable | Only smallest idempotency sample completes consistently |
| Fixed-reviewer findings | 38 total, 6 high | 44 total, 6 high | 54 total, 9 high |
| Normal lifecycle risk | Working path exists; serious partial-failure and race gaps | Completion and terminal-history seams are structurally unreliable | Activation, completion, admission, finalization, and worker semantics all need work |
| Repair radius before feature work | High but organized around durable handoffs and fencing | High; must stabilize core completion and terminal accounting first | Very high; demo patch is local, residual redesign is broad |
| Architectural donor value | Strong integrated orchestration and recovery primitives | Highest: decomposition, metrics, Redis, packaging, and tests | Strong bounded contracts, frontend, SSE, correlation, and governance ideas |
| Recommended role | Base | Primary donor | Selective donor |

## Consolidation strategy

The three branches are too divergent for wholesale merging. GPT-to-Opus differs across roughly 611 files, and GPT-to-GLM across roughly 630 files. Port behavior, invariants, and regression tests through deliberate boundaries instead of cherry-picking whole service trees.

### Phase 1 — Freeze the demonstrated GPT behavior

Before changing architecture, capture characterization tests for:

- A representative 10k surge.
- Sold-out-only traffic.
- Duplicate/idempotent attempts.
- Active to draining to completed lifecycle.
- Durable terminal summary and history detail.
- Browser recovery after reconnect and finalization.

Runtime execution was outside this assessment, so these tests should be implemented and run when the consolidation environment is ready.

### Phase 2 — Harden the correctness spine

Treat the following as one coordinated milestone:

1. Compare-and-set lifecycle transitions and an admission/terminal fence.
2. Durable load-completion outbox with idempotent acknowledgement or API reconciliation.
3. Transactional order-dispatch outbox or autonomous undispatched-order scanner.
4. Autonomous pending-hold reconciliation after admission closes.
5. Durable ERP result/idempotency semantics and recovery ownership.
6. Redis-first, fail-closed run eligibility coupled to the lifecycle fence.
7. Removal of default control credentials and direct control-port exposure.

### Phase 3 — Import high-value donor behaviors

From Opus, prioritize decomposition seams, metric aggregation, pending/compensation concepts, test cases, worker runtime patterns, SSE mechanics, and packaging. From GLM, prioritize canonical contracts, frontend reducer/degraded-state patterns, correlation, access governance, and infrastructure guards.

Every import should begin with the donor's behavioral test or a newly written characterization test. The goal is not to preserve donor code shape; it is to preserve the better invariant in the GPT-based architecture.

### Phase 4 — Consolidate secondary surfaces

After the correctness spine is reliable, merge the best DTO boundaries, dashboard recovery, history/detail UX, admin workflows, database checks and indexes, configuration validation, test taxonomy, smoke tooling, and documentation.

## Decision risks and reassessment triggers

This recommendation should be revisited if any of the following occurs:

- Standardized representative runs show GPT cannot reproduce its observed 10k completion.
- A bounded Opus fix proves reliable completion, atomic terminal accounting, and durable history across representative and fault-injected runs.
- GLM's load-generator correction reveals materially stronger burst handling while its activation and finalization protocol is repaired.
- Consolidation design shows GPT's durable-handoff repairs require more replacement than porting the working behavior onto another branch.

Until such evidence exists, GPT offers the best balance of demonstrated viability and controlled repair scope.

## Evidence index

### GPT-5.5

- Comparison: `results/comparison_vs_base/gpt-5.5_vs_base.md`
- Independent audit: `results/independent_review/gpt-5.5_independent_review.md`
- Browser-use report: `results/browser_use_testing/gpt-5.5_browser_use_report.md`
- Central audit findings: `gpt-5.5:ir-F1`, `ir-F2`, `ir-F5`, `ir-F11`, `ir-F16`, `ir-F17`, `ir-F18`, `ir-F21`
- Central comparison entries: `gpt-5.5:C24`, `C25`, `C32`, `C38`, `C49`, `C55`, `C60`, `C62`, `C63`, `C96`

### Opus-4.8

- Comparison: `results/comparison_vs_base/opus-4.8_vs_base.md`
- Independent audit: `results/independent_review/opus-4.8_independent_review.md`
- Browser-use report: `results/browser_use_testing/opus-4.8_browser_use_report.md`
- Central audit findings: `opus-4.8:ir-F1` through `ir-F6`, `ir-F19`, `ir-F21`
- Central comparison entries: `opus-4.8:C21`, `C24`, `C25`, `C26`, `C33`, `C39`, `C42`, `C43`, `C44`, `C49`, `C53`, `C54`, `C55`, `C58`, `C59`, `C68`, `C69`, `C97`, `C98`, `C109`

### GLM-5.2

- Comparison: `results/comparison_vs_base/glm-5.2_vs_base.md`
- Independent audit: `results/independent_review/glm-5.2_independent_review.md`
- Browser-use report: `results/browser_use_testing/glm-5.2_browser_use_report.md`
- Central audit findings: `glm-5.2:ir-F1` through `ir-F9`, plus `ir-F10`, `ir-F12`, `ir-F19`, `ir-F25`
- Central comparison entries: `glm-5.2:C2`, `C3`, `C6`, `C7`, `C18`, `C19`, `C22`, `C26`, `C46`, `C48`, `C53`, `C55`, `C64`, `C65`, `C67`, `C69`, `C75`, `C76`, `C82`, `C91`, `C93`
