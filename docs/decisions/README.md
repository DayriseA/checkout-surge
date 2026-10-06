# Decision Records

This folder records choices that could otherwise look like mistakes, omissions or inconsistencies to a future audit or independent review, so reviewers do not re-raise them. Each entry records why: context, decision, consequences and accepted risks, rejected alternatives. It is not a description of how the system works, a runbook, a work log, or a measurement record.

## Two Layers

- **[Scope and Caveats](scope_and_caveats.md)** is the project-level layer: the accepted project boundary, intentional non-goals, current caveats, and deferred decisions.
- **Domain logs** hold the decisions of one domain, as numbered entries. A domain gets its own log only when it has its own arbitrations.

Domain documents in `docs/` keep explaining how things work, and their existing "Decisions & Rationale" sections stay where they are. New decisions go to the logs.

## Index

| Log | Prefix | Covers |
| :-- | :-- | :-- |
| [Hosted deployment](hosted_deployment.md) | `HD` | Platform and sizing, gate, core idle stop, core recovery, runner lifecycle, guard, deployment and CI, and hosted-triggered run-evidence rules |

## What Does Not Belong Here, and Where It Goes

| Content | Where it goes |
| :-- | :-- |
| How something behaves, step by step | The domain document (for example [Hosted Runtime](../hosted_runtime.md)) |
| Commands, flags, what to do when something fails | The runbook ([Hosted Operations](../hosted_operations.md)) |
| Measurements, timings, costs, run results | [Reference Runtime Measurements](../reference_runtime_measurements.md). An entry may quote the one figure its trade-off rests on. |
| Configuration values (sizes, limits, timeouts, intervals, regions) | Code or config. An entry names the setting, never its value. |
| Project boundary, non-goals, user-facing caveats | [Scope and Caveats](scope_and_caveats.md) |
| Why one specific line looks odd | A comment beside that line, when the file can hold one |
| Task status, plans, follow-ups, pending actions, who decided when | The backlog, or nowhere |

## Entry Format

```markdown
### HD-07 Short title

- **Status:** accepted
- **Date:** YYYY-MM-DD
- **Context:** the problem or the finding, in one or two sentences.
- **Decision:** what was decided.
- **Consequences:** accepted risks, limits and costs.
- **Rejected alternatives:** each option with a one-line reason (when relevant).
- **Code:** paths or symbols where the decision lives (when relevant).
```

- **Inclusion test.** An entry earns its place only if, without it, someone could reasonably change the behavior believing it an improvement, without knowing why it was chosen. If a code comment would prevent the change just as well, write the comment instead.
- **Title.** It states the choice, ideally what the choice rules out; never a measured fact or a value.
- **Context** is one or two sentences. **Consequences** are accepted risks, limits and costs, not mechanics.
- **Why, not how.** Entries record the trade-off, the rejected alternatives and the accepted risks, not how the system works. They never copy configuration values, constants, ports, paths or URLs that live in code or config.
- **Shared rules.** A rule shared by several entries is stated once and linked from the others.
- **Self-contained.** Write the context inline. No task numbers, working files, checkpoints, review sessions, attribution, roadmap or pending actions.
- **Stable IDs.** IDs are never renumbered or reused.
- **Index.** Each log starts with an ID-ordered index; a new entry is added to it too.
- **Citing from code.** Code cites entries as `Accepted risk HD-NN (docs/decisions/<log>.md)`.
- Keep entries short. Details of how something works belong in the domain documents.

## Statuses

- `accepted`: the decision stands.
- `superseded by HD-NN`: a later entry replaced it.
- `withdrawn`: the content moved elsewhere. The body becomes one line, "Withdrawn: moved to <link>". Used only when something cites the ID.

To change a decision, add a new entry and set the old entry's status to `superseded by <new ID>`. Editorial trims that remove out-of-scope content without changing the decision are made in place, as are fixes to a stale path or symbol. Never change a heading: docs link to its anchor.

## For Reviewers

Before reporting a finding, check these records. An accepted entry is re-raised only with new evidence: changed code, a newly reachable scenario, or new facts. A finding that re-raises an entry cites its ID and states the new evidence.
