# 13a — Measurement and Tuning

**Design:** sections 1.1, 1.2 · **Depends on:** 01–12, 14

## Goal

`surge-10k` is measured on Fly with the final setup, and the owner settles Machine sizes and the `DEMO_MAX_*` caps from that evidence.

## Scope

- **Measure** `surge-10k` on Fly and compare it with the local reference (`docs/reference_runtime_measurements.md`).
- **Runner size** (owner decision, 2026-10-06): measure the current performance-4x / 8 GB first, then performance-8x / 16 GB. Try performance-6x / 12 GB only if 8x improves arrival rate or latency.
  - The runner saturates its 4 vCPU while k6 creates its 10,000 VUs and during dispatch (task 02).
  - Fly's performance presets include 6x, 10x, 12x and 14x besides 1, 2, 4, 8 and 16 (pricing page, checked 2026-10-03). RAM is free between 2 and 8 GB per vCPU; the increment (256 MB or 2 GB) is unverified. Billing is per vCPU plus RAM above 2 GB per vCPU, per second while running: performance-4x / 8 GB is about $0.18 per hour, performance-6x / 12 GB about $0.28 per hour (US base rates; Europe carries a markup).
- **Core size:** watch the core's metrics during the runs, and propose a resize only if it saturates. The core is resized manually (design 1.1).
- **Caps:** propose `DEMO_MAX_*` values from the measurements, including constant-arrival runs (design 1.2). The values are the owner's decision.
- **Slow core stop** (input from task 12 below): find the container, then propose fixing its shutdown or accepting the 30 s worst case. The owner decides.
- Record the settled sizes and caps in their configuration, and their reasons where the inclusion rule of `docs/decisions/` calls for it.

## Out of Scope

- Documentation and GitHub Actions (13b), secret rotation and opening (13c), bot review (13d).

## Done When

- Sizes and caps are settled with the owner and recorded.
- The slow stop is understood, and fixed or accepted.

## Open Points

- None.

## Inputs from Task 12

- **Slow core stop with a run starting (observed, not fixed).** A `deploy.mjs core --force` stopped the core while a public run start was in flight (the API had just started the runner). The core VM shut down only at its 30 s stop timeout instead of the usual 11 s: an application process kept retrying Redis (`ioredis` `ECONNREFUSED 127.0.0.1:6379`) after Redis had stopped on its 10 s delay. Which container did not exit on SIGINT is unknown (the earlier log lines had rotated out). Find it, and decide whether its shutdown needs fixing or whether the 30 s worst case is accepted; the idle stop meets it only through its accepted race with a run start (HD-21).

## Working Notes

_None yet._
