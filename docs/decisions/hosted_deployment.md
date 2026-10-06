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
- **Decision:** One owner in the API runs every runner operation one at a time and holds a Fly lease on the runner Machine during each, to coordinate with the deploy script, except on a host that is not ok, where Fly grants no usable lease ([HD-47](#hd-47-the-runner-is-recreated-from-a-deployed-config-without-a-lease-on-a-host-that-is-not-ok)). Run starts and starting-run reconciliation run inside the API maintenance authority, together with resets.
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
- **Decision:** Try `start` 3 times in place, with 1 s then 3 s back-off. Transient errors are retried but never recreate the runner; capacity and dead-host errors recreate it after the retries, and a runner already on a host that is not ok is recreated at once. The new runner is built from the deployed runner config ([HD-47](#hd-47-the-runner-is-recreated-from-a-deployed-config-without-a-lease-on-a-host-that-is-not-ok)) and created with region `"<core region>,eu"`; the old one is force-destroyed only once the new one has started, otherwise it is kept. A create refused for capacity fails the run before traffic (zero counters, 503 `runner_capacity_unavailable`) and the visitor sees a provider message. While relocating, the run carries `runner_relocating` so the dashboard can say so, and every run records the runner's region. `POST /admin/demo/runner/recreate` (control token) runs the same replacement deliberately, only while the runner is stopped, and leaves the new runner stopped.
- **Consequences:** A recreation takes about 14 s. A runner placed outside the core's region adds k6-to-API latency; the recorded region makes it visible. A runner on a dead host is recreated without its lease and from the deployed config, since Fly returns neither a full config nor a usable lease there ([HD-47](#hd-47-the-runner-is-recreated-from-a-deployed-config-without-a-lease-on-a-host-that-is-not-ok)).
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

### HD-43 Every k6 counter is initialized, so an absent counter is unknown

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** k6 leaves out of its summary export any counter that never received a sample. Clean runs then lacked their zero-valued counters, which read as missing evidence and raised generator warnings on every run.
- **Decision:** The generated script adds a zero sample to every counter the load orchestrator reads, k6 built-ins included, before traffic starts. A valid export therefore lists each one, and a counter absent from an export stays unknown. On the point stream, these zero samples are not evidence: they prove neither a total nor an arrival.
- **Consequences:** Clean runs have no counter warnings, and the unknown-versus-zero rule (HD-13) stays strict at the field level. Without a usable export, a counter takes its streamed sum, or else stays unknown, so a completion report can carry unknown fields. Equations and comparisons apply only when their terms are known. Finalization does not wait for an unknown accepted-response counter, which can never become known. It still requires drained pending persistence and one order per reservation, and a known accepted count still sets the floor. A test ties the script's initialized counters to the parser's list, so a rename cannot become a silent zero.
- **Rejected alternatives:**
  - Read a counter absent from a valid export as zero: it trusts that every counter is declared and named the same in the script and the parser, and a rename or an export divergence would become a silent zero.
  - Warn on each absent counter: k6's normal behavior flags every clean run.
  - Default missing evidence to zero: hides lost evidence.
- **Code:** `generateK6Script` (`setup()`), `counterMetricFields` and `parseK6JsonLine` in `k6-output-parser.ts`, `reconcileAcceptedResponses`.

### HD-44 Only an observed platform gap is not applicable

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** cgroup v1 (Fly Machines) has no memory `high` boundary, so the `high` event count has no counterpart there. Counting it as unavailable flagged every hosted run.
- **Decision:** That probe is marked not applicable only when the mount table shows cgroup v1 without cgroup v2 at the probed root. It keeps a null value, adds no warning, and reads "Not applicable". Every other missing or unreadable probe, on any layout, stays a warning.
- **Consequences:** An unusual or new layout surfaces as warnings, never as silence; a new gap is added only once observed.
- **Rejected alternatives:**
  - Treat an absent probe file as not applicable: hides a broken probe.
  - Derive not-applicable probes from controller metadata for every layout: covers hosts never seen, for more code.
  - Report zero: claims a measurement nobody made.
- **Code:** `unsupportedCgroupProbes` in `load-run-diagnostics.ts`, `countUnavailableLoadRunDiagnosticProbes`.

### HD-47 The runner is recreated from a deployed config, without a lease on a host that is not ok

- **Status:** accepted
- **Date:** 2026-10-06
- **Context:** Runner recreation copied the old Machine's config and took its lease. Fly returns only a partial config, and grants no usable lease, for a Machine whose host is not ok, which is exactly when a dead-host recreation needs both.
- **Decision:** Every core deploy writes the runner Machine's full config, as last deployed, into the core's API container as a file, and the API builds a recreated runner from it, with the run's size and API address. On a runner whose host is not ok, the API takes no lease, as Fly's own tooling does: a start recreates the runner at once, a stop does nothing, and the old runner is force-destroyed without a nonce, a 404 counting as done.
- **Consequences:** A recreation always rebuilds the runner config of the last core deploy, so a runner changed by hand, or deployed alone, since then is not carried over; the one-command deploy keeps both in step ([HD-46](#hd-46-one-command-deploys-the-runner-and-the-core-together-and-a-version-mismatch-fails-the-deploy)). A missing file fails the recreation, and with it the run, before any traffic.
- **Rejected alternatives:**
  - Copying the old Machine's config: partial on a host that is not ok.
  - A copy in the gate, like the core's ([HD-34](#hd-34-core-recovery-recreates-a-fresh-core-and-retires-the-old-one-only-once-the-new-one-is-healthy)): the API cannot read the gate's files.
  - Building the config inside the API image from the repository: the runner image's label is known only once it is built.
- **Code:** `FlyRunnerHost.replace` and `FlyRunnerHost.withLease` in `apps/api/src/services/fly-runner-host.ts`, `runnerConfigFile` in `infra/fly/deploy.mjs`.

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

## Gate

### HD-27 The gate relays with `@fastify/reply-from`, retries off

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** The gate relays through a proven library ([HD-02](#hd-02-the-gate-is-the-only-public-address-and-the-only-waker)). `@fastify/reply-from`, on the Fastify stack the other services use, replays some failed or 503-answered requests by default, after delays of up to tens of seconds.
- **Decision:** Use it with retries turned off.
- **Consequences:** The core's own errors, such as a dashboard recovery at capacity, reach the visitor once and at once, and no request is sent to the core twice.
- **Rejected alternatives:** `http-proxy`: unmaintained.
- **Code:** `apps/gate/src/server.ts`.

### HD-28 The gate checks the core's state before relaying, but a Fly API failure does not block a ready core

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** For each request, the gate must choose between relaying to the core and showing its own page. Fly's Machines API has no SLA on standard plans and has had outages roughly monthly, while running Machines and 6PN usually keep working.
- **Decision:** Before relaying, the gate reads the core's state from the Machines API plus a readiness probe that the core never counts as activity, and caches that status briefly: this discovers the core, chooses the page, and follows the boot. Once the core is ready, a failed Fly read, or a probe that gets no answer at all, keeps the last ready status and the read is retried on the next cycle; a probe that answers "not ready" still means not ready. A failed relay drops the status and forces a fresh read.
- **Consequences:**
  - Accepted staleness: a core that just stopped can still be relayed to until its status expires or a relay fails, and a core that just became ready can show the booting page a moment longer.
  - Accepted limit: during a Machines API outage, a stopped core cannot be woken, and a relay failure shows the unavailable page.
- **Rejected alternatives:**
  - Relay first and consult Fly only on failure: a TCP connect to a stopped Machine's 6PN address is not refused but hangs (measured from the gate: no answer within 30 s), so each visit to a stopped core would wait for a connect timeout; and a reachable core whose web is down would go undetected.
  - Refreshing the status in the background: more code and tests for little gain.
- **Code:** `apps/gate/src/core-status.ts`.

### HD-29 The gate's lease covers only the start command

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** The gate and the deploy script coordinate through the core Machine lease ([HD-45](#hd-45-the-deploy-updates-a-sleeping-core-under-its-lease-read-again-after-the-builds)).
- **Decision:** The gate holds the lease only around the start command, not through the boot until the core is ready: a started core is one the deploy script refuses to update, provided the script re-reads the core's state under the lease just before its update, so a longer hold would only block deploys. A held lease is shown as "updating", although a lease alone does not prove a deploy (it can also be a wake whose gate died before releasing it, until the lease expires); telling holders apart is not worth the code for a page that only asks the visitor to retry. Retrying a failed start and recreating the core are core recovery ([HD-34](#hd-34-core-recovery-recreates-a-fresh-core-and-retires-the-old-one-only-once-the-new-one-is-healthy)), which the wake triggers and which keeps the lease until it ends.
- **Consequences:**
  - A visitor may see "updating" while no deploy runs; a retry works once the lease is released or expires.
  - A wake during the deploy's builds is never interrupted: the script takes the core lease only after its builds, reads the core again under it, and waits for an awake core to sleep first.
  - The wake's lease TTL covers the worst case of the wake's own calls (read, wait for a stopping core, start retries), so a gate dying mid-wake keeps "updating" up to that TTL, as a recovery keeps it up to its own longer lease ([HD-34](#hd-34-core-recovery-recreates-a-fresh-core-and-retires-the-old-one-only-once-the-new-one-is-healthy)).
- **Code:** `CoreWake` in `apps/gate/src/core-wake.ts`.

### HD-30 Gate pages answer any request with HTML 503

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** Bookmarks, deep links and pages left open must all land on the gate's own page while the core is not ready.
- **Decision:** While the core is not ready, the gate answers every method and URL, API calls included, with its HTML page and status 503, never cached.
- **Consequences:** API calls and page polling get HTML instead of JSON while the core is not ready: the countdown widget reads it as "Demo paused", and the web treats it as a failed call.
- **Rejected alternatives:** JSON answers on API paths: a second error format to keep in step with the contracts, for callers that already handle a failed call.
- **Code:** `apps/gate/src/pages.ts`.

### HD-31 The gate sleeps, and a visit wakes it

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** The gate is the only public address, but it need not run while nobody visits.
- **Decision:** Fly Proxy starts the gate Machine on an incoming request and stops it once traffic is gone.
- **Consequences:** The first request to a sleeping gate takes a few seconds longer (measured: about 4 to 5 s).
- **Rejected alternatives:** An always-running gate: a permanent cost for a demo used a few hours per month.

### HD-32 Accepted risk: the core's Caddy trusts the whole private network for visitor addresses

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** The core's Caddy must take the visitor address from the gate's forwarding header. A Machine's 6PN address follows its host and carries no app prefix, so the gate's address is not a stable identity.
- **Decision:** Caddy trusts forwarding headers from any address of Fly's private network (6PN). The gate overwrites every client-supplied forwarding header.
- **Consequences:** 6PN is isolated per organization, so only the organization's Machines and WireGuard peers can claim a visitor address. The trusted address feeds only the API's per-source SSE cap and the dashboard-recovery source key, never authentication, admin access or run budgets, which use the signed cookie. An attacker holding a Machine of the organization can already call the API directly over 6PN and holds deploy tokens ([HD-26](#hd-26-accepted-risk-deploy-tokens-give-a-compromised-component-wide-control)), so this trust gives nothing more.
- **Rejected alternatives:**
  - The gate's address, written at deploy time or resolved when Caddy starts: it goes stale when Fly moves the gate, and every visitor then silently shares one SSE cap.
  - The organization's prefix only: an organization-specific value with the same silent failure if the app changes organization, for a gain only against a failure of Fly's isolation.
- **Code:** `infra/caddy/Caddyfile.fly`, `apps/gate/src/relay-headers.ts`.

## Core Recovery

### HD-34 Core recovery recreates a fresh core and retires the old one only once the new one is healthy

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** The core is pinned to its volume's host, so a host without capacity, or a dead host, leaves it unable to start, and nobody is around to repair it. Its data is disposable ([HD-05](#hd-05-core-data-is-disposable-with-no-restore-path)).
- **Decision:** On a visitor's wake, the gate retries `start` in place with back-off, like the runner ([HD-17](#hd-17-runner-capacity-failures-retry-in-place-then-recreate)). Capacity and dead-host failures, and a core already on a host that is not ok, then recreate the core: a new empty volume placed by Fly in the core's home region or elsewhere in Europe, sized for the core's Machine, and a new Machine on it, which installs fresh. The new Machine is built from the core config the deploy script last sent, which it also writes into the gate Machine as a file; without that file there is no recovery. The old Machine and volume are destroyed only once the new core is healthy (setup succeeded, the readiness probe answers); otherwise the new ones are removed and the old core is kept. The gate holds the old core's lease for the whole recovery, except on a host that is not ok, where it takes no lease and force-destroys the old core without one, as Fly's own tooling does. Visitors see the relocating page meanwhile.
- **Consequences:**
  - A recovery loses run history and admin edits. The visitor waits under a minute (measured on Fly: 37 s from the start button to the demo).
  - A capacity refusal keeps the old core and shows the no-capacity page until a visitor tries again; any other failure keeps the old core and returns visitors to the start page.
  - A core on a host that is not ok shows the start button rather than the booting page, so a deliberate visitor action can recreate it.
  - The old volume's deletion is only started: on a host that is down, Fly keeps it pending until the host returns, and the guard cleans up what remains.
  - A recovery always rebuilds the last deployed config, so a core config changed by hand since the last deploy is not carried over.
  - When the listing shows no core at all (a dead core whose partial config lost its metadata, or a core deleted by hand), a visitor's wake creates one from the deployed config, with no lease and nothing destroyed. The gate never touches a Machine it does not recognize as the core. Accepted risk: if the listing wrongly omitted an existing core, a duplicate core is created; the selection rule serves the usable one and the guard removes the surplus, and nothing unknown is ever destroyed.
  - Accepted risk: the recovery runs inside the gate process. A gate stopped mid-recovery can leave a volume without a Machine, or two core Machines, for the guard to clean up, and visitors see "updating" until the lease expires.
  - When several cores exist, the gate skips any that cannot serve (on a host that is not ok, or with a failed setup), so a leftover never hides the core that can. Accepted gap: a new core that starts but never becomes healthy without a setup failure, and whose removal also fails, can still be selected until the guard removes it.
- **Rejected alternatives:**
  - Destroying the old core before the new one is healthy: a failed recreation would leave no core at all.
  - Recreating on transient errors: a new core would hit the same Machines API trouble.
  - Releasing the lease after the start, as a normal wake does ([HD-29](#hd-29-the-gates-lease-covers-only-the-start-command)): a deploy could update the old core while it is being replaced.
  - Copying the old Machine's config: Fly returns only a partial config for a Machine whose host is not ok, exactly when a dead-host recovery needs it.
  - Taking a lease on a core whose host is not ok: Fly's own tooling skips leasing such Machines.
  - Treating a core-app Machine without the `role` label on a down host as the core: the gate could destroy a Machine that is not the core.
- **Code:** `CoreWake` in `apps/gate/src/core-wake.ts`, `CoreRecovery` in `apps/gate/src/core-recovery.ts`, `writeCoreConfigToGate` in `infra/fly/deploy.mjs`.

### HD-35 A fresh core is requested by a mark that the next wake acts on

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** The recovery path must be triggerable on purpose, to test it and to give the deploy a fresh core after incompatible changes, while the gate is the only public component and holds no shared secret.
- **Decision:** An operator, or the deploy script, sets `recreate=requested` in the core Machine's metadata. The next visitor wake then recreates the core instead of starting it; the mark is not copied to the new core.
- **Consequences:** No new secret or privileged endpoint on the gate. The visitor sees a fresh-install page, the same recovery without the provider-capacity wording of a real recovery's relocating page. The fresh install happens at the next wake, not at deploy time, so the first visitor after it waits longer and the deploy script cannot confirm the new core itself. A marked core never starts again with incompatible data.
- **Rejected alternatives:**
  - An authenticated recovery endpoint on the gate: a new secret and an admin surface on the only public component ([HD-26](#hd-26-accepted-risk-deploy-tokens-give-a-compromised-component-wide-control)).
  - A recovery command run from a workstation or CI: no private network to probe the new core's health, and the gate would not know to show the relocating page.
- **Code:** `recreationRequested` in `apps/gate/src/core-machine.ts`.

### HD-36 The runner follows the core's region, even at one recreation per run

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** A recovered core can land outside its home region, and a runner in another region adds latency between k6 and the API.
- **Decision:** When a run starts, a runner whose region differs from the core's is recreated in the core's region first, then elsewhere in Europe, through the runner's capacity recreation path.
- **Consequences:** While the core's region has no room for the runner, the runner is recreated at every run start (about 14 s each) and may land outside it again; the recorded runner region shows it.
- **Rejected alternatives:** Remembering a failed placement to skip later attempts: state for a rare case, and the next run would keep the cross-region latency without trying again.
- **Code:** `FlyRunnerHost.start` in `apps/api/src/services/fly-runner-host.ts`.

## Guard

### HD-37 The guard acts only under a Machine's lease, and skips a leased one

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** The hourly guard stops and destroys Machines that a wake, a recovery, a deploy or a runner operation may be working on at the same moment. Fly does not refuse a stop or a destroy sent without the lease nonce: it blocks until the lease expires, then runs it.
- **Decision:** Every stop and destroy takes the Machine's lease first, then reads the Machine again under it, and acts only if its state, its host status and its latest start are unchanged since the plan; a held lease or a changed Machine skips it until the next run. On a host that is not ok, where Fly grants no usable lease, a destroy takes none, as Fly's own tooling does ([HD-34](#hd-34-core-recovery-recreates-a-fresh-core-and-retires-the-old-one-only-once-the-new-one-is-healthy)); the Machine is read again just before the destroy, which narrows the window but cannot close it.
- **Consequences:** The old core of a recovery in progress is leased by the gate, so the guard never destroys it under the gate's feet. A plan can be minutes old after the core probes, so a core woken, a runner started or a host back since then is left alone. A Machine that stays leased, or keeps changing, is cleaned an hour later. Machines that carry no lease, such as a recovery's new core and volume, rely on the age-based grace period instead.
- **Rejected alternatives:**
  - Acting without the lease, with a short client timeout: the blocked call may still run once the lease expires, in the middle of the holder's next step.
  - Reading the lease before acting: racy, and one more call for the same result.
- **Code:** `Guard.withLease` in `apps/gate/src/guard.ts`.

### HD-38 The guard probes a core several times within one run

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** A core saturated by a `surge-10k` burst can miss a readiness probe (measured on Fly: no answer within 2 s mid-burst, an answer in 18 ms two minutes later). The guard is a one-shot Machine started hourly, with no state between runs.
- **Decision:** Within one run, a started core past its startup grace is stopped as unreachable only when it stays silent on several probes a few minutes apart. Only a started core is probed, so a run that finds the core asleep takes under a second.
- **Consequences:** A run that finds a silent core lasts a few minutes. A guard that cannot reach a healthy core over the private network would stop it; the core can always be restarted through the gate. When a core stays silent, the guard lists the Machines again before planning, so a core woken by the gate during the probes is not taken for the silent one; every stop and destroy also re-reads its Machine first ([HD-37](#hd-37-the-guard-acts-only-under-a-machines-lease-and-skips-a-leased-one)).
- **Rejected alternatives:**
  - One probe per hourly run, with the count kept between runs (for example in the core's metadata): a dead core would stay up for hours, and the count is more state to maintain.
  - A single probe: a burst would stop a working core.
- **Code:** `Guard.unreachableCores` in `apps/gate/src/guard.ts`.

### HD-39 The guard keeps the core the gate would use, not the newest

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** A recovery can leave a second `role=core` Machine: a new core whose setup failed or that never answered, or the old core on a dead host ([HD-34](#hd-34-core-recovery-recreates-a-fresh-core-and-retires-the-old-one-only-once-the-new-one-is-healthy)). Unlike the runner's ([HD-18](#hd-18-the-newest-runner-machine-wins)), the newest core is not necessarily the one that can serve.
- **Decision:** The guard keeps the core that the gate's own selection would use, where a core silent on every probe cannot serve either, and destroys every other `role=core` Machine past the grace period, then deletes its volume.
- **Consequences:** The gate and the guard share one rule, so they agree on the core. A silent leftover past the grace period is destroyed rather than only stopped, so the gate cannot select it again on the next wake. When no core can serve, the gate's choice is still kept, so a dead core remains for a visitor's wake to recreate.
- **Rejected alternatives:**
  - Keeping the newest, as for the runner: a recovery's failed new core would win, and the working old core would be destroyed.
  - Keeping the started one: the started core can be the failed one.
- **Code:** `selectCore` in `apps/gate/src/core-machine.ts`, `Guard.planCore` in `apps/gate/src/guard.ts`.

### HD-40 Accepted risk: the gate Machine holds the guard's runner token

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** The guard runs in the gate app and needs a runner-app deploy token. A single-image Machine receives every secret of its app.
- **Decision:** Keep the runner-app token as a gate-app secret, so the public gate Machine receives it too.
- **Consequences:** The blast radius does not grow: a compromised gate already controls the core app and its secrets, which include the API's own runner-app token ([HD-26](#hd-26-accepted-risk-deploy-tokens-give-a-compromised-component-wide-control)).
- **Rejected alternatives:**
  - Per-container secret lists, which would turn the gate into a container Machine and move the deployed core config file with it: work for no security gain.
  - A separate app for the guard: another app, token and deploy target for the same result.

### HD-41 The guard is deployed without `skip_launch`

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** The deploy script creates and updates every other Machine with `skip_launch`, so a deploy never starts anything ([HD-24](#hd-24-deploys-build-remotely-and-replace-whole-machine-configs)). Observed on Fly: a scheduled Machine created or updated with `skip_launch` was never started by Fly's scheduler, while the same Machine updated without it ran on schedule. Fly documents no such rule.
- **Decision:** The deploy script creates and updates the guard without `skip_launch`.
- **Consequences:** Creating the guard runs it once at deploy time, which is harmless; an update leaves a stopped guard stopped. An operator who changes the guard by hand must not pass `--skip-start` (flyctl sets `skip_launch` with it), or the guard silently stops running.
- **Rejected alternatives:** Starting the guard once after a `skip_launch` deploy: an update with `skip_launch` after a start also stopped the schedule.
- **Code:** `deployGuard` in `infra/fly/deploy.mjs`.

### HD-42 The guard leaves a role-less Machine on a down host alone

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** A Machine on a host that is not `ok` returns only a partial config, which may lack its `role` label; in practice it is a dead core. The gate already creates a fresh core when no core is listed ([HD-34](#hd-34-core-recovery-recreates-a-fresh-core-and-retires-the-old-one-only-once-the-new-one-is-healthy)).
- **Decision:** The guard never destroys a Machine it cannot identify on a host that is not `ok`; it logs a warning on each run.
- **Consequences:** If the host never returns, the Machine and its volume linger (a few cents a month) until the owner removes them. If the host returns, the Machine shows its role again and the normal rules apply.
- **Rejected alternatives:** Destroying it after the leftover grace like other unknown Machines: it cannot be told apart from a foreign Machine, and it may be the only real core on a host that comes back. Destroying it only once a usable core exists and after a long grace: more code for a case never observed.

## Deployment and Access

### HD-24 Deploys build remotely and replace whole Machine configs

- **Status:** accepted
- **Date:** 2026-10-03
- **Context:** Local image builds exhausted the owner's workstation memory, and `flyctl machine update` merges the new JSON into the old Machine config.
- **Decision:** The deploy script builds images on Fly's remote builder (Depot) and pushes them without deploying, labelled by commit, with a unique label per build for uncommitted trees, because the Machines API keeps a Machine's image when the reference string is unchanged. `--no-depot` (Fly's previous builder) covers a Depot incident, and `--local-build` falls back to a local build. Machines are created and updated through the Machines API with the full config and `skip_launch`; the deploy never starts them.
- **Consequences:** Images are always linux/amd64, with a build cache kept at Fly; the expected build cost is zero within the free build minutes. A key removed from the config does not survive an update. After a create or an update, the script waits for `stopped`, because Fly refuses a start for a few seconds then. The Machines API can refuse an image pushed seconds earlier as unknown (`MANIFEST_UNKNOWN`) while the registry already serves it, so the script retries that refusal.
- **Rejected alternatives:**
  - Local Docker builds by default: they exhausted the workstation's memory.
  - `flyctl machine update` or `machine run --machine-config`: they merge into the old config and keep removed keys.
- **Code:** `infra/fly/deploy.mjs`.

### HD-25 The infrastructure-limit message uses an explicit code allowlist

- **Status:** accepted
- **Date:** 2026-10-03
- **Context:** Hosted run limits come from the deployment caps. A visitor who hits one must learn that it is a hosting choice, not a defect.
- **Decision:** The web shows the infrastructure-limit message only for an explicit, contract-typed allowlist of run-limit codes. Every other rejection keeps its ordinary presentation. The wording stays provider-neutral, so it holds for local and hosted runtimes.
- **Consequences:** A new limit code shows the message only once added to the list; a renamed code breaks compilation.
- **Rejected alternatives:** A suffix or name rule on codes: it would also cover errors that must not show this message, such as admin policy edits against the caps and ERP limits.
- **Code:** `infrastructureRunLimitCodes` in `apps/web/src/app/lib/presentation/error-presentation.ts`.

### HD-26 Accepted risk: deploy tokens give a compromised component wide control

- **Status:** accepted
- **Date:** 2026-10-02
- **Context:** Machine control needs Machines API tokens inside Machines: the API holds app-scoped deploy tokens for the runner app (`RUNNER_FLY_API_TOKEN`) and for its own core app (`CORE_FLY_API_TOKEN`), and the gate and guard hold core and runner tokens. Fly deploy access can run code that reads secrets.
- **Decision:** Accept it. Tokens are app-scoped deploy tokens, given only to the containers that use them; no personal or organization-wide token ever goes into a Machine. Attenuating tokens to specific actions is optional, because the caveat schema is undocumented.
- **Consequences:** A compromised gate, the only always-exposed component, means full control of the core app, its secrets included, and through the core's runner token, of the runner app. No sensitive data is involved, so the exposure is financial. Mitigations: a minimal gate surface, the guard's cleanup of unexpected Machines, and billing controls in the Fly dashboard.

### HD-33 Accepted risk: core secrets reached Fly's build cache

- **Status:** accepted
- **Date:** 2026-10-05
- **Context:** `.dockerignore` excluded environment files only at the repository root, so the gitignored local copy of the core secrets went with every remote build context into the cached build stage on Fly's builder. Final images hold only the deployed packages or the Next.js standalone build, so no pushed image contains the file.
- **Decision:** Rotate the core secrets before go-live rather than rely on the cache expiring. `.dockerignore` now excludes environment files at any depth.
- **Consequences:** Until the rotation, the secrets also sit in a builder cache that Fly controls; Fly already holds them as app secrets.
- **Code:** `.dockerignore`.

### HD-45 The deploy updates a sleeping core under its lease, read again after the builds

- **Status:** accepted
- **Date:** 2026-10-06
- **Context:** A deploy replaces whole Machine configs, and its builds take minutes. A visitor can wake the core through the gate at any time, and an update decided from a state read before the builds could cut that visitor's session.
- **Decision:** The script builds first. It then waits for an awake core to sleep, takes the core lease, reads the core again under it, and updates it with the lease nonce only if it is stopped or was never started. It holds the lease through the wait for `stopped` and the write of the core config into the gate, and releases it in every case. A held lease fails the script, to be re-run. `--force` stops an awake core under the lease instead of waiting. The runner is updated the same way under its own lease, and a running runner is refused unless `--force` stops it.
- **Consequences:** The lease TTLs cover the waits at Fly's 60 s cap and the full `MANIFEST_UNKNOWN` retry budget; a request that hangs beyond them is not covered, and no client deadline is added on purpose, because aborting a mutating call does not cancel it at Fly.
  - A wake during the builds is never interrupted: the deploy waits for that session to end, at most until the guard's awake cap.
  - A wake while the script holds the lease shows "updating" ([HD-29](#hd-29-the-gates-lease-covers-only-the-start-command)).
  - A script killed while it holds the lease leaves "updating" until the lease expires, or until the operator clears it with flyctl.
  - With `--force`, the visitors' session ends at once, and a run in progress ends failed.
  - Fly keeps the lease across the update (verified), so a wake right after the update still shows "updating".
- **Rejected alternatives:**
  - Taking the lease before the builds: wakes would be refused for minutes instead of seconds.
  - Waiting on a held lease: a recovery holds it for minutes, and an operator at the terminal can simply re-run.
  - Updating an awake core, which Fly allows: it restarts the core under its visitors.
- **Code:** `deployCore`, `deployRunner`, `withLease` and `requireStopped` in `infra/fly/deploy.mjs`.

### HD-46 One command deploys the runner and the core together, and a version mismatch fails the deploy

- **Status:** accepted
- **Date:** 2026-10-06
- **Context:** The version handshake refuses every run while the core and the runner run different commits ([HD-14](#hd-14-the-version-handshake-refuses-mismatched-runs)), so the gap between their two updates must stay invisible, and a partial deployment must never pass unnoticed.
- **Decision:** `all` updates the runner, the core, then the gate, with the runner's update inside the core lease: a wake meanwhile shows "updating", and a sleeping core cannot start the runner. Single-app deploys remain, for example for a gate-only change. Every deploy ends by comparing the deployed core and runner versions, even after a failed step, and exits non-zero when they differ.
- **Consequences:** A runner-only or core-only deploy of a new commit is reported as a failure on purpose. The gate's version is not compared: the gate takes no part in a run.
- **Rejected alternatives:** Deploying each app with its own command: a wake between them meets a partial deployment and refused runs.
- **Code:** `deploy` and `verifyVersions` in `infra/fly/deploy.mjs`.

### HD-48 A requested fresh core stays requested until a wake acts on it

- **Status:** accepted
- **Date:** 2026-10-06
- **Context:** Incompatible changes are deployed with `--fresh-core`, which sets the recreation mark ([HD-35](#hd-35-a-fresh-core-is-requested-by-a-mark-that-the-next-wake-acts-on)) in the core config the deploy sends. Every later deploy replaces the whole config.
- **Decision:** The mark is set in the same update as the incompatible code, and a deploy carries over a mark it finds, so only a wake clears it, by recreating the core.
- **Consequences:** A core deployed with incompatible changes never starts on its old data, even when another deploy follows before any visitor. A mark set by mistake is removed by hand, through the Machines API metadata endpoint.
- **Rejected alternatives:** Setting the mark in a separate step after the deploy: a wake in between would start the new code on incompatible data.
- **Code:** `deployCore` in `infra/fly/deploy.mjs`.
