# Issue 20 - Guard dashboard SSE updates against stale run events


## Recommended Order Rationale

Fix this after admin/session and correlation cleanup so browser-side recovery has stable server semantics to test against.

## Ownership Boundary

- Web operator dashboard component/reducer
- Dashboard event contract use in the browser

## Problem

The watch dashboard applies every live SSE payload directly to recovered state. It does not check whether the event belongs to the current run/sale offer or whether it is older than the recovery baseline. Delayed events from a previous run can overwrite newer recovery data.

## Task

Scope live events to the recovered baseline:

- Ignore events whose `runId` disagrees with `recovery.data.currentRun`.
- Ignore sale-offer-scoped events whose `saleOfferId` disagrees with the recovered current sale offer.
- Ignore events with `occurredAt` older than the recovery baseline unless they are explicitly accepted as part of that baseline window.
- Keep terminal-event follow-up recovery behavior.

## Acceptance Criteria

- Previous-run metric, business, inventory, queue, or run events cannot overwrite a newer recovery snapshot.
- Same-run fresh events still update the dashboard.
- Terminal events still trigger the intended recovery refresh.

## Tests

Add reducer/component tests for stale previous-run business, metric, and run events arriving after a newer recovery snapshot.
