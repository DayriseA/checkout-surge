---
name: orchestrate-kilo
description: Orchestrate a delegated implement/review loop where the first implementer rung runs on Kilo Code CLI (`kilo run`, cheap fast model) and later rungs plus the reviewer run on `codex exec` - brief an implementer and a reviewer, triage findings, escalate when the loop stalls.
allowed-tools: Bash(kilo *) Bash(codex *)
---

# Delegated implement/review loop (kilo run + codex exec)

It seems you have a good sense of what needs to be done. So organize this efficiently: delegate the implementation, delegate the review, triage and arbitrate the findings yourself, and escalate only when the loop stalls. Take note of the time at the start and the end of this orchestration so you can give the overall time in the finishing recap.

This is the cost/speed-optimized variant of `orchestrate`: the first implementer rung runs on a fast, cheap model through Kilo Code CLI; if it fails to land the work, the proven codex ladder takes over. The reviewer is always codex.

## Roles

- **You (main thread)** — orchestrator and arbiter. You brief the implementer and the reviewer, triage the reviewer's findings (you have the warm context to judge what's real), fix trivialities directly, and decide when it's done. You do **not** review the diff yourself during the cycles — your own review happens once, at the very end (see Final pass). If hesitating between "one more polish cycle" and "good enough, note the caveat and finish", choose the latter.
- **Implementer** — a subprocess that writes the code and documentation: `kilo run` on rung 1, `codex exec` on later rungs. Before reporting back it must run the project's tests, type checks, linter and formatter, and report their actual output or a concise faithful summary of it.
- **Reviewer** — a sandbox-enforced read-only `codex exec` subprocess, model `gpt-6-astra`, reasoning effort `high`. Reviews the working tree after each implementer report: the full relevant diff plus surrounding code and tests, checked against the original request. It writes code nowhere and its findings are input to your triage, not orders.

Subprocesses share the same host but **not** your context — brief them explicitly.

## Escalation ladder

For cost management you start with the cheap rung, escalating to a fresh implementer only when the current one fails to land the fixes within its cycle budget:

| Rung | Tool | Model | Effort | Cycles |
| ---- | ------------ | ------------------------------ | ---------------- | ------ |
| 1 | `kilo run` | `zai-coding-plan/glm-5.3-flash` | `--variant high` | 2 |
| 2 | `codex exec` | `gpt-6-sol` | `high` | 2 |
| 3 | `codex exec` | `gpt-6-astra` | `low` | 2 |
| 4 | native subagent | `claude-opus-5-5` | `medium` | 2 |
| 5 | `codex exec` | `gpt-6-astra` | `high` | 1 |

When rotating rungs, start a **fresh** implementer session (no resume) and give it the full briefing **plus** the surviving findings, what was already tried against them, and why it didn't land — enough that it won't repeat the dead ends. Kilo and codex sessions are separate worlds: a codex rung can never resume a kilo session, so the rung 2 briefing must be self-contained. If issues still remain after the last rung, stop and write a concise handoff report: current state, surviving findings by severity, what each implementer tried, and what a human should look at first.

## Command templates

Use the session scratchpad directory (`$SCRATCH`) for all output files. Both `kilo run` and `codex exec` are synchronous; launch them as background Bash commands (they can exceed the foreground timeout) and act when they complete. Always redirect stdin from `/dev/null` — without it, `codex exec` blocks forever on "Reading additional input from stdin..." when run in the background, and the same guard costs nothing for kilo.

### Implementer, rung 1 (kilo run)

Kilo has no `-o` report-file option, so the briefing itself must end with: *"When you are done, write your final report to `$SCRATCH/impl-cycle-N.txt` and make it your last action."* The raw JSON event stream goes to a `.jsonl` log; the `sessionID` field of its first line is the session ID.

**First cycle** (fresh session):

```bash
kilo run --auto -m <rung model> --variant high --format json \
  --title "impl-rung-1-cycle-N" \
  "<full briefing, ending with the report-file instruction>" \
  > "$SCRATCH/impl-cycle-N.jsonl" 2>&1 < /dev/null
```

Extract and store the session ID:

```bash
grep -o -m1 '"sessionID":"[^"]*"' "$SCRATCH/impl-cycle-N.jsonl"
```

(Fallback if the log is unusable: `kilo session list --format json --search "impl-rung-1-cycle-N"`.)

**Follow-up cycle, same rung** (resumed session, it still holds the original briefing):

```bash
kilo run --auto -s "<IMPL_SESSION_ID>" -m <rung model> --variant high --format json \
  "<surviving findings, ending with the new report-file path>" \
  > "$SCRATCH/impl-cycle-N.jsonl" 2>&1 < /dev/null
```

Never use `--continue` (`-c`): it resumes the most recent session, which is the wrong one whenever sessions interleave. Explicit session IDs only.

Reading the result: read the report file. If it is missing or truncated, the last `"type":"text"` event of the `.jsonl` log is the model's final message. Exit code `0` means the run completed; a non-zero exit with a permission diagnostic in the log means a `deny` rule in `~/.config/kilo/kilo.jsonc` blocked it (`--auto` only auto-approves what isn't explicitly denied).

### Implementer, rungs 2+ (codex exec)

**First cycle of a rung** (fresh session):

```bash
codex exec --yolo -m <rung model> -c model_reasoning_effort="<rung effort>" \
  --json \
  -o "$SCRATCH/impl-cycle-N.txt" \
  "<full briefing>" > "$SCRATCH/impl-cycle-N.jsonl" < /dev/null
```

After it finishes, extract the implementer's session ID from the top of the JSONL log — the session/thread-started event near the start carries it (look for `session_id`, falling back to `thread_id` if the schema differs). Store it; you need it for follow-up cycles on the same rung.

**Follow-up cycle, same rung** (resumed session, it still holds the original briefing):

```bash
codex exec resume "<IMPL_SESSION_ID>" \
  -m <rung model> -c model_reasoning_effort="<rung effort>" \
  -c approval_policy='"never"' -c sandbox_mode='"danger-full-access"' \
  -o "$SCRATCH/impl-cycle-N.txt" \
  "<surviving findings>" < /dev/null
```

Never use `resume --last`: implementer and reviewer sessions interleave, so "most recent" is often the wrong one. Explicit IDs only.

### Reviewer (codex exec, all cycles)

**First cycle** (fresh session):

```bash
codex exec -s read-only -m gpt-6-astra -c model_reasoning_effort="high" --json \
  -o "$SCRATCH/review-cycle-N.txt" \
  "<review briefing>" > "$SCRATCH/review-cycle-N.jsonl" < /dev/null
```

Extract and store the reviewer's session ID from its JSONL log the same way as the codex implementer's.

**Later cycles** (resumed session, it still holds the original briefing):

```bash
codex exec resume "<REVIEW_SESSION_ID>" \
  -c sandbox_mode='"read-only"' -m gpt-6-astra -c model_reasoning_effort="high" \
  -o "$SCRATCH/review-cycle-N.txt" \
  "<what changed + triage decisions>" < /dev/null
```

The reviewer session persists across the whole loop, including implementer rung rotations (kilo → codex included).

The codex `-o` file contains the subprocess's final report — read it from there rather than parsing stdout.

## Cycle

1. Launch the implementer with the current ladder configuration (start at rung 1). Brief it fully: the task, relevant files and paths, constraints, project conventions (point it at `AGENTS.md` and `docs/quality_checklists.md`), acceptance criteria, the test/typecheck/lint commands, and (on kilo) the report file path. On later cycles with the same implementer, resume its session and just relay the surviving findings (plus the new report path on kilo) — it still holds the original briefing.

2. When it reports back, launch the reviewer, briefed with the original task, acceptance criteria, constraints, and where the relevant changes live. Its job: look for bugs, missed or misread requirements, regressions, and missing or vacuous tests. Tell it to focus on what's *wrong*, not what could be *better* — style preferences, speculative edge cases, and optional refactors are out of scope for this workflow unless they hide a real bug. On later cycles, resume its session and relay what changed since its last pass, plus your triage decisions on its previous findings and the rationale — so it doesn't re-litigate what you already ruled on.

3. Triage and arbitrate the reviewer's report yourself — a reviewer will almost always find *something*, and you decide what counts. Sort each finding:
   - **Trivial** (typo, stray comment, one-line doc fix): fix it yourself directly instead of spending a cycle on it.
   - **Real problem** (bug, missed requirement, broken or missing test, docs drift): relay it to the implementer, stating explicitly what was missed, and go back to step 2.
   - **Nice-to-have**: note it for the final summary; do not cycle on it.

4. Stop cycling when a reviewer pass leaves the "real problem" bucket empty, then move to the final pass.

## Final pass (main thread, single)

Only after the reviewer's findings have all been processed — real problems fixed and confirmed, the rest noted — do your own review, once: read the full relevant diff yourself and check it against the original request. This is a good-measure sanity check with warm context — don't rerun tests, type checks, or lint the subprocesses already reported green just before, and don't reopen settled findings.

- If you catch an actual bug or missed requirement, it goes back into the cycle (counting toward the ladder as usual, including a reviewer pass on the fix).
- Anything else you notice goes into the final summary as a noted follow-up.

## Finishing

Update any impacted documentation in docs/ so it doesn't drift from actual codebase reality. That include the task document itself too (status and completion notes). Stage the changes — do not commit. Report the final validation status, the overall orchestration time and which rung landed the work, list the noted follow-ups if any, then give me a concise conventional commit message. The first line should give clarity at a glance; the bullets document the meaningful changes without becoming a full changelog.

N.B. Don't rerun the tests/typecheck/lint the subprocesses already ran — they share your environment. Rerun only if the reported output is missing, ambiguous, or stale, or files changed after it ran (the rung 1 cheap-model guard above is the one deliberate exception).
