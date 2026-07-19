# Issue 07 — Interrupted generated requests are reported as never started

## Classification

- Priority: P1
- Status: Resolved — implemented and independently verified on 2026-07-19
- Affected path: Run journal, generated traffic accounting, history/detail trustworthiness
- Audit run: `598023fd-b68b-46c2-bf24-d13d0096a39f`

## Issue observed

During the Preview deadlock, API access logs showed all 1,000 generated `/buy` requests arriving:

- 750 returned a response;
- 250 accepted-path requests remained in flight until the load process was interrupted.

The orchestrator journal instead reported:

- emitted: 750;
- completed: 750;
- unstarted/request shortfall: 250.

Those 250 requests were not unstarted. They had reached the API and were central evidence of the failure. The report at the time therefore concealed interrupted/in-flight work and gave an incorrect explanation for the shortfall.

The deadlock that triggered the interruption is documented in `issue_01.md`, but the accounting error is independent: any timeout, network stall, or forced k6 shutdown can create the same misleading result.

## Original reproduction

1. Run a generated scenario with a known planned attempt count.
2. Make the target endpoint accept requests but hold some responses beyond k6's run/grace deadline.
3. Compare API-received requests with the completion journal/history fields.

Before the fix, requests still in flight at shutdown were counted as request shortfall/unstarted instead of started-but-interrupted.

## Identified cause

The k6 output parser used completion-oriented built-in metrics for both start and completion semantics (`apps/load-orchestrator/src/application/k6-output-parser.ts`):

- `http_reqs` was mapped to both emitted and completed request counts;
- completed `iterations` and `planned - http_reqs` were used to derive unstarted/request-shortfall counts;
- the generated script had a maximum duration and graceful-stop boundary but no explicit counter incremented immediately before each HTTP attempt (`apps/load-orchestrator/src/application/k6-script.ts`).

When k6 was interrupted with HTTP operations in flight, the final built-in summary could not distinguish genuinely unstarted iterations from attempts that began but did not produce a completed HTTP metric. The parser then assigned the remainder to the wrong category.

## Implemented resolution

- The generated k6 script now increments `checkout_attempts_started` immediately before `http.post()` and `checkout_responses_completed` immediately after the call returns, before response classification.
- Terminal accounting now uses the canonical fields `plannedRequests`, `startedRequests`, `completedRequests`, `interruptedRequests`, and `unstartedRequests` with these enforced equations:

```text
plannedRequests = startedRequests + unstartedRequests
startedRequests = completedRequests + interruptedRequests
```

- Shared contracts strictly validate the equations in HTTP, delivery, transport-projection, and real request-lifecycle shapes. A real completion report also requires the HTTP, delivery, and lifecycle copies of all five counts to agree.
- The parser selects the strongest available response-completion evidence from the explicit completion counter and `http_reqs`, preferring the explicit counter on ties and preserving the selected summary-export or point-stream source in diagnostics. Completion evidence can raise the started floor but cannot erase a larger explicit started count.
- HTTP failure calculations remain based on completed responses. Accepted, sold-out, unexpected-response, reservation, order, ERP, notification, and inventory accounting remain separate from transport-attempt accounting.
- Delivery quality is derived by the API from genuinely unstarted attempts. Interrupted attempts do not become unstarted or get described as API-received.
- New orchestrator journals and finalization records use only the canonical field names. Explicit read-boundary normalization keeps legacy execution journals and PostgreSQL JSON summaries readable without weakening the live completion schemas.
- Dashboard recovery now exposes nullable terminal transport accounting for the selected run when completion evidence exists. Watch, public/admin history lists, and public/admin history detail use the same `Planned`, `Started`, `Responses completed`, `Interrupted`, and `Unstarted` terminology.
- No relational migration or second persistence model was introduced; the affected summaries remain typed JSON.

## Compatibility and known limits

- Old HTTP summaries map legacy `emittedRequests` to the best available started evidence and retain the old `completedRequests`, allowing interrupted and unstarted counts to be derived when the historical data supports it.
- Old delivery-only summaries did not record distinct completion evidence. They are therefore normalized as started = completed = old emitted, interrupted = 0, and unstarted = planned - started. Historical interrupted traffic that was never recorded cannot be reconstructed.
- Existing database rows are normalized when read and are not rewritten in place.
- Preset tuning, new analytics, and the deadlock addressed by Issue 01 remain outside this issue.

## Acceptance criteria

- [x] A forced hung-endpoint fixture reports the pre-request count as started even when k6 is terminated before responses return.
- [x] Started-but-incomplete requests appear in a distinct interrupted category, not unstarted/request shortfall.
- [x] Genuinely unstarted iterations remain distinguishable.
- [x] Planned, started, completed, interrupted, and unstarted counts satisfy documented reconciliation equations.
- [x] Orchestrator journal, API recovery, Watch, and history/detail expose consistent values and terminology.
- [x] Existing HTTP/business outcome counters remain accurate for completed responses.

## Verification

Final independent review confirmed:

- contracts unit tests: 113 passed;
- load-orchestrator unit tests: 122 passed;
- web unit tests: 236 passed;
- API route tests: 83 passed;
- focused API finalization, maintenance, recovery, history, delivery, and redelivery tests: 96 passed;
- Docker-backed pinned k6 v2.0.0 compatibility tests: 4 passed, including the real hung-endpoint termination case;
- shared package build and contracts, load-orchestrator, API, web, and worker type checks passed;
- changed-file Biome checks and `git diff --check` passed.

The direct host k6 command was unavailable because `/usr/local/bin/k6` is not installed in the workspace. The repository's required Docker-backed compatibility lane passed. Five failures in the broader API suite were reproduced unchanged at baseline commit `a001173` and are unrelated to Issue 07: two in `demo-run-service.test.ts` and three in `postgres-buy-persistence.test.ts`.

## Scope guard

This issue corrects the truthfulness of existing run reporting. It does not propose new analytics or a separate observability product.
