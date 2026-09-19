# 17 — Build the dashboard estimate and admission flow

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 17 of 21. Execute after [16](16_project_operational_progress_and_history.md); task 15 supplies authoritative preview/start contracts.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 7, D11–D13. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: web scenario selection/forms, API client, preview state and component tests.

## Objective and fixed rules

Explain expected duration, bottleneck and demo limit before launch, using only the API estimate. The UI must never grant authority to its own formula or a stale response. Admission initially allows conservative occupancy at most 600 seconds, subject to effective policy; an actual overrun is continued processing, not automatic cancellation.

Retain public/admin restrictions and all remaining scenario controls. Retired retry, breaker and drain-timeout knobs stay absent. Admin mode has no routine duration bypass; profiles are predefined admin presets, not an arbitrary editor.

## Repository entry points

Inspect the existing scenario draft/preset/custom-start components, API client and state/hooks in `apps/web/src/`, their tests in `apps/web/test/`, task 15's shared preview/start schemas in `packages/contracts/`, and task 12's removed controls. Follow the current component/state ownership rather than adding a new global store or a second API transport layer.

## Implementation work

- [ ] Request a bounded API preview for the currently selected authoritative preset/custom inputs. Debounce/cancel or otherwise bound superseded requests using current app patterns; previewing never consumes a start budget or claims the run slot.
- [ ] Track input/request identity so a late response for older inputs cannot replace the current preview. Show pending/error/unavailable states honestly and disable start while the current preview is pending or rejected.
- [ ] Present explanatory and conservative admission durations with clear labels, effective ceiling, bottleneck and relevant assumptions. Show actionable rejection guidance from the API rather than unexplained disabled controls or a falsely exact completion promise.
- [ ] Echo the fingerprint of the preview actually shown when starting. A structured `estimate_stale` response replaces it with the fresh estimate and requires explicit user re-confirmation; do not silently auto-start under changed conditions.
- [ ] Preserve authoritative handling of over-budget, unestimable, concurrent-run, policy, authentication and visitor-budget rejections even when the button was previously enabled. A successful preview is not a reserved admission.
- [ ] Maintain accessible pending/error/rejection copy and the established public/admin mode separation. Do not expose internal policy constants, forced outage publicly or new storefront/per-order controls.
- [ ] Keep the accepted estimate visible when the run begins and hand off to runtime progression using the accepted server snapshot, not the editable draft. Resetting a draft must not erase evidence for an already accepted run.

## Acceptance and validation

- [ ] Component/client tests cover allowed and rejected estimates, preview pending/failure, rapid edits and out-of-order responses, preset/policy changes, and start-time stale rejection.
- [ ] Start sends the displayed matching fingerprint; fresh stale-preview data requires a new user confirmation rather than automatic retry.
- [ ] No React estimator duplicates backend formulas. Public/admin visibility, remaining controls and retired-control removal remain correct.
- [ ] Browser verification on an isolated runtime demonstrates one accepted low-capacity scenario and one duration rejection with no run/inventory/traffic side effects. Capture actual evidence or report a blocked browser check; do not claim it from component tests alone.
- [ ] Run focused web/component/API-client tests and `pnpm type-check`; run affected contract/API tests for changed interfaces. Use existing documented browser tooling directly for this bounded workflow, not the entire composition/characterization suite.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep changes surgical and all visible/persisted project copy in English. Format/check touched supported files with Biome; execute through Linux/Dev Container with isolated resources. No reference-runtime reset or long suite without request. Report actual/skipped checks and retain locked preview semantics.

## Completion handoff

Deliver the complete preview/start UX and tests. Record request-staleness protection, explicit re-confirmation behavior, rejection copy and browser evidence. Next: [18 — runtime and history UX](18_build_runtime_progress_history_and_admin_controls.md).
