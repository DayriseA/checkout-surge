# Issue 18 - Require admin sessions for protected web proxy routes

Status: Fixed


## Recommended Order Rationale

Address the main web/admin security boundary before smaller correlation header polish and browser workflow test expansion.

## Ownership Boundary

- Web server-side backend proxy helpers
- Admin session route
- Admin UI components that currently send raw passphrases
- Web proxy tests

## Problem

Protected admin proxy routes accept either a signed session cookie or a matching `x-admin-passphrase` header. Documentation says operators should exchange the passphrase once for a signed `HttpOnly` session, and protected routes should verify that session before adding the server-side control token.

## Task

Split authorization helpers:

- Use passphrase-only verification only for `POST /api/admin/session`.
- Add/use `requireAdminSession()` for protected proxy routes.
- Remove raw passphrase headers from destructive action calls, including run-history deletion.

## Acceptance Criteria

- Reset, chaos mutation, admin preset mutation, history deletion, and admin starts reject raw passphrase headers without a valid admin session.
- The session creation route still accepts the passphrase and sets the signed `HttpOnly` session.
- Protected client components rely on the cookie session, not per-request passphrase forwarding.

## Tests

Update web proxy tests to assert raw-passphrase access is rejected outside session creation, and session-cookie access still works.
