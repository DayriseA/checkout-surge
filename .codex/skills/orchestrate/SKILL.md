---
name: orchestrate
description: Orchestrate delegated implementation and review cycles with native Codex subagents, escalating when fixes stall. Use for an implement/review loop with the main agent arbitrating findings.
---

# Implementation and native Codex review

Delegate implementation and review, triage and arbitrate findings yourself, and escalate only when the current implementer exhausts its cycle budget. Record start and end times for the final recap.

## Roles and ownership

- **You (main agent):** — orchestrator and arbiter. You brief the implementer and the reviewer, triage the reviewer's findings (you have the warm context to judge what's real), fix trivialities directly, and decide when it's done. You do **not** review the diff yourself during the cycles — your own review happens once, at the very end (see Final pass). If hesitating between "one more polish cycle" and "good enough, note the caveat and finish", choose the latter.
- **Implementer:** — a native Codex subagent that writes the code and documentation. Before reporting back it must run the project's tests, type checks, linter and formatter, and report their actual output or a concise faithful summary of it.
- **Reviewer:** a read-only native Codex subagent using `gpt-6.1-sol` with `xhigh` reasoning. Reviews the working tree after each implementer report: the full relevant diff plus surrounding code and tests, checked against the original request. It writes code nowhere and its findings are input to your triage, not orders.

The reviewer's read-only role is an instruction, not a separate sandbox guarantee: native agents inherit the harness permissions unless the exposed tool explicitly offers isolation. Do not claim sandbox-enforced read-only access.

Record the initial working-tree and staging state. All workers operate on the same checkout; keep one writer active at a time and wait for implementation to finish before reviewing. Preserve unrelated user changes. Subagents do not share your context, so brief them explicitely.

## Escalation ladder

| Rung | Execution | Model | Reasoning | Implementation attempts |
| --- | --- | --- | --- | --- |
| 1 | Native Codex subagent | `gpt-6-luna` | `high` | 1 |
| 2 | Native Codex subagent | `gpt-6.1-sol` | `medium` | 2 |
| 3 | Native Codex subagent | `gpt-6.1-sol` | `high` | 2 |
| 4 | Native Codex subagent | `gpt-6-astra` | `medium` | 2 |
| 5 | Native Codex subagent | `gpt-6-astra` | `xhigh` | 2 |

An attempt is one implementation turn followed by review. The first attempt includes initial implementation.
When rotating rungs, start a **fresh** implementer session (no resume) and give it the full briefing **plus** the surviving findings, what was already tried against them, and why it didn't land — enough that it won't repeat the dead ends. If issues still remain after the last rung, stop and write a concise handoff report: current state, surviving findings by severity, what each implementer tried, and what a human should look at first.
Report unavailable tools or models; never silently substitute models.

## Native Codex delegation

Use the subagent lifecycle exposed by the current harness for Codex work: create an agent, retain its returned identifier, send follow-up work to that same agent, and receive its completion report.

In a harness exposing `agents.spawn_agent`, set the rung's `model` and `reasoning_effort`; use `fork_turns: "none"` for an explicit model override and supply a self-contained briefing. Use `agents.followup_task` to start another turn on an idle agent; `agents.send_message` alone does not restart it. Use native completion notifications and waits to receive reports. Adapt to the actual exposed tool schema rather than inventing parameters.

Respect the harness concurrency limit and release retired agents if supported.

## Implement / review cycle

1. Launch the implementer with the current ladder configuration (start at rung 1). Brief it fully: the task, relevant files and paths, constraints, project conventions (point it at `AGENTS.md` and `docs/quality_checklists.md`), acceptance criteria, and the test/typecheck/lint commands. On later cycles with the same implementer, resume its session and just relay the surviving findings — it still holds the original briefing.

2. When it reports back, launch the reviewer, briefed with the original task, acceptance criteria, constraints, and where the relevant changes live. Its job: look for bugs, missed or misread requirements, regressions, and missing or vacuous tests. Tell it to focus on what's *wrong*, not what could be *better* — style preferences, speculative edge cases, and optional refactors are out of scope for this workflow unless they hide a real bug. On later cycles, resume its session and relay what changed since its last pass, plus your triage decisions on its previous findings and the rationale — so it doesn't re-litigate what you already ruled on.

3. Triage and arbitrate the reviewer's report yourself — a reviewer will almost always find *something*, and you decide what counts. Sort each finding:
   - **Trivial** (typo, stray comment, one-line doc fix): fix it yourself directly instead of spending a cycle on it.
   - **Real problem** (bug, missed requirement, broken or missing test, docs drift): relay it to the implementer, stating explicitly what was missed, and go back to step 2.
   - **Nice-to-have**: note it for the final summary; do not cycle on it.

4. Stop cycling when a reviewer pass leaves the "real problem" bucket empty, then move to the final pass.

## Final pass and delivery

Only after the reviewer's findings have all been processed — real problems fixed and confirmed, the rest noted — do your own review, once: read the full relevant diff yourself and check it against the original request. This is a good-measure sanity check with warm context — don't rerun tests, type checks, or lint the subprocesses already reported green just before, and don't reopen settled findings.

- If you catch an actual bug or missed requirement, it goes back into the cycle (counting toward the ladder as usual, including a reviewer pass on the fix).
- Anything else you notice goes into the final summary as a noted follow-up.

## Finishing

Update any impacted documentation in docs/ so it doesn't drift from actual codebase reality. That include the task document itself too (status and completion notes). Stage the changes — do not commit. Report the final validation status, the overall orchestration time and which rung landed the work, list the noted follow-ups if any, then give me a concise conventional commit message. The first line should give clarity at a glance; the bullets document the meaningful changes without becoming a full changelog.

N.B. Don't rerun the tests/typecheck/lint the subprocesses already ran — they share your environment. Rerun only if the reported output is missing, ambiguous, or stale, or files changed after it ran.
