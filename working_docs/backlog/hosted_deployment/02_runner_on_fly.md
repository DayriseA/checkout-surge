# 02 — Runner on Fly

**Design:** sections 3.7, 4.5, 7.1, 10 · **Depends on:** 01

## Goal

The runner runs on its own Fly Machine, started by hand, and a real `surge-10k` run completes across the two Machines. This task closes the feasibility test.

## Scope

- **Fly app and Machine config** for the runner: no volume, performance 4 vCPU / 8 GB, restart policy `no`, `role=runner` metadata, no public address, no autostart.
- **Fly variant of the load-orchestrator image:** a `runtime-fly` target on top of `runtime`. Its root entrypoint raises `nofile`, sets `ip_local_port_range` and `tcp_tw_reuse`, then drops to `node`.
- **Networking:**
  - the load-orchestrator listens on IPv6;
  - the API derives the `apiBaseUrl` it gives the runner from its own 6PN address.
- **Manual wiring for now:** the API reaches the runner through a configured address, and the runner's `API_BASE_URL` is set by hand.
- **Runner secret** stored as a Fly secret.
- **Deploy script** extended to the runner image and Machine.
- **Feasibility checks:**
  - limits of the k6 process;
  - `ip_local_port_range` and `tcp_tw_reuse` take effect;
  - time from runner `start` to load-orchestrator ready;
  - the 10k IPv6 connection burst;
  - manual recreation of the runner.

## Out of Scope

- Runner start and stop driven by the API, boot IDs, loss detection and capacity handling.

## Done When

- A `surge-10k` run completes with a manually started runner.
- Its results are compared with `docs/reference_runtime_measurements.md` and recorded in the working notes.
- The feasibility verdict is written into `design.md`: the topology is confirmed, or the points to revisit are listed.

## Open Points

- None.

## Working Notes

_None yet._
