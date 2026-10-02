---
name: process-backlog
description: Process backlog task documents sequentially with a chosen Codex implementation skill, using a fresh subagent per task and committing each staged result before continuing.
---

# Process a backlog with Codex subagents

Act as the backlog manager: resolve and order tasks, delegate, commit, and report. The selected implementation skill owns implementation, review, validation, and staging. Do not duplicate its work. Record start and finish times.

## Resolve inputs and check preconditions

- Resolve the implementation skill and task selection from the user's request. Example: `$process-backlog use orchestrate-kilo for tasks 5 to 8 in working_docs/backlog/`.
- Resolve the skill through the available skills catalog or an explicitly supplied `SKILL.md` path. Read it to confirm that it can implement, validate, and stage without committing. Stop if the skill is missing, ambiguous, or incompatible. Do not copy its implementation workflow into this skill.
- Resolve the tasks to existing documents: a directory excluding README/index files, an explicit list, or a numbered range. Keep explicit user order; otherwise read the backlog README/index and follow its dependencies and priorities, then task number. Stop on unresolved dependencies or ambiguous selections instead of silently skipping tasks. Announce the ordered list and a one-line rationale, then proceed.
- Resolve the target checkout to an absolute path. Every worker, subprocess, and Git command must use that checkout explicitly, including when the inherited working directory points elsewhere. Do not switch branches, create worktrees, push, or merge unless requested.
- Confirm the index is empty with `git diff --cached --quiet` (exit 0). Exit 1 means pre-existing staging: stop without changing it. Other exit codes are errors. Record HEAD and the initial working-tree status. Unstaged and untracked user changes must be preserved, including unrelated hunks in files a task touches.
- Check that native delegation and the selected skill's required tools are available. Nested orchestration needs child agents able to delegate too; stop and report unavailable capabilities rather than silently changing models or workflows.
- Create a unique scratch directory under `.tmp/process-backlog/` in the target checkout, using timestamp plus a unique suffix, and one numbered subdirectory per task. Verify scratch is Git-ignored; if it is not, stop without editing ignore rules. Keep reports and commit-message files there.

## Delegate one task at a time

Create one fresh Codex subagent per task. Explicitly delegate it with model `gpt-6-astra` and reasoning effort `medium`. In a harness exposing `agents.spawn_agent`, use `fork_turns: "none"` and a self-contained briefing. If the available delegation mechanism cannot accept or honor the requested model and reasoning effort, stop and report the unavailable capability rather than silently substituting another configuration.

Brief the task agent with:

> Work only in `<absolute checkout>`. Read `<absolute task document>` and follow the implementation skill at `<absolute SKILL.md>`, including its referenced resources. Read the checkout's applicable AGENTS.md and docs/quality_checklists.md. Your role is the task orchestrator described by that skill, even though you are a subagent of the backlog manager. You may delegate implementation and review as the skill directs.
>
> User constraints and acceptance criteria: `<include the relevant user request, task ordering context, validation scope, and initial unrelated changes>`.
>
> Use `<absolute task scratch directory>` for all scratch output. Preserve unrelated files and hunks. Stage only this task's changes; never commit, reset, stash, clean, switch branches, push, or merge. If user changes cannot be separated safely, return HANDOFF.
>
> Wait for all your workers and subprocesses to actually finish before reporting. A report file appearing is not proof that its process exited. Use the shell runner's session waits and native agent completion tools, with waits no longer than 60 seconds per call; continue waiting within your turn. Stop further writers before returning HANDOFF, and report any worker that could not be stopped. Report unavailable tools or models rather than silently substituting them.
>
> Perform the selected skill's final review and validation requirements. Update the task document's status and completion notes when successful. Write your final report to `<absolute task scratch directory>/result.md` and return the same report as your final message:
>
> ```text
> STATUS: LANDED | HANDOFF
> RUNG: <successful rung, or n/a if the skill has no ladder>
> DURATION: <elapsed time>
> VALIDATION: <commands and outcomes, including explicit skips or blockers>
> FOLLOW-UPS: <noted follow-ups, or none>
> COMMIT MESSAGE:
> <the selected skill's conventional commit message, verbatim; omit on HANDOFF>
> HANDOFF: <reason, current state, surviving issues and remaining workers; only on HANDOFF>
> ```

Retain the returned agent identifier. Wait for its completion, then read its report. If it ends without a final STATUS report, resume that same agent once to finish waiting and produce the report. In this harness use `agents.followup_task`; `agents.send_message` alone does not restart an idle agent. A repeated missing or malformed report stops the backlog.

Keep only one task active. Respect concurrency and nesting limits; close retired agents when the harness supports it, after their workers have finished. If capacity is exhausted, stop with the remaining task list rather than taking over implementation.

## Commit or stop

- **LANDED:** Require an unambiguous successful validation report and a nonempty commit message. Explicitly justified inapplicable checks are acceptable; failed required checks are not. Confirm no workers remain active and HEAD still equals the recorded value. Require a nonempty index (`git diff --cached --quiet` exits 1); an empty index is a protocol error, not a successful task.
- Commit exactly the staged result with `git commit -F <message file>`, writing the message as literal text through a file API or safely quoted heredoc. Never run `git add` in the manager. Do not read the diff, rerun checks, or redo the task agent's triage: the selected skill owns those steps.
- On successful commit, record its hash and confirm the index is empty before proceeding. Stop on commit failure or unexpected remaining staging; do not retry with hooks disabled or modify the index to repair it.
- **HANDOFF, unexpected HEAD changes, or any protocol/tool error:** Stop the loop. Do not commit, clear the index, revert changes, or start another task. Report what happened and preserve the checkout for inspection. If workers remain active, request their termination and confirm the outcome before handing back.

## Recap

Report total elapsed time and a table with task, status, commit hash (or `-`), rung, duration, and follow-ups. If stopped, include the handoff or error report and the unprocessed tasks. State that commits are local; never imply they were pushed.
