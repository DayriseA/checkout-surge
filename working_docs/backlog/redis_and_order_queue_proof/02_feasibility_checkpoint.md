# 02 — Feasibility Checkpoint

**Design:** sections 2, 4, 5 · **Depends on:** 01

## Goal

The owner knows, from measurements in the proof environment, whether a configuration exists where each comparison shows its point fairly, and decides go or no-go.

## Scope

- **Prototypes on a throwaway branch:**
  - the three modes of design section 4;
  - the fairness rules of section 5, including equal protections and a PostgreSQL queue for the mode without Redis;
  - two or three API processes;
  - PostgreSQL and Redis at a realistic distance.
- **Measurements on Fly.io**, with the modes interleaved, repeated, and the spread reported. Start from the 2026-10-08 study's presets and adjust them.
- **For each comparison, a configuration a visitor can understand:** what differs, by how much, and why.
- **What each configuration needs in production:** Machines, processes, cost per month.

## Done When

- The owner has a report: the configurations found or not found, the measurements, what production would need, and a recommendation.
- The work stops here until the owner decides.

## Open Points

- The design's open points on distance and on what the presets show are explored here, not decided.

## Working Notes

### Outcome (2026-10-11, recorded 2026-10-12)

Done on the archived branch `codex/redis-order-queue-feasibility`, where the full report sits in this file's working notes; its lab lives there under `scripts/feasibility/` and `infra/fly/feasibility/`. The owner gave a general GO to continue. The configurations found and their results are summarized in [review_2026-10-12.md](review_2026-10-12.md#findings): Redis cut PostgreSQL CPU by a median 95.4 % (1,000 arrivals/s for 10 s, stock 1), and the queue cut winner p95 from 33.7 s to 2.3 s with every order confirmed in both modes (5,000-buyer spike, stock 500, ERP 100 ms and 20 TPS). The restart decisions are in design section 3.1.
