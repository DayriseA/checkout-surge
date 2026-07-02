# Issue 13 - Make load-orchestrator readiness verify API reachability

Status: Fixed

## Recommended Order Rationale

After internal correlation is correct, strengthen readiness so runtime smoke checks catch unreachable API targets before a dashboard-triggered run starts.

## Ownership Boundary

- Load-orchestrator runtime readiness
- Docker Compose service dependency behavior
- Runtime health-check script assertions

## Problem

Load-orchestrator readiness reports `api_base_url_configured=ok` when `config.apiBaseUrl` is non-empty. It does not request the API from inside the service. Compose starts the load orchestrator after the API container is merely started, not healthy.

## Task

Update readiness:

- Fetch the configured API liveness/readiness endpoint from inside the load-orchestrator service.
- Mark the readiness check unavailable on connection, DNS, timeout, or non-ready responses.
- Consider Compose `depends_on` health gating for the API service.
- Update health-check script expectations if check names or nested assertions change.

## Acceptance Criteria

- Bad in-container `API_BASE_URL` values fail readiness.
- API not-yet-ready state fails load-orchestrator readiness.
- `runtime:smoke` and health checks reflect the real dependency status.

## Tests

Add readiness tests for reachable and unreachable API targets, plus any health-check script coverage needed by the changed response shape.
