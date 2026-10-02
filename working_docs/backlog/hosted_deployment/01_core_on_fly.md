# 01 — Core on Fly

**Design:** sections 3.1, 3.2, 3.3, 3.7, 7.1, 8, 10 · **Depends on:** none

## Goal

The core runs on one Fly multi-container Machine, started and stopped by hand, and the core-side feasibility checks pass. The task ends with the packaging verdict: multi-container, or the `supervisord` fallback.

## Scope

- **Fly app and Machine config** for the core: multi-container, performance 4 vCPU / 8 GB, `cdg`, one volume, `role=core` metadata, no public address, no autostart.
- **Boot sequence** with `depends_on` conditions: PostgreSQL and Redis healthy, then setup (migrate and seed), then API, worker and Mock ERP.
- **Volume layout** for PostgreSQL and Redis in separate subdirectories.
- **Fly variant of the API image:** a `runtime-fly` target on top of `runtime`. Its root entrypoint raises `nofile`, then drops to `node`. `somaxconn` is set before the API listens.
- **Networking:**
  - the API and a hosted Caddy variant listen on IPv6;
  - `API_TRUSTED_PROXY_CIDRS` is loopback;
  - the web container does not depend on the load-orchestrator.
- **Core secrets** stored as Fly secrets.
- **Deploy script, first version:** build the images, tag them with the commit SHA, push them, and create or update the core Machine.
- **Feasibility checks:**
  - access to multi-container Machines;
  - flyctl path resolution from `infra/fly/`: `--config` and `--dockerfile` relative to the working-directory argument, and the base of a `machine_config` path if one is used;
  - the startup gate, with a deliberately failing migration or seed;
  - shared-volume ownership;
  - limits of the API process;
  - graceful stop, and data recovery after a stop under activity;
  - crashes of each service;
  - leases;
  - time from `start` to core ready;
  - manual recreation of the core on a fresh volume.

## Out of Scope

- The gate. The core is reached through a private tunnel (`fly proxy` or WireGuard).
- The runner, idle stop, automated recovery, and lease coordination in the deploy script.

## Done When

- A stopped core started with `fly machine start` serves the demo UI through the private tunnel, with no manual step.
- Every feasibility check is recorded in the working notes, with its result and measurements.
- The packaging verdict and any corrected platform fact are written into `design.md`.

## Open Points

- None.

## Working Notes

_None yet._
