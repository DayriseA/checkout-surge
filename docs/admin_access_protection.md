# Admin Access Protection - Decisions & Rationale

This document records the implemented access-protection model for the deployed demo admin surface. It is scoped to preventing abuse, accidental cost spikes, and unsafe failure-mode controls while preserving the public demo value of the dashboard.

---

## Goals

- Keep the deployed demo publicly inspectable so visitors can see live system behavior without an account.
- Prevent anonymous users, bots, or direct API callers from spamming expensive demo runs or repeatedly resetting demo state.
- Allow a trusted operator to inspect, save, duplicate, and archive presets, start runs, use recovery/reset tools, and bypass public run budgets within configured safety limits.
- Keep protection proportional to the project: explicit demo access control, not a full production identity platform.

## Non-Goals

- No customer storefront authentication.
- No full user-management system, OAuth flow, RBAC matrix, password recovery, or multi-tenant authorization model.
- No payment-grade security guarantees.
- No hard deployment split between public and admin applications unless a later hosting decision requires it.

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

The `/admin` page validates the signed cookie before rendering protected content. Anonymous responses mount only the passphrase sign-in client island. For an authenticated response, server-only readers attach the control token directly to protected upstream reads and pass only contract-validated, serializable results to focused client controllers. Mutations continue through the same-origin `/api/admin` proxies, so page-level rendering remains an additional exposure boundary rather than a replacement for proxy and service authorization.

The shared secret or passphrase must never be exposed through browser-readable JavaScript, `NEXT_PUBLIC_*` variables, or persisted client state. Frontend button visibility is only a usability layer; backend and service enforcement are the source of truth.

Unsafe browser admin requests must carry an exact `Origin` matching `WEB_ORIGIN`. Admin login attempts use bounded per-client and global windows in shared Redis in production and fail closed when Redis is unavailable. Caddy overwrites the internal client-identity and attestation headers; the web service accepts that identity only when the server-only `ADMIN_EDGE_ATTESTATION_SECRET` matches. Direct or host-native requests without that trusted edge assertion share the conservative `unknown` bucket; `Forwarded` and `X-Forwarded-For` are never trusted. The in-memory limiter is restricted to non-production development/test processes and does not provide multi-instance enforcement.

`WEB_ORIGIN` is a comma-separated exact allowlist of canonical HTTP or HTTPS origins. Entries with credentials, paths, queries, fragments, empty values, or mixed HTTP/HTTPS schemes are invalid. `ADMIN_SESSION_MAX_AGE_SECONDS`, `ADMIN_LOGIN_CLIENT_ATTEMPTS`, `ADMIN_LOGIN_GLOBAL_ATTEMPTS`, and `ADMIN_LOGIN_WINDOW_SECONDS` must be positive integers; only absent values receive the documented example defaults. Production additionally requires a valid `REDIS_URL` and non-placeholder `ADMIN_EDGE_ATTESTATION_SECRET`. Cookie `Secure` is derived only from the validated origin scheme: every HTTPS deployment is secure, while an intentional HTTP origin remains usable even when the production server build is exercised locally.

The passphrase decision hashes both inputs to fixed length before constant-time comparison. Admin session tokens are versioned and HMAC-authenticated before their payload is decoded; cookies are `HttpOnly`, `SameSite=Strict`, path-scoped to `/`, and `Secure` on configured HTTPS origins. All unsafe `/api/admin` requests, including session creation, pass through the exact-Origin check. The shared admin proxy guard adds the service token and privileged operator assertion only after session and CSRF admission succeeds.

Direct service endpoints that mutate demo state or start load must reject unauthenticated requests even if the dashboard hides the corresponding control.

---

## Public Controls

Public mutation should be narrow:

- Allow curated public preset starts and bounded public custom starts. Public custom values are run-scoped and are not saved as shared preset defaults.
- Enforce per-visitor and global public run budgets before starting another public demo run or public surge trigger.
- Reject requests when a run is already active or draining.
- Use a server-issued visitor identity rather than trusting browser-supplied forwarding headers.
- Apply shared-store run-budget limiting in the API layer.
- Reserve visitor/global budget atomically and release the exact reservation when a later synchronous start step rejects, so denied or failed starts do not burn capacity.
- Keep public starts inside API-enforced traffic caps.

Examples of acceptable public controls:

- Start a predefined public preset such as `preview-1k`, `surge-5k`, `surge-10k`, or `idempotency-check-200` when the public run budget allows another start.
- Start `public-custom` with bounded buyer count, inventory, ERP latency/error profile, and approved worker backpressure profiles.

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
- Use retained Mock ERP global chaos controls only as diagnostics/recovery controls outside the normal preset start workflow.
- Bypass public run budgets.

Admin authorization is not a substitute for safety limits. All dangerous controls must still enforce server-side caps so a typo, compromised browser session, or unexpected UI bug cannot request unbounded infrastructure work.

Reset is a fenced terminal workflow, not an unordered cleanup script. A session-scoped PostgreSQL advisory lock uses the same global key as run creation for the whole workflow, so a successor cannot start while cancellation or cleanup remains unresolved. For each recoverable run, the API claims the terminal transition under its run admission lock, closes Redis eligibility, installs the run-scoped traffic-metric fence, and calls the authenticated load-orchestrator abort endpoint with the exact run ID and canonical correlation ID. `no_current_run` is an idempotent success for that already-fenced candidate; a current-run mismatch is `409` and never signals the other run. Only confirmed termination permits reset-owned queue handling, a final business/inventory reread, immutable failed-summary insertion, and scoped live-projection clear. Admission, abort, queue, or summary failure leaves the claimed `failed/admin_reset` transition without a summary. Even after the session lock is released, run creation checks for that durable state under the same global advisory transaction and returns `409 demo_reset_incomplete`; a reset retry must write the missing summary before another traffic start can be delegated. Summary-backed historical resets and projection-only retries do not trigger this gate. Redis inspection or projection-clear failure still prevents reset success and retains safe retry state, but a post-summary clear retry does not duplicate history or re-abort a successor. Reset never flushes Redis, deletes historical summaries or inventory, or disconnects SSE clients.

The operational `runtime:reset` client owns cross-service coordination, not the API route. It calls the protected API reset first and then attempts protected Mock ERP `POST /chaos/reset` even when the API failed, using one correlation ID and bodyless requests. Each complete response, including its body read, has a practical 30-second default deadline. Partial results are sanitized so the exact service token cannot appear in messages or response-correlation output, printed per service, and return a nonzero exit. Mock ERP alone owns restoration of its four global chaos defaults; the API reset does not mutate that process-local configuration. Existing one-second TPS buckets and in-flight ERP calls remain bounded limitations rather than reset rollback claims.

---

## Configured Safety Caps

Dangerous-control caps must come from environment variables and be validated at service startup. They should not be hardcoded in route handlers, React components, or one-off utility functions.

Expected cap categories:

| Category | Example environment-backed limits |
| :-- | :-- |
| Public starts | Per-visitor starts per window, global public starts per window, public custom caps, and API-enforced traffic caps on buyer count, emitted attempts, steady requests per second, duration, and start delay. |
| Admin preset traffic | API-enforced traffic-mode-specific caps for saved/started preset snapshots. |
| Load-orchestrator internals | Limits for retained low-level k6 templates or diagnostics that stay inside the load-orchestrator boundary rather than the public/admin preset contract. |
| Mock ERP diagnostics | Maximum latency, minimum allowed TPS cap, maximum error rate, whether forced outage requires admin mode for retained global chaos controls. |
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
| Demo reset/recovery | No | No | Yes | Yes behind proxy | The protected API workflow uses exact-run confirmed traffic abort, blocks successor starts with `demo_reset_incomplete` until a missing summary is repaired, and keeps projection cleanup truthfully retryable; the separate operational client subsequently restores Mock ERP defaults and reports partial failure. |
| Queue reset/inspection controls | Limited reads | No | Yes | Yes behind proxy | Reads may be public only if sanitized and cheap. |
| Mock ERP chaos status | Yes | No | Optional | No | Read-only visibility helps explain failure modes. |
| Mock ERP chaos update/reset | No | No | Yes | Yes behind proxy | Retained global diagnostic controls are admin-only; normal ERP behavior comes from the run snapshot. |
| Public preset list/recovery reads | Yes | No | Optional | No | Safe read model for public dashboard; recovery reads must not expose secrets or internal service URLs. |
| Admin preset reads/saves/duplicates/archival | No | No | Yes | Yes behind proxy | Admins may inspect all presets and mutate only editable admin-only presets. Public presets are read-only and must be duplicated or copied to `Custom` before editing. Archival (soft delete) is limited to operator-created, non-system, non-custom, active admin presets; it requires UI confirmation and is enforced by the service, not just UI disabling. |
| Run History summaries and public-safe details | Yes | No | Optional | No | Historical summaries and sanitized detail DTOs are public portfolio data. The public detail DTO excludes reservation tokens, idempotency keys, raw event payloads, private headers, and unsafe operational controls. |
| Run History deletion | No | No | Yes | Yes behind proxy | Admins may delete one, selected, or all summaries; delete-all requires explicit confirmation. |
| Start demo run | Safe public preset or bounded public custom only | Capped, public-budget protected | Yes for all presets and admin configurations within deployment hard caps | Yes behind proxy | Direct service calls must enforce auth, traffic caps, public runtime policy for public principals, visibility, and active-run conflicts. Preset editability belongs to preset mutation endpoints, not run starts. |
| Load metrics/finalization reports | No | No | No | Yes | Internal service path only. |

---

## Implementation Boundary

- Dashboard session, signed visitor cookie issuance, and browser-facing proxy routes belong in `apps/web`.
- Public/admin runtime policy enforcement belongs in `apps/api`; Mock ERP and Load Orchestrator still enforce their own protected service-token boundaries rather than trusting the dashboard.
- Business workflows should remain in services; route handlers should parse, authorize, call services, and return responses.
- Rate limits and run budgets should use an explicit shared or injected store where needed, not module-level infrastructure clients.
- Shared request/response types and error vocabulary should live in `@checkout-surge/contracts` when they cross package boundaries.

Current implementation note: Every run start first authenticates the control-service channel. The principal (runner) is derived from the validated admin session at the Next.js proxy and asserted to the API on the operator-mode header, which the API honors only alongside a valid `CONTROL_SERVICE_TOKEN`; privilege is never read from the browser request body, which carries run intent only. Public starts also require the complete HMAC-signed server-issued visitor credential, independently verified by the API with the shared `PUBLIC_CLIENT_COOKIE_SECRET`. The cookie is issued for one year; the credential itself is a replayable bearer value and does not enforce expiry or key rotation. The public run budget is enforced by the API through a Redis reservation/release protocol keyed on the verified visitor. Admin starts bypass per-visitor/global budgets while still passing hard caps and active/draining lifecycle rules; public-mode starts fail closed. A run records `operatorMode`, and public run detail displays it. Public visitors may start only public-visible presets, and public visitor configuration is accepted only through the public custom flow under the public runtime policy. Admins may start public or admin presets with optional run-scoped configuration validated against deployment hard caps; this does not save changes back to read-only public presets. The public runtime policy is a PostgreSQL singleton for admin-tunable budgets, defaults, and limits. Setup environment values initialize it only when absent and setup reruns preserve admin edits. The seven API-owned cap values are mirrored into setup solely to validate/store a compatible first policy. API deployment configuration remains authoritative, overlays caps on every policy use/response, and validates the active policy before listening.

Run History implementation note: Public visitors may read paginated historical run summaries at `/run-history` and public-safe details for individual runs. Authenticated admins can hard-delete individual summaries, selected visible summaries, or all summaries. The delete-all path requires the `DELETE_ALL_RUN_SUMMARIES` confirmation value in addition to the admin session and service-token proxy boundary. Demo reset does not delete historical summaries.

Current preset/run implementation note: Public preset definitions are durable database rows seeded from checked-in defaults. Public presets are read-only, while admin-only presets are editable. `public-custom` is a read-only base preset used by the public UI for bounded run-scoped starts; submitted public custom values are validated by API policy and frozen into the run snapshot but never saved back to `public-custom` or `Custom`. The `Custom` preset remains a persisted admin-only scratch preset mutated only through preset management endpoints. A normal run start freezes the accepted configuration into `demo_runs.configSnapshot`, creates a generated run sale offer with isolated inventory, and uses API-enforced traffic caps for buyer count, emitted attempts, steady requests per second, duration, start delay, and optional admin steady-arrival VU controls. Operator-created admin preset copies (non-system, editable, non-custom) may be soft-archived through the protected `DELETE /admin/demo/presets` route, proxied by the signed admin-session web path with the server-owned control token and gated by a UI confirmation dialog. The API service independently enforces archival eligibility; public, `public-custom`, `Custom`, and seeded/system admin presets are rejected as `preset_not_archivable`. Archival sets `archived_at`, excludes the preset from active lists and lookups, and retains the row so historical `DemoRun` references and the reserved slug remain intact.

Current frontend route note: The public route `/` contains the visitor demo picker, bounded public custom controls, and the admin passphrase flow without navigating anonymous visitors into the dashboard shell. Public and admin starts navigate to `/watch` for current-run observation. Privileged preset editing, duplication, archival (with confirmation), reset/recovery, and ERP diagnostics live behind the authenticated `/admin` surface; direct anonymous `/admin` requests render only the sign-in gate. The watch route is backed by current-run dashboard recovery and realtime events; completed arbitrary run detail remains a Run History concern.

---

## Testing Expectations

Security-focused test coverage should include:

- Protected mutating endpoints reject anonymous requests.
- Browser-readable configuration does not expose admin or service secrets.
- Public preset and public custom starts are capped, public-budget protected, validated by API policy, and blocked during active/draining runs.
- Public custom submissions do not mutate persisted presets or future defaults.
- Public runtime policy updates require admin session and trusted proxy headers, persist in PostgreSQL, and reject values above deployment hard caps.
- Public run budget enforcement is covered by real Redis integration tests for visitor/global windows and release behavior.
- Public run detail reads expose the public-safe DTO and do not include reservation tokens, idempotency keys, raw event payloads, or unsafe operational controls.
- Admin preset saves and starts are capped by API environment-backed limits.
- Admin preset archival is protected by the admin-session web proxy and the API control token, requires UI confirmation, rejects public, `public-custom`, `Custom`, and seeded/system admin presets at the service boundary, and excludes archived presets from active lists, lookups, and run starts.
- Demo reset cannot run through a public path.
- Run History delete routes reject unauthenticated requests and require delete-all confirmation.
- Chaos updates reject unsafe values above configured caps.
- Internal ingestion endpoints reject missing or invalid service tokens.
- Realtime/read endpoints do not leak secrets or admin-only control material.

Manual verification should also include a deployed-demo checklist that exercises a public visitor flow and an authenticated admin flow separately.
