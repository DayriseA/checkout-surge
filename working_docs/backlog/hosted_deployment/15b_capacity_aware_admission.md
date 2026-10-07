# 15b — Capacity-Aware Admission

**Design:** section 1.2 · **Depends on:** 15a, 18

## Goal

A run is admitted only when it is expected to complete, or, for the owner, after a warning and a confirmation. Constant-arrival runs get enough VUs by default.

## Scope

- **Default VU allocation** (owner decision, 2026-10-08).
  - When `k6Vus` is absent, the API resolves VUs at admission as the rate times the deployment's latency budget. All of them are pre-allocated, within the deployment's VU cap.
  - The API writes them into the run, so the runner needs no deployment setting. The API and the runner must still derive the same plan (HD-14).
  - Check the effect on local runs: memory and open connections.
  - Rewrite the field hints that say the public VU limits cap derived values (`apps/web/src/app/lib/presentation/field-hints.ts`); the code caps only explicit VUs.
- **Feasibility model** (owner decisions, 2026-10-08).
  - **Constant arrival:**
    - expected to complete up to 80 % of the capacity C;
    - at the limit between 80 % and 100 %;
    - expected to fail above C, unless the run is short enough for its backlog to fit within the VUs.
  - **Buyer spike:** the time to serve, buyers divided by C', is compared with the safety cutoff.
  - **Stock** enters only if 15a shows an effect.
  - **Success** means every planned request is started and answered: none dropped, unstarted or interrupted (owner decision, 2026-10-08, after cloud VM A). Latency is not a criterion.
  - **ERP settings** do not hold VUs (13a).
- **Capacity per deployment** (owner decision, 2026-10-08). C, C' and the latency budget are API env values, next to the caps and the estimator constants:
  - Fly: `infra/fly/core/machine.json`;
  - local: `docker-compose.yml`, `.env.example` and the table in `docs/local_development.md`, defaulting to the cloud VM's measurement.
- **Behavior.**
  - **Public custom runs:** only those expected to complete are accepted. Otherwise the visitor gets a clear message, shown before the start in the existing estimate preview and enforced by the API.
  - **Admin runs:** "at the limit" and "expected to fail" get a warning in the existing "Start this run?" confirmation dialog, and never a refusal.
  - **Public presets** are fixed and must stay expected to complete on both deployments.
- **Messages.** Propose the wording to the owner at a checkpoint before writing it into the UI. In plain language, say:
  - what limits the run (the single API process);
  - the largest setting that would fit;
  - what to change.
- **Decision log:** record entries where the inclusion test of `docs/decisions/README.md` calls for it.

## Out of Scope

- Public limits and visitor explanations (15c).
- A multi-process API (HD-51).
- The conservative estimate's over-conservatism (owner decision, 2026-10-08). It only refuses configurations estimated above 600 s; the slot is released at the run's real end.

## Done When

- The model, its thresholds and messages are implemented with the values from 15a, and the messages are approved by the owner.

## Open Points

- How the public VU limits apply to VUs resolved by the API.
- The exact backlog condition for a constant-arrival run above C.
- The messages (checkpoint).

## Inputs from Preparation (2026-10-08)

- **Admission order** (`apps/api/src/services/demo-run-service.ts`):
  1. visitor credential;
  2. caps and public limits (`invalid_run_configuration` with a violation code);
  3. run conflict;
  4. estimator (`estimated_duration_rejected`, every operator mode, no admin bypass);
  5. public run budget.
- **Estimate preview:** debounced, and it blocks the start while pending or rejected (`apps/web/src/app/components/use-run-estimate.ts`). It is used by the public custom form and the admin. The rejection copy is in `apps/web/src/app/lib/presentation/estimate-presentation.ts`.
- **Admin:** the only confirmation is the generic "Start this run?" dialog (`admin-authenticated-surface.tsx`), which shows the effective configuration and the estimate notice.
- **After a run fails on the VU limit,** an explanation already exists (`apps/api/src/services/run-failure-diagnostic.ts`, `apps/web/src/app/components/run-failure-explanation.tsx`).
- **Callers that derive VUs:** `resolveConstantArrivalVus` is called from the k6 script, the traffic completion binding (deep-equal of the runner's plan against the API's own), run history, the planned request count, the public policy validation and the traffic delivery plan.
- **Buyer spike:** VUs equal the buyers, bounded by the buyer caps only, not the VU caps (HD-51).
- **Values:** C, C' and the latency budget come from 15a's working notes.

## Working Notes

_None yet._
