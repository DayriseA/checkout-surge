# Issue 06 - Recover lost notification enqueue after order confirmation


## Recommended Order Rationale

With order confirmation behavior stabilized, fix the next downstream durability gap: confirmed orders must not make runs fail just because notification enqueue had a transient queue failure.

## Ownership Boundary

- Worker order processing service
- Notification job publication boundary
- Persistence/outbox or recovery scanner
- Demo run finalization expectations

## Problem

After an order is confirmed, notification work exists only as a BullMQ job. If publishing that job fails, the order job completes, but finalization blocks on `missing_notifications` because no durable notification record or repair path exists.

## Task

Add a durable recovery mechanism for notification work:

- Prefer a notification outbox row written transactionally with or immediately after order confirmation.
- Alternatively add a confirmed-order scanner that recreates missing notification jobs/records.
- Ensure transient BullMQ publication failures can be retried or repaired later.

## Acceptance Criteria

- A confirmed order with an initial notification enqueue failure can still produce the required notification record.
- Run finalization does not fail with `business_drain_timeout` solely because the first enqueue attempt failed.
- Notification publishing remains backgrounded from the order response path.

## Tests

Add a regression test where notification enqueue fails once after confirmation and the run can finalize after recovery.
