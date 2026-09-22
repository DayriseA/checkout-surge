# Add contextual field hints and clean up the public and admin forms

Status: implemented on 2026-09-22 (steps 0 to 3 of §9; see §10 for completion notes). Scope: a "?" hint next to every meaningful field on `/demo` and `/admin`, the small label and unit fixes that go with it, percent entry for every ERP error rate, and removal of the three inert run-config fields. This spec merges two independent proposals written from the same brief (called report A and report B below); both were deleted once merged. Every claim the two disagreed on was re-checked against the code; §7 lists those arbitrations.

This document is the single spec for the work. The copy in §3 to §5 is final and can be pasted as-is.

Owner decisions taken on 2026-09-22 and applied below:

- Section hints on all seven admin panel headings (§4.1).
- ERP error rate is entered as a **percent everywhere**, admin included (§8.2). The old "fraction 0.25 = 25%" wording is gone.
- Admin traffic and ERP labels keep their technical names for now; hints bridge to the public labels with "Shown to visitors as …" (§6).
- The three inert run-config fields (Hold minutes, Persistence retry seconds, Quantity per checkout) are removed as part of this same task instead of a separate backlog item (§8.1).

## 1. What we are building

A small "?" button next to field labels on the public "Customize a scenario" form (`/demo`) and on the `/admin` console. Hovering, focusing or tapping it shows a short explanation of what the field means and what changing it does. Constraints (unit, min, max, entry format) stay visible under the field as today.

Three layers, each with its own place (both reports agree):

| Layer | Question it answers | Where |
| --- | --- | --- |
| Hint (new) | What is this? What changes if I move it? | "?" bubble next to the label |
| Constraint line (existing) | How do I enter a valid value? | Visible text under the field: `Unit: buyers. Minimum: 1. Maximum: 10,000.`, `Enter 25 for 25%.` |
| Scope or consequence sentence (existing, a few additions) | What does this section affect? What does this button do? | Visible prose under a heading or next to a button |

Worked example, Buyer count:

- Today, under the field: `Unit: buyers. Minimum: 1. Maximum: 10,000. How many distinct buyers arrive in the spike.`
- After: constraint line `Unit: buyers. Minimum: 1. Maximum: 10,000.` and hint: *How many simulated shoppers try to buy at the same moment. Each one tries to reserve one unit. When there are more buyers than stock, the extra ones are turned away as sold out.*

## 2. Writing rules for hints

Merged from both reports, then tightened.

1. **Two or three sentences, 40 words maximum.** Longer explanations belong on the home page.
2. **Order: what it is, then what you will see change.** Optionally, one typical use.
3. **Plain words first, jargon in parentheses.** First mention is "the simulated back-office system (ERP)", "virtual users (VUs)", "the load generator (k6)".
4. **No numbers that already sit in the constraint line.** No min or max in a hint.
5. **Say what the code does, not what the label suggests.** Recruiters with admin access may read the source. If a field is only recorded, the hint says so (or the field is removed, see §8.1).
6. **Same concept, same sentence.** Public and admin share one definition string. Admin may append one technical sentence (engine name, HTTP code, scope).
7. **Do not promise outcomes the field does not control.** "Arrival rate" is a target, not delivered throughput. "Failure rate" is per call, not the share of orders that end up failed.
8. **Text only.** No links inside a hover bubble. English only.

## 3. Public form: "Customize a scenario"

Source: `apps/web/src/app/components/public-demo-entry.tsx` (`LabeledInput`, `TrafficModeSelector`). The generated `Unit / Minimum / Maximum` part of the constraint line stays. The `helper` prop is removed from the line, except where it is an entry instruction (noted as "keep visible").

| Label | Config field | Stays visible under the field | Hint |
| --- | --- | --- | --- |
| **Traffic pattern** (radio legend) | `trafficConfig.mode` | option labels | How buyers arrive. **Everyone at once**: a fixed crowd checks out at the same instant, like a flash sale opening. **Steady stream**: new buyers keep arriving at a constant rate for a set time. |
| **Buyer count** | `buyerCount` | `Unit: buyers. Minimum: 1. Maximum: N.` | How many simulated shoppers try to buy at the same moment. Each one tries to reserve one unit. When there are more buyers than stock, the extra ones are turned away as sold out. |
| **Duplicate each buyer attempt** | `duplicateEachBuyerAttempt` | `Doubles the planned attempts.` | Simulates an impatient shopper who clicks Buy twice. Both clicks carry the same request key, so the API recognizes the repeat and returns the same reservation instead of taking a second unit. |
| **Arrival rate** | `ratePerSecond` | `Unit: requests/second. Minimum: 1. Maximum: N.` | How many new checkout attempts the load generator starts every second, for the whole traffic duration. Delivery can fall short of this target if the generator cannot keep up. |
| **Traffic duration** | `durationSeconds` | `Unit: seconds. Minimum: 1. Maximum: N.` Keep `Planned attempts = arrival rate × duration.` next to the total. | How long new buyers keep arriving. Order processing continues after traffic stops, so the run usually lasts longer than this. |
| **Planned total attempts** (summary line) | derived | the value | Every checkout request the load generator will send: buyers (×2 with duplicates), or arrival rate × duration. It must stay within the public limit. |
| **Starting stock** | `inventoryConfig.startingStock` | `Unit: units. Minimum: 0. Maximum: N.` | Units for sale when the run starts. Each successful reservation takes one. Set it below the buyer count to see sold-out rejections. Whatever the load, the system must never sell more than this. |
| **Slow ERP** (fieldset legend) | `erpConfig` | **Visible one-line intro** (see note) | *(no hint; the intro replaces it)* |
| **Delay per order** | `erpConfig.latencyMs` | `Unit: milliseconds. Minimum: 0. Maximum: N.` | Extra time the simulated ERP takes to answer each confirmation call. Reservations stay fast because stock is secured before the ERP is called. Orders simply wait longer in the backlog. |
| **Capacity** | `erpConfig.maxTps` | `Unit: calls/second. Minimum: N. Maximum: N.` | The most confirmation calls per second the simulated ERP accepts. Calls above that rate are refused and retried later, so a low capacity makes the order backlog grow, then drain slowly. |
| **Failure rate** | `erpConfig.errorRate` (UI %, stored as ratio) | `Unit: percent. Minimum: 0. Maximum: N. Enter 25 for 25%.` (keep visible) | The share of confirmation calls the simulated ERP fails at random with a temporary error. The worker retries them, so this is not the share of orders that end up failed. |
| **Advanced protection settings** (summary) | — | — | Safety limits around the load generator. The defaults suit most runs. |
| **Safety cutoff** (spike only) | `maxDurationSeconds` | `Unit: seconds. Minimum: 1. Maximum: N.` | A time limit on sending the spike, not on the whole run. If some attempts are still unsent when it expires, the load generator stops and the run reports partial delivery. Order processing continues afterwards. |
| **Start delay** | `startDelaySeconds` | `Unit: seconds. Minimum: 0. Maximum: N.` | How long the load generator waits after the run is accepted before sending the first buyer. Use it to open the live view on an idle system first. |

Notes:

- **Slow ERP intro.** Report A put the ERP definition in a legend hint, report B in a visible sentence. Visible wins: every field in this group depends on knowing what an ERP is, and a visitor should not have to hover to find out. Proposed sentence under the legend: *The ERP is the simulated back-office system that confirms each order after its stock is reserved. Here it is deliberately slow and unreliable.*
- **Capacity unit.** Change `orders/second` to `calls/second` (report B). Retries consume capacity too, so "orders" overstates what the limit counts.
- **No hint on the Buyers and Stock legends.** Their single field or the Traffic pattern hint already covers them.
- **Budget line and shared-runtime disclosure** are already explanatory prose. No change.

## 4. Admin console: `/admin`

Sources: `admin-authenticated-surface.tsx` (layout, current run, readiness, maintenance) and `admin-feature-views.tsx` (policy, presets, ERP).

### 4.1 Section headings

One hint per `h2`, so an admin who was not around when the console was built knows what each panel is for. Report B did not propose these but did not object; they cost one icon each and answer the most common "what is this panel?" question.

| Section | Hint |
| --- | --- |
| Current run | The run currently holding the shared demo. Only one run can be active at a time; new starts are blocked until it finishes or is reset. |
| Shared dependencies | Health checks of the services a run needs: database, Redis, queue, load generator, simulated ERP. Runs cannot start while a required dependency is not ready. |
| Routine actions | *(none, shortcut row)* |
| Presets: Inspection and starts | A preset is a saved scenario: traffic, stock, simulated ERP and worker settings. Public presets are the cards visitors see. Admin presets exist only here. You can also start a one-off run with edited values without saving them. |
| ERP fault injection (global fallback) | Live controls of the simulated ERP service itself. Each run carries its own frozen ERP settings, so changes here never affect a running run. They apply only to ERP calls that carry no run settings, and reset when the Mock ERP restarts. |
| Recovery and cleanup | Operator tools. Reset stops all demo work immediately and frees the demo. Cleanup permanently deletes old generated runs from the history. |
| Public runtime policy | Rules for anonymous visitors: how many runs they may start, the values pre-filled in "Customize a scenario", and the limits on what they may enter. Runs already accepted keep their own snapshot. |

### 4.2 Preset identity and display

| Label | Field | Hint |
| --- | --- | --- |
| Slug (read-only) | `slug` | Permanent technical identifier, used by the API and in run history. It cannot be edited; duplicate the preset to get a new one. |
| Visibility (read-only) | `visibility` | **public**: shown to every visitor as a preset card and read-only here. **admin**: visible only in this console, and editable. |
| Custom (read-only) | `isCustom` | Marks a scratch scenario: the admin "Custom" preset or the base of the public "Customize a scenario" form. Scratch scenarios cannot be archived. |
| Name | `display.name` | Display name shown in preset lists and, for public presets, on the visitor card. |
| Description | `display.description` | Short explanation of what this scenario demonstrates and what a viewer should notice. Shown under "Technical details" on public cards. |
| Sort order | `display.sortOrder` | Position in preset lists. Lower numbers come first. Constraint line `Whole number.` stays. |
| Duplicate slug | `targetSlug` | Identifier for the new admin-only copy of the selected preset. The copy takes the saved values, not unsaved edits. Constraint line (new, visible): `Letters are lowercased and separators become hyphens, e.g. recruiter-demo.` |

One button deserves a hint because its label is ambiguous. **Copy saved values to custom scenario** writes into the admin "Custom" scratch preset (slug `custom`), not into the public "Customize a scenario" base. Hint: *Overwrites the admin "Custom" scratch preset with this preset's saved values, so you can experiment without touching the original. It does not change the public form.* "Run once with these values" already has an explanatory confirmation dialog.

### 4.3 Traffic editor (presets and "Public custom defaults")

| Admin label | Public equivalent | Hint |
| --- | --- | --- |
| Traffic pattern | Traffic pattern | Same as public, plus: *Technically, k6 `per-vu-iterations` (one virtual user per buyer) versus `constant-arrival-rate`.* |
| Buyer count | Buyer count | Same as public. |
| Max duration seconds | Safety cutoff | *Shown to visitors as "Safety cutoff".* Then same as public. |
| Duplicate attempts | Duplicate each buyer attempt | Same as public. |
| Requests per second | Arrival rate | *Shown to visitors as "Arrival rate".* Then same as public. |
| Duration seconds | Traffic duration | *Shown to visitors as "Traffic duration".* Then same as public. |
| Preallocated VUs | *(derived for visitors)* | Virtual users (VUs) are the load generator's reusable workers; each sends one request at a time. This many are ready before traffic starts. Too few for the rate and attempts are skipped, reported as partial delivery. |
| Max VUs | *(derived for visitors)* | The most virtual users the load generator may add when responses slow down and every prepared one is busy. At least the preallocated count. For visitors, both values are derived from the arrival rate. |
| Start delay seconds | Start delay | Same as public. |

VU derivation for visitors: preallocated = rate, max = 2 × rate, capped at 10,000 (`resolveConstantArrivalVus`, `packages/contracts/src/load.ts`).

### 4.4 Inventory, per-run ERP, worker (`RunConfigInputs`)

| Admin label | Field | Hint |
| --- | --- | --- |
| Inventory (legend) | `inventoryConfig` | *(none)* |
| Starting stock | `startingStock` | Same as public. |
| Quantity per checkout | `quantityPerCheckout` | **No hint. Field to be removed** (§8.1). |
| Hold minutes | `reservationHoldMinutes` | **No hint. Field to be removed** (§8.1). |
| Per-run ERP (legend) | `erpConfig` | Simulated ERP behaviour frozen into every run started from this preset. It takes precedence over the global "ERP fault injection" values. |
| ERP latency ms | `erpConfig.latencyMs` | *Shown to visitors as "Delay per order".* Then same as public. |
| ERP max TPS | `erpConfig.maxTps` | *Shown to visitors as "Capacity".* Then same as public, plus: *TPS means transactions (confirmation calls) per second. Over the limit the ERP answers HTTP 429 and the worker backs off.* |
| ERP error rate | `erpConfig.errorRate` | *Shown to visitors as "Failure rate".* Then same as public, plus: *Injected failures are HTTP 503. Runs declaring more than 30% are refused at start because their duration cannot be estimated.* Constraint line becomes `Unit: percent. Minimum: 0. Maximum: 100. Enter 25 for 25%.` (percent entry, see §8.2) |
| ERP forced outage | `erpConfig.forcedOutage` | Makes the simulated ERP refuse every confirmation for this run. A run declared this way is refused at start because its duration cannot be estimated. It is kept for completeness of the snapshot, not as a working scenario. |
| Worker and backpressure (legend) | `backpressureConfig` | How the background worker pulls orders from the queue. Backpressure means the queue absorbs the surge so the slow ERP only receives what it can handle. |
| Worker concurrency | `orderProcessConcurrency` | How many orders the worker processes in parallel for this run. Higher values drain the backlog faster but push harder on the ERP, which still enforces its own capacity. Also feeds the admission duration estimate. |
| Persistence retry seconds | `pendingPersistenceRetryAfterSeconds` | **No hint. Field to be removed** (§8.1). |

**Effective run preview** (`summary`): *The exact configuration the run would receive if started now, with your edits merged onto defaults. On start it becomes the run's frozen snapshot, visible later in run history.* Inside it, one hint on **Queue name / Physical queue name**: *Logical queue name and the underlying BullMQ queue. Fixed, shown for traceability.* No other per-row hints.

### 4.5 ERP fault injection (`AdminErpDiagnosticsView`)

Keep the existing visible scope statement, reworded: *Runs use the ERP settings frozen when they start. These controls change fallback behaviour for calls that carry no run settings; they do not change an accepted run.*

| Label | Hint |
| --- | --- |
| Accepted run snapshot (per-run) (group title) | The ERP settings frozen into the active run. These are what the running run's orders actually use. |
| Configured global fallback (group title) | The ERP service's own values, used for calls without run settings. Reset to deployment defaults when the Mock ERP restarts. |
| Latency ms | Same core as "Delay per order", ending with: *Applies to calls that carry no run settings.* |
| Max TPS | Same core as "Capacity", same scope ending. |
| Error rate | Same core as "Failure rate", same scope ending. Constraint line `Unit: percent. Minimum: 0. Maximum: N. Enter 25 for 25%.` |
| Forced outage | Makes the simulated ERP refuse every call that uses the fallback settings. |

"Reset ERP controls" restores the process's initial fallback configuration, not a clean "healthy" preset. Worth one visible sentence next to the button if not already clear from the confirmation dialog.

### 4.6 Public runtime policy (`AdminRuntimePolicyView`)

Budget here means a number of run starts, not money. The first hint says so.

| Label | Field | Hint |
| --- | --- | --- |
| Enforce public budget | `isPublicRunBudgetEnforced` | Limits how many runs anonymous visitors may start per time window, per visitor and overall. "Budget" counts starts, not money. Off: visitors may start whenever the demo is free; configuration limits still apply. |
| Budget window seconds | `publicRunBudget.windowSeconds` | Length of each counting period for public starts (3600 = one hour). Windows are fixed, not rolling: counters reset at each boundary. |
| Per-visitor starts | `perVisitorMaxStarts` | Most runs one visitor may start per window. Visitors are recognized by an anonymous browser credential, not an account. |
| Global starts | `globalMaxStarts` | Most runs all visitors together may start per window. Protects the shared host from a crowd of visitors. |
| Public custom defaults (sub-heading) | `publicCustomDefaults` | The values pre-filled in the public "Customize a scenario" form. Settings visitors cannot edit (worker concurrency, VUs) are always taken from here. |
| Public custom limits (sub-heading) | `publicCustomLimits` | The highest (or lowest) values visitors may enter in "Customize a scenario". They constrain choices; they do not set a run's values. Each must stay within the deployment hard caps below. |
| Max total requests | `maxTotalRequests` | Upper limit on a visitor run's planned total attempts: buyers (×2 with duplicates), or rate × duration. |
| Max buyers | `maxBuyers` | Highest value visitors may enter for "Buyer count". |
| Max requests/sec | `maxRequestsPerSecond` | Highest value visitors may enter for "Arrival rate". |
| Max duration seconds | `maxTrafficDurationSeconds` | Highest value visitors may enter for "Traffic duration" and for "Safety cutoff". |
| Max start delay seconds | `maxTrafficStartDelaySeconds` | Highest value visitors may enter for "Start delay". |
| Max preallocated VUs / Max VUs | `maxPreAllocatedVus`, `maxVus` | Visitors do not set virtual users; they are derived from the arrival rate. This caps the derived values, so it indirectly limits the arrival rate a visitor can use. |
| Max starting stock | `maxStartingStock` | Highest value visitors may enter for "Starting stock". |
| Max ERP latency ms | `maxErpLatencyMs` | Highest value visitors may enter for "Delay per order". |
| Min ERP max TPS | `minErpMaxTps` | Lowest "Capacity" visitors may choose. Stops a visitor from making the ERP so slow that the run cannot finish within the demo time limit. |
| Max ERP max TPS | `maxErpMaxTps` | Highest value visitors may enter for "Capacity". |
| Max ERP error rate | `maxErpErrorRate` | Highest "Failure rate" visitors may choose. |
| Buyer spike / Constant arrival (checkboxes) | `allowedTrafficModes` | Which traffic patterns visitors may pick ("Everyone at once" / "Steady stream"). At least one must stay allowed. **Rename the labels to "Allow buyer spike" / "Allow constant arrival"** (both reports; matches the existing validation labels). |
| Hard max … (read-only facts) | `deploymentHardCaps` | One hint on the group: *Absolute ceilings set by the server's environment configuration to protect the host. Not editable here. Every preset and public limit must stay below them.* Expand "RPS" to "requests/second" and "VUs" to "virtual users" in these labels. |

### 4.7 Other forms

Report B inventoried surfaces report A skipped. Kept where cheap and useful:

| Control | Hint |
| --- | --- |
| Admin passphrase (`/admin` signed out) | The admin passphrase provided by the project owner. It unlocks the operator controls. *(one sentence, low priority)* |
| Identifier type (`/run-history/[runId]` search) | The kind of identifier you copied: an internal database order ID, the public order ID returned by checkout, or a correlation ID used to trace one request. |
| Identifier (same form) | Finds records of this run matching the identifier exactly, including records outside the recent view. Keep `Enter an exact identifier.` visible, not only as a placeholder. |

No hints on: run-history row checkboxes and delete confirmations (already explained), diagnostics links, Routine actions, `/watch` readouts.

## 5. UI pattern

Both reports converge. Summary of the agreed requirements:

- **One component**, e.g. `apps/web/src/app/components/field-hint.tsx`, used everywhere. **No new dependency**; the web app only has next/react/react-dom, and a tooltip library is not worth it.
- It is a **toggletip**, not a `title` attribute: a `<button type="button">` with a 16 to 18 px circled "?" and a 24 × 24 px minimum hit area. Accessible name `About {label}`. `aria-expanded` reflects state.
- **Opens** on hover, keyboard focus and click/tap. **Closes** on Escape, blur, outside click, and mouse leave after a short delay so the pointer can move onto the bubble. After Escape, do not reopen until a new interaction.
- The bubble is `role="tooltip"`, linked to the **button** via `aria-describedby`. The **input's** `aria-describedby` keeps pointing at the constraint line and errors only, so screen readers do not read a paragraph on every focus.
- The button sits **outside the `<label>`**, next to it. Clicking it must never focus the input, toggle the checkbox or select the radio. The admin `Checkbox` currently wraps its input in the label; it needs the button placed beside, not inside.
- Text only inside the bubble. No links or focusable controls.
- Positioning in plain CSS (absolute, `max-w-72`, wraps). Check clipping inside the admin `<details>` panels, narrow grids and at phone width; use the native Popover API (`popover="manual"`) only if clipping actually occurs.
- Hints stay reachable when the field is disabled (disabled fieldsets may require placing the trigger outside the disabled subtree).
- Styling reuses existing tokens (`text-muted`, `border-border`, `bg-surface`, `ring-accent`), matching `control-styles.ts`.

**Copy lives in one module**, `apps/web/src/app/lib/presentation/field-hints.ts`, next to `public-vocabulary.ts`: a keyed object of shared definitions plus a second object for admin-only concepts. Admin variants that add a sentence compose the shared string. Context-specific scope sentences (§4.5 intro, §4.6 sub-headings) stay near their sections. No schema-driven form system, and no deriving hints from substring matching on field names: a policy limit and a run value mean different things.

**Wiring points**: `LabeledInput` (public) gets a `hint` prop and loses the meaning part of `helper`; `LabeledTextInput`, `DraftInput`, `Checkbox`, `TrafficModeSelector` legend and `ConfigFieldset` legend (admin) get an optional `hint`; `h2` panel headings and `Fact`/`FieldRow` group titles get one where §4 says so.

## 6. Label and constraint-line changes (small, do with the hint work)

These reduce the need for hints instead of adding one. All were proposed by at least one report and cost a line each.

| Where | Change | Why |
| --- | --- | --- |
| Public "Capacity" constraint line | `orders/second` → `calls/second` | Retries consume capacity; "orders" is inaccurate. |
| Admin error-rate inputs (presets, public defaults, public limits, ERP fallback) | Enter a percent like the public form; constraint line `Unit: percent. Minimum: 0. Maximum: N. Enter 25 for 25%.` | Public uses percent, admin used a fraction; an admin who tested the public form would type `25` and hit a validation error. Owner decision: one convention everywhere (§8.2). |
| Admin numeric constraint lines | Add the unit, as the public form does (`Unit: seconds. Minimum: 1.`) | Keeps units out of hints and makes `Minimum: 1.` self-explanatory. |
| Policy checkboxes | "Buyer spike" / "Constant arrival" → "Allow buyer spike" / "Allow constant arrival" | They are permissions, not a mode selector. The validation summary already uses these names. |
| Hard-cap facts | "RPS" → "requests/second", "VUs" → "virtual users" | Abbreviations a recruiter will not know. |
| Duplicate slug | Add visible entry guidance (`recruiter-demo`, lowercase, hyphens) | It is an entry format, so it belongs in the constraint layer. |

Owner decision: admin traffic and ERP labels keep their technical names ("Max duration seconds", "Requests per second", "ERP latency ms", "ERP max TPS"). They match the snapshot fields an admin cross-checks in run history and in the code, so they have value of their own. The hints bridge the gap with "Shown to visitors as …". A rename can be reconsidered later as a separate naming decision.

## 7. Where the two reports disagreed, and what the code says

| Topic | Report A | Report B | Verified in code | Decision |
| --- | --- | --- | --- | --- |
| ERP forced outage per run | "Expect the run not to settle until reset" | "Admission does not accept forced-outage runs" | `demo-duration-estimator.ts` returns `decision: "rejected"`, reason `declared_permanent_outage`; `demo-run-service.ts` calls the admission for every start, admin included. | B. Hint says the run is refused at start. |
| Order of ERP checks | Not stated | Outage → capacity → delay → random error | `chaos-control-service.ts`: 503 outage, then 429 TPS, then sleep, then 503 error. | B. Failure rate hint says "confirmation calls", not "orders". |
| Duplicate attempts | Same idempotency key, API returns original reservation | Same request identity, reuses reservation | `k6-script.ts`: key `run:{id}:buyer:{__VU}` when duplicates on. | Both right; A's wording is more concrete and is kept. |
| Where the ERP definition goes | Legend hint | Visible sentence | n/a | B. Visible sentence; everything in the group depends on it. |
| Three inert fields | Honest "recorded only" hints | Visible qualification notes | No runtime consumer; hold and retry-after come from API env config. | Neither. Remove the fields as part of this task (§8.1). |
| Capacity unit | `orders/second` | `calls/second` | Retries hit the TPS limiter too. | B. |
| Section hints on admin `h2` | Yes | Not proposed | n/a | A, all seven panels (owner decision). Cheap orientation for admins who did not build the console, and "Recovery and cleanup" holds the most dangerous actions. |
| Sign-in and run-history search hints | Out of scope | Yes | n/a | B, low priority. One sentence each. |
| Budget windows | Fixed | Fixed, not rolling | `public-run-budget-store.ts`: `Math.floor(now / windowSeconds)`. | Both right. Hint says "fixed, not rolling". |
| Failure-rate terminal rule | Unsure, kept vague | "Not the final failed-order percentage" | Jobs are published with `attempts: 1`; retries are the worker's own deferrals (`erp-resilience-policy.ts`). Terminal rule is not simple. | Hint stays at "the worker retries them" and denies the wrong reading. |

## 8. Issues beyond tooltips

### 8.1 Remove the three inert run-config fields (part of this task)

The admin preset editor and the "Public custom defaults" form let an admin edit three settings. They are persisted in the accepted run snapshot and shown in run history, but nothing reads them at runtime:

| UI label | Snapshot field | What actually applies |
| --- | --- | --- |
| Hold minutes | `inventoryConfig.reservationHoldMinutes` | API env `RESERVATION_HOLD_MINUTES` (`apps/api/src/runtime/config.ts`, `reserve-order-service.ts` `expiresAt`) |
| Persistence retry seconds | `backpressureConfig.pendingPersistenceRetryAfterSeconds` | API env `PENDING_PERSISTENCE_RETRY_AFTER_SECONDS` (`reserve-order-service.ts` `pendingResponse`) |
| Quantity per checkout | `inventoryConfig.quantityPerCheckout` | Nothing. Requests use `trafficConfig.quantityPerAttempt` (see the `unique_acceptable_orders` assumption text in `demo-duration-estimator.ts`) |

This most likely comes from a UI and snapshot that were not updated after earlier runtime changes. Editing these fields misleads the operator, and any honest hint would have to say "this does nothing". Owner decision: remove them rather than document them. Since the cleanup stems from the same intent (forms an unfamiliar admin can trust), it is folded into this task instead of a separate one.

Work items:

- [x] Confirm the table above is still accurate: grep every consumer, including worker and load-orchestrator.
- [x] Remove the three inputs from the admin forms (`admin-feature-views.tsx` `inventoryFields` / `workerFields`, `EffectiveRunPreview` rows "Quantity per checkout", "Reservation hold minutes", "Pending retry after seconds"), from `admin-drafts.ts`, and from the run-history detail rows ("Configured hold (minutes)" and siblings).
- [x] Remove the fields from the write-side run-config contracts and preset seeds. Keep historical snapshots readable by accepting and ignoring the retired keys, following the existing `historicalAcceptedRunConfigSnapshotSchema` pattern.
- [x] Decide whether the persisted public runtime policy (`publicCustomDefaults`) needs a data migration or tolerant parsing of the retired keys.
- [x] Update affected tests: contracts, admin drafts, admin forms, run-history detail.

Non-goals: making these values configurable per run (that would be a feature, not this cleanup), and changing the env-driven hold and retry-after behaviour.

Ownership: web admin forms and drafts, shared contracts (`@checkout-surge/contracts`), preset seeds (`@checkout-surge/db`). Possibly the API runtime config if a consumer turns up during the confirmation step.

### 8.2 Error-rate unit: percent everywhere (decided)

Today the public form takes a percent (`percentToRatio` in `public-demo-entry.tsx`) while every admin form takes a raw fraction (`admin-drafts.ts`, constraint `Allowed range: 0–1.` from `intrinsicInputBounds`). Owner decision: the admin forms also take a percent. Scope of that change, to be done in the same pass as the admin hints (step 3 of §9):

- `admin-drafts.ts`: draft error-rate strings (`erpErrorRate` in `RunConfigDraft`, `maxErpErrorRate` in `RuntimePolicyDraft`, the ERP fallback draft) are percents in the UI and are converted to a 0 to 1 ratio when building the config, policy or chaos request, and back when loading a draft from a saved value. Reuse the public conversion helpers rather than adding new ones.
- Validation messages and `fieldLabels` that mention `0–1` now say percent.
- `intrinsicInputBounds`: error-rate constraint line becomes `Unit: percent. Minimum: 0. Maximum: N. Enter 25 for 25%.`, with the maximum taken from the safety cap or policy converted to a percent.
- Read-only displays (`EffectiveRunPreview`, ERP "Accepted run snapshot" and "Configured global fallback" rows, hard-cap facts if any) show a percent too, so the operator never sees `0.25` next to a field where they typed `25`.
- Tests on `admin-drafts` and the admin form components that assert the fraction are updated.

Contracts, API and Mock ERP are untouched: the stored value stays a ratio. This is a web presentation change, with a slightly larger footprint than the rest of the hint work.

### 8.3 `allowForcedOutage` has no control

It exists in the runtime-policy draft and validation labels but is not rendered. Since forced-outage runs are refused at admission anyway, leave it alone. Noted, not touched.

### 8.4 Smaller observations carried over

- Current-run facts show raw enum values (`Status: draining`) while the public side has `runLifecycleStatusLabel`. Consistency item, out of scope.
- Public preset card fact "Detailed assumptions" actually shows the outcome focus ("Stock depletes without overselling"). A label like "Expected outcome" would fit better. Out of scope.

## 9. Delivery plan

Boundary: web components and presentation for the hints, the label changes and the percent conversion. The inert-field removal (§8.1) additionally touches the write-side run-config contracts, preset seeds and their tests. No API, worker or Mock ERP behaviour changes.

Suggested order: do the removal first, so the hint wiring never has to handle fields that are about to disappear.

0. **Inert-field removal.** The checklist in §8.1: confirm consumers, drop the three inputs and preview rows, drop the draft keys, retire the contract fields with tolerant parsing of old snapshots, update seeds and tests.
1. **Component and copy module.** `FieldHint` with its tests: opens on focus and click, closes on Escape and outside click, accessible name, and a click on the icon does not toggle a wrapped checkbox. Plus `field-hints.ts`.
2. **Public form.** Wire §3, split constraint lines from meaning, add the Slow ERP intro sentence, change the Capacity unit. Update the public-form tests that assert helper text.
3. **Admin.** Section hints (§4.1), preset editor (§4.2 to §4.4), ERP (§4.5), policy (§4.6) with the label and constraint-line changes from §6, and the percent conversion for admin error-rate inputs (§8.2). Then the three small forms in §4.7.
4. **Browser pass.** Phone width, zoom, open `<details>`, keyboard only, one screen reader. Check bubble clipping and pointer transfer onto the bubble.

Tests, per the repo policy: test the component behaviour once; per form, one assertion that a hint is reachable and that the constraint line no longer contains the meaning sentence; for the percent change, one round-trip test in `admin-drafts` (25 in, 0.25 stored, 25 back). Do not snapshot every string.

## 10. Completion notes

- §8.1 consumer check confirmed the table: no worker, load-orchestrator or script reads the three snapshot values; hold and retry-after keep coming from API env config.
- Persisted data: owner decision, no SQL migration and no tolerant parsing for persisted presets or the public runtime policy. Existing local databases must be recreated with `pnpm runtime:wipe` then `pnpm runtime:setup`. Historical run snapshots still parse through the non-strict `historicalAcceptedRunConfigSnapshotSchema`, which drops the retired keys.
- The `public_reservation_hold_override_not_allowed` violation code was removed with the field.
- Percent helpers moved to `apps/web/src/app/lib/presentation/percent.ts` and are shared by the public form and admin drafts.
- The "Advanced protection settings" and "Effective run preview" hints sit inside their `<summary>` and do not toggle the `<details>`.
- Step 4 (browser pass) was only partly automated: hint visibility and keyboard behaviour inside `<summary>` were checked in a browser during review. Phone width, zoom, bubble clipping in narrow admin grids and a screen-reader pass remain to do manually.
- Per-form hint assertions were added for the public form, preset editor, public runtime policy and ERP fault injection; sign-in and run-history search have none (low value).
