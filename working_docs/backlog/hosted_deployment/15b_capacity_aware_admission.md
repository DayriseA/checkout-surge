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

### Implementation up to the message checkpoint (2026-10-08)

- **Model:** `apps/api/src/services/capacity-admission.ts`, beside the duration estimator: `assessCapacity` (pure), `requireCapacityAdmission`, `withResolvedConstantArrivalVus`, the strict `deploymentCapacitySchema` (k ≥ 1; accepted rates at most the sold-out ones, which keeps every setting monotonic for the "largest fit" search) and `localDeploymentCapacity` (code defaults). Reuses `k6GracefulStopSeconds`; k6's 60 s request timeout, the 80 % share and the 10 s window are local constants.
- **Wire shape:** `capacityAssessmentSchema` in `packages/contracts/src/estimate.ts`. The preview returns `{ result, capacity }`; a refused public custom start answers 400 `estimated_capacity_rejected` with the assessment as details. Constant arrival: `verdict`, `acceptedOrders`, `loadPerSecond`, `capacityPerSecond`, `poolOrderLimit`; buyer spike: `verdict`, `acceptedOrders`, `timeToServeSeconds`, `windowSeconds` (= min(cutoff, 60)). When not expected to complete, `fit` gives, one setting at a time, the largest rate / buyer count / stock and the smallest cutoff expected to complete (`null`: no value of that setting alone fits).
- **Buyer spike with duplicate clicks:** A ≤ the unique buyers (duplicates share an idempotency key), and the sold-out term counts every planned request (2N − A). Equal to the settled formula without duplicates.
- **Env:** `CAPACITY_CONSTANT_ARRIVAL_SOLD_OUT_PER_SECOND`, `CAPACITY_CONSTANT_ARRIVAL_ACCEPTED_PER_SECOND`, `CAPACITY_CONSTANT_ARRIVAL_ACCEPTED_ORDER_COST`, `CAPACITY_BUYER_SPIKE_SOLD_OUT_PER_SECOND`, `CAPACITY_BUYER_SPIKE_ACCEPTED_PER_SECOND`, `CAPACITY_VU_LATENCY_BUDGET_SECONDS`: Fly values in `infra/fly/core/machine.json`, local values in `docker-compose.yml`, both `.env.example`, the `docs/local_development.md` table, and as code defaults.
- **Admission order:** credential → caps and public limits on the requested configuration → VU resolution → run conflict → estimator → capacity (public custom only) → public run budget. Preview: same resolution, returns both.
- **Resolved vs explicit VUs:** told apart by order, not by a stored mark. Validation runs on the configuration the caller sent; VUs are resolved after it, within the deployment VU caps, and stored as explicit `k6Vus`. Nothing validates a stored snapshot again (checked: only `resolveValidatedConfig` and the web admin draft check call the validator, both before resolution). The deployment VU caps now apply to explicit VUs only (absent VUs are capped by construction); the contracts and policy-service tests that pinned the old cap check on derived VUs were rewritten. `resolveConstantArrivalVus` keeps the rate / 2 × rate derivation for stored runs without VUs and for configurations not yet admitted (only their planned request count is read).
- **HD-14:** the runner receives the stored snapshot, so `deriveLoadExecutionPlan` reads the same explicit VUs on both sides and the completion binding's deep-equal holds; the runner needs no setting.
- **Public presets:** `buildSeedPresets` moved from `packages/db/src/scripts/seed.ts` to `packages/db/src/seed-presets.ts` and is exported from `@checkout-surge/db`; `apps/api/test/unit/capacity-admission.test.ts` reads both deployments' values from `machine.json` and `docker-compose.yml` and pins every public preset as expected to complete (largest share: local `surge-10k`, 11.5 s of 48 s).
- **Local runs, estimated (not measured):** at the local public limit of 1,000/s, 3,000 VUs pre-allocated instead of 1,000 (max 2,000): about 0.7 GB of k6 memory instead of 0.2 to 0.45 GB at about 225 kB per VU. From about 3,334/s, admin runs hit `DEMO_MAX_VUS` (10,000): about 2.3 GB, 3.7 GB peak on cloud A. Each VU that runs an iteration keeps its own keep-alive connection, so up to one API connection per VU: 3,000 at the public limit, 10,000 at the cap, well within `nofile` (1,048,576), the 8,192 listen backlog and the generator's 55,296 ports. The local budget itself is still provisional (15a).
- **Decision log:** HD-59 (default VUs resolved at admission; supersedes HD-53, whose premise was the old allocation; the public rate value stays until 15c measures) and HD-60 (public custom runs admitted only when expected to complete, admin warned).
- **Checks:** Biome, `pnpm type-check`, unit tests of contracts, db, api and web pass. API service tests that need PostgreSQL/Redis (`demo-run-service.test.ts`, `public-runtime-policy-service.test.ts`) were written but not run: Docker was down. The route-level tests in `api.test.ts` that need no database pass. `load-orchestrator` unit tests fail on this Windows workstation with `EPERM: fsync`, untouched by this task.
- **UI:** placeholders only (`capacityRefusalCopy`, `capacityWarningCopy` in `estimate-presentation.ts`); the refusal blocks the public custom start, the admin warning shows in "Start this run?" without blocking. Field hints rewritten (`maxVus`, `publicDefaults`, `maxPreAllocatedVus`, `maxPublicVus`).

### Messages wired (2026-10-08, after the owner approved the checkpoint)

- The owner's wording is in `apps/web/src/app/lib/presentation/capacity-presentation.ts`. The preview still shows nothing for a run expected to complete. The public refusal shows from the preview and from the API's `estimated_capacity_rejected`. The admin warning shows in "Start this run?". The HD-25 allowlist is unchanged.
- The assessment now echoes the assessed settings (rate, duration and stock for constant arrival; buyers and stock for a buyer spike), so a message needs nothing but the assessment. `k6RequestTimeoutSeconds` moved to contracts, beside `k6GracefulStopSeconds`.
- **Rules:** stock counts as an issue only when less stock, still at least 1 unit, would fit (`fit.startingStock` > 0). Otherwise the stock mention and "or the stock" are dropped. `null` clauses are dropped, and nouns and "fit/fits" agree with 1. A buyer spike says "too close to" at the limit and "more than" past its window.
- **Additions not in the approved wording:**
  - The buyer-spike refusal opens with the same "too heavy" headline.
  - The admin "Expected to complete" clause also lists the stock when it fits.
  - Admin buyer spikes bound by their cutoff get "Near…: about {time} to answer, {pct} % of the {cutoff}-second safety cutoff" (at the limit) or "Beyond…: …, more than the {cutoff}-second safety cutoff. Expect a failed delivery: answers arriving too late, or requests never sent before the cutoff." (expected to fail).
- **Checks:** Biome, `pnpm type-check`, unit tests of contracts, db, api and web, and the database-free route tests in `api.test.ts` pass. The database-backed API tests are still not run.

### Fix pass after review, cloud verification and arbitration (2026-10-08)

- **Cloud boundary failure (4 vCPU VM, local values):**
  - 1,000/s for 10 s with stock 1,000 sits exactly at the 80 % line, so it is classed expected to complete. It failed, with 2,770 requests unstarted and a p95 of 13.9 s.
  - A run at 92 % failed too.
  - k6 used 813 MB RSS at 3,000 VUs, against the 0.7 GB estimated above.
  - Owner decision: 15c confirms the values on Fly and on a cloud VM before raising the limits, and adjusts the env values, the VU budget included. The values are unchanged here.
- **Cutoff suggestion:** `assessCapacity` takes an `admitsCutoff` predicate. The service checks the smallest completing cutoff against the duration estimate and the run limits; if they refuse it, the suggestion is `null`. Reviewer case (local, 10,000 buyers, stock 970, cutoff 1 s, ERP 100 ms / 5 TPS / 5 %, concurrency 5): the estimate is 591 s at 1 s and 608 s at 18 s, so the result is buyers 124 and cutoff `null`.
- **Admin VUs:**
  - The run editor leaves both VU fields empty by default, which means automatic allocation. Filling one requires the other. Previews show "automatic".
  - The preview now returns `automaticVus`. "Start this run?" warns when the explicit pre-allocated VUs are below it.
  - The seeded `admin-smoke-constant` and `admin-failure-path` explicit VUs (10/50, 10/60) dated from the initial seed with no recorded reason, and would have triggered the warning (10 against 60 and 45). They are now automatic. Existing rows keep their values until a fresh core or reset, because those presets are not overwritten on reseed.
- **Public wording:** owner rewrites applied: "requests per second" for constant arrival, the "too close to the demo server's limit" opening and the "{pct}% of what the server can sustain" clause at the limit, and the server sentence in buyer-spike refusals. The presentation tests now use only fixtures the model can produce.
- `demo-run-service.test.ts`: the duplicate-preview test compares only `result` and checks the capacity time separately. A new test covers the reviewer's case.
