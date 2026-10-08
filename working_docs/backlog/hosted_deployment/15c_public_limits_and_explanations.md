# 15c — Public Limits

**Design:** section 1.2 · **Depends on:** 15b, deployed

## Goal

Visitors can use what the hardware sustains, with capacity values confirmed by measurement.

## Scope

- **Confirm the capacity values first** (owner decision, 2026-10-08, after the 15b cloud verification). On a 4 vCPU cloud VM, the heaviest run the local public form admits (1,000/s for 10 s, stock 1,000, exactly 80 %) failed: 2,770 requests never sent, p95 13.9 s. The local values were provisional, and the 3 s VU budget was measured with stock 1.
  - **On Fly:** runs at the proposed public limits with stock 1,000.
  - **On a cloud VM:** runs at the local public maximum.
  - Then adjust the `CAPACITY_*` env values, the VU budget included, before raising any limit.
  - Agents' in-container commands on Fly may be refused by the permission system: plan the Fly runs as an owner-run prompt (as for task 18's last check) if needed.
- **Raise the public limits** to the measured values. Targets on Fly (owner decision, 2026-10-08), to confirm by the measurements: rate 2,500 requests per second and 25,000 total requests per run; stock 1,000, buyers 10,000 and duration 120 s unchanged. The 15b model refuses combinations that are too heavy.
  - **Live policy row:** edited from the admin console, by the owner, or by the supervisor with the owner's approval.
  - **Seed:** the `PUBLIC_CUSTOM_*` values in the `setup` container env of `infra/fly/core/machine.json`, since a fresh core seeds the policy from them, and the local seed in `docker-compose.yml`.
  - The caps stay at or above the seed values (design 1.2).
  - Update or withdraw HD-53, whose premise (the default VU allocation) no longer holds.
## Out of Scope

- Admission code (15b), a multi-process API (HD-51).
- Comparative runs with and without the Redis layer (task 21).
- The narrative and visitor explanations (15d).

## Done When

- The public limits are raised to the measured values, live and in the seed.

## Open Points

- None.

## Working Notes

_None yet._

### Fly confirmation (2026-10-08, 21:10 Paris, run by the owner with Codex, version `d5198be8`)

- ERP 100 ms / 50 TPS / 0 % / concurrency 5, constant arrival 10 s, VUs = rate × 3 s.
- A run counts as complete when sent = planned, with no interrupted, unstarted, dropped or failed request.
- The core was recreated on the first wake (as `8e7366c7754918`), then stopped on its own.

| Run | Stock | VUs | Complete | Counts (planned/started/completed/interrupted/unstarted/failed) | Mean / p95 (s) | Generator CPU mean/peak % |
|---|--:|--:|---|---|---|---|
| 2,500/s ×2 | 1 | 7,500 | yes, yes | 25,000/25,000/25,000/0/0/0 | 1.02 / 7.40; 0.28 / 1.76 | 41/89, 42/90 |
| 2,200/s ×2 | 1,000 | 6,600 | yes, yes | 22,000/22,000/22,000/0/0/0 | 3.05 / 11.78; 3.28 / 12.98 | 25/90 |
| 10,000 buyers ×2 | 1,000 | 10,000 | yes, yes | 10,000/10,000/10,000/0/0/0 | 6.89 / 10.24; 6.88 / 9.75 | 28/89, 29/91 |

- The Fly values hold at the targets: 2,500/s sold out is 71 % of C_s, and 2,200/s with stock 1,000 is the model's 80 % point.
- **Watch:** with stock 1,000 the mean iteration time (3.05 to 3.28 s) slightly exceeds the 3 s VU budget. The runs completed, with little VU margin.
- **Owner decision (2026-10-08):** raise Fly's `CAPACITY_VU_LATENCY_BUDGET_SECONDS` to 4 s for VU margin with stock. That gives 8,800 VUs at 2,200/s, about 2.5 GB of k6 memory on the 16 GB runner, and the 10,000 cap at 2,500/s.
