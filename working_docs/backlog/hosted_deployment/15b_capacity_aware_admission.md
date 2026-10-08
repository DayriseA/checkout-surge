# 15b — Capacity-Aware Admission

**Design:** section 1.2 · **Depends on:** 15a, 18

## Goal

A run is admitted only when it is expected to complete, or, for the owner, after a warning and a confirmation. Constant-arrival runs get enough VUs by default.

## Scope

- **Default VU allocation** (owner decision, 2026-10-08).
  - When `k6Vus` is absent, the API resolves VUs at admission as the rate times the deployment's latency budget. All of them are pre-allocated, within the deployment's VU cap.
  - The API writes them into the run, so the runner needs no deployment setting. The API and the runner must still derive the same plan (HD-14).
  - Check the effect on local runs: memory and open connections.
  - Resolved VUs are bounded by the deployment's VU cap only. The public VU limits keep applying to explicit VUs alone, as the code already does (owner decision). Rewrite the field hints that say otherwise (`apps/web/src/app/lib/presentation/field-hints.ts`).
  - The 3 s budget was measured with stock 1; with stock 1,000 the mean iteration time on Fly was 3.6 to 4.7 s. 15c checks it on Fly at the raised public limits and adjusts the env value if needed.
- **Feasibility model** (owner decisions, 2026-10-08; values in "Inputs from Task 15a"). A = min(stock ÷ quantity per attempt, planned requests) is the number of orders a run can accept.
  - **Constant arrival** (rate R, duration T):
    - the load is R + (k − 1) × A ÷ min(T, 10 s), with k fitted per deployment (Fly 7, local 15, provisional). The orders' cost is spread over at most 10 s, the measured run length, because accepted orders arrive first;
    - expected to complete up to 80 % of C_s, at the limit between 80 % and 100 %, expected to fail above C_s, with no backlog exception (owner decision);
    - the run is also expected to fail when A > C_a × (T + 30 s): k6's graceful stop interrupts orders the database pool has not answered by then.
  - **Buyer spike** (N buyers):
    - the time to serve is A ÷ C′_a + (N − A) ÷ C′_s;
    - it is compared with min(cutoff, 60 s): k6's request timeout fails any request unanswered after 60 s. Expected to complete up to 80 %, at the limit up to 100 %, expected to fail above;
    - k6's 30 s graceful stop after the cutoff is left as a reserve, because the model was up to 37 % optimistic on Fly (owner decision).
  - **Success** means every planned request is started and completed with zero failed responses: none dropped, unstarted, interrupted, failed or unexpected (owner decisions, 2026-10-08, after cloud VM A and the 15a review). Latency is not a criterion.
  - **ERP settings** do not hold VUs (13a).
- **Capacity per deployment** (owner decision, 2026-10-08). C_s, C_a, k, C′_s, C′_a and the latency budget are API env values, next to the caps and the estimator constants:
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

- None. The messages were settled at the checkpoint (2026-10-08): the public preview shows nothing for a run expected to complete, and the owner approved the public refusal and the admin warnings, including the agent's five follow-up choices.

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

## Inputs from Task 15a

Details, fit errors, alternatives and caveats: [15a's working notes](15a_capacity_measurement.md#proposed-values-for-15b-2026-10-08). A measured run counted as complete when every planned request started and completed with zero failed responses (transport failures plus unexpected responses).

| Value | Fly | Local (4 vCPU VM) |
|---|--:|--:|
| C, constant arrival, all sold out | 3,500/s | 3,000/s |
| C', buyer spike, all sold out | 2,600/s | 1,150/s |
| Accepted throughput, constant arrival / buyer spike | 240 / 240/s | 195 / 155/s |
| k, cost of an accepted order in sold-out answers (constant arrival) | 7 | 15 |
| Latency budget | 3 s | 3 s, provisional |

- **Stock enters the model.** With A = min(stock, planned requests): a constant-arrival run fits when rate + (k − 1) × A / duration ≤ C, and A ≤ accepted throughput × (duration + 30 s graceful stop). A buyer spike's time to serve is A / accepted throughput + (buyers − A) / C', compared with the cutoff and with k6's 60 s request timeout.
- **Watch:** at low stock, buyer spikes on Fly ran up to 37 % slower than predicted (26 % at stock 1,000; 55 % by k6's bound). The budget was measured with stock 1; with stock 1,000 the mean iteration time on Fly rose to 3.6 to 4.7 s. The local budget and the local k are not confirmed by a run.

## Working Notes

_None yet._
