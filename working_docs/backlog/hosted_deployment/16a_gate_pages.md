# 16a — Gate Pages

**Design:** sections 2.3, 6 · **Depends on:** 17

## Goal

The gate's own pages match the demo's look, read clearly to a visitor who does not know the infrastructure, and match what is happening to the core.

## Context

- The owner's view after go-live (2026-10-07): the gate pages are ugly and rudimentary, and they clash with the demo.
- A visitor sees them before the demo, between sessions, and through the "Demo paused" link of the countdown widget.
- Task 16 was split into 16a (gate pages) and 16b (demo messages) on 2026-10-08. Its runner counters moved to task 22.
- One `renderGatePage` in `apps/gate/src/pages.ts` builds all eight pages: an inline `<style>` with four hard-coded colors and the system font, no brand mark.
- The gate image does not contain `apps/web` (`turbo prune gate` in `docker/Dockerfile.node-service`), so it cannot import the web theme or its font.
- The demo has no dark theme: `apps/web/src/app/globals.css` defines light tokens only (Tailwind v4 `@theme`), with Archivo bundled by the web and a system fallback stack.

## Scope

- **Redesign every page:** asleep (start button), starting, updating, relocating, installing a fresh demo, no capacity, setup failure, unavailable.
  - Light theme only, like the demo (owner decision, 2026-10-08).
  - The demo's colors as a small inline constant in `apps/gate/src`, copied from `globals.css` (about 9 to 15 tokens).
  - The system font stack the demo declares as its fallback, no font file (owner decision, 2026-10-08): the pages answer `no-store`, and some reload every 3 to 5 s.
  - Self-contained: the gate cannot load assets from a sleeping core.
  - Same behavior: every page keeps its HTTP status, cache header, reload and action, so the gate's contract with polling clients is unchanged.
  - Wording reviewed for a visitor who does not know the infrastructure.
- **A capacity-triggered recreation shows the relocating page** (owner decision, 2026-10-08).
  - Today the gate cannot tell a mark set because the core's host refused the deploy (HD-56) from one the owner requested: both are `recreate=requested` (`recreationRequested` in `apps/gate/src/core-machine.ts`), and both show "Installing a fresh demo".
  - When the deploy marks the core for capacity (`infra/fly/deploy.mjs`), it also records the reason, for example a second metadata key, carried over like the mark (HD-48) and removed with it when the core is recreated.
  - The gate then picks "Relocating the demo", whose wording already covers a capacity issue. No new page state.
- **A start that times out re-reads the core** (owner decision, 2026-10-08, the only waking-behavior change in this task).
  - Incident (2026-10-08, 11:58 UTC): a visitor woke the core while the CI deploy was running. The gate held its own lease, and Fly's start call timed out after 30 s (`TimeoutError`, classified `unclassified_provider_error`, not retried). The gate answered 503 "The demo is unavailable". The core finished starting seconds later.
  - After a start timeout, the gate re-reads the Machine: if it is starting or started, it shows the starting page; otherwise the unavailable page, as today.
  - No blind retry: a timed-out start may have taken effect, and a second start would get 412 `still_active`.
- **Tests.**
  - The existing page tests in `apps/gate/test/server.test.ts`, plus what they miss today: the cache header, the reload seconds, and the starting and setup-failure pages.
  - The two behavior changes at their boundaries (`apps/gate/test/core-wake.test.ts`, and the deploy script's marking).
- **Docs:** the design's section 2.3 table, the page table in `docs/hosted_runtime.md`, and the decision log where a consequence of HD-29, HD-45 or HD-56 changes.

## Out of Scope

- Other changes to waking, recovery or runs.
- New gate states or routes, a font route included.
- A dark theme.
- The demo's run-start and run-failure messages (16b).

## Done When

- Every gate page is redesigned and reviewed with the owner on a preview of the eight pages.
- A capacity-triggered recreation shows the relocating page, and a start timeout on a core that is starting shows the starting page.
- The gate's page tests pass, with the cache header and reloads asserted.

## Open Points

- None.

## Working Notes

_None yet._
