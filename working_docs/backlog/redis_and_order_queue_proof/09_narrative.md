# 09 — Narrative and Decisions

**Design:** sections 1, 5 · **Depends on:** 08

## Goal

The demo's texts explain what each comparison shows and why, honestly, and the decisions are recorded.

## Scope

- The preset texts, the overview page, the README and the architecture docs.
- The overview's "known limits" section: remove what the project now shows, and keep what it still cannot show.
- Present any simulated constraint as a simulation.
- Decision log entries for the modes, the fairness rules and the topology, where they pass the inclusion test.

## Done When

- The owner has reviewed the texts.

## Open Points

- None.

## Working Notes

### Task 09A — Source-only production topology candidate

The deployment default now prepares the same physical topology as the proof for all runs: a performance 6-CPU/12 GiB core with one control authority and three buyers, private PostgreSQL/Redis on a performance 2-CPU/4 GiB stores Machine with the existing deployer's 6 GiB volume, a performance 16-CPU/32 GiB runner, and the existing gate/guard allocation. Both environments share routing, connection pools and pinned PostgreSQL, Redis and Caddy images. The candidate adds `checkout-surge-stores` to the production app tuple in `personal`; the normal CI `all` target uses that default. Explicit environment files remain restricted to proof apps in `playground-416`.

`proofEvidenceCapture` is an optional boolean, disabled when omitted or false. Only an explicit true value on a proof environment installs native k6 capture and the runner observer. Normal full-config deployments generated from fresh templates omit their environment key, observer file and init override, including the embedded runner/core recovery configurations. Production never enables capture. Measurement profiles must opt in explicitly; the retained old profiles and evidence are unchanged.

This change prepares source only. Production is unchanged, and creating the new production stores app/volume, staging its credentials and lifecycle tokens, deploying, and merging into `dev` or `main` still require the owner's final review. No production secrets were read or reused. Before that review, the completed proof must receive a normal full seven-image redeploy at a new SHA with capture disabled, then demonstrate ordinary functional flows unattended on the same hardware and routing. Measurement claims, final narrative and decision-log updates follow hosted validation in Task 09B. Legacy history and admin edits remain disposable under HD-05; no migration or restore framework is introduced.

Validation took place within 2026-10-11 20:25:31–20:26:58 UTC in the existing development container, serially with a 1536 MiB Node heap cap. Touched-code Biome formatting and check passed; both infrastructure test files passed 17 tests; gate configuration, stores lifecycle, core wake/recovery and guard tests passed 71 tests across five files with one worker and file parallelism disabled; gate production type-check and the root test type-check passed. The initial Docker socket access was denied by the host sandbox; the same authorized command succeeded with escalation. There were no test failures or behavioral fixes during this validation batch, and no build or infrastructure startup was run.

The new cases cover the exact production tuple and rejection of mixed identities, proof isolation including the new production stores name, the retained three-app proof input, optional boolean capture validation, physical config parity with capture on/off, and production's unconditional capture exclusion. A fully mocked execution of the ordinary default `all` deploy checks seven image builds, the new 6 GiB stores volume, removal of the prior runner capture configuration, and matching capture-free live and embedded runner/core recovery configurations. All child processes and HTTP calls in that deploy test are replaced by mocks; no provider commands execute. Final self-review kept changes at configuration/composition boundaries, retained the existing deployment flow, and left final measurements, narrative claims and decision supersession pending hosted validation and owner review.

Independent review identified a newly reachable same-commit capture transition: the runner's existing subset comparison could ignore removed capture keys and leave measurement instrumentation installed. The skip-update check now also compares capture-key presence; the producer installs native capture, the observer file and init override together, and full-config replacement removes them together. The mocked CLI cases exercise explicit false and omission at the same image/version, including both recovery layers. This preserves HD-24's full-config removal guarantee without introducing a generic config-diff mechanism. The separate provider rejection of the old pinned image reference syntax is recorded as an operational preflight failure in Task 04, not as workload evidence.

Attempt 2 validation ran within 20:37:36–20:38:02 UTC, again serially in the existing development container with a 1536 MiB Node heap cap. Biome formatting/check passed for the four changed JavaScript files, and both infrastructure test files passed 19/19 cases, including both same-SHA capture-removal regressions. No test failures occurred. Gate TypeScript source/tests were unchanged, so their previously passing types and 71 tests were not repeated. All three base image references now use the fully qualified `registry-1.docker.io/library/<image>@sha256:<digest>` shape with the original exact digests; provider validation status is recorded separately in Task 04. Self-review retained the narrow configuration/deployer boundary and introduced no generic diff, tag fallback, restore framework, production action or protected-branch mutation.

Independent full review and its narrow correction review are clear. The supervisor's final pass covered the complete ten-file change and surrounding deployment/configuration paths. This completes source preparation only; hosted validation, final narrative and owner rollout review remain pending.
