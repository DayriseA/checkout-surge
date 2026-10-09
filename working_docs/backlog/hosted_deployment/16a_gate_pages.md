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

- **2026-10-08, implementation.**
  - **Pages (`apps/gate/src/pages.ts`).** Same states, statuses, `no-store`, reloads (booting 3 s, relocating and fresh install 5 s), actions and return-path handling. New look: the demo's navy band with its brand mark (inline SVG) and "Checkout-Surge", a surface card on the page background, a status pill per page in the demo's `StatusPill` tones (progress for starting, maintenance, moving and reinstalling, with a pulsing dot that stops under `prefers-reduced-motion`; warning for no capacity and unavailable; danger for setup failure; idle for asleep), the demo's title style and primary button, a full-width button and a 16 px gutter below 560 px. 14 colors copied from `globals.css`, the fallback font stack, `color-scheme: light`, no font file, asset or script. Titles: asleep, "Starting the demo", "Maintenance in progress" (a held lease is not always a deploy, HD-29), "Moving the demo to new servers", "Installing a fresh demo", "No room at the hosting provider", "The demo could not start", "The demo is unavailable". The retry button reads "Try again" on every page.
  - **Capacity reason.** `markCoreForRecreation` in `deploy.mjs` sets `recreate_reason=capacity` through the metadata endpoint, then `recreate=requested`. `deployCore` carries the reason over with the mark; `freshConfig` strips both. The gate's wake passes `refreshing` only for a mark without that reason (`recreationForCapacity` in `core-machine.ts`).
  - **Start timeout.** In `CoreWake.startInPlace`, a start rejected with the client's `TimeoutError` reads the Machine again, still under the lease: `starting` or `started` counts as an accepted start (status invalidated, 303); otherwise, or on a failed read, the timeout is thrown as before (unavailable). The lease TTL is unchanged: nothing is sent to the core after that read.
  - **Tests.** `server.test.ts`: cache header and reload seconds asserted, booting and setup-failure pages rendered. `core-wake.test.ts`: the capacity-marked core shows relocating; a timed-out start on a starting core shows starting without a second start; a timed-out start on a stopped core, or with a failed read, is unavailable. `core-recovery.test.ts`: the deployed config carries the mark and its reason, and the new core gets neither. `deploy.mjs` has no tests (it runs on import).
  - **Docs.** design 2.2, 2.3 and 3.5; `docs/hosted_runtime.md` (pages, waking, recovery); `docs/hosted_operations.md` (recreation mark). Decision log: consequences corrected in place in HD-29, HD-35 and HD-56; HD-45 unchanged; no new entry (code comments carry both reasons).
  - **Pending.** The owner's review of the eight pages on the preview.

### Closure (2026-10-09)

- Owner review on the preview: approved, with CSS loop animations (owner decision) and the loading bar moved to the bottom of the card.
- Adversarial review arbitrated. Fixed: a dot-segment return path could redirect off-site (pre-existing), the reason key removal in the operations doc, and two stale `design.md` passages. Accepted: a reason left alone by a failed second metadata write is inert, and the next deploy drops it.
- Cloud verification at `63b3208b`: the full suite passed, and the rendered pages, reloads, reduced motion and return paths were checked.
- Deployed at `fa04a5ba`. The live gate serves the new asleep page (503, `no-store`) without waking the core.
- Done.
