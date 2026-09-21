# Adaptive ERP — Carried-over follow-ups awaiting a decision

Optional items surfaced while tasks 03 to 11 and 17c were implemented. None of them blocks a later task, and none is scheduled: each one is a judgement call for the project owner to action or reject.

This file is intentionally not named `xx_*.md`, so the sequential task runner never treats it as an implementation task.

Deferred work that a later task genuinely needs was **not** recorded here. It was written into the destination task documents instead: the stranded recovery-attempt ceiling, the hardcoded `escalated` counter and the inert queue parameters are in [14](14_retire_scenario_engine_controls.md); the idle-window rate step is in [20](20_calibrate_policy_and_obtain_approval.md).

## 1. Stored terminal results are preserved semantically, not byte for byte

- Origin: task 03, mock ERP ledger.
- Observation: `erp_confirmation_ledger.terminal_result` is a `jsonb` column, so PostgreSQL normalizes key order and whitespace. A replayed body is therefore equal as a value, not as a byte string. The completion notes of [03](03_persist_mock_erp_ledger_and_status_lookup.md) describe the restart coverage as verifying "byte-identical lookup/replay", which is accurate only because both sides are serialized from the parsed row.
- Decision: leave it as is, or store the canonical body as `text` if any future consumer ever compares raw bytes or a signature. Nothing in the current codebase does.

## 2. The task 06 pruning fix has no dedicated test

- Origin: task 06, bounded attempt history.
- Observation: after the final review pass, the orchestrator added a one-line change that prunes orphaned call rows inside `recordDispatchIntent`, so a crash loop that never persists an outcome stays bounded. The reviewer did not re-examine it, and no test targets that specific path. The surrounding orphan-pruning behavior is covered by the retention integration test.
- Decision: accept the existing indirect coverage, or add a focused test that drives repeated dispatch intents without outcomes and asserts the per-order bound holds.

## 3. Preset duplication rejects an out-of-ceiling source with a raw Zod error

- Origin: task 08, bounded request deadlines.
- Observation: `duplicatePreset` and the copy-to-custom path now parse the source preset against the 5000 ms deployment ceiling. A stored preset above that ceiling is rejected with a Zod parse error rather than a domain-specific one, so the message is not written for an operator. The rejection itself is correct and intended.
- Related deployment note: a run accepted before this ceiling existed, with an ERP latency above 5000 ms, would have its confirmation requests rejected by the mock ERP. This only affects runs in flight at deploy time; history readers stay permissive.
- Decision: leave the raw error, or map it to an explicit domain error. Task [14](14_retire_scenario_engine_controls.md) already touches preset schemas and their consumers, so it is the natural place if this is actioned.

## 4. Repeated status-lookup failures are not treated as outage evidence

- Origin: task 04, ERP classification and reconciliation.
- Observation: a failing status lookup neither opens nor closes the availability circuit. This follows task 04's rules — only a fresh non-replayed confirmation teaches health — and it deliberately keeps reconciliation progressing during an outage. What is undecided is whether *repeated* lookup failures should themselves count as evidence that the ERP is unavailable.
- Decision: keep lookups non-teaching, or let sustained lookup failure contribute to the circuit. This changes learning semantics rather than a constant, so it is a structural decision and would need explicit approval before task [20](20_calibrate_policy_and_obtain_approval.md) calibrates against it.

## 5. A corrupt accepted run snapshot still blocks notification publication

- Origin: task 11, terminal technical failures.
- Observation: `apps/worker/src/queue/bullmq-notification-record-publisher.ts` publishes generated-run notifications through the publication fence, which parses the accepted run snapshot before enqueueing. Task 11 made a missing or invalid snapshot fail the affected order instead of parking it, and lets an earlier uncertain call found `succeeded` by lookup confirm the order. That confirmed order then cannot publish its notification, notification recovery meets the same failure on every pass, and the run stays `draining` because settlement requires one notification per confirmed order. The behavior predates task 11 and also affects any order confirmed before the snapshot became unreadable. Reaching it requires a stored snapshot to become missing or corrupt mid-run, which no supported workflow does.
- Decision: accept it as an unreachable-in-practice corruption case, or let notification publication proceed without the parsed snapshot (it only needs the run's nonterminal status for the fence). Task [12](12_implement_destructive_admin_reset.md)'s destructive reset already gives an operator a way out of a stuck run.

## 6. The estimator reserves the full traffic budget and sums traffic and ERP time

- Origin: task 17c, estimator re-fit (user decision on 2026-09-21 to defer the estimate-ratio criterion to task 20).
- Observation: D11's envelope adds the whole declared traffic budget to the ERP drain time. Task 17b shows both assumptions are pessimistic: traffic and ERP work overlap (the incident finalized at 96.7 s against a 148.8 s sequential base), and a buyer spike stops when stock sells out (`surge-10k` traffic ended at 13 s of its 120 s budget). The over-estimate is largest on short runs, far below the 600-second ceiling, and only 1.74x on the incident, so admission decisions are not affected today; the visible cost is a pessimistic figure wherever the conservative estimate is displayed. Overlap alone would barely change the ratios; the constants that dominate them are handed to task [20](20_calibrate_policy_and_obtain_approval.md).
- Decision: keep D11's sequential envelope, or approve a structural change (overlap, or a sell-out-aware traffic term). An under-estimate admits a run that overstays the occupancy ceiling, while an over-estimate only costs accuracy, so any change must stay above every measurement. Altering D11 needs explicit approval before task 20 calibrates against it.
