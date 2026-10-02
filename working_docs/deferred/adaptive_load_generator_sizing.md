# Deferred: Per-Run Load-Generator Sizing on Ephemeral Machines

Status: deferred on 2026-10-01. Nothing here is implemented.

The first hosted deployment uses one fixed, measured machine size. Hosted run limits are enforced through the existing `DEMO_MAX_*` / `PUBLIC_CUSTOM_*` deployment caps, and the UI explains that those limits are a hosting choice.

This document keeps the design work on sizing the load generator per run, so the topic can be reopened later without redoing the analysis.

The Fly.io facts below come from platform research on 2026-09-30, and the platform's resource pricing changed on 2026-10-01. Re-verify every size and price before use.

## 1. Why it was deferred

- **Demo value is low.** Users mostly run the public presets. Very large admin custom runs are rare and add little to what the demo shows.
- **The risk is high.** Most of the hard correctness work in this design is about one thing: losing an ephemeral generator in the middle of a run. A fixed generator co-located with the system keeps the existing durable journal, reconciliation and finalization guarantees unchanged.
- **The cost argument is weak.** At 1-3 active hours per month, the difference between a generously sized fixed machine and a right-sized one is cents to a few euros per month. Idle cost and the number of wake-ups dominate the bill, not the size.
- **Stated framing for the deployed demo.** Hosted limits are a deliberate hosting decision, documented as such, not an unknown ceiling. Larger runs remain possible locally or on a more ambitious deployment of the same code.

## 2. Target design

- **The core stays the same.** One machine holds the system under test (API, worker, Mock ERP, Redis, PostgreSQL, web, Caddy). PostgreSQL and Redis data live on a persistent volume.
- **One runner per run.** Each accepted run gets one runner Machine in the same region, in a separate Fly app. It has no public service and is sized before launch.
- **The runner runs the whole existing `apps/load-orchestrator` image.** That includes k6, the child-process supervisor, the live aggregator, the resource sampler and the journal. It is not only k6 plus a new remote-supervision protocol, because the service already has the right boundaries:
  - it has no database access;
  - the API drives it over HTTP (`start`, `status`, `abort` in `apps/api/src/services/traffic-execution-gateway.ts`);
  - each start request carries the target `apiBaseUrl`;
  - metrics and completion go back to the API over HTTP.
- **Provisioning is an API application workflow** behind a port, with two adapters:
  - a static adapter that keeps today's fixed `LOAD_ORCHESTRATOR_BASE_URL` for Compose;
  - a Fly Machines adapter.

  The provisioning clients are constructed only in the composition root. Routes stay thin.
- **Least privilege.** The core holds only an app-scoped deploy token for the runner app.
- **Wire details.** Runner traffic goes over Fly 6PN, which is IPv6 only and bypasses Fly Proxy. Every service the runner calls must listen on `::`.

## 3. Design requirements

The code references below were checked on 2026-10-01.

### 3.1 Durable execution authorization, not just a unique name

- A deterministic Machine name prevents duplicate creation (a retry returns 422 `already_exists`). It does not make "create at Fly" and "record in PostgreSQL" atomic.
- After an ambiguous create, recover the Machine by name and `run_id` metadata. Verify its identity and persist the association before any traffic is authorized.
- `restart.policy = no` only covers process exit. A host migration can keep the Machine ID while replacing the VM, and the rootfs journal does not survive that. So blindly replaying `start` to a reachable Machine can relaunch load.
- Required: a durable, API-side execution authorization bound to `(runId, runner instance)`.
  - A runner instance that was not the one authorized must never start k6.
  - When in doubt, keep an observable blocked state and refuse to replay. Failing without traffic is acceptable; duplicate traffic is not.

### 3.2 Separate observation from verdict

| Observed situation | Correct decision |
| --- | --- |
| Ambiguous Fly create, ID not recorded | Recover by name and metadata. No second launch until identity is resolved. |
| HTTP timeout or Fly inspection unavailable | Unknown, not proof of stop. Re-inspect within bounds and keep the run's exclusive slot. |
| Runner gone, completion already persisted by the API | Keep the canonical result. A lost acknowledgement does not fail the run. |
| Runner definitively lost, no report | Incomplete result. Block any new traffic, then settle the already-accepted orders. |
| Run cancelled during provisioning | A late Machine never receives launch authorization, and its cleanup is tracked. |

### 3.3 Losing the generator does not end the orders

- `DemoRunService.failRun()` (`apps/api/src/services/demo-run-service.ts`, around line 463) writes a synthetic summary tagged `<reason>_before_traffic_start`. That is wrong once orders have been accepted.
- On generator loss, the API must:
  - close traffic admission and confirm that traffic has stopped;
  - let business processing settle or cancel cleanly, keeping the exclusive slot until a coherent end;
  - never invent zero counters for measurements that disappeared.
- A received completion and a "lost" verdict must be arbitrated by one atomic transition. A valid completion that was already persisted wins.

### 3.4 Provisioning is an asynchronous workflow, not a longer HTTP timeout

- The gateway's start call is bounded at 5 s by default.
- Today the start confirmation moves the run to `active` while `trafficStatus` may still be `starting` (`updateRunAfterTrafficStart`).
- With provisioning, the flow becomes:
  1. accept the run durably and respond quickly;
  2. provision in the background;
  3. publish the real traffic start.
- Cancellation, the occupancy estimate and the 900 s automatic reset must account for the preparation phase as well as the processing phase.
- The UI should show a "Preparing load generator" state.

### 3.5 Sizing policy ownership and fallback

- Profile types may be shared, but the mapping "scenario → machine size" is application or deployment policy. It belongs in the API or in deployment config, not in `@checkout-surge/contracts`.
- Never fall back automatically to a smaller profile on a capacity error unless that profile is validated for the scenario. Otherwise fail visibly with a dedicated reason, for example `load_generator_capacity_unavailable`.
- Never move the runner silently to another region either.

### 3.6 Cleanup must survive a core failure

- A reaper that lives only in the API cannot clean anything while the API is down.
- Add both of these:
  - a hard maximum lifetime enforced by the runner itself;
  - an independent periodic check for forgotten Machines, for example the same external watchdog that guards the core's awake time.
- Expiry follows the same confirmed-stop-then-settle rules. It never releases a run silently.
- With `auto_destroy`, the exit code is lost. Prefer: wait for `stopped`, read the exit event, then `DELETE`.

### 3.7 Decision to take when reopening: can a crash lose the final k6 report?

| Option | Behavior | Constraints |
| --- | --- | --- |
| **Disposable runner, no volume** | The run stays known and orders persist, but the final measurements may be missing. Never relaunched automatically. | Needs the durable launch authorization (3.1) and an honest "incomplete" result. |
| **Runner with its own volume** | The journal survives ordinary restarts. | Host capacity and volume recovery become constraints, and resizing a volume-bound Machine can fail on a full host. |

The disposable runner is the preferred option for this demo, provided incomplete results are displayed honestly and the single launch is durably protected.

## 4. Sizing and capacity facts to keep in mind

- **Generator memory scales with VUs.**
  - Buyer-spike uses `per-vu-iterations` with `vus = buyerCount` (`apps/load-orchestrator/src/application/k6-script.ts`).
  - Constant-arrival uses up to `maxVus`. Automatic sizing is `min(rate, 10_000)` preallocated, with up to `min(2 × rate, 10_000)`.
- **Buyers, VUs, connections and total requests are different ceilings.**
  - The generator port range `10240-65535` holds 55,296 ports. With one source address and one destination, that bounds simultaneous connections, not the total number of requests over time.
  - A single runner therefore cannot hold a 100,000-buyer simultaneous spike against one API endpoint. Distributed k6 would be required, and it is outside the current scope.
- **Generator size is not the only limit.** The single Node API process, `somaxconn`, `nofile`, and core CPU, disk and memory also limit what a run can do. A bigger generator does not raise the system-under-test envelope.
- **Calibrate from existing evidence.** Each run already persists `generatorCapacity` (host facts) and `generatorUtilisation` (peak k6 RSS, cgroup memory, CPU). Use these per preset to derive profile thresholds.
- **Initial profile guesses (uncalibrated):**
  - up to 2k VUs: 2 dedicated vCPU / 4 GB
  - up to 10k VUs: 4 dedicated vCPU / 16 GB
  - more: 8 dedicated vCPU / 32-64 GB

## 5. Fly.io facts used (as of 2026-09-30; re-verify)

- **Machines API.**
  - Endpoints: create, start, stop, `wait?state=`, destroy, metadata, leases.
  - Rate limit: 1 request/s per action, burst 3.
  - Create has no idempotency key.
- **Timing.** Create takes "low double-digit seconds". Start of a stopped Machine is well under a second. Both are unmeasured for this project.
- **Billing.** Per second while started. A stopped Machine costs rootfs only, $0.15/GB per 30 days.
- **Size and RAM rules changed on 2026-10-01.** The announcement allows adding RAM up to 128 GB per preset, with new pricing. It is not verified here. The previous "8 GB per performance vCPU" rule must not drive the catalog.
- **6PN.** Machines in other apps of the same org are reachable at `<machine_id>.vm.<app>.internal`. `.internal` DNS omits stopped Machines.
- **Kernel limits.** Hard `nofile` was historically 10,240 (community-reported), which is right at a 10k burst. Raise it from a root entrypoint before dropping to the `node` user, then verify the limits of the final process.
- **Placement.** Placement failures are the caller's job to retry. Capacity incidents occurred in European regions in 2025-2026.

## 6. Change inventory when reopened

- **`apps/api`:**
  - a `LoadGeneratorProvisioner` port with static and Fly adapters;
  - an asynchronous provisioning workflow;
  - durable execution authorization;
  - loss-versus-completion arbitration;
  - run-scoped abort and release;
  - a reaper;
  - an occupancy allowance for preparation;
  - config (`LOAD_GENERATOR_MODE`, runner app, image, region, token).
- **`packages/db`:** persist the runner identity, instance and authorization per run, either as columns or as a lease table.
- **`packages/contracts`:**
  - new failure reasons, such as `load_generator_lost` and `load_generator_capacity_unavailable`;
  - an optional preparation indicator in the dashboard projection;
  - profile types only, not the sizing policy.
- **`apps/load-orchestrator`:**
  - a one-shot mode that exits after its run's completion is acknowledged or rejected;
  - a hard maximum lifetime;
  - a hosted root entrypoint for `nofile` and `sysctl` that listens on `::`.
- **`apps/web`:** UI copy for the preparation phase and for incomplete or lost-generator results.
- **Infra:** a runner Fly app (image push only, no resident Machine) and an independent watchdog for forgotten runners.
- **Tests:**
  - an ambiguous create;
  - a crash before persistence;
  - a new instance under the same Machine ID;
  - a lost acknowledgement;
  - cancellation during preparation;
  - loss during business processing;
  - a completion racing the loss verdict;
  - profile thresholds.

## 7. Lower-effort intermediate step (no provisioning code)

Before full per-run sizing, a fixed remote runner already gives benchmark isolation:

- one pre-created runner Machine of fixed size, with a small volume for its journal;
- started and stopped together with the core;
- reached by pointing the core's `LOAD_ORCHESTRATOR_BASE_URL` at it.

This keeps the existing journal guarantees. It costs a second Machine lifecycle to coordinate, IPv6 listening, and entrypoint changes for `nofile` and `sysctl`.
