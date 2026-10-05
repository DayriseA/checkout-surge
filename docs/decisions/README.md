# Decision Records

This folder records settled decisions, accepted risks, known limitations, and arbitrated review findings, so that later reviews and audits do not reopen points that were already decided.

## Two Layers

- **[Scope and Caveats](scope_and_caveats.md)** is the project-level layer: the accepted project boundary, intentional non-goals, current caveats, and deferred decisions.
- **Domain logs** hold the decisions of one domain, as numbered entries. A domain gets its own log only when it has its own arbitrations.

Domain documents in `docs/` keep explaining how things work, and their existing "Decisions & Rationale" sections stay where they are. New decisions go to the logs.

## Index

| Log | Prefix | Covers |
| :-- | :-- | :-- |
| [Hosted deployment](hosted_deployment.md) | `HD` | The Fly.io deployment: topology, gate, runner lifecycle, core idle stop, deployment |

## Entry Format

```markdown
### HD-07 Short title

- **Status:** accepted
- **Date:** YYYY-MM-DD
- **Context:** the problem or the finding, in one or two lines.
- **Decision:** what was decided.
- **Consequences:** what follows, including accepted risks and limits.
- **Rejected alternatives:** each option with a one-line reason (when relevant).
- **Code:** paths or symbols where the decision lives (when relevant).
```

- An entry earns its place only if, without it, someone could reasonably change the behavior believing it an improvement, without knowing why it was chosen.
- Entries record the why (the trade-off, the rejected alternatives, the accepted risks), not how it works. They never copy configuration values, constants, ports, paths or URLs that live in code or config.
- IDs are stable: never renumbered or reused.
- Each entry is self-contained: write the context inline. Do not reference temporary working files, task numbers, or review sessions.
- Keep entries short. Details of how something works belong in the domain documents.

## Statuses

- `accepted`: the decision stands.
- `superseded by HD-NN`: a later entry replaced it.

To change a decision, add a new entry and set the old entry's status to `superseded by <new ID>`. Leave the old decision text as it was. Fixing a stale path or symbol in place is fine.

## For Reviewers

Before reporting a finding, check these records. An accepted entry is re-raised only with new evidence: changed code, a newly reachable scenario, or new facts. A finding that re-raises an entry cites its ID and states the new evidence.
