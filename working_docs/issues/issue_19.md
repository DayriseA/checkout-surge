# Issue 19 - Align cleanup response correlation header with body


## Recommended Order Rationale

This is a small API consistency issue that should be handled after cleanup ownership and admin route behavior are stabilized.

## Ownership Boundary

- API admin maintenance route
- Shared correlation ID conventions

## Problem

The cleanup endpoint accepts `correlationId` in the body and returns it in the response body, but it does not update the `x-correlation-id` response header after normalizing the body value.

## Task

Update the cleanup route:

- Import/use `correlationIdHeaderName`.
- Set the response header after normalizing the cleanup correlation ID from the body.
- Keep behavior aligned with other body-correlation routes.

## Acceptance Criteria

- Cleanup response body and `x-correlation-id` header match the supplied body `correlationId`.
- Requests without a body correlation ID still use the normal request correlation behavior.

## Tests

Add a route test asserting both payload and header equal the supplied cleanup body `correlationId`.
