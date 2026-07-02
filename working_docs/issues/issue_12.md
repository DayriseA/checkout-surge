# Issue 12 - Propagate correlation IDs on internal load-orchestration calls

Status: Fixed

## Recommended Order Rationale

Do this before deeper load-orchestrator readiness and production-runner tests so new tests can assert the correct cross-service trace vocabulary.

## Ownership Boundary

- API-to-load HTTP client in demo run service
- Load-to-API client for metrics and completion
- Fastify route correlation normalization where needed

## Problem

Internal clients include `correlationId` in request bodies but do not send the shared `x-correlation-id` header. Fastify derives request log context, response headers, and errors from the header before handlers parse the body, causing body/header/log correlation IDs to diverge.

## Task

Normalize internal correlation propagation:

- Send `x-correlation-id` from the validated contract payload on API-to-load start calls.
- Send `x-correlation-id` from metric and completion payloads on load-to-API calls.
- Consider normalizing `request.correlationId` from parsed internal bodies after authentication for logs emitted after parsing.

## Acceptance Criteria

- Load-orchestrator start response header matches the body `correlationId`.
- API metric and completion ingestion receive the same header/body correlation ID.
- Logs and error payloads at internal boundaries can be joined by one correlation ID.

## Tests

Add regression tests for start response header/body equality and load metric/completion calls reaching the API with the matching header.
