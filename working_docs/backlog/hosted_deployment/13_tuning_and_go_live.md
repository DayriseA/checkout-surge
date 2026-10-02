# 13 — Tuning and Go-Live

**Design:** sections 1.1, 1.2, 2.5, 8, 9 · **Depends on:** all previous tasks, plus the external prerequisite

## Goal

The demo is measured, tuned, documented and opened to visitors.

## Scope

- **Measure** `surge-10k` on the final setup and compare it with the local reference.
- **Tune** Machine sizes and the `DEMO_MAX_*` caps. The values are the owner's decision, based on the measurements.
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
