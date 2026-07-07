# Exploratory Test Session

## Findings

| Code | Finding | Severity |
| --- | --- | --- |
| E1 | Live watch shows stale/global dashboard metrics when no run is active | Medium |
| E2 | Run outcomes panel mixes terminal outcomes with live transition/pressure counters | Medium |
| E3 | Watch page exposes an empty/internal load-run controls section | Low |

### E1 — Live watch shows stale/global dashboard metrics when no run is active (Medium)

What happens: `/watch` reports `No run in progress`, but several live panels still show concrete values that appear to come from previous/non-current activity. This makes the current-run dashboard internally contradictory.

Reproduction:

1. Start from `http://localhost:8080/`.
2. Open `Live Watch`.
3. If needed, start a small public custom run from `/` (for example buyers `12`, stock `4`, duration `3`) and wait for it to finalize.
4. Reopen or reload `http://localhost:8080/watch` after the run has completed.

Observed evidence after reload:

- `Recovery status` says `No run in progress`.
- `Request surge` says `0.0/s`, `0 reservations`, `RESERVATIONS SECURED 0`.
- `Run outcomes` says `RESERVATIONS SECURED 0`, `CONFIRMED 0`, `NOTIFICATIONS 0`.
- The same page still shows `Inventory drain 100 / 100 left`, ERP confirmation timings, and `Consistency lag` values such as `MEDIAN (P50) 183.5 s`, `P95 191.9 s`, `MAX 193.7 s`, and `over 100 confirmed`.

Expected behavior: when there is no current run, run-scoped panels should either show an explicit empty/no-current-run state or a clearly labeled historical/global baseline. Values shown as part of the live watch should not imply that a non-existent current run has 100 confirmed orders or old consistency-lag values.

Impact: this is central to the product promise: the live dashboard is supposed to prove current run behavior. Stale/global values make it hard to trust the dashboard during demos and after refresh/reconnect.

### E2 — Run outcomes panel mixes terminal outcomes with live transition/pressure counters (Medium)

What happens: during an active run, the `Run outcomes` panel displays terminal outcomes (`Confirmed`, `Failed`) alongside live transition/pressure counters (`Processing`, `Retrying`, `Delayed`) as if they are one mutually comparable outcome set. The counts themselves appear intentional: the code defines these as cumulative order-transition buckets, where `processing` counts orders the worker picked up, `retrying` counts scheduled retry pressure, and `delayed` counts circuit-open deferrals. The issue is that the panel title and description make them read like final run outcomes.

Reproduction:

1. Open `http://localhost:8080/`.
2. In `Custom run`, enter buyers `20`, starting stock `5`, duration `15`.
3. Click `Start custom run`.
4. Watch the automatically opened `/watch` page while the run is active.

Observed evidence:

- `Request surge` / inventory showed `RESERVATIONS SECURED 5`.
- `Run outcomes` showed `RESERVATIONS SECURED 5`, `CONFIRMED 4`, `PROCESSING 5`, `RETRYING 1`, and `NOTIFICATIONS 4`.

Expected behavior: the UI should separate terminal business outcomes from live operational counters, or relabel the section so users understand which values are cumulative transition/pressure signals. For example, `Confirmed`, `Failed`, and `Notifications` could stay under outcomes, while `Processing`, `Retrying`, and `Delayed` could move to an in-flight/backpressure section or be explicitly labeled as cumulative worker signals.

Impact: users watching a surge can misread valid cumulative counters as contradictory final outcomes. This weakens the operator view and the portfolio demo's clarity even if the underlying aggregate math is working as designed.

### E3 — Watch page exposes an empty/internal load-run controls section (Low)

What happens: `/watch` includes a visible section labeled `Load-run controls TASK 6.4` with explanatory text, but no controls are actually rendered there.

Reproduction:

1. Open `http://localhost:8080/watch`.
2. Scroll/read the bottom of the page below the consistency-lag panel.

Observed evidence: the page shows `Load-run controls`, a visible `TASK 6.4` badge, and the copy `Start, observe, and stop preset runs through the API-owned run lifecycle.`, but there are no start/stop controls in that section.

Expected behavior: the public/operator UI should not expose roadmap task labels or empty implementation placeholders. If run controls intentionally live only on `/` and `/admin`, this section should be removed or changed to a link/action that matches the implemented flow.

Impact: low functional impact, but it makes the delivered product feel unfinished and may confuse a user looking for the promised controls.

## Notes

### N1 — Run history `Queued orders 0` reads like a total even when orders confirmed

Lower confidence: this may be a labeling problem rather than a data bug.

After completed public custom runs, `/run-history` showed summaries such as `Accepted reservations 4`, `Queued orders 0`, `Confirmed orders 4`, and `Notifications recorded 4`. If `Queued orders` is intended to mean current terminal-state queued orders, the label should say that. As written, it reads like total queued orders and conflicts with the confirmed-order count.

## Appendix — Session coverage

- Public navigation: `/`, `/about`, `/watch`, `/run-history`, and `/admin` entry from the shared nav.
- Public custom run validation: zero buyers/duration rejected with inline messages; no console errors observed.
- Public custom run execution: launched small runs with constrained buyers/stock/duration and observed automatic `/watch` navigation, finalization, and history persistence.
- Live dashboard: inspected empty state, active-run state, post-finalization state, and full reload/recovery behavior.
- Run history: inspected public view, admin-enhanced view, and post-sign-out public view.
- Admin access: verified passphrase gate, successful sign-in with `change-me-admin-passphrase`, sign-out, and wrong-passphrase feedback.
- Admin controls: inspected run controls, preset list, preset editor open/cancel, preset editor invalid numeric validation, runtime policy labels, and runtime policy hard-cap validation.
- Browser console: checked warning/error logs on the primary pages and flows exercised; no relevant console errors were observed.
