---
name: process-backlog
description: Process a set of backlog task documents one after another - each task is delegated to a fresh subagent that runs a chosen implementation skill (orchestrate-kilo, orchestrate, ...) on it, then the main thread commits the staged result on the current branch and moves on to the next task.
arguments: [skill, tasks]
disable-model-invocation: true
allowed-tools: Bash(git *)
---

# Process a backlog with a delegated implementation skill

Implementation skill to use: `$skill`
Tasks to process: `$tasks`

You are the backlog manager, nothing more. You never implement, review or triage a task yourself: every task goes to a fresh subagent that runs `$skill` on it exactly as if you had invoked that skill directly. Your job is sequencing, committing and reporting. Note the time when you start and when you finish.

## 1. Resolve the inputs

- **Skill**: `$skill` must be one of the skills listed as available. If it is not, stop and say so.
- **Tasks**: resolve `$tasks` into a list of task document paths. It may be a directory (every task document in it, index/README files excluded), an explicit list of files, or a range such as "tasks 5 to 12 of `<dir>`". Every resolved path must exist.
- **Order**: if the user gave an explicit order, keep it. Otherwise decide the order yourself: read any README or index in the backlog directory and honour the priorities, suggested order and dependencies it documents; when it says nothing, order by priority then by task number. Announce the resolved list in its final order with a one-line rationale, then start without waiting for confirmation.
- **Output directory**: `.tmp/process-backlog/<YYYYMMDD-HHMM>/` at the repo root (git-ignored), with one subdirectory per task named after the task identifier. Create it now.

## 2. Preconditions

The git index must be empty (`git diff --cached --quiet` succeeds). Anything already staged would be swept into the first task's commit, so stop and report if it is not. Untracked files and unstaged modifications are fine and must be left alone.

## 3. Task loop

Process the tasks strictly one at a time. For each task:

1. Launch **one** `general-purpose` subagent with the Agent tool, in the background, briefed with the template below. Do not launch the next task before this subagent has reported back.
2. Wait for its completion notification, then read its report.
3. Act on the report status (section 4).

If a completion notification arrives without a STATUS report, the subagent ended its turn while a subprocess was still running: resume it once with "continue the loop and wait inside your turn, as briefed". Do not relaunch it.

Subagent brief template (fill the placeholders):

> Read the task described in `<task path>` to understand the subject and assess the work to be done, then invoke the Skill tool with skill=`<skill>`. It runs an implement/review loop through subprocesses and tells you how to brief them, triage findings and finish. Two adjustments to its instructions: use `<absolute output directory for this task>` as the scratchpad directory (`$SCRATCH`) for every output file. Second adjustment, because you run as a subagent: never end your turn while a kilo run or codex exec subprocess is still running. After launching it in the background as the skill describes, wait inside the same turn until its report file exists, using a foreground Bash polling loop with a timeout parameter close to 10 minutes, relaunched as many times as needed, or the Monitor tool with an until-condition on that file. End your turn only with the final STATUS report. Do not touch files unrelated to the task.
>
> When you are done, your final message must be only this report, nothing before it:
>
> ```
> STATUS: LANDED | HANDOFF
> RUNG: <rung that landed the work, or "none">
> DURATION: <overall orchestration time>
> VALIDATION: <one line: what was run and whether it was green>
> FOLLOW-UPS: <bullet list of noted follow-ups, or "none">
> COMMIT MESSAGE:
> <the conventional commit message the skill produced, verbatim>
> HANDOFF: <only when STATUS is HANDOFF: the skill's handoff report>
> ```

## 4. After each task

- **LANDED**: verify that the index is not empty (`git diff --cached --quiet` fails), then commit exactly what is staged with the commit message from the report, using `git commit -F <file>` with the message written to a file in the task's output directory. Never run `git add`: the subagent staged what belongs to the task and everything else in the working tree stays out of the commit. Record the commit hash, then confirm the index is empty again before starting the next task.
- **HANDOFF**: stop the loop. Leave the working tree and the index untouched so the human can inspect them, and report (section 5).
- **Anything else** (no report, malformed report, subagent error): stop the loop the same way and quote what you got.

Do not read the diff, rerun validation or second-guess the subagent's triage: the implementation skill already includes a reviewer and a final pass, and repeating them here defeats the delegation.

## 5. Final recap

Give the overall time, then one table with a row per task: task, status, commit hash (or "-"), rung, duration, follow-ups. If the loop stopped early, say on which task and why, paste the handoff report, and list the tasks left unprocessed.
