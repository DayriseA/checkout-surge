# 07 — Comparative Presets and Load Generator

**Design:** section 3 · **Depends on:** 03–06

## Goal

One or two fixed presets show each comparison clearly and repeatably on the hosted hardware.

## Scope

- Tune the presets from the checkpoint's configurations, measured on Fly.io with the modes interleaved and repeated.
- Size the runner for the presets' rates.
- The presets are the only way to start a comparative mode. Custom runs, public or admin, never offer one.

## Done When

- The presets show their point in every repetition, and the spread is recorded.

## Open Points

- None about exposure: the owner confirmed a simple public demonstration with fixed settings. The measured tuning determines the smallest useful set of comparisons.

## Working Notes

### Owner clarification — 2026-10-11

The owner confirmed that visitors must be able to run a simple fixed demonstration of Redis and order-queue benefits. Admin-only access would not fulfill that goal. Infrastructure choices, execution sequencing and reset are delegated to the agent, while the existing demo remains functional and production intervention waits for final review. Keep one simple visitor entry and no editable comparative-mode controls; use the smallest fixed set that retained measurements justify.
