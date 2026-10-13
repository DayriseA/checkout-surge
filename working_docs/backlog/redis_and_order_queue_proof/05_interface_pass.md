# 05 — Interface Pass

**Design:** sections 1, 3.1 · **Depends on:** 04

## Goal

The two comparisons read clearly and look finished to a visitor on Watch and in run history.

## Scope

The owner's feedback (2026-10-13, after trying both comparisons on a laptop screen):

- **Everything in the top section.** "Run 1 of 2" (and which mode is running) belongs in the run's header or in its stage track (Preparing, Buyers arriving, Confirming orders, Result), so a visitor sees which run is live without scrolling.
- **The side-by-side view is a third tab** next to the existing ones (Overview, Pipeline). It becomes the active tab when the pair completes, so the live view (charts by default) hands over naturally to the comparison, which suits the frozen end state.
- **No prose that restates the figures.** Remove the long introduction under the comparison's title and the takeaway sentences that repeat the numbers. The figures (with a neutral ratio where useful) speak for themselves; disclosures and how to read the figures move to the detail pages of task 06, reached by a short link.
- **Preset texts are accurate.** The queue comparison's "Detailed assumptions" speak of a slow ERP although its ERP is the standard one (20 orders/s, 100 ms); check every preset's derived texts, the Redis comparison's included.
- Within the existing design system. No new behavior beyond the tab's automatic activation.

## Done When

- **Owner checkpoint C:** the owner validates the interface.

## Open Points

- None.

## Working Notes

_None yet._
