# Issue 14 - Cover the production SpawnK6Runner path

Status: Fixed


## Recommended Order Rationale

Add production-runner coverage after completion reliability and correlation/readiness fixes so the tests exercise the intended production path rather than its current gaps.

## Ownership Boundary

- Load-orchestrator tests
- `SpawnK6Runner` injectable process boundary
- k6 script generation compatibility checks

## Problem

Tests cover script strings, parser behavior, and the HTTP route with a fake `K6Runner`, but they do not instantiate `SpawnK6Runner` or verify temporary script writing, k6 stdout parsing, metric batching, completion reporting, non-zero exits, errors, or cleanup.

## Task

Add production-path tests:

- Inject a fake `spawnProcess` that emits k6 JSON lines and `close`/`error` events.
- Assert metric batches, completion reports, failure reports, and temp directory cleanup.
- Add at least one script-level check that catches real k6 syntax/API drift.

## Acceptance Criteria

- The real runner orchestration path has unit coverage without launching real k6 for every test.
- Non-zero exit and process error behavior are covered.
- Completion reporting behavior introduced by Issue 11 is covered.

## Tests

Add or expand `apps/load-orchestrator/test/load-orchestrator.test.ts` or a focused runner test file.
