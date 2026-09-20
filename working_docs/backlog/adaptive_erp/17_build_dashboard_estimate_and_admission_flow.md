# 17 — Build the dashboard estimate and admission flow

## Handoff

- Status: Pending.
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

- [ ] Request a bounded API preview for the currently selected authoritative preset/custom inputs. Debounce/cancel or otherwise bound superseded requests using current app patterns; previewing never consumes a start budget or claims the run slot.
- [ ] Track input/request identity so a late response for older inputs cannot replace the current preview. Show pending/error/unavailable states honestly and disable start while the current preview is pending or rejected.
- [ ] For an allowed configuration, show a short allowed state without advertising a completion promise. For a rejected one, show the conservative duration, effective ceiling, bottleneck and the API's adjustment guidance rather than an unexplained disabled control.
- [ ] Preserve authoritative handling of over-budget, unestimable, concurrent-run, policy, authentication and visitor-budget rejections even when the button was previously enabled. A successful preview is not a reserved admission.
- [ ] Maintain accessible pending/error/rejection copy and the established public/admin mode separation. Do not expose internal policy constants, forced outage publicly or new storefront/per-order controls.
- [ ] When the run begins, hand off to runtime progression using the accepted server snapshot, not the editable draft, and stop showing the estimate.

## Acceptance and validation

- [ ] Component/client tests cover allowed and rejected estimates, preview pending/failure, rapid edits and out-of-order responses, and a start-time rejection after an allowed preview.
- [ ] No React estimator duplicates backend formulas. Public/admin visibility, remaining controls and retired-control removal remain correct.
- [ ] Browser verification on an isolated runtime demonstrates one accepted low-capacity scenario and one duration rejection with no run/inventory/traffic side effects. Capture actual evidence or report a blocked browser check; do not claim it from component tests alone.
- [ ] Run focused web/component/API-client tests and `pnpm type-check`; run affected contract/API tests for changed interfaces. Use existing documented browser tooling directly for this bounded workflow, not the entire composition/characterization suite.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep changes surgical and all visible/persisted project copy in English. Format/check touched supported files with Biome; execute through Linux/Dev Container with isolated resources. No reference-runtime reset or long suite without request. Report actual/skipped checks and retain the locked preview semantics of D12.

## Completion handoff

Deliver the complete preview/start UX and tests. Record the out-of-order response protection, rejection copy and browser evidence. Next: [18 — runtime progress and grace notice](18_build_runtime_progress_and_grace_notice.md).
