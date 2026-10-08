# 16 — Gate Pages and Messages

**Design:** sections 2.3, 6 · **Depends on:** 17

## Goal

The gate's own pages and the messages about starting and failing runs match the demo's look and theme, and read clearly to a visitor who does not know the infrastructure.

## Context

- The owner's view after go-live (2026-10-07): the gate pages are ugly and rudimentary, and they clash with the demo.
- The gate renders them as standalone HTML (`apps/gate/src/pages.ts`), separate from the web app's theme (`apps/web/src/app/globals.css`).
- A visitor sees them before the demo, between sessions, and through the "Demo paused" link of the countdown widget.

## Scope

- **Gate pages.** Redesign every state: asleep (start button), starting, updating, relocating, installing a fresh demo, no capacity, setup failure, unavailable.
  - Same visual language as the demo: colors, typography, light and dark themes.
  - Self-contained: the gate cannot load assets from a sleeping core.
  - Same behavior: every page keeps its current HTTP status, cache header, reload and action, so the gate's contract with polling clients is unchanged.
- **Run-start and run-failure messages.** Review the wording on the public page, the watch page, the run report and history, and the admin start dialog and Current run panel, for consistency and clarity: relocation, provider capacity, a generator that could not start, version mismatch while the demo updates.

## Inputs (known message gaps)

- **Admin read failures.** The admin shows the generic "The latest information is temporarily unavailable" for read failures other than a start (`retryPresentation` in `apps/web/src/app/lib/presentation/error-presentation.ts`), whatever the cause.
- **Core recreated for capacity.** A capacity-triggered core recreation (a deploy refused by a full host marks the core) shows the fresh-install page, the requested-recovery page, rather than the relocating page.
- **Old failed runs.** Runs that failed before task 17 with `load_orchestrator_unavailable` before traffic keep the old traffic-failure wording.
- **Request timeouts read "unidentified".** A run failed by transport loss keeps an unidentified failure explanation, even when its requests timed out after k6's 60 s request timeout (measured: 631 of 10,000 buyers, every reservation confirmed server-side). The stored evidence has a single count of status-0 attempts and cannot tell a timeout from a connection error. Recognizing timeouts needs a separate counter on the runner, so the API and the runner must be updated together (HD-14) (owner decision, 2026-10-08).
- **Reply count off by one** (seen during the task 18 cloud verification, 2026-10-08). Completed requests sometimes exceed accepted + sold out + transport failures + unexpected by one, and `completedIterations` differs by one from `completedRequests`. The admin page then shows "Replies recorded 7,621" beside 7,620 accepted. The counts come from the runner, so a fix there means updating the API and the runner together (HD-14).
- **"Checkout attempts … ended at" shows the runner's report time** (seen during the task 18 second pass, 2026-10-08). The label uses the runner's `completedAt`, stored after k6's graceful stop, its shutdown and the final metric batches. That is about 55 s after a 10 s sending window, so the run seems to last 65 s, and it does not match "30 seconds after its sending window closed" in the late-answer explanation.
- **A wake during a deploy shows "The demo is unavailable"** (2026-10-08, 11:58 UTC). A visitor woke the core while the CI deploy was running. The gate's start call to Fly timed out after 30 s (`TimeoutError`), and the gate answered 503 with "The hosting provider did not answer as expected". The core finished starting seconds later. The gate should show its updating page, or retry the start, instead of the unavailable page.
- **Singular grammar.** "All 1 available units were reserved…" and "All 1 reservations were confirmed" on a run with stock 1.
- **No unit harness for a pending start.** The public page has none, so the visitor's own pending start (the hidden "already in progress" notice, the relocation message) has no component test.

## Out of Scope

- Behavior changes to waking, recovery or runs (task 17 settled the relocation behavior).
- New gate states or routes.

## Done When

- Every gate page and the listed messages are redesigned and reviewed with the owner, in light and dark themes.
- The gate's page tests still pass (statuses, headers, actions), and the wording changes are covered at the boundaries that render them.

## Open Points

- Whether the gate pages share a stylesheet generated from the web theme or keep a small inline copy (settled when the task starts).
- Whether the capacity-triggered recreation gets its own page wording, which needs the gate to tell it apart from a requested one.

## Working Notes

_None yet._
