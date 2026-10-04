# Hosted Deployment - Decision Log

Decisions, accepted risks, and known limitations of the hosted deployment. The entry format, statuses, and the rule for reviewers are in the [README](README.md).

**Context for every entry.** The hosted demo runs on Fly.io as three apps: a public **gate**, a **core** Machine that holds the system under test (Caddy, web, API, worker, Mock ERP, PostgreSQL, Redis), and a **runner** Machine that holds the load-orchestrator and its k6 child process. The core and the runner talk over Fly's private IPv6 network (6PN). One API process is the sole maintenance authority. The demo runs a few hours per month at most, so idle cost must be near zero and waking must be fast.

## Platform and Topology

### HD-01 Fly.io, with the load generator on its own Machine

- **Status:** accepted
- **Date:** 2026-10-02
- **Context:** The load generator must never compete with the system under test for CPU or memory, and stopped infrastructure must cost almost nothing.
- **Decision:** Host on Fly.io, region `cdg`. The core and the runner are separate Machines, both on dedicated (performance) CPUs, starting at 4 vCPU / 8 GB and resized after measurement.
- **Consequences:** Stopped Machines start in seconds and are billed per second. Machine sizes are configuration, kept separate from run limits.
- **Rejected alternatives:**
  - AWS EC2 stop/start: slower to start, and not cheaper.
  - Generator on the core Machine: it would share CPU with the system under test and distort the evidence.
  - Shared CPUs: throttled past their baseline quota, which would distort a 10k burst.

### HD-02 The gate is the only public address and the only waker

- **Status:** accepted
- **Date:** 2026-10-02
- **Context:** Bots must not be able to wake the core, and a visitor on any URL must see our own page while the core is not ready.
- **Decision:** The gate holds the only public address. It serves its own pages, starts the core through the Machines API only after a deliberate visitor action (a button that sends a POST), then relays all visitor traffic (pages, API, SSE) to the core's Caddy over 6PN. It is one TypeScript program in the monorepo. The core has no public address and no autostart. There is no wake quota. The k6 burst goes from the runner straight to the core's API, never through the gate.
- **Consequences:** A legitimate visitor is never refused a wake. The gate is the only always-exposed component ([HD-26](#hd-26-accepted-risk-deploy-tokens-give-a-compromised-component-wide-control)).
- **Rejected alternatives:**
  - Public core with Fly Proxy autostart: any bot request would wake it.
  - Caddy plus a separate program: two processes to supervise and to keep in sync on the core's state and address.
  - `fly-replay` routing to the core: its interaction with a no-autostart core and with SSE is undocumented, and visitors would see Fly's error pages instead of ours.
  - A wake quota: it would refuse legitimate visitors.

### HD-03 Accepted risk: bots can keep an awake core up

- **Status:** accepted
- **Date:** 2026-10-02
- **Context:** Once a visitor has woken the core, the gate relays every request, bot traffic included.
- **Decision:** Accept it. Revisit only on evidence from gate logs and Fly metrics after real traffic: the wake button would then set a signed session cookie, and the gate would relay only requests that carry it. Stronger protection (for example Turnstile) only if metrics show a need.
- **Consequences:** Bot requests count as activity ([HD-20](#hd-20-the-api-stops-its-own-idle-core)) and can extend the awake time up to the 3-hour awake cap enforced by the scheduled guard. Public run budgets, keyed on the signed visitor cookie, already bound what such traffic can trigger. The exposure is cost only.

### HD-04 The core is one Fly multi-container Machine

- **Status:** accepted
- **Date:** 2026-10-03
- **Context:** The core's services must start in order: databases, then migrations and seed, then the applications.
- **Decision:** One multi-container Machine that reuses the per-service images, with `depends_on` conditions (`healthy`, `exited_successfully`) that Fly reapplies on every start. A single image with `supervisord` stays the fallback if Fly breaks multi-container.
- **Consequences:** Three small workarounds, each verified on Fly:
  - Fly signals every container at once on stop, so PostgreSQL and Redis delay their shutdown by 10 s; otherwise the Machine hangs until its stop timeout.
  - An image `ENV` wins over a container's `env`, so keys an image already sets (`PGDATA`, the web image's `HOSTNAME`) are set in the container command.
  - A container without a `secrets` list gets no app secret, so each container lists the secrets it needs.

  A failed migration or seed keeps the API closed while the Machine still reports `started`; the failure shows in the Machines API `containers[].state`.
- **Rejected alternatives:**
  - Machine `config.processes`: needs a shared image and has no readiness dependencies.
  - `fly.toml` `[processes]` groups: each group gets its own Machines.
  - Docker Compose inside a Machine, or Fly's Compose conversion.
- **Code:** `infra/fly/core/machine.json`, `infra/fly/core/delayed-stop.sh`.

### HD-05 Core data is disposable, with no restore path

- **Status:** accepted
- **Date:** 2026-10-02
- **Context:** Run history and admin edits are cosmetic for this demo, and nobody is around to repair a broken core by hand.
- **Decision:** PostgreSQL and Redis keep their data on a Fly volume for disk performance, but nothing depends on it. Recovery and incompatible pre-release changes recreate a fresh, empty core that migrates and seeds on its first boot. There is no volume fork and no snapshot restore; Fly's default daily snapshots stay enabled but unused.
- **Consequences:** History and admin edits can be lost on a recovery or an incompatible change. The seed must stay idempotent on an existing database.
- **Rejected alternatives:**
  - Rootfs storage: its documented maxima (2,000 IOPS, 8 MiB/s) are far below a volume's on this size (up to 16,000 IOPS, 64 MiB/s).
  - A restore path: complexity for cosmetic data.

### HD-06 Hosted-only behavior is selected by configuration

- **Status:** accepted
- **Date:** 2026-10-02
- **Context:** The local Compose topology must keep working while the hosted runtime adds Machine control.
- **Decision:** Each service picks its implementation at its composition root. Behind one runner-host interface, the Fly host starts, stops, and recreates the runner Machine, while the local host treats the runner as always on. The runner's per-run shutdown and self-exit timers (`RUNNER_LIFECYCLE_ENABLED`) and the core idle stop (`CORE_IDLE_STOP_ENABLED`) are off unless configured. Boot-ID checks, `load_generator_lost`, and the version handshake are active everywhere.
- **Consequences:** Accepted cost: local and CI tests never start or stop a real Machine. Unit tests cover the Fly paths with fakes, and the rest is verified on Fly.
- **Rejected alternatives:** Hosted-or-local checks scattered through the code.
- **Code:** `apps/api/src/index.ts`, `apps/api/src/services/runner-host.ts`, `apps/api/src/services/fly-runner-host.ts`, `apps/load-orchestrator/src/runtime/config.ts`.

## Runner

### HD-07 The API starts and stops the runner for each run

- **Status:** accepted
- **Date:** 2026-10-02
- **Context:** A `surge-10k` run leaves about 10,000 sockets in TIME_WAIT. The runner must cost nothing while idle and stay free to move when a host lacks capacity.
- **Decision:** One fixed runner Machine with no volume, restart policy `no`, and no autostart (neither public nor Flycast). The API starts it explicitly right before dispatch, always from a stopped state (a runner found running is stopped first), and stops it when the run reaches a terminal state.
- **Consequences:** Every run gets a fresh boot and a clean kernel socket state. A run starts about 3.5 to 4 s later than with an always-on runner (about 8 s on the first run after a deploy). A runner crash mid-run can lose the final k6 report ([HD-12](#hd-12-boot-id-fencing-and-immediate-load_generator_lost), [HD-13](#hd-13-missing-traffic-evidence-is-unknown-never-zero)). Explicit starts let the API see and classify capacity errors ([HD-17](#hd-17-runner-capacity-failures-retry-in-place-then-recreate)).
- **Rejected alternatives:**
  - An always-on runner: idle cost, and socket state carried from one run to the next.
  - Fly Proxy or Flycast autostart: hides capacity errors from our code.
  - A volume: pins the runner to one host.
- **Code:** `RunnerOperations.bootForRun` and `releaseAfterRun` in `apps/api/src/services/runner-operations.ts`, `apps/api/src/services/fly-runner-host.ts`.

### HD-08 The runner stops at the terminal state, not at `draining`

- **Status:** accepted
- **Date:** 2026-10-03
- **Context:** Once the completion report is persisted (the run is `draining`, about 30 s for `surge-10k`), finalization no longer needs the runner.
- **Decision:** Keep one stop trigger: the terminal state (finalization, failure, admin or automatic reset).
- **Consequences:** The runner stays up during the drain, about 0.15 cents per run.
- **Rejected alternatives:** Stopping at `draining`: saves that time, but adds a second stop trigger to maintain and test.

### HD-09 Fenced shutdown through the runner, Fly `stop` only as a fallback

- **Status:** accepted
- **Date:** 2026-10-02
- **Context:** Fly's `stop` has no fencing parameter, so a late stop for run N could kill the runner already booted for run N+1.
- **Decision:** A normal stop is `POST /traffic/shutdown` with `{runId, bootId}`: the runner exits only when both match and nothing is in flight (`deferred_busy` is retried for 30 s). Fly `stop` is the fallback for an unreachable or stuck runner, issued by the same serialized owner ([HD-11](#hd-11-runner-operations-and-run-starts-are-serialized-in-process)). That owner also skips a release, or an unreachable-runner stop, for any run other than its latest boot.
- **Consequences:** A Fly `stop` sends SIGINT, so the runner still publishes an interrupted completion report and the run finalizes as a failed shortfall, not a silent loss.
- **Code:** `apps/load-orchestrator/src/application/runner-lifecycle-service.ts`, `RunnerOperations` in `apps/api/src/services/runner-operations.ts`.

### HD-10 The runner exits on its own; a report unacknowledged at maximum lifetime is lost

- **Status:** accepted
- **Date:** 2026-10-03
- **Context:** The runner must stop even when the API is down or its stop never arrives.
- **Decision:** The runner exits after 3 minutes with no execution and no completion report awaiting acknowledgement. It also exits at a maximum lifetime, counted from process boot, of the automatic-reset deadline (`automaticRunResetDeadlineSeconds`, 900 s) plus 30 s, even mid-run or with an unacknowledged report.
- **Consequences:** Such a report is lost with the volume-less Machine; by then the API has already reset the run automatically with unknown counters ([HD-13](#hd-13-missing-traffic-evidence-is-unknown-never-zero)). A report the API rejected definitively (`completion_rejected`) blocks neither the shutdown nor the idle exit.
- **Rejected alternatives:** Persistent storage for the runner's journal: cost and host pinning for a case the automatic reset already covers.
- **Code:** `apps/load-orchestrator/src/application/runner-lifecycle-service.ts`.

### HD-11 Runner operations and run starts are serialized in-process

- **Status:** accepted
- **Date:** 2026-10-03
- **Context:** Runner start, stop, update, and recreation must never interleave, and a starting-run replay must never race a start being set up.
- **Decision:** One owner in the API runs every runner operation one at a time and holds a Fly lease on the runner Machine during each, to coordinate with the deploy script. Run starts and starting-run reconciliation run inside the API maintenance authority, together with resets.
- **Consequences:** Correct only under the single-API-process contract ([Scope and Caveats](scope_and_caveats.md#intentional-non-goals)). Fly leases are advisory between our own cooperating clients, not a security boundary.
- **Rejected alternatives:** Distributed coordination: unnecessary with one API process.
- **Code:** `apps/api/src/services/runner-operations.ts`, `apps/api/src/services/demo-maintenance-authority.ts`.

### HD-12 Boot-ID fencing and immediate `load_generator_lost`

- **Status:** accepted
- **Date:** 2026-10-04
- **Context:** A crashed or rebooted runner must never relaunch traffic for a run, and a lost run must not wait for the 900 s automatic reset.
- **Decision:** The runner generates a boot ID at process start, since Fly has no per-boot identifier. The API records it with the run before dispatch, and every start or replay carries it as `expectedBootId`; a mismatch is refused before any traffic. On the API's 5 s poll, a `starting` or `active` run with a recorded boot is lost when its runner Machine is stopped, reports another boot ID, or sits on a host marked `unreachable`: the run fails at once with `load_generator_lost` and unknown counters. A runner unreachable for about 60 s while its Machine is started is stopped through Fly, then checked again.
- **Consequences:** Detection takes seconds (3.4 s from SIGKILL to the terminal run, measured on Fly). A run already `draining` keeps its persisted report and finalizes normally. The API does not try to stop a runner on an unreachable host, because the stop could hang; the next start recreates it ([HD-17](#hd-17-runner-capacity-failures-retry-in-place-then-recreate)). Only hard losses (crash, SIGKILL, host loss) are detected this way; a Fly `stop` yields an interrupted report instead ([HD-09](#hd-09-fenced-shutdown-through-the-runner-fly-stop-only-as-a-fallback)).
- **Rejected alternatives:** An automatic runner restart: a restarted runner could replay traffic silently.
- **Code:** `apps/api/src/services/runner-loss-monitor.ts`, `RunnerOperations.checkRunner`, `failLostRun` in `apps/api/src/services/demo-run-service.ts`.

### HD-13 Missing traffic evidence is unknown, never zero

- **Status:** accepted
- **Date:** 2026-10-03
- **Context:** A run can end without a k6 completion report (runner loss, reset during traffic). Zeros there would claim that no traffic happened.
- **Decision:** A summary written without a report records true zeros only with affirmative no-start evidence: setup failed before the start was dispatched, the runner answered the start with a definitive 4xx (`TrafficStartRejectedError`), or a starting run has no recorded boot, so it was never dispatched. Every other missing report, admin and automatic resets included, records unknown (`null`) counters across contracts, persistence, and UI. A persisted report is always kept.
- **Consequences:** The API still classifies such a run's delivery status as `failed`; the web hides the delivery verdict when counts are unknown and shows the unavailable-evidence text instead. A starting run without a recorded boot (for example after a failed boot write) is failed within one poll; reading the database settles an ambiguous commit, and a run whose boot was in fact recorded is replayed normally.
- **Code:** `syntheticFailedTrafficSummary` in `apps/api/src/services/traffic-delivery-plan.ts`, `apps/api/src/services/demo-run-startup-reconciliation-service.ts`, `apps/web/src/app/lib/presentation/traffic-evidence.ts`.

### HD-14 The version handshake refuses mismatched runs

- **Status:** accepted
- **Date:** 2026-10-03
- **Context:** A partial deployment, with the core and the runner on different commits, would produce evidence from mismatched code.
- **Decision:** Before dispatch, the API compares its commit with the runner's (`COMMIT_SHA`, the same string as the image label). A mismatch refuses the run: it ends failed (`load_orchestrator_unavailable`) with zero counters, the start answers 503 `runner_version_mismatch`, and the UI says the demo is being updated. On Fly, `unknown` never matches; the local runner host accepts `unknown`, so Compose works without `COMMIT_SHA`.
- **Consequences:** Refused attempts appear in run history as failed runs, because the run row exists before the runner may be asked its version (single-run admission comes first). No new failure reason was added.
- **Code:** `RunnerOperations.bootForRun`, `acceptUnknownVersion` in `apps/api/src/index.ts`.

### HD-15 Accepted risk: startup replay skips the version handshake

- **Status:** accepted
- **Date:** 2026-10-03
- **Context:** Startup reconciliation replays a starting run against its recorded boot without running the version handshake again.
- **Decision:** Accept it.
- **Consequences:** It matters only if the API crashes in the milliseconds between recording the boot and dispatching, and a deploy then lands within the runner's 3-minute idle window.
- **Code:** `apps/api/src/services/demo-run-startup-reconciliation-service.ts`.

### HD-16 Fly error classification is best-effort

- **Status:** accepted
- **Date:** 2026-10-02
- **Context:** Fly publishes no error contract, yet recovery must tell provider capacity apart from our own errors.
- **Decision:** One classifier, shared with the Machines API client, maps documented and observed signals to `provider_capacity` (a create refused with `insufficient_capacity` or `volume_placement_capacity`, or a start 409 with a known capacity phrase), `host_unreachable` (408, or `host_status: "unreachable"`), `transient` (429, 5xx), `conflict` (any other 409, such as a lease or version conflict; it never triggers a recreation), `own_error` (any other 4xx, or an unrequested non-zero exit), and `unclassified_provider_error`. The package holds no business rule; recovery sequences stay with their owners.
- **Consequences:** Phrase matching can drift as Fly changes its messages, so the classifier is maintained over time. An unknown signal falls to `unclassified_provider_error` and is shown as such, never guessed.
- **Code:** `packages/fly-machines/src/classifier.ts`.

### HD-17 Runner capacity failures: retry in place, then recreate

- **Status:** accepted
- **Date:** 2026-10-04
- **Context:** A stopped Machine can fail to start when its host lacks capacity; the runner has no volume pinning it to that host.
- **Decision:** Try `start` 3 times in place, with 1 s then 3 s back-off. Transient errors are retried but never recreate the runner; capacity and dead-host errors recreate it after the retries, and a runner already on an unreachable host is recreated at once. The new runner reuses the current config and is created with region `"<core region>,eu"`; the old one is force-destroyed only once the new one has started, otherwise it is kept. A create refused for capacity fails the run before traffic (zero counters, 503 `runner_capacity_unavailable`) and the visitor sees a provider message. While relocating, the run carries `runner_relocating` so the dashboard can say so, and every run records the runner's region. `POST /admin/demo/runner/recreate` (control token) runs the same replacement deliberately, only while the runner is stopped, and leaves the new runner stopped.
- **Consequences:** A recreation takes about 14 s. A runner placed outside the core's region adds k6-to-API latency; the recorded region makes it visible.
- **Rejected alternatives:** Recreating on transient errors: a new Machine would hit the same Machines API trouble.
- **Code:** `FlyRunnerHost.start` and `FlyRunnerHost.recreate` in `apps/api/src/services/fly-runner-host.ts`.

### HD-18 The newest runner Machine wins

- **Status:** accepted
- **Date:** 2026-10-04
- **Context:** A failed destroy after a recreation, or a lost create response, can leave two `role=runner` Machines. Refusing to choose wedged every runner operation.
- **Decision:** The API uses the newest `role=runner` Machine by `created_at` and logs a warning. Older Machines are left for the scheduled guard to remove.
- **Consequences:** An orphan from a lost create response is the newest, so it is simply used. The deploy script still refuses to run with two runners, since an operator runs it and sees the error.
- **Rejected alternatives:**
  - Failing every operation until someone cleans up: wedges the unattended demo.
  - A hardcoded Machine ID: breaks on every recreation.
- **Code:** `FlyRunnerHost.findRunnerMachine` in `apps/api/src/services/fly-runner-host.ts`.

### HD-19 Accepted risk: post-start wait errors are not retried

- **Status:** accepted
- **Date:** 2026-10-04
- **Context:** The in-place retry covers the `start` call only; the wait for `started` that follows sits outside the retry loop.
- **Decision:** Accept it.
- **Consequences:** Such an error fails the run cleanly before any traffic, with zero counters, and the next start heals the runner.
- **Code:** `FlyRunnerHost.startInPlace` in `apps/api/src/services/fly-runner-host.ts`.

## Core Idle Stop

### HD-20 The API stops its own idle core

- **Status:** accepted
- **Date:** 2026-10-04
- **Context:** The core must sleep when nobody uses it, but never during a run that is still settling orders after its HTTP traffic ends.
- **Decision:** The API stops its own Machine (`FLY_APP_NAME`, `FLY_MACHINE_ID`) after 10 minutes with no nonterminal run and no counted activity, checked on its 5 s poll. The deadline lives in API memory, and a countdown widget on every page displays it.
  - Counted: every visitor request through the web server (the Next.js Proxy reports it to `POST /core/activity`), the "stay awake" button, and a nonterminal run, so the countdown restarts at 10 minutes when a run ends.
  - Not counted: healthchecks, the widget's status polling, the demo page's recovery polling, open SSE connections, and requests made straight to the API (runner traffic, operator calls).
- **Consequences:** The gate's readiness probes must use an uncounted path (`/health`, or the API's `/health/ready`). The stop targets the API's own Machine ID and takes no lease: while another client holds the core lease, the stop blocks up to the client's 30 s timeout and the next check retries. A failing idle stop is left to the guard's 3-hour awake cap.
- **Rejected alternatives:**
  - Fly Proxy autostop: it sees only HTTP traffic and would cut a run still settling orders.
  - Counting in the API: it misses pages that never call the API.
  - Counting the recovery polling: an open demo tab would keep the core awake forever.
  - A literal "no run and no activity for 10 minutes": the core could stop right after a long run while the visitor reads its result.
- **Code:** `apps/api/src/services/core-idle-stop.ts`, `apps/web/src/proxy.ts`, `apps/web/src/app/components/core-idle-countdown.tsx`.

### HD-21 Accepted risk: idle stop races a run start

- **Status:** accepted
- **Date:** 2026-10-04
- **Context:** The idle check decides to stop, then calls Fly `stop`. A run can be admitted between that decision and Fly's SIGINT.
- **Decision:** Accept the race.
- **Consequences:** The window measured about 170 ms on Fly, and can reach 30 s (the Machines client timeout) while another client holds the core lease, today only a deploy. Web starts are not protected inside it: the proxy's activity report is not guaranteed to reach the API first, and activity recorded after the decision cannot cancel it. The interrupted run is reconciled on the next wake, by starting-run reconciliation or the runner-loss monitor.
- **Rejected alternatives:** Running the check under the maintenance authority, plus a permanent "stop committed" latch read by run starts: disproportionate coupling, and starts or resets would block behind a stop that can hang.
- **Code:** `CoreIdleStop` in `apps/api/src/services/core-idle-stop.ts`.

### HD-22 Known limitation: short operator runs are not counted

- **Status:** accepted
- **Date:** 2026-10-04
- **Context:** The end of a run counts as activity only when a 5 s check sees the run nonterminal.
- **Decision:** Accept the limitation.
- **Consequences:** A run started straight on the API (an operator with the control token) that ends before the next check is never counted, so an otherwise idle core can stop up to 10 minutes earlier than the rule says. Web starts are counted by the proxy, and no run is ever cut off by this.
- **Code:** `CoreIdleStop` in `apps/api/src/services/core-idle-stop.ts`.

### HD-23 Accepted risk: stale countdown after stay awake

- **Status:** accepted
- **Date:** 2026-10-04
- **Context:** The widget applies status responses in arrival order, so a poll sent before "stay awake" can land after its response and show the older deadline.
- **Decision:** Accept it.
- **Consequences:** Display only: the deadline itself lives in the API, and the next poll (at most 30 s later) corrects the widget.
- **Code:** `CoreIdleCountdown` in `apps/web/src/app/components/core-idle-countdown.tsx`.

## Deployment and Access

### HD-24 Deploys build remotely and replace whole Machine configs

- **Status:** accepted
- **Date:** 2026-10-03
- **Context:** Local image builds exhausted the owner's workstation memory, and `flyctl machine update` merges the new JSON into the old Machine config.
- **Decision:** The deploy script builds images on Fly's remote builder (Depot) and pushes them without deploying, labelled `<service>-<commit-sha>` (with a `-dirty` suffix for uncommitted changes). `--no-depot` (Fly's previous builder) covers a Depot incident, and `--local-build` falls back to a local build. Machines are created and updated through the Machines API with the full config and `skip_launch`; the deploy never starts them.
- **Consequences:** Images are always linux/amd64, with a build cache kept at Fly; the expected build cost is zero within the free build minutes. A key removed from the config does not survive an update. After a create or an update, the script waits for `stopped`, because Fly refuses a start for a few seconds then.
- **Rejected alternatives:**
  - Local Docker builds by default: they exhausted the workstation's memory.
  - `flyctl machine update` or `machine run --machine-config`: they merge into the old config and keep removed keys.
- **Code:** `infra/fly/deploy.mjs`.

### HD-25 The infrastructure-limit message uses an explicit code allowlist

- **Status:** accepted
- **Date:** 2026-10-03
- **Context:** Hosted run limits come from the deployment caps (`DEMO_MAX_*`). A visitor who hits one must learn that it is a hosting choice, not a defect.
- **Decision:** The web shows the infrastructure-limit message only for an explicit, contract-typed allowlist: the `deployment_*_exceeded` run codes and the public load-size codes (buyers, duration, max VUs, preallocated VUs, request rate, total requests, start delay). ERP limits, starting stock, invalid input, and admin policy-edit codes (`*_exceeds_deployment_cap`) keep their ordinary presentation. The wording stays provider-neutral, so it holds for local and hosted runtimes.
- **Consequences:** A new limit code shows the message only once added to the list; a renamed code breaks compilation.
- **Rejected alternatives:** Suffix or pattern matching on codes: it would catch policy-editing and ERP failures.
- **Code:** `infrastructureRunLimitCodes` in `apps/web/src/app/lib/presentation/error-presentation.ts`.

### HD-26 Accepted risk: deploy tokens give a compromised component wide control

- **Status:** accepted
- **Date:** 2026-10-02
- **Context:** Machine control needs Machines API tokens inside Machines: the API holds app-scoped deploy tokens for the runner app (`RUNNER_FLY_API_TOKEN`) and for its own core app (`CORE_FLY_API_TOKEN`), and the gate and guard hold core and runner tokens. Fly deploy access can run code that reads secrets.
- **Decision:** Accept it. Tokens are app-scoped deploy tokens, given only to the containers that use them; no personal or organization-wide token ever goes into a Machine. Attenuating tokens to specific actions is optional, because the caveat schema is undocumented.
- **Consequences:** A compromised gate, the only always-exposed component, means full control of the core app, its secrets included, and through the core's runner token, of the runner app. No sensitive data is involved, so the exposure is financial. Mitigations: a minimal gate surface, the guard's cleanup of unexpected Machines, and billing controls in the Fly dashboard.
