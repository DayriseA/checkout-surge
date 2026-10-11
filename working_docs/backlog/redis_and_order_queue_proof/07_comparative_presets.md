# 07 — Comparative Presets and Load Generator

**Design:** section 3 · **Depends on:** 03–06

## Goal

One immutable public preset/start button shows both comparisons clearly and repeatably on the hosted hardware.

## Scope

- Tune the presets from the checkpoint's configurations, measured on Fly.io with the modes interleaved and repeated.
- Size the runner for the presets' rates.
- The presets are the only way to start a comparative mode. Custom runs, public or admin, never offer one.

## Done When

- The presets show their point in every repetition, and the spread is recorded.

## Open Points

- None about exposure: the owner confirmed a simple public demonstration with fixed settings. The measured tuning sets the two internal matched workloads without exposing visitor configuration.

## Working Notes

### Owner clarification — 2026-10-11

The owner requires one visible immutable public preset/start button and no editable stages or modes. Internally it executes two fixed matched workloads (Redis versus PostgreSQL and queued versus inline ERP), four normal child runs in total. Sequencing/reset are delegated: one public-budget and exclusive reservation, total estimated occupancy within 600 seconds, and the existing 900-second hard cleanup grace anchored to demonstration acceptance. Retain all four child summaries. The existing demo remains functional; production intervention waits for final review.
