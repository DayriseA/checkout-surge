# 14 — Clean-Run Generator Warnings

**Design:** section 4.3 (missing evidence is unavailable, never zero) · **Depends on:** 03

## Goal

A clean run shows no generator warnings, locally or on Fly. Warnings stay reserved for real evidence gaps.

## Context

Found in task 02 (see its Working Notes) and confirmed on a clean local run by a cloud agent on 2026-10-03:

- **k6 counters.** On a run with no incident, `transportFailures`, `unexpectedResponses`, `droppedIterations` and `soldOutResponses` have no source (unavailable), and the run stores `k6_outcome_counter_summary_export_unavailable`. This predates the hosted work and happens locally too. Likely cause, unverified: k6 omits from its summary export a counter that was never incremented.
- **Platform probes.** On Fly (cgroup v1), the memory `high` event counter has no equivalent, so every hosted run reports it as unavailable. Other probes can be absent on some local hosts too (separate `cpu` and `cpuacct` mounts were seen on a cloud runner).

## Scope

- **Confirm the k6 cause** before changing anything: how k6 exports a declared counter with zero samples, and whether the export itself is present on a clean run.
- **k6 counters:** when the summary export exists and a counter is absent from it, count zero. When the export itself is missing, keep the counters unavailable. This must stay consistent with the unknown-versus-zero semantics delivered by task 03.
- **Platform probes:** a probe the platform does not provide is reported as not applicable, not as a generator warning. A probe that should exist but fails stays a warning.
- **Web:** the run report reflects these states without alarming wording on a clean run.

## Out of Scope

- New probes or metrics.

## Done When

- A clean `surge-10k` run on Fly and a clean local run both show zero generator warnings.
- A run whose k6 summary export is really missing still reports unavailable counters.
- Tests cover both cases at the parser and diagnostics boundaries.

## Open Points

- None.

## Working Notes

_None yet._
