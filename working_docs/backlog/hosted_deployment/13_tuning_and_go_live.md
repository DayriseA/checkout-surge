# 13 — Tuning and Go-Live

**Design:** sections 1.1, 1.2, 2.5, 8, 9 · **Depends on:** all previous tasks, plus the external prerequisite

## Goal

The demo is measured, tuned, documented and opened to visitors.

## Scope

- **Measure** `surge-10k` on the final setup and compare it with the local reference.
- **Tune** Machine sizes and the `DEMO_MAX_*` caps. The values are the owner's decision, based on the measurements.
  - The runner saturates its 4 vCPU while k6 creates its 10,000 VUs and during dispatch (task 02). Measure whether a larger runner changes arrival rate or latency. Fly's performance presets include 6x, 10x, 12x and 14x besides 1, 2, 4, 8 and 16 (pricing page, checked 2026-10-03), so intermediate sizes such as 6 vCPU are available. RAM is free between 2 and 8 GB per vCPU; the increment (256 MB or 2 GB) is unverified. Billing is per vCPU plus RAM above 2 GB per vCPU, per second while running: performance-4x / 8 GB is about $0.18 per hour, performance-6x / 12 GB about $0.28 per hour (US base rates; Europe carries a markup).
- **Operator notes,** including the manual core resize.
- **GitHub Actions** calling the same deploy script.
- **Documentation:** move implemented behavior into `docs/`, and update `docs/runtime_topology.md` and `docs/scope_and_caveats.md`.
- **Portfolio link** to the gate.
- **Bot review,** after a few days of real traffic: check the gate logs and Fly metrics, then decide on the signed session cookie.

## Out of Scope

- Everything listed as out of scope in `design.md`.

## Done When

- The demo is reachable from the portfolio link.
- Sizes and caps are settled and recorded.
- `docs/` describes the hosted runtime.
- The bot review is done and its outcome recorded.

## Open Points

- None.

## Working Notes

_None yet._
