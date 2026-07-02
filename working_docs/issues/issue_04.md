# Issue 04 - Remove tests that lock in known-bad recovery behavior


## Recommended Order Rationale

Run this after Issues 02 and 03 so the suite can stay green while replacing the tests that previously asserted broken behavior. This is a verification and cleanup issue for those two core recovery fixes.

## Ownership Boundary

- API tests around reservation pending persistence
- Worker tests around ERP confirmation retry/idempotency

## Problem

Some tests assert known-bad outcomes:

- Pending Redis holds remain `reservation_pending_persistence` forever with no order.
- ERP confirmation is called twice after confirmed-state persistence fails.

Those tests make the suite protect defects instead of desired recovery behavior.

## Task

Audit and update the affected tests so they assert the intended product behavior after Issues 02 and 03:

- Pending Redis holds are durably reconciled once PostgreSQL is available.
- Successful ERP confirmations are reused and not repeated after local persistence failure.

## Acceptance Criteria

- No test names or assertions describe permanent pending holds as expected behavior.
- No test expects duplicate downstream ERP confirmation after a successful ERP response.
- Regression tests clearly document the intended recovery behavior.

## Tests

Run the API and worker test subsets touched by Issues 02 and 03.
