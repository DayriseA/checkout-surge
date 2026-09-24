# Admin Access Protection - Decisions & Rationale

This document records the implemented access-protection model for the local reference demo and the boundary a future hosted adaptation must preserve. It is scoped to preventing abuse, accidental cost spikes, and unsafe failure-mode controls while preserving the public demo value of the dashboard; it does not claim production-grade identity or hosted deployment readiness.

---

## Goals

- Keep the demo publicly inspectable so visitors can see live system behavior without an account.
- Prevent anonymous users, bots, or direct API callers from spamming expensive demo runs or repeatedly resetting demo state.
- Allow a trusted operator to inspect, save, duplicate, and archive presets, start runs, use recovery/reset tools, and bypass public run budgets within configured safety limits.
- Keep protection proportional to the project: explicit demo access control, not a full production identity platform.

## Non-Goals

- No customer storefront authentication.
- No full user-management system, OAuth flow, RBAC matrix, password recovery, or multi-tenant authorization model.
- No payment-grade security guarantees.
- No hard deployment split between public and admin applications unless a later hosting decision requires it.

These exclusions are classified in [Scope and Caveats](scope_and_caveats.md#intentional-non-goals); this section remains authoritative for the access-protection rationale.

---

## Access Modes

| Mode | Intended actor | Capabilities |
| :-- | :-- | :-- |
| Public viewer | Portfolio visitor | Read dashboard snapshots, observe realtime metrics on `/watch`, inspect run outcomes and history. |
| Public limited operator | Portfolio visitor trying the demo | Trigger curated public presets or a bounded, non-persistent public custom run from `/`; starts are public-budget protected, capped, and blocked while another run is active or draining. |
| Admin operator | Project owner or trusted reviewer | Use `/admin` to inspect all presets, run public presets, save editable admin presets, use the `Custom` scratch preset, duplicate/copy presets, archive accidental operator-created preset copies, reset or recover demo state, delete run history, and bypass public run budgets within configured caps. |

The public dashboard should remain useful without credentials. Credentials are required when an action can create meaningful infrastructure load, erase demo state, hide evidence, or degrade the simulated downstream system.

---

## Protection Model

Use a lightweight server-side dashboard session/proxy model:

1. The Next.js dashboard exposes a passphrase-based admin login.
2. Successful login sets a signed `HttpOnly` session cookie.
3. Browser clients call Next.js dashboard API routes for control actions.
4. Next.js server routes proxy protected calls to the owning API or Mock ERP boundary. Normal demo starts go to the API, which owns the lifecycle and delegates accepted traffic execution to the Load Orchestrator.
5. Service-to-service calls use private tokens from environment variables.

The root layout and `/admin` page validate the signed cookie before rendering protected content. All responses include an Admin navigation link; anonymous requests to `/admin` mount only the passphrase sign-in client island, while authenticated responses also include a sign-out action that clears the same HttpOnly cookie. Run History stays publicly readable but mounts selection and deletion controls only for a server-validated admin session. For an authenticated response, server-only readers attach the control token directly to protected upstream reads and pass only contract-validated, serializable results to focused client controllers. Sign-in, sign-out, and expired-session handling refresh the server route so browser state never becomes the authorization source. Mutations continue through the same-origin `/api/admin` proxies, so page-level rendering remains an additional exposure boundary rather than a replacement for proxy and service authorization.

The shared secret or passphrase must never be exposed through browser-readable JavaScript, `NEXT_PUBLIC_*` variables, or persisted client state. Frontend button visibility is only a usability layer; backend and service enforcement are the source of truth.

The browser-facing BFF never copies the incoming browser header set to an internal service request. Proxy requests use a fresh allow-listed header set containing JSON negotiation, the normalized correlation header, and only the server-owned control token, operator-mode assertion, or signed public visitor credential required by that route. Browser cookies, raw passphrases, session material, authorization headers, browser-supplied service tokens, and arbitrary headers remain at the web boundary. Public, watch, and authenticated admin server rendering does not make credentialless dashboard recovery calls. Instead, each mounted browser converges through the recovery BFF, which mints or reuses the HttpOnly signed visitor cookie; caller-supplied visitor identity headers are ignored. This keeps process-local per-visitor recovery budgets separate and prevents the web container's fallback network identity from becoming a shared browser bucket. Backend errors are returned only after strict canonical-envelope validation; malformed responses are replaced with a safe BFF-owned `502` envelope. Browser readers also validate the shared error envelope before exposing its safe message, status, error code, correlation ID, and bounded delta-seconds retry guidance.

Unsafe browser admin requests must carry an exact `Origin` matching `WEB_ORIGIN`. The sole web process applies bounded process-local per-client and global token buckets to admin login attempts. A valid HMAC-signed public visitor cookie supplies the client UUID when one already exists; the login route does not mint an identity, and requests with an absent or invalid cookie share the conservative `unknown` bucket. The global bucket still bounds aggregate attempts when visitor cookies are refreshed or rotated. Caller-supplied identity headers, `Forwarded`, and `X-Forwarded-*` are never trusted. This policy resets on web-process restart and intentionally makes no cross-instance limiting claim because multiple web processes are outside the accepted local topology.

`WEB_ORIGIN` is a comma-separated exact allowlist of canonical HTTP or HTTPS origins. Entries with credentials, paths, queries, fragments, empty values, or mixed HTTP/HTTPS schemes are invalid. `ADMIN_SESSION_MAX_AGE_SECONDS`, `ADMIN_LOGIN_CLIENT_ATTEMPTS`, `ADMIN_LOGIN_GLOBAL_ATTEMPTS`, and `ADMIN_LOGIN_WINDOW_SECONDS` must be positive integers; only absent values receive the documented example defaults. Cookie `Secure` is derived only from the validated origin scheme: every HTTPS deployment is secure, while an intentional HTTP origin remains usable even when the production server build is exercised locally.

The passphrase decision hashes both inputs to fixed length before constant-time comparison, and absent or incorrect passphrases receive the same authentication failure. Exhausted login buckets return bounded `Retry-After` guidance without consulting credentials. Admin session tokens are versioned and HMAC-authenticated before their payload is decoded; cookies are `HttpOnly`, `SameSite=Strict`, path-scoped to `/`, and `Secure` on configured HTTPS origins. All unsafe `/api/admin` requests, including session creation, pass through the exact-Origin check. The shared admin proxy guard adds the service token and privileged operator assertion only after session and CSRF admission succeeds.

Direct service endpoints that mutate demo state or start load must reject unauthenticated requests even if the dashboard hides the corresponding control.

---

## Public Controls

Public mutation should be narrow:

- The dashboard at `/demo` is the only supported public-start client. There is no supported direct or integration public API client.
- Allow curated public preset starts and bounded public custom starts. Public custom values are run-scoped and are not saved as shared preset defaults.
- Enforce per-visitor and global public run budgets before starting another public demo run or public surge trigger.
- Reject requests when a run is already active or draining.
- Use a server-issued visitor identity rather than trusting browser-supplied forwarding headers.
- Apply shared-store run-budget limiting in the API layer.
- Reject over-ceiling or unestimable starts before reserving any visitor/global budget.
- Reserve visitor/global budget atomically and release the exact reservation when a later synchronous start step rejects, so denied or failed starts do not burn capacity.
- Keep public starts inside API-enforced traffic caps. Public and admin preset/custom starts also require a finite conservative occupancy estimate at or below the effective `estimatedDemoOccupancyCeilingSeconds` (600-second default/deployment maximum); admin has no bypass. Recompute from current policy/preset under the global start lock, after run-conflict checks and before budget reservation or creation.

The API preview `POST /demo/runs/estimate` uses the same strict request intent, control-service token, operator-mode assertion, and signed public visitor verification as start. It returns HTTP 200 for allowed or rejected estimates without a lock, budget consumption, or run side effects. Start rejects with HTTP 400 `estimated_duration_rejected`; its details contain the reason, finite duration only when estimable, bottleneck, effective ceiling, estimator/engine identities and adjustment guidance. Browser estimate fields cannot influence start. The web preview proxy and its Origin/read-limiting controls belong to task 17; existing start CSRF checks remain unchanged.

Examples of acceptable public controls:

- Start a predefined public preset such as `preview-1k`, `surge-5k`, `surge-10k`, `slow-erp-5k`, `laggy-erp-5k`, or `idempotency-check-200` when the public run budget allows another start.
- Start `public-custom` with bounded buyer count, starting stock, ERP latency/error profile, start delay, and buyer-spike safety cutoff. Worker/backpressure, retry, circuit, reservation-hold, and ERP request-timeout settings remain policy/deployment controlled; the shared accepted-snapshot validator rejects public custom deviations from the protected defaults. The dashboard always submits `forcedOutage: false` and never exposes an outage control, even if a permissive runtime-policy response is received. The retained persisted `forcedOutage` default, `allowForcedOutage` limit, and validator rule are API-boundary defense only; they do not describe a supported non-dashboard client or a dashboard-configurable capability.

Examples of controls that should not be public:

- Demo reset.
- Queue reset or obliteration.
- Forced ERP outage.
- Arbitrary request count, duration, virtual-user, ramp-stage, or long-duration load runs outside the API public runtime policy.
- Large error-rate changes that can make the demo look broken for later visitors.
- Internal metric ingestion or demo-run finalization reports.

---

## Admin Controls

Admin operators can use the full demo surface:

- Start any public or admin-only preset.
- Save editable admin presets and the persisted `Custom` scratch preset.
- Duplicate public presets into editable admin-only presets or copy a preset into `Custom`.
- Archive accidental operator-created preset copies. Only editable, non-custom, non-system, active admin presets are archivable; public presets, `public-custom`, the persisted `Custom` preset, and seeded/system admin presets cannot be archived. Archival is a soft delete that removes the preset from active lists and lookups while retaining the row and historical `DemoRun` references. The archive action is protected by both the signed admin-session web proxy and the API control token, requires UI confirmation, and is independently guarded by the service predicate. Archived slugs remain reserved by the global unique index and cannot be reused.
- Start editable admin presets after the accepted configuration has been saved.
- Reset demo state as a recovery/local-maintenance action: globally serialize run starts with reset, fence any starting, active, or draining run as failed, close admission and metric ingestion, confirm exact-run traffic termination, handle reset-owned queues, write immutable summaries, and clear only the affected live dashboard projection.
- Use retained Mock ERP global fallback fault-injection controls. Normal run processing uses the ERP configuration frozen in the accepted run snapshot; global values govern non-run calls and are fallback only when a request has no snapshot configuration.
- Bypass public run budgets.

Admin authorization is not a substitute for safety limits. All dangerous controls must still enforce server-side caps so a typo, compromised browser session, or unexpected UI bug cannot request unbounded infrastructure work.

Reset is a fenced terminal workflow, not an unordered cleanup script. A session-scoped PostgreSQL advisory lock uses the same global key as run creation for the whole workflow, so a successor cannot start while cancellation or cleanup remains unresolved. For each recoverable run, the API claims the terminal transition under its run admission lock, closes Redis eligibility, installs the run-scoped traffic-metric fence, and calls the authenticated load-orchestrator abort endpoint with the exact run ID and canonical correlation ID. `no_current_run` is an idempotent success for that already-fenced candidate; a current-run mismatch is `409` and never signals the other run. Only confirmed termination permits bounded reset-owned queue handling and a final business/inventory reread. The API writes one immutable failed summary, purges the run's orders, reservations, processing/control evidence, ERP attempts and ledger entries, notifications, finalization evidence, resilience state, and run-scoped Redis state, then stamps `admin_reset_completed_at`. The run row, summary, closed generated sale offer, and ownership context remain so history and later exact teardown still work. A failure before the marker leaves the claimed `failed/admin_reset` transition retryable; the existing incomplete-reset admission gate blocks a successor until retry finishes the idempotent purge. Projection-only retries remain marker-backed and do not duplicate history. Reset does not disconnect SSE clients or change unrelated/catalog state.

During incomplete reset recovery, Admin disables every start action and offers Reset retry; Watch identifies operator-stop recovery and unavailable history, and public entry explains temporary unavailability without admin controls. The global projection state comes from the durable null-marker predicate, including fresh navigation and API restart without a sale offer. Active selected queue work has at most 5 seconds to settle, capped at 25 seconds elapsed since reset processing began to reserve 5 seconds within the 30-second client budget after the possible 20-second abort. If that grace period expires, reset removes non-active jobs, leaves active locked jobs alone, restores owned pauses, and completes the destructive purge so successor admission can reopen. Post-marker projection/shared-state failure is explicitly partial cleanup and does not block admission.


The web “Reset demo” action invokes only the API-owned reset above; global ERP fault injection is not changed by that reset. The operational `runtime:reset` client is the full-reset path and owns cross-service coordination, not the API route or React. It calls the protected API reset first and then attempts protected Mock ERP `POST /chaos/reset` even when the API failed, using one correlation ID and bodyless requests. Each complete response, including its body read, has a practical 30-second default deadline. Partial results are sanitized so the exact service token cannot appear in messages or response-correlation output, printed per service, and return a nonzero exit. Mock ERP alone owns restoration of its four process-local global fallback defaults; direct global edits persist until changed, reset, or Mock ERP restarts. Accepted arrivals in the process-local rolling one-second TPS limiter and in-flight ERP calls remain bounded limitations rather than reset rollback claims.

---

## Configured Safety Caps

Dangerous-control caps must come from environment variables and be validated at service startup. They should not be hardcoded in route handlers, React components, or one-off utility functions.

Expected cap categories:

| Category | Example environment-backed limits |
| :-- | :-- |
| Public starts | Per-visitor starts per window, global public starts per window, public custom caps, and API-enforced traffic caps on buyer count, emitted attempts, constant-arrival requests per second, duration, and start delay. |
| Admin preset traffic | API-enforced traffic-mode-specific caps for saved/started preset snapshots. |
| Load-orchestrator internals | Limits for retained low-level k6 templates or diagnostics that stay inside the load-orchestrator boundary rather than the public/admin preset contract. |
| Mock ERP fault injection | Maximum latency, minimum allowed TPS cap, maximum error rate, whether forced outage is allowed for retained global fallback controls. |
| Demo reset/recovery | Public reset disabled; admin reset globally excludes new starts, fences the exact run, confirms load termination within the API's distinct 20-second abort-response deadline, handles reset-owned queues, writes immutable truth, and clears only that run's live projection. |
| Realtime/read paths | Connection limits, request rate limits, maximum snapshot page sizes. |
| Internal ingestion | Required service token, accepted caller identity, maximum metric/run-summary payload size. |

The local defaults and environment names are documented in `docs/local_development.md`. A hosted deployment must choose deployment-specific values instead of reusing those examples.

---

## Endpoint Policy Matrix

| Surface | Public read | Public mutate | Admin session | Service token | Notes |
| :-- | :-: | :-: | :-: | :-: | :-- |
| Admin session creation | No | No | Created on success | No | Exact trusted Origin, per-client/global login admission, and constant-time passphrase verification are required. |
| Dashboard snapshot/status reads | Yes | No | Optional | No | Public portfolio visibility is intentional. |
| Dashboard realtime connection | Yes | No | Optional | No | Payloads must not include secrets or unsafe control tokens. |
| Demo reset/recovery | No | No | Yes | Yes behind proxy | The protected API workflow uses exact-run confirmed traffic abort, blocks successor starts with `run_conflict` / `details.conflictReason = reset_incomplete` until the missing `admin_reset_completed_at` completion marker is repaired, and keeps projection cleanup truthfully retryable; the separate operational client subsequently restores Mock ERP defaults and reports partial failure. |
| Queue reset/inspection controls | Limited reads | No | Yes | Yes behind proxy | Reads may be public only if sanitized and cheap. |
| Mock ERP chaos status | Yes | No | Optional | No | Read-only visibility helps explain failure modes. The response intentionally includes the effective non-sensitive safety caps used to describe and validate admin inputs; knowing these clamps grants no mutation authority. |
| Mock ERP chaos update/reset | No | No | Yes | Yes behind proxy | Retained global diagnostic controls are admin-only; normal ERP behavior comes from the run snapshot. |
| Public preset list/recovery reads | Yes | No | Optional | No | Safe read model for public dashboard; recovery reads must not expose secrets or internal service URLs. |
| Admin preset reads/saves/duplicates/archival | No | No | Yes | Yes behind proxy | Admins may inspect all presets and mutate only editable admin-only presets. Public presets are read-only and must be duplicated or copied to `Custom` before editing. Archival (soft delete) is limited to operator-created, non-system, non-custom, active admin presets; it requires UI confirmation and is enforced by the service, not just UI disabling. |
| Run History summaries and aggregate details | Yes | No | Optional | No | Historical summaries and strict aggregate detail DTOs are public portfolio data. Public detail omits row collections, persisted identifiers/correlation data, event sources, free-form diagnostics, and sale-offer IDs. |
| Run History admin aggregate detail | No | No | Yes | Yes server-side | No live per-order presentation exists on any surface. The distinct admin path requires a validated page session at the web boundary and a server-only reader's control token at the API boundary before richer protected aggregates (internal failure reason, load-generator diagnostics, ERP attempt summaries) are read; it exposes no row collections and no identifier search. |
| Run History deletion | No | No | Yes | Yes behind proxy | Admins may delete one, selected, or all summaries; delete-all requires explicit confirmation. |
| Start demo run | Safe public preset or bounded public custom only | Capped, public-budget protected | Yes for all presets and admin configurations within deployment hard caps | Required for every start | The API first authenticates the service token. Public mode additionally requires the signed visitor credential; admin mode additionally depends on the web proxy's validated page session before it asserts operator mode. Traffic caps, visibility, policy, and active-run conflicts still apply. |
| Load metrics/finalization reports | No | No | No | Yes | Internal service path only. |

---

## Implementation Boundary

- Dashboard session, signed visitor cookie issuance, and browser-facing proxy routes belong in `apps/web`.
- Public/admin runtime policy enforcement belongs in `apps/api`; Mock ERP and Load Orchestrator still enforce their own protected service-token boundaries rather than trusting the dashboard.
- Business workflows should remain in services; route handlers should parse, authorize, call services, and return responses.
- Rate limits and run budgets should use an explicit shared or injected store where needed, not module-level infrastructure clients.
- Shared request/response types and error vocabulary should live in `@checkout-surge/contracts` when they cross package boundaries.

Current implementation note: Every run start first authenticates the control-service channel. The principal (runner) is derived from the validated admin session at the Next.js proxy and asserted to the API on the operator-mode header, which the API honors only alongside a valid `CONTROL_SERVICE_TOKEN`; privilege is never read from the browser request body, which carries run intent only. Public starts also require the complete HMAC-signed server-issued visitor credential, independently verified by the API with the shared `PUBLIC_CLIENT_COOKIE_SECRET`. The service token authenticates the server-side caller, while the visitor credential supplies an anonymous budget principal; neither is human identity, production-grade abuse prevention, or a substitute for deployment network controls and rate limiting. The cookie is issued for one year; the credential itself is a replayable bearer value and does not enforce expiry or key rotation. The public run budget is enforced by the API through a Redis reservation/release protocol keyed on the verified visitor. Admin starts bypass per-visitor/global budgets while still passing hard caps and active/draining lifecycle rules; public-mode starts fail closed. A run records `operatorMode`, and public run detail displays it. Public visitors may start only public-visible presets, and public visitor configuration is accepted only through the public custom flow under the public runtime policy. Admins may start public or admin presets with optional run-scoped configuration validated against deployment hard caps; this does not save changes back to read-only public presets. The public runtime policy PostgreSQL singleton contains only admin-tunable budgets, defaults, and limits. Setup environment values initialize it only when absent and setup reruns preserve admin edits. API deployment configuration is the sole hard-cap source; the API combines current caps with the strict mutable row for every effective response and enforcement decision, and rejects an incompatible active policy before listening.

Run History implementation note: Public visitors may read a purpose-built complete comparison list at `/run-history` and aggregate-only details for individual runs. Each ordinary list row shows the scenario with its comparison facts and one report link. A run whose failure reason is `admin_reset` is instead labelled “Cancelled”; its detail states that experiment data was discarded and does not render the purged collections as a real result. Authenticated history uses the same derived presentation plus administrator-only deletion controls. The run row and its one immutable summary remain after reset, so single, selected, delete-all, retention, and exact-teardown paths continue to work for cancelled entries. Both representations are `no-store`.

Current preset/run implementation note: Public preset definitions are durable database rows seeded from checked-in defaults. Public presets are read-only, while admin-only presets are editable. `public-custom` is a read-only base preset used by the public UI for bounded run-scoped starts; submitted public custom values are validated by API policy and frozen into the run snapshot but never saved back to `public-custom` or `Custom`. The `Custom` preset remains a persisted admin-only scratch preset mutated only through preset management endpoints. A normal run start freezes the accepted configuration into `demo_runs.configSnapshot`, creates a generated run sale offer with isolated inventory, and uses API-enforced traffic caps for buyer count, emitted attempts, constant-arrival requests per second, duration, start delay, and resolved automatic or explicit constant-arrival VUs. Operator-created admin preset copies (non-system, editable, non-custom) may be soft-archived through the protected `DELETE /admin/demo/presets` route, proxied by the signed admin-session web path with the server-owned control token and gated by a UI confirmation dialog. The API service independently enforces archival eligibility; public, `public-custom`, `Custom`, and seeded/system admin presets are rejected as `preset_conflict` with `details.conflictReason = not_archivable`. Archival sets `archived_at`, excludes the preset from active lists and lookups, and retains the row so historical `DemoRun` references and the reserved slug remain intact.

Current frontend route note: The public route `/demo` keeps the response-driven public preset picker primary, exposes each preset's technical facts in an independent disclosure, and puts bounded `public-custom` controls behind a grouped "Customize a scenario" disclosure that stays mounted while collapsed. The custom form derives limits and shared-budget copy from runtime policy, shows the planned emitted-attempt total, never offers or submits forced outage, exposes no edit path for worker/backpressure, retry, circuit, reservation-hold, or ERP request-timeout settings, and omits the backpressure override. The required nested inventory and ERP override groups carry the exact protected reservation-hold and request-timeout defaults. Public and admin starts navigate to `/watch` for current-run observation (public starts append the accepted `acceptedRunId` so Watch can link that exact public result through the same-origin `/api/demo/runs/history/[runId]` read proxy; the parameter is navigation context, not authorization); Watch itself is observation-only and contains no second hard-coded preset catalog. Privileged preset editing, duplication, archival, reset/recovery, generated-run cleanup, and global ERP fault injection live behind the authenticated `/admin` surface. High-impact shared mutations use the reusable accessible native confirmation dialog with effective scope/timing summaries, browser-managed stacking, inertness, focus containment/restoration, Escape routing, application-owned pending lockout, and retryable errors. Global navigation links to `/admin`, where direct anonymous requests render only the sign-in gate. The watch route is backed by current-run dashboard recovery and realtime events; completed arbitrary run detail remains a Run History concern.

---

## Testing Expectations

Security-focused test coverage should include:

- Protected mutating endpoints reject anonymous requests.
- Browser-readable configuration does not expose admin or service secrets.
- Public preset and public custom starts are capped, public-budget protected, validated by API policy, and blocked during active/draining runs.
- Public custom submissions do not mutate persisted presets or future defaults.
- Public runtime policy updates require admin session and trusted proxy headers, persist in PostgreSQL, and reject values above deployment hard caps.
- Public run budget enforcement is covered by real Redis integration tests for visitor/global windows and release behavior.
- Public run detail reads expose only the strict aggregate DTO and do not include row records, persisted identifiers/correlation data, event sources, free-form diagnostics, reservation tokens, idempotency keys, raw event payloads, or unsafe operational controls; protected admin detail retains richer protected aggregates but no row collections and no identifier search.
- Admin preset saves and starts are capped by API environment-backed limits.
- Admin preset archival is protected by the admin-session web proxy and the API control token, requires UI confirmation, rejects public, `public-custom`, `Custom`, and seeded/system admin presets at the service boundary, and excludes archived presets from active lists, lookups, and run starts.
- Demo reset cannot run through a public path.
- Run History delete routes reject unauthenticated requests and require delete-all confirmation.
- Chaos updates reject unsafe values above configured caps.
- Internal ingestion endpoints reject missing or invalid service tokens.
- Realtime/read endpoints do not leak secrets or admin-only control material.

Manual verification should also include a deployed-demo checklist that exercises a public visitor flow and an authenticated admin flow separately.
