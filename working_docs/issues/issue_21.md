# Issue 21 - Add browser workflow coverage for web surfaces

Status: Fixed


## Recommended Order Rationale

Schedule browser workflow tests after the admin session and SSE behavior changes so the tests encode the corrected workflows rather than the current gaps.

## Ownership Boundary

- Web test suite
- Browser-style component/page workflows
- Optional Playwright coverage if the repo supports it

## Problem

Current web tests render static markup or call route handlers directly. They do not execute browser event handlers for public starts, custom payload construction, admin sign-in/session use, navigation, recovery refresh, history deletion, or proxy error handling.

## Task

Add browser workflow coverage for key surfaces:

- Public curated start.
- Public custom start.
- Admin sign-in plus one protected action.
- Watch recovery refresh/SSE follow-up behavior.
- Run-history selected/delete-all actions.
- Lightweight page smoke tests for `/`, `/watch`, `/admin`, `/run-history`, `/run-history/[runId]`, and `/about`.

## Acceptance Criteria

- Event handlers build and submit the expected requests.
- Session-backed admin workflows are covered after Issue 18.
- Run-history destructive controls are covered without relying only on route unit tests.
- Page smoke tests catch broken route/page loading.

## Tests

Use jsdom/Testing Library or Playwright, matching the existing repo test stack and keeping tests focused.
