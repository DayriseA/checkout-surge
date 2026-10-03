# 08 — Deployment-Cap Message

**Design:** section 1.2 · **Depends on:** none

## Goal

A visitor who hits a hosting limit understands that it is a deliberate hosting choice, not an input mistake.

## Scope

- **API:** check that it refuses to start when the persisted public policy exceeds the deployment caps, and add the check if it is missing. Verified: `validateActivePolicyAtStartup` already refuses it; no change.
- **Web:** a message for run rejections with `deployment_*_exceeded` codes and with the public load-size codes (buyers, duration, max VUs, preallocated VUs, request rate, total requests, start delay); never for ERP limits, starting stock, or invalid input. It explains the hosting reason and invites the user to run the project locally or on larger infrastructure. On a rejected custom run, the form still flags the offending field and shows the message alongside. The custom run form also carries a fixed hint line with the same invitation. `*_exceeds_deployment_cap` codes are admin policy-edit rejections and keep the ordinary validation message.

## Out of Scope

- Choosing the cap values (task 13).

## Done When

- A deployment-cap rejection shows the hosting message.
- Invalid input never shows it.

## Open Points

- None.

## Working Notes

### Summary by package

- **Web:** Reuse the shared error presentation boundary for infrastructure-limit run rejections. Public preset starts, public custom starts, and admin run starts show the same English message. Tests cover all fourteen selected violation codes, ordinary validation exclusions, and browser start flows.
- **API:** No changes needed. The startup policy guard already refuses incompatible persisted public policy.
- **Contracts:** No changes to codes, validation rules, or cap values.

### Wording

Headline: "This run exceeds an infrastructure limit"

Message: "This limit was deliberately chosen for the infrastructure running this demo. For larger runs, run the project locally or deploy it on larger infrastructure."

### Where it appears and violation transport

The API's `validateAcceptedRunSnapshot` throws `invalid_run_configuration` with `details.violationCode`, `details.path`, and violation details for the first failed rule. Public and admin Next.js start proxies preserve the validated error envelope. `readProxyJson`/`readBackendResponse` retain its details. The shared `mapErrorPresentation` maps only that error with one of the seven `deployment_*_exceeded` run codes or the seven public load-size codes (buyers, duration, max VUs, preallocated VUs, request rate, total requests, start delay). Public custom runs bypass their existing field-validation interception only for these selected rejections. Public preset notices, custom operation notices, and admin start confirmation notices render the resulting presentation.

ERP TPS, latency, error rate, starting stock, invalid input, other rejections, and runtime-policy editing errors retain their existing presentation. The same wording applies to local and hosted infrastructure without assuming a hosting provider or promising unlimited local capacity.

### Startup check result

`PublicRuntimePolicyService.validateActivePolicyAtStartup()` calls `readEffectivePolicyRow()`, which parses the persisted mutable row and combines it with the current deployment hard caps through `publicRuntimePolicySchema`. The effective schema validates public limits and defaults against those caps. The guard throws on validation errors; `apps/api/src/index.ts` awaits it before `server.listen`. The existing `apps/api/test/public-runtime-policy-service.test.ts` startup test checks refusal with a current max-buyers cap of 9,999 against the persisted policy's 10,000 limit. All eight public runtime policy service tests, including that startup refusal test and missing-row diagnostics, passed in the full API suite. No missing guard was found, so no API change was made.

### Decisions to review

- Use a small explicit allowlist at the existing web presentation boundary. This avoids broad suffix matching and keeps policy-editing or ERP failures out of the message.
- Preserve existing transport, notices, protected diagnostics, and validation behavior. No new component or API response shape is needed.
- Keep the suggestion provider-neutral and accurate for both runtimes. Cap values and enforcement remain unchanged.
- The task Scope and design section 1.2 incorrectly identify `*_exceeds_deployment_cap` as run-rejection codes. Those codes belong to admin policy editing. The implemented run selection is `deployment_*_exceeded` plus the seven explicitly requested public load-size codes; the user's correction supersedes that claim.

### Questions for owner

None. No broader scope is required.

### Documentation impact

Future documentation changes only: correct the run-rejection code claim in task 08 Scope and design section 1.2; describe the infrastructure-limit UI message and selected public load-size rejections in `docs/admin_access_protection.md` when documentation updates are authorized. No documentation outside these Working Notes was changed.

### Validation

Commands run from the repository root with the project-pinned pnpm 10.33.2.

The environment's default pnpm 11.19.0 initially tried to auto-install dependencies and failed creating `/home/agent/.local/share/pnpm` before checks executed. The reversible workaround is `COREPACK_HOME=/tmp/cap-message-corepack corepack pnpm --version`, then a temporary `/tmp/cap-message-bin/pnpm` shim that invokes `corepack pnpm`. Each successful validation invocation is prefixed with `PATH=/tmp/cap-message-bin:$PATH COREPACK_HOME=/tmp/cap-message-corepack`. No repository dependency/configuration files were changed.

- `pnpm exec biome check --write apps/web/src/app/lib/presentation/error-presentation.ts apps/web/src/app/components/public-demo-entry.tsx apps/web/test/error-presentation.test.ts apps/web/test/browser-workflows.test.ts apps/web/test/admin-controller-state.test.tsx`: passed; five files checked, three formatted.
- `pnpm type-check`: passed; all 11 Turbo tasks and the root test typecheck completed successfully. Repeated after the final test-fixture correction and passed again (10 Turbo cache hits, web checked, root test typecheck checked).
- `pnpm test:unit`: first run failed in the existing API `demo-duration-estimator` seeded-fixture test, which timed out at its 5-second limit while typecheck ran concurrently; Turbo cancelled the web task. This is an observed timeout, not evidence of a pre-existing defect. The identical unit stage passed on retry inside `pnpm test` without concurrent typecheck: all 11 Turbo tasks succeeded, including API 259 tests and web 730 tests. The changed web test files passed (browser workflows 79, admin controller 86, initial error presentation 52). Self-review then removed an unreachable missing-code case and used producer-shaped ordinary-rejection fixtures; the final focused error presentation run passed all 51 tests.
- Final combined `pnpm exec biome check --write` invocation covering all six touched paths: passed; five supported code/test files checked, no fixes needed; Markdown ignored.
- `pnpm exec biome check --write working_docs/backlog/hosted_deployment/08_deployment_cap_message.md`: no files processed (exit 1), because Biome ignores Markdown. No lint rules were suppressed.
- Docker local socket check: passed, daemon version 28.4.0.
- `pnpm test:infra:up`: passed; isolated PostgreSQL and Redis are healthy.
- `pnpm --filter web exec vitest run --config vitest.config.ts test/error-presentation.test.ts`: passed, 51 tests after the test-only fixture correction.
- `pnpm test`: passed (exit 0). The unit stage passed all 11 Turbo tasks; API passed 20 files / 334 tests including all eight runtime policy service tests; integration passed 17 files / 192 tests (DB 82, Mock ERP 7, worker 103), all six Turbo tasks.
- `test:composition` and `test:characterization`: not run, as requested.

### Integration (2026-10-03)

Follow-ups applied when merging into `dev`:

- The web allowlist of infrastructure-limit codes is typed with `PublicRuntimePolicyViolationCode`, so a renamed contract code breaks compilation.
- A custom run rejected with an infrastructure-limit code again flags the offending field, and the summary also shows the hosting notice. The notice comes from the same `mapErrorPresentation` mapping.
- The custom run form shows a fixed hint line: "These limits were chosen for the infrastructure running this demo. For larger runs, run the project locally or deploy it on larger infrastructure." The second sentence is shared with the hosting notice (`largerRunsGuidance`). Per-field input-error messages are unchanged.
- Admin wording stays the shared message.
- Task scope and design section 1.2 corrected to the owner's code rule.
