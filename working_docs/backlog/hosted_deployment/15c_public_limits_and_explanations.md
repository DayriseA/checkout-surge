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
