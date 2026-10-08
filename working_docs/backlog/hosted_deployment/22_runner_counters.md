# 22 — Runner Counters

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

_None yet._
