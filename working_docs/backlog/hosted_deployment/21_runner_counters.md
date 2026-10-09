# 21 — Runner Counters

**Design:** none · **Depends on:** none

## Goal

A run's evidence tells request timeouts apart from connection errors, and its reply counts add up.

## Context

- Moved from task 16 on 2026-10-08: these are runner evidence fixes, not messages. The API and the runner must be updated and deployed together (HD-14, HD-46).
- **Request timeouts read "unidentified".** A run failed by transport loss keeps an unidentified failure explanation, even when its requests timed out after k6's 60 s request timeout (measured: 631 of 10,000 buyers, every reservation confirmed server-side). The runner counts every status-0 reply in one counter (`checkout_transport_failures` in `apps/load-orchestrator/src/application/k6-script.ts`), so the evidence cannot tell a timeout from a connection error (HD-58). Recognizing timeouts needs a separate counter on the runner (owner decision, 2026-10-08).
- **Reply count off by one** (seen during the task 18 cloud verification, 2026-10-08). Completed requests sometimes exceed accepted + sold out + transport failures + unexpected by one, and `completedIterations` differs by one from `completedRequests`. The admin page then shows "Replies recorded 7,621" beside 7,620 accepted. Likely cause, unverified: `completedRequests` is the larger of `checkout_responses_completed` and `http_reqs` (`k6-output-parser.ts`), and `http_reqs` can count a reply that arrived at k6's stop before the script classified it.

## Scope

- **Timeouts.** A separate k6 counter, initialized in `setup()` (HD-43), reported as an optional field (stored runs lack it; absent evidence is unknown, HD-13), and a failure diagnostic cause with its explanation in the web. Check the timeout error code against the k6 version in `apps/load-orchestrator/Dockerfile`.
- **Off by one.** Confirm the cause, then fix it. `completedRequests` feeds `classifyTrafficDelivery`, so state any verdict the fix can move.

## Out of Scope

- Other runner or API changes.

## Done When

- A run whose requests timed out names that cause, and its reply counts add up.
- The API and the runner are deployed together.

## Open Points

- None.

## Working Notes

### Implementation (2026-10-09, worktree)

- **Timeout code.** k6 v2.0.0 (`grafana/k6:2.0.0` in the Dockerfile): `requestTimeoutErrorCode errCode = 1050` ("request timeout") in `lib/netext/httpext/error_codes.go`; `transport.go` `RoundTrip` maps a `net.Error` with `Timeout()` to 1050, or to `tcpDialTimeoutErrorCode` (1211) when the timeout happened while dialing. Grafana's error-code docs list 1050 as "The HTTP request has timed out". Samples of a timed-out request are pushed (`PushIfNotDone` on the VU context, which is still alive).
- **Counter.** `checkout_request_timeouts` (status 0 and `error_code === 1050`, added after `checkout_transport_failures`), initialized in `setup()`, parsed as `requestTimeouts`, reported as optional `httpSummary.requestTimeouts` (nullable), stored with the run's `http_summary`. The script now sets `timeout` from `k6RequestTimeoutSeconds` (60 s, k6's default, so no behavior change). The transport-failure total is unchanged.
- **Diagnostic.** New public cause `request_timeouts`: reason `traffic_transport_major_loss`, `trafficStatus` `succeeded`, and timeouts alone above the failure tier (> 5 %) of started requests. Derived at read time; older runs (no field) and unknown counts stay `unidentified`. Delivery causes are unchanged (a different failure reason).
- **Web.** "Requests timed out": count line "{n} of {started} requests timed out ({pct}%)"; "The server still handled …" only on the existing server-side proof (every sent request a confirmed and notified reservation), otherwise "may still have handled"; next step: fewer buyers, a smaller burst, or the same traffic over more time.
- **Off by one.** Cause confirmed from k6's source: `PushIfNotDone` drops every sample (HTTP and custom counters) once the VU context is done. A reply that arrives as the graceful stop ends the context pushes its `http_reqs` sample, then the script's `checkout_responses_completed` and outcome adds are dropped; `max(responses_completed, http_reqs)` then counted a reply with no outcome. The same race can split `responses_completed` from the outcome add. Fix: completed = sum of the four outcome counters when all known, else `responses_completed`, else `http_reqs`; never the max. Reproduced by a parser test (the old parser reports 10 completed for 9 classified, with the completion counter also at 10).
- **Verdicts that can move.** Only new runs: completed can drop by the replies cut at the stop, which become interrupted. Delivery status can drop at a boundary: one tier on large plans, but with fewer than 100 planned requests one cut reply can skip tiers (10 planned: `complete` → `failed`). `interrupted_requests` can cross its tier. Transport loss (against started) is unchanged. Stored runs keep their stored counts, so nothing becomes unreadable. `completedIterations` is not reconciled with completed requests and can exceed it by a few (cloud: +3, +6; constant-arrival iterations beyond the plan return early and still count); it stays diagnostic.
- **Reconciliation warning.** The reconciliation warning shown beside a timeout explanation is pre-existing and accurate, left as is (owner decision 2026-10-09).
- **Docs.** `load_generation_metrics_streaming.md`, `core_business_entities.md`, `reference_runtime_measurements.md`, `capacity_measurement.md`; HD-58 consequence corrected in place. No new decision entry: the code comments cover the choices.
- **Checks.** Biome clean; `pnpm type-check` and `pnpm type-check:test` pass; contracts 162, api 359, web 789 unit tests pass; load-orchestrator 166 pass, 22 fail (known Windows `EPERM fsync`, timeouts and probe). Docker unavailable, so the new API test (completion stored and read back as `request_timeouts`) was not run.

### Closure (2026-10-09)

- Cloud verification at `8da8c899`: the full suite passed on Linux. All-accepted spikes of 10,000 buyers timed out 1,211 and 1,283 requests, every one counted as a request timeout; the cause read `request_timeouts`, with the "Requests timed out" explanation. Constant-arrival runs cut by the graceful stop had reply counts that add up.
- Adversarial review arbitrated, and its four low findings were fixed: "requests" instead of "buyers", "started each one" instead of "sent", tests pinned to reachable cases, these notes corrected.
- Deployed at `94b24799`, with the API and the runner on the same version.
- Done.
