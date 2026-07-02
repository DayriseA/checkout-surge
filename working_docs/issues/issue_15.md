# Issue 15 - Treat expected sold-out responses as successful k6 HTTP outcomes


## Recommended Order Rationale

This is independent of durability fixes but belongs near load-orchestrator work because it touches generated k6 behavior and run summaries.

## Ownership Boundary

- Load-orchestrator k6 script generation
- k6 output parsing and HTTP summary projection

## Problem

The generated k6 script treats `202` and clean `409` sold-out responses as expected custom outcomes, but it does not configure k6's HTTP expected-status callback. k6's built-in `http_req_failed` still counts expected `409` responses as HTTP failures, and the accumulator copies that metric into `httpSummary.failedRequests` and `failureRate`.

## Task

Correct HTTP failure accounting:

- Prefer generating a k6 response callback that treats `202` and expected `409` sold-out responses as successful for `http_req_failed`, or
- Compute `failedRequests` from unexpected custom responses instead of raw k6 HTTP failure points.

## Acceptance Criteria

- All-sold-out expected traffic reports `failedRequests: 0`.
- All-sold-out expected traffic reports `failureRate: 0`.
- Unexpected non-accepted/non-sold-out responses are still counted as failures.

## Tests

Add parser/script tests proving sold-out-only traffic does not inflate HTTP failure metrics.
