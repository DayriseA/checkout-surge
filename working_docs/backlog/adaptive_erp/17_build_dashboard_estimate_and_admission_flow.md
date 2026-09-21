# 17 — Build the dashboard estimate and admission flow

## Handoff

- Status: Done (pending commit). Browser verification performed by the orchestrator on 2026-09-21.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 17 of 21. Execute after [16](16_enforce_estimated_duration_admission.md), which supplies the authoritative preview/start contracts.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 6, D11–D13. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: web scenario selection/forms, API client, preview state and component tests.

## Objective and fixed rules

Before launch, tell the user whether the configuration is allowed, using only the API estimate; when it is rejected, explain the estimated duration, bottleneck, demo limit and what to adjust. The UI must never grant authority to its own formula or to a response for older inputs. Admission allows conservative occupancy of at most 600 seconds, subject to effective policy. The estimate is an internal admission mechanism: once a run is accepted the dashboard shows nothing about it.

Retain public/admin restrictions and all remaining scenario controls. Retired retry, breaker and drain-timeout knobs stay absent. Admin mode has no duration bypass.

## Repository entry points

Inspect the existing scenario draft/preset/custom-start components, API client and state/hooks in `apps/web/src/`, their tests in `apps/web/test/`, task 16's shared preview/start schemas in `packages/contracts/`, and task 14's removed controls. Follow the current component/state ownership rather than adding a new global store or a second API transport layer.

## Implementation work

- [x] Request a bounded API preview for the currently selected authoritative preset/custom inputs. Debounce/cancel or otherwise bound superseded requests using current app patterns; previewing never consumes a start budget or claims the run slot.
- [x] Track input/request identity so a late response for older inputs cannot replace the current preview. Show pending/error/unavailable states honestly and disable start while the current preview is pending or rejected.
- [x] For an allowed configuration, show a short allowed state without advertising a completion promise. For a rejected one, show the conservative duration, effective ceiling, bottleneck and the API's adjustment guidance rather than an unexplained disabled control.
- [x] Preserve authoritative handling of over-budget, unestimable, concurrent-run, policy, authentication and visitor-budget rejections even when the button was previously enabled. A successful preview is not a reserved admission.
- [x] Maintain accessible pending/error/rejection copy and the established public/admin mode separation. Do not expose internal policy constants, forced outage publicly or new storefront/per-order controls.
- [x] When the run begins, hand off to runtime progression using the accepted server snapshot, not the editable draft, and stop showing the estimate.

## Acceptance and validation

- [x] Component/client tests cover allowed and rejected estimates, preview pending/failure, rapid edits and out-of-order responses, and a start-time rejection after an allowed preview.
- [x] No React estimator duplicates backend formulas. Public/admin visibility, remaining controls and retired-control removal remain correct.
- [x] Browser verification on an isolated runtime demonstrates one accepted low-capacity scenario and one duration rejection with no run/inventory/traffic side effects. Capture actual evidence or report a blocked browser check; do not claim it from component tests alone.
- [x] Run focused web/component/API-client tests and `pnpm type-check`; run affected contract/API tests for changed interfaces. Use existing documented browser tooling directly for this bounded workflow, not the entire composition/characterization suite.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep changes surgical and all visible/persisted project copy in English. Format/check touched supported files with Biome; execute through Linux/Dev Container with isolated resources. No reference-runtime reset or long suite without request. Report actual/skipped checks and retain the locked preview semantics of D12.

## Completion handoff

Deliver the complete preview/start UX and tests. Record the out-of-order response protection, rejection copy and browser evidence. Next: [18 — runtime progress and grace notice](18_build_runtime_progress_and_grace_notice.md).


## Completion notes (2026-09-21)

### Ownership and decisions

Implemented only the web admission boundary. API/contracts and estimator formulas are unchanged. Verified tasks 14–16 in code: retired controls remain absent, preview shares the strict start request and returns HTTP 200 for both decisions, start recomputes admission after conflict checks, and `buildPolicyFromDraft` still preserves the server-owned occupancy ceiling. No ceiling editor or admin bypass was added. The existing client-computed preset settling formula and its “Approximate settling” row were removed so the UI does not advertise a competing completion estimate.

Both new thin preview routes mirror their start siblings. Public preview validates the request, resolves/signs the visitor identity, forwards public mode and the server control token, and returns any issued visitor cookie. Its sibling has no separate Origin gate; none was invented. Admin preview uses `authorizeAdminProxy`, which enforces exact Origin and a valid admin session before parsing the body, then supplies trusted admin mode/control headers. Both routes validate successful responses with `previewDemoRunResponseSchema`. The private-route test inventory now includes admin preview; `route-metadata.test.ts` lists page titles only and needed no change. Existing backend-proxy validation/correlation behavior is reused.

`useRunEstimate` is component-owned and shared by public preset cards, the public custom form, and the admin preset controller. Public cards retain their independent start actions, with one preview per available card; the public custom form previews only while expanded. Admin previews the selected effective configuration, including unsaved run-once values, and freezes the confirmation request. Server preset/policy identity changes also invalidate the preview. All transport goes through `readProxyJson`.

Preview bounding is client-side: a 300 ms trailing debounce and an `AbortController` per request; no server rate-limiting subsystem or dependency was added. There is no reusable web preview/read limiter; the existing admin-login limiter has a different boundary. Strict proxy validation remains enforced. This bounds ordinary UI traffic, not arbitrary direct HTTP callers.

Out-of-order protection has two parts: effect cleanup cancels the debounce and aborts the superseded operation; completion checks the abort signal even if the transport ignores cancellation. Display state is also keyed by mode, serialized request and authoritative source identity, so an old result cannot stand in for changed inputs. Input changes immediately derive pending state. Tests cover rapid edits, late completion, returning to an earlier input, cancellation, and inactive controls. Authoritative start rejections are separately keyed to the submitted inputs and override an allowed preview without discarding the current input's completed preview.

Pending and rejected previews disable start, including the admin confirmation button. Unavailable/malformed/error previews allow an attempted start while retaining all existing readiness, conflict, policy, validation, authentication and visitor-budget handling. The explicit message is “Preview unavailable. You can try starting; the server will check admission again.” A preview failure is advisory and cannot permanently block an otherwise valid start.

Both start callers parse `estimated_duration_rejected` details with `estimateAdmissionRejectionDetailsSchema` and use the same rejection presentation for finite and unestimable responses. A valid estimate rejection does not enter the uncertain-start recovery branch; it is a definitive non-acceptance. All other existing start handling remains in place.

After acceptance, admission UI is hidden immediately and previews stop, including the gap before recovery refresh/navigation completes. Public navigation uses the accepted response's run ID. Admin retains the accepted server snapshot while recovery catches up and reuses its existing “Watch live” link with `acceptedRunId`; the existing authoritative recovery/runtime components own progress. Editable drafts never supply runtime progress. An inactive recovery releases the admin acceptance latch only when its producer `recoveredAt` timestamp is newer than both the accepted run start and the recovery captured at acceptance. A failed read that rewraps the previous projection cannot clear the accepted-run handoff. Runtime progress/grace changes remain task 18.

### Actual presentation copy

Notices use `role="status"` and `aria-live="polite"`.

- Pending: “Checking whether this configuration is allowed…”
- Allowed: “Configuration allowed. Admission is checked again when you start.” No duration or completion promise.
- Unavailable: “Preview unavailable. You can try starting; the server will check admission again.”
- Rejected: “Configuration not allowed.” Finite results add “Conservative duration: {value} seconds.” All rejections add “Demo limit: {value} seconds.” and “Bottleneck: {label}.” API `reasons` follow, except the public-safe unestimable/outage substitutions below. Numbers use English display formatting with up to two decimal places; only the API decision controls admission, including when displayed numbers round to the same value.

Exhaustive `satisfies Record<EstimatorBottleneck, string>` mapping:

| Contract value | Label |
| --- | --- |
| `traffic_dispatch` | Traffic dispatch |
| `erp_capacity` | ERP capacity |
| `worker_concurrency` | Concurrent order processing |
| `erp_latency` | ERP response delay |
| `adaptive_pacing` | Adaptive processing pace |
| `declared_outage` | ERP availability |
| `unestimable` | No supported estimate |

Exhaustive `satisfies Record<EstimatorUnestimableReason, string>` mapping:

| Contract value | Copy |
| --- | --- |
| `declared_permanent_outage` | ERP availability prevents a supported estimate. |
| `error_rate_above_policy_maximum` | The error rate is too high for a supported estimate. |
| `unsupported_scenario` | This scenario does not have a supported estimate. |

Admin outage copy is “The declared permanent ERP outage prevents a finite estimate.” Admin receives the API adjustment reasons, including “Disable the declared permanent ERP outage to obtain a finite estimate.” Public outage/unsupported guidance is “Choose another scenario or try again when the demo is available.” Public high-error guidance is “Lower the error rate and try again.” These substitutions prevent outage controls and the internal supported-error threshold from leaking publicly. Unestimable results show no fabricated duration; the effective demo limit remains visible as requested.

### Changed files

- New routes: `apps/web/src/app/api/demo/runs/estimate/route.ts`, `apps/web/src/app/api/admin/demo/runs/estimate/route.ts`.
- Shared client state/presentation: new `apps/web/src/app/components/use-run-estimate.ts`, `run-estimate-notice.tsx`, and `apps/web/src/app/lib/presentation/estimate-presentation.ts`; updated `apps/web/src/app/lib/control-paths.ts`.
- Surfaces: `apps/web/src/app/components/public-demo-entry.tsx`, `apps/web/src/app/components/admin/admin-authenticated-surface.tsx`, `admin-feature-views.tsx`.
- Tests: new `apps/web/test/run-estimate.test.tsx`, `estimate-fixtures.ts`; updated `admin-control-proxy.test.ts`, `admin-controller-state.test.tsx`, `browser-workflows.test.ts`, `dashboard-control-surface.test.ts`. The existing recovery/mutation workflow suites isolate preview timing with a hook mock; the new suite exercises the real hook, transport and both surfaces, including custom edits and submissions.
- Documentation: this task, `working_docs/backlog/adaptive_erp/index.md`, `docs/local_development.md`, `docs/architecture.md`.

### Validation and remaining handoff

- `pnpm exec biome check --write <all touched files>`: exit 0; **15 supported files checked, no fixes applied** on the final pass. This configuration does not format Markdown. `git diff --check`: exit 0.
- `pnpm type-check`: exit 0; **11/11 Turbo tasks successful** (10 cached), followed by successful workspace test TypeScript checking.
- `pnpm --filter web test:unit test/run-estimate.test.tsx`: exit 0; **1 file / 19 tests passed**.
- `pnpm --filter web test:unit`: exit 0; **47 files / 812 tests passed**, 0 failures. This includes the preview proxy tests and the existing backend-proxy/route-metadata suites.
- `pnpm test:unit`: exit 0; **11/11 Turbo tasks successful** (9 cached); package tests **1,452/1,452 across 92 files**, environment safety **7/7**, script tests **54/54**. Web passed **812/812** again.
- Non-failing diagnostics: jsdom reports unsupported document navigation for public acceptance tests; the existing browser-workflow suite reports an unawaited React `act` warning in the full unit run. No warning suppressions were added.
- Earlier development runs caught a state-union narrowing error, an incomplete test request, and legacy tests that assumed immediate start availability. These were corrected before the final passing runs.

Final self-review completed against `docs/quality_checklists.md`: scope and phase boundaries respected, routes remain thin, no infrastructure clients or dependencies added, existing contracts and transport reused, vocabulary exhaustive and public-safe, relevant tests pass, and no unrelated cleanup. The delegated browser verification is recorded under "Browser evidence" below.

The implementer did not perform browser verification; the orchestrator did (see "Browser evidence" below). The implementer ran no `pnpm runtime:*`, composition, characterization, infrastructure, or API integration commands were run. API/contracts interfaces were not changed, so additional infrastructure/API validation is not required. Known unrelated formatting offenders remain untouched. No staging, commits, branch switch, or unrelated cleanup.

### Review correction: retain acceptance across failed recovery

Fixed the admin acceptance latch in `admin-authenticated-surface.tsx`: a new `available` wrapper is no longer treated as fresh recovery evidence. The latch clears only for an inactive projection whose `recoveredAt` is newer than both the recovery captured at acceptance and the accepted run's `startedAt`. The preserved projection returned after a failed recovery keeps its old timestamp, so the accepted `Watch live` target survives and preview/start remain disabled. The public surface has no corresponding flaw: its acceptance flag is only set to true and is never cleared by recovery; no public change was needed.

Added one regression in `run-estimate.test.tsx` using the real `useDashboardRecovery` with `preserveAvailableRecoveryOnFailure` and `onStartComplete`. It reproduced the original `/watch` fallback before the fix, then passed after the fix. It also verifies no renewed previews after failure and that a subsequent newer successful inactive read releases the latch.

Validation for this correction: touched-file Biome passed (2 supported files; Markdown ignored), `git diff --check` passed, focused admission tests passed **20/20**, `pnpm type-check` passed **11/11 tasks** plus workspace test types, and `pnpm --filter web test:unit` passed **813/813 tests across 47 files**, all exit 0. The web run emitted only the known non-failing jsdom document-navigation diagnostics. Changes in this correction are limited to the admin controller, regression test, and these notes. Final checklist reviewed; no browser verification, staging, commits, or branch changes.

### Browser evidence (orchestrator, 2026-09-21)

Performed once by the orchestrator with Playwright CLI (headless Chromium) against the wiped reference runtime: `pnpm runtime:wipe`, `pnpm runtime:setup`, `pnpm runtime:up`, dashboard at `http://localhost:8080`, then `pnpm runtime:down`. Evidence files are under `.tmp/process-backlog/20260921-0132/17/browser/` (untracked scratch).

- Public `/demo` on a fresh runtime: all four curated presets show "Configuration allowed. Admission is checked again when you start." with enabled start buttons and no duration (`02-demo.yml`).
- Duration rejection: public custom inputs 5,000 buyers, stock 1,000, ERP delay 100 ms, capacity 1 order/s. The preview (`POST /api/demo/runs/estimate`, HTTP 200) rendered "Configuration not allowed.", "Conservative duration: 2,025 seconds.", "Demo limit: 600 seconds.", "Bottleneck: ERP capacity." and the API guidance; "Start custom run" was disabled (`05-custom-rejected.yml`, `05-custom-rejected.png`, `06-estimate-*.txt`). Rapid field edits produced only three preview requests (debounce); an intermediate out-of-range stock value (5,000 over the 1,000 public maximum) honestly showed "Preview unavailable…" from the 400 validation answer.
- Authoritative start for the same body, forced from the page with `fetch('/api/demo/runs/start')` to bypass the disabled button: HTTP 400 `estimated_duration_rejected` (`07-forced-start-rejection.json`). Afterwards the recovery projection still had `currentRun: null`, `inventory: null`, `recentMetrics: []` and an empty order queue (`03-recovery-before.json` vs `08-recovery-after-rejection.json`), and `/run-history` showed "No runs yet" (`09-run-history-after-rejection.yml`): no run, inventory or traffic was created.
- Accepted low-capacity scenario: public custom 100 buyers, stock 20, delay 100 ms, capacity 2 orders/s showed the allowed state (`10-low-capacity-allowed.*`); the start answered HTTP 202 and navigated to `/watch?acceptedRunId=e31a389b-6844-4cda-8cea-b2fd9a79c50c`. The watch page contained no estimate, duration, ceiling or "Configuration allowed" copy (`11-after-accept-watch.*`). The run later appeared as Completed in `/run-history` (`13-run-history-after-accepted.yml`).
- Observation (follow-up, not fixed): the API's guidance strings are rendered verbatim and begin with the raw bottleneck code, e.g. "erp_capacity: Increase declared ERP capacity or reduce acceptable orders/stock."; public wording of API guidance belongs to the API/estimator copy (task 20 calibration or a copy pass). The admin surface was not browser-checked; it is covered by component tests only.
