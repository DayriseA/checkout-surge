# 07 — Comparative Presets and Load Generator

**Design:** section 3 · **Depends on:** 03–06

## Goal

One immutable public preset/start button shows both comparisons clearly and repeatably on the hosted hardware.

## Scope

- Tune the presets from the checkpoint's configurations, measured on Fly.io with the modes interleaved and repeated.
- Size the runner for the presets' rates.
- The presets are the only way to start a comparative mode. Custom runs, public or admin, never offer one.

## Done When

- The presets show their point in every repetition, and the spread is recorded.

## Open Points

- None about exposure: the owner confirmed a simple public demonstration with fixed settings. The measured tuning sets the two internal matched workloads without exposing visitor configuration.

## Working Notes

### Owner clarification — 2026-10-11

The owner requires one visible immutable public preset/start button and no editable stages or modes. Internally it executes two fixed matched workloads (Redis versus PostgreSQL and queued versus inline ERP), four normal child runs in total. Sequencing/reset are delegated: one public-budget and exclusive reservation, total estimated occupancy within 600 seconds, and the existing 900-second hard cleanup grace anchored to demonstration acceptance. Retain all four child summaries. The existing demo remains functional; production intervention waits for final review.

### Parent acceptance foundation - partial implementation

Slice A extracts shared transaction-bound child insertion and the existing post-commit launch path. Ordinary starts and comparison acceptance share the same START advisory lock and control maintenance authority. A comparison freezes four child identities and matched snapshots, checks their combined estimated occupancy, charges one public budget reservation and atomically inserts the parent with its first child before launch. Accepted or ambiguous dispatch failures retain their charge; affirmative pre-traffic rejection may compensate it. The parent retains exclusive ownership while cleanup is pending.

One archived immutable comparison backing preset gives all four children accurate provenance; it is not selectable until slice B publishes the same registry row with the comparison dispatcher. Candidate settings reproduce task 02's retained shapes: Redis/PostgreSQL at 1,000 arrivals/s for ten seconds, stock one, ERP zero latency / 1,000 TPS and explicit 10,000 VUs; queued/inline ERP at 5,000 finite-spike buyers, an 80-second cutoff, stock 500, ERP 100 ms / 20 TPS and concurrency five. These candidates still require common-runtime hosted calibration. Sequencing, recovery, cleanup, read models and public presentation remain outside this partial slice. No final repeatability claim is made.

Local slice A validation passed in the dev container with serial workspace production type checks and test type checks, a 1,536 MiB Node heap cap and one Vitest worker. Focused checks passed: workload/capacity units (16), migration units including schema drift (5), projection units (5), the complete lifecycle API file (77, including seven new parent cases), PostgreSQL pending-persistence recovery (2), seven affected API recovery cases and one worker finalization case. The first test-type pass exposed stale fixtures from earlier runtime changes; narrow dependency repairs in those fixtures brought the second pass to green. Tests used dedicated PostgreSQL 17 / Redis 7 Alpine containers, one CPU each, 512/128 MiB memory limits, temporary filesystem data, a private inner network and no published ports; all owned resources were removed and their absence verified. Observed memory samples were PostgreSQL 90.56-335.4 MiB, Redis 5.637-8.059 MiB, and Linux available memory 6,685,724 kB before validation / 5,923,156 kB after the focused tests; these are samples, not peaks. Hosted tuning, sequencing and publication remain unvalidated in this slice.

The independent review and supervisor final pass are clear after one compensation-race correction. A fresh transaction now waits for the original START lock before a separate READ COMMITTED absence lookup; unresolved verification retains the charge. A real delayed-commit regression observes the blocked verifier, commits the original atomic parent/child transaction late, and confirms no refund or duplicate launch. The correction passed eight affected parent cases, API source types, focused test types, touched-file Biome and whitespace checks (2026-10-11 19:00:42-19:01:07 UTC); unchanged ordinary checks were not repeated. Cumulative slice A coverage is 78 lifecycle cases, including eight new parent cases, and 114 targeted tests overall. Dedicated temporary stores/network were removed and verified absent again. Memory readings remained samples, not peaks. This completes the acceptance foundation only; runtime sequencing, cleanup, publication and hosted evidence remain pending.

### Parent runtime foundation - partial B1 implementation

B1 adds one-stage reconciliation using the frozen child identities, the shared maintenance authority and the START advisory lock. Normal finalization supplies a nullable business-settlement certificate in the same fenced transaction as its immutable summary; synthetic failure and reset writers never certify a child. A certified failed business result can advance. Existing starting-run reconciliation continues to own boot replay and undispatched-run failure. Each child copies the canonical parent acceptance time for its displayed and enforced cleanup deadline. Manual reset and the parent deadline close a settled stage gap without purging its certified child.

Uncertified failed children retain parent ownership until exact required cleanup succeeds; their original failure and immutable history remain intact. Open parents also block idle stop and history deletion. Comparison retention treats all actually created children as one group under the existing age and latest-run rules: every external cleanup must finish before one transaction deletes their durable history and parent. A missing expected child or summary preserves the group as unavailable. Single-child history or generated-run deletion refuses comparison membership. No public routes, publication, UI, hosted validation or end-to-end completion claim is included in B1.

B1 local validation passed with serial production type checks and workspace test types; the final comparison test fixture changes also passed a focused test-type check. The focused units passed 8 projection/idle cases and 5 migration cases including schema drift. All 9 comparison runtime cases passed across focused reruns. The complete affected lifecycle, finalization, history and maintenance files passed 182 tests. The comparison cases use real PostgreSQL/Redis, a pool of one for the application database and a separate pool-of-one reset fence, real normal finalization and exact durable purge; runner dispatch and queue maintenance are mocked ports. Existing maintenance regressions exercise the reused late-work/reset fences. These checks establish local workflow behavior, not hosted mode performance or end-to-end publication.

Validation initially exposed a non-discriminated retention result type, test fixture typing/start-timestamp mistakes, and a real timestamp-encoding error in both new SQL deadline expressions. Corrections preserved the existing positive latest-run retention setting and automatic-reset attribution. The validation used dedicated PostgreSQL 17 / Redis 7 Alpine containers with one CPU each, 512/128 MiB limits, temporary filesystem data and no published ports; owned containers/network were removed and absence verified after failed and successful attempts. Sampled PostgreSQL memory was 68-401.9 MiB and Redis 5.051-6.555 MiB in the final infrastructure run; Linux available memory was 6,705,316 kB at initial preflight and 5,976,548 kB after the affected regression files. These are samples, not peaks. Routes, control composition, public contracts and publication remain for B2; no hosted readiness claim is made.

Independent B1 review identified one reachable ownership-release bug: a reset could successfully retry an older run's dashboard projection without cleaning the newly admitted comparison child. The wrapper now requires that exact child's durable cleanup marker before releasing parent ownership after inner reset success or failure. The existing certified-stage-gap behavior and ordinary projection-retry admission rule remain intact. Two real-service regressions cover manual reset and the parent deadline: the old projection retry leaves the active, unmarked child owned by a cleanup-pending parent; the following exact cleanup releases it only after its durable marker, preserving the earlier immutable summary.

Correction validation passed API production types, focused lifecycle test types, touched-file Biome, all 9 comparison runtime cases, the two new regressions plus the existing ordinary projection-retry regression, and the 49-case maintenance file. Unchanged workspace checks and other regression files were not repeated. The bounded job ran from 2026-10-11 19:28:51 to 19:29:56 UTC with the same heap, worker and dedicated temporary-store limits; its containers and network were removed and verified absent. Observed samples were PostgreSQL 67.85-118 MiB, Redis 4.656-5.402 MiB, and Linux available memory 6,654,652 kB at preflight / 6,344,528 kB before the maintenance file; these are samples, not peaks. This remains a local partial-runtime result, with public composition and hosted evidence pending.

The independent review confirmed the correction on the second implementation attempt with no surviving findings. The supervisor then read the complete relevant 20-file change and its surrounding ownership boundaries; the final checklist is clear. No additional code changed after the reported green checks.
