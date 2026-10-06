# 13b — Documentation and Continuous Deployment

**Design:** sections 7.2, 8, 9 · **Depends on:** 01–12, 14

## Goal

`docs/` describes the hosted runtime and how to operate it, and GitHub Actions deploys with the same script as the workstation.

## Scope

- **Documentation.** `working_docs/` is deleted once the hosted deployment is done, so everything still true in `design.md` that a reader or an operator needs moves into `docs/`.
  - Propose the file layout to the owner before writing.
  - Update the hosted-deployment boundary in `docs/runtime_topology.md` and the caveats in `docs/decisions/scope_and_caveats.md`, which still lists hosted deployment as a non-goal.
  - `docs/decisions/hosted_deployment.md` keeps the decisions; the new documentation describes behavior and links to entries instead of restating them.
  - Sizes and caps are being measured in 13a: point to where they are configured rather than quoting values. Leave the slow-stop point to 13a.
- **Operator notes,** including:
  - the manual core resize;
  - admin writes through `fly proxy 8080` from `localhost` are refused, because the core's web origin is the gate's public URL (operators use the gate, or call the API with the control token);
  - the token and secret rotation procedure (design 7.2);
  - freeing a lease left by a killed deploy, removing a `recreate` mark set by mistake, the runner recreate route;
  - the guard's logs (`component: guard`) as the only signal of a failed guard run.
- **GitHub Actions** (owner decision, 2026-10-06): deploy automatically on every push to `main`, calling `infra/fly/deploy.mjs all`.
  - No `--force`: the script waits for the core to sleep.
  - One deploy at a time; a queued deploy waits and is never cancelled mid-run, since a killed deploy leaves its lease until the TTL.
  - The Fly token is a repository secret that the owner creates and stores. Find the least-privileged token type that covers the three apps and the remote builder, and give the owner the exact commands.
  - Third-party actions are pinned by commit SHA.
  - The workflow is first exercised end to end in 13c.

## Out of Scope

- Measurement and tuning (13a), secret rotation and opening (13c), bot review (13d).

## Done When

- `docs/` describes the hosted runtime and its operation, with no reference to `working_docs/`.
- The workflow is committed, and the owner has the commands to create and store its token.

## Open Points

- None.

## Working Notes

_None yet._
