# Task 11: Remove default control-plane credentials and unnecessary published ports from the Docker Compose runtime

## Execution context

- **Execution order:** This is task 11 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P0 (deployment blocker)
- **Area:** security / deployment
- **Source:** independent review (high)
- **Retrieved implementation context:** The donor and reference behavior, exact adaptation points, and combined target design are recorded below. No other checkout or branch is required to implement this task.
- **Locations:** `docker-compose.yml:3`, `apps/api/src/runtime/config.ts:60`, `apps/web/src/app/lib/server/backend-proxy.ts:23`

Production compose supplies checked-in fallback control-token, admin-passphrase, and session secrets; services validate only non-emptiness; compose publishes every service port to the host. Anyone who has read the repository gets working credentials for admin reset, cleanup, history deletion, preset mutation, unsafe starts, and ERP chaos — bypassing the web session entirely.

## Current base behavior and exact ownership

The defect spans configuration composition and the startup boundary; it is not an authorization-route rewrite.

- Root `docker-compose.yml` defines `CONTROL_SERVICE_TOKEN` in the shared `x-app-env` anchor as `${CONTROL_SERVICE_TOKEN:-change-me-shared-control-token}`. That anchor is inherited by API, worker, Mock ERP, load orchestrator, web, and `runtime-setup`, even though only API, Mock ERP, load orchestrator, and web consume the token. This unnecessarily distributes the control credential to worker and setup containers.
- The web service additionally supplies `${ADMIN_DASHBOARD_PASSPHRASE:-change-me-admin-passphrase}`, `${ADMIN_SESSION_SECRET:-change-me-admin-session-secret}`, and `${PUBLIC_CLIENT_COOKIE_SECRET:-change-me-public-client-cookie-secret}`. Because Compose runs application images with `NODE_ENV: production`, these are production credentials, not merely source-code examples.
- Root `.env.example` and the app-specific `.env.example` files contain the same `change-me-*` values. More importantly, `scripts/env-utils.mjs` includes root and package `.env.example` files in `runtimeEnvFilePaths()` before loading private `.env` overrides. Therefore the examples currently act as executable runtime defaults for every `pnpm ...` command wrapped by `scripts/run-with-env.mjs`; changing Compose alone does not remove the fallback.
- `apps/api/src/runtime/config.ts` (`loadApiConfig` / `requireEnv`) requires only a non-empty `CONTROL_SERVICE_TOKEN`. `apps/mock-erp/src/runtime/config.ts` (`loadMockErpConfig` / `requireEnv`) and `apps/load-orchestrator/src/runtime/config.ts` (`loadLoadOrchestratorConfig` / `requireEnv`) do the same. A checked-in placeholder passes all three loaders.
- The worker has no control-plane credential in `WorkerConfig` and should not gain one. “Every service” in this task means every process that consumes a security-sensitive credential, not forcing irrelevant secrets into worker or setup configuration.
- The web has no startup config loader for these secrets. `apps/web/src/app/lib/server/backend-proxy.ts` reads `ADMIN_DASHBOARD_PASSPHRASE`, `ADMIN_SESSION_SECRET`, and `CONTROL_SERVICE_TOKEN` lazily in `requireAdminPassphrase`, `requireAdminSession`, `createAdminSessionCookie`, and `requireControlServiceToken`; missing values yield request-time `503` responses. `apps/web/src/app/lib/server/public-visitor.ts` likewise reads `PUBLIC_CLIENT_COOKIE_SECRET` at request time. Non-empty public placeholders therefore remain accepted, and a misconfigured web process can start successfully.
- The protected effects are real even when the web session is bypassed: API route guards use the shared token for reset, maintenance cleanup, run-history deletion, preset/runtime-policy mutation, and privileged run operations; Mock ERP chaos routes use it for update/reset; load orchestrator control routes use it for traffic starts. The service token is the direct-service trust boundary.
- Root Compose publishes PostgreSQL `5432`, Redis `6379`, API `4000`, worker health `4300`, Mock ERP `4100`, load orchestrator `4200`, web `3000`, and Caddy/dashboard proxy `8080`. Container-to-container calls, `depends_on`, and container health checks use Compose DNS or loopback and do not require host publication. The intended browser entry point is already the single-origin Caddy service on `8080`.

## Donor and reference findings (already retrieved)

### Opus behavior worth adapting

Opus root `docker-compose.yml` removes literal `change-me-*` credential substitutions. Application services use an optional root `.env` through the `x-app-env-file` / `env_file` anchor, while container-network URLs remain explicit per-service overrides. This is the useful Compose pattern: secrets come from external runtime configuration rather than YAML defaults.

Do not copy Opus’s claim that every service fails fast. Its actual implementation has gaps:

- `apps/api/src/runtime/config.ts` assigns `optionalString(env, "CONTROL_SERVICE_TOKEN")` to optional `ApiConfig.controlServiceToken`.
- `apps/mock-erp/src/runtime/config.ts` and `apps/load-orchestrator/src/runtime/config.ts` also make the token optional.
- Their route guards fail closed with `503` when no token exists, but the processes still boot. That is safer than an open route but does not meet this deployment-blocker’s startup-validation requirement.
- Its web helpers in `apps/web/src/lib/admin-auth.ts` return possibly undefined environment values rather than validating the complete secret set at startup.
- Opus still publishes all eight host ports, so it provides no solution for the network-exposure half of this task.

### GLM behavior worth adapting

GLM provides a focused web startup-validation design in `apps/web/lib/config.ts` and `apps/web/instrumentation.ts`:

- `validateProductionSecrets()` enumerates `ADMIN_DASHBOARD_PASSPHRASE`, `ADMIN_SESSION_SECRET`, `PUBLIC_CLIENT_COOKIE_SECRET`, and `CONTROL_SERVICE_TOKEN`, trims them, reports all offenders in one startup error, and rejects both unset values and the known committed sentinel strings.
- Next.js `instrumentation.ts` calls the validator from `register()`, giving the standalone production server a process-start boundary rather than discovering bad configuration during an admin request.
- `apps/web/tests/config.test.ts` covers unset, whitespace-only, sentinel, partially invalid, fully configured, and local-bypass cases.

Do not copy GLM’s local bypass or fallback behavior as-is. Its root Compose still supplies every `change-me-*` default and sets `ALLOW_INSECURE_SECRETS: "1"`, which disables the production validator for the standard Compose runtime. Its API config (`apps/api/src/app/config.ts`) also falls back to the known control token and public-cookie secret, and its other services do not apply equivalent sentinel rejection. The useful donor material is the aggregate validation and startup hook, not the escape hatch.

### `checkout-forge` reference behavior

Forge confirms the expected configuration shapes but is not a security solution. Its `apps/api/src/config.ts`, `apps/mock-erp/src/config.ts`, and `apps/load-orchestrator/src/config.ts` use Zod `requiredStringEnv("CONTROL_SERVICE_TOKEN")`, which rejects missing/blank values at startup but accepts the public placeholder. Its worker config does not consume the token. Forge web reads the dashboard secrets at request boundaries, while its root Compose still supplies the same known fallbacks and publishes every service port. Use the service ownership and typed-loader shapes for orientation only.

## Required combined design

Implement the strictest useful combination rather than copying any donor wholesale.

1. **Remove executable credential defaults.** In root `docker-compose.yml`, remove every `:-change-me-*` secret fallback. Stop placing `CONTROL_SERVICE_TOKEN` in the broad shared anchor; inject it only into `api`, `mock-erp`, `load-orchestrator`, and `web`. Inject the three web-only secrets only into `web`. Worker and `runtime-setup` must not receive control-plane or cookie credentials. Preserve non-secret operational defaults and internal service URLs.
2. **Make examples non-executable as credentials.** Account for `scripts/env-utils.mjs` loading `.env.example` automatically. Secret example entries must be blank/documentary, or runtime environment loading must stop treating example secret values as defaults. A private root `.env` (or deployment secret provider) supplies real values. Do not replace one repository-wide known secret with a different known secret. Keep documentation clear that developers must generate distinct values and must not reuse the admin-session and public-visitor HMAC secrets.
3. **Validate at each owning process’s startup.** API, Mock ERP, and load orchestrator loaders must reject missing, blank, and known checked-in placeholder values for `CONTROL_SERVICE_TOKEN` before listening. Web must resolve and validate all four of its required secrets once at server startup, ideally through a typed server-only config module plus a Next instrumentation `register()` hook suited to the current `apps/web` layout. Retain request guards as defense in depth, but do not rely on their `503` behavior as configuration validation.
4. **Do not add a standard-runtime bypass.** The normal production Compose path must not set `ALLOW_INSECURE_SECRETS` or an equivalent escape hatch. If an intentionally insecure fixture is ever necessary for tests, keep it confined to test-only configuration; it is not acceptable in root runtime Compose or normal dev commands.
5. **Publish only the intended edge in the base runtime.** Keep host publication for `dashboard-proxy` on `8080`; remove base-runtime publications for `3000`, `4000`, `4100`, `4200`, `4300`, `5432`, and `6379`. Internal `expose` metadata is optional and does not create a security boundary; Compose-network reachability and existing health checks work without it.
6. **Preserve explicit host-native/debug workflows without reopening the default.** `pnpm infra:up` currently depends on host access to PostgreSQL and Redis, while `health:check`, `runtime:reset`, `runtime:smoke:load`, and `maintenance:cleanup-runs` contain direct localhost service URLs. Move genuinely needed publications to a deliberate development/debug Compose override or profile, bind them to `127.0.0.1`, and update the owning scripts/docs to opt into it. Prefer the `8080` edge for browser/runtime smoke behavior and container-network execution for internal maintenance where practical. Do not silently leave direct ports in the base file merely to avoid adjusting these callers.
7. **Keep configuration errors non-secret.** Errors may list offending variable names and explain that values are missing/known placeholders, but must never echo configured values. Compare against the already-known placeholder deny-list only; do not log real secrets.

## Service-by-service adaptation map

| Service | Required sensitive values | Code/config boundary | Required result |
| --- | --- | --- | --- |
| API | `CONTROL_SERVICE_TOKEN` | `docker-compose.yml`; `apps/api/src/runtime/config.ts` `loadApiConfig` / `requireEnv` | Token is injected only here and other consumers; loader refuses missing/blank/known-placeholder input before `apps/api/src/index.ts` starts the server. Existing route guards and service composition remain unchanged. |
| Mock ERP | `CONTROL_SERVICE_TOKEN` | `docker-compose.yml`; `apps/mock-erp/src/runtime/config.ts` `loadMockErpConfig` / `requireEnv` | Process refuses unsafe token before exposing confirmation/chaos routes; keep chaos safety-cap parsing unchanged. |
| Load orchestrator | `CONTROL_SERVICE_TOKEN` | `docker-compose.yml`; `apps/load-orchestrator/src/runtime/config.ts` `loadLoadOrchestratorConfig` / `requireEnv` | Process refuses unsafe token before accepting start requests or forwarding authenticated callbacks; keep k6/path/URL parsing unchanged. |
| Web | `CONTROL_SERVICE_TOKEN`, `ADMIN_DASHBOARD_PASSPHRASE`, `ADMIN_SESSION_SECRET`, `PUBLIC_CLIENT_COOKIE_SECRET` | `docker-compose.yml`; new or existing server-only config/startup hook; consumers in `apps/web/src/app/lib/server/backend-proxy.ts` and `public-visitor.ts` | All values are validated together at startup. Request helpers consume validated configuration (or retain defensive absence checks) without public fallbacks. Signing secrets remain distinct and server-only. |
| Worker | none of the above | shared Compose anchor only | Remove inherited token; do not add credential validation for a value the worker does not use. Keep database/Redis/ERP config behavior unchanged. |
| `runtime-setup` | none of the above | shared Compose anchor only | Remove inherited token and web secrets; retain only database/Redis values required for migrate/seed. |
| Caddy/dashboard proxy | none | `docker-compose.yml`, `infra/caddy/Caddyfile` | Remains the sole base host entry point on `8080`; it does not receive application secrets. |
| PostgreSQL/Redis | database credentials / internal data, not this task’s application control secrets | `docker-compose.yml` | No base host publication. Do not broaden this task into database authentication redesign; use the explicit loopback dev override for host-native development. |

## Port-exposure implications and caveats

- Removing `ports` does not remove service availability inside the default Compose network. API-to-PostgreSQL/Redis/orchestrator calls, worker-to-Mock-ERP calls, web server-side proxy calls, Caddy reverse proxying, health checks against `127.0.0.1`, and `depends_on: condition: service_healthy` continue to work.
- Host calls to the direct service URLs will stop working by design in the base runtime. Update health/maintenance/smoke commands in the same change or route them through an explicit loopback-only tooling override; otherwise the security fix will appear as an unrelated operational regression.
- Caddy currently routes `/dashboard/events` to API and all other traffic to web. Do not expose generic API, Mock ERP, or load-orchestrator passthrough routes merely to preserve direct debugging; that would move rather than remove the attack surface.
- `.devcontainer/docker-compose.yml` merges with the root file and may intentionally need development ports/forwarding. Keep any such exposure explicit in that development-only layer, aligned with `docs/runtime_topology.md`, and avoid duplicate/conflicting port declarations after the base ports are removed.
- Compose interpolation happens before container startup, whereas `env_file` supplies container environment. Choose one consistent secret-injection mechanism and verify both missing-file and missing-value behavior. Runtime fail-fast checks are still required even if Compose uses `${VAR:?message}`, because services can be launched outside Compose.
- A length check alone is insufficient: all existing `change-me-*` strings are non-empty and long enough to pass ordinary HMAC minimums. The validator must explicitly reject known placeholders. This task need not implement a general password-strength estimator or inspect arbitrary secret entropy.

## Focused verification guidance

No app startup is necessary to validate the document, but the implementing agent must add boundary-focused automated coverage and perform static Compose checks:

- Extend API config tests in `apps/api/test/api.test.ts` (or extract a focused runtime-config test) to prove missing, whitespace-only, known-placeholder, and valid tokens behave as specified.
- Extend `apps/mock-erp/test/unit/mock-erp.test.ts` with known-placeholder rejection in addition to its existing missing-token assertion.
- Add equivalent loader coverage for `apps/load-orchestrator/src/runtime/config.ts`; pin missing, blank, known-placeholder, and valid-token behavior.
- Add web server-config tests covering all four variables: aggregate reporting for multiple offenders, missing/blank values, each known placeholder, fully valid distinct values, and confirmation that error text does not contain supplied secret values. Pin the startup-hook call separately if the current Next test setup can import it reliably.
- Add a static assertion or review check that rendered base Compose publishes only `8080`, that no rendered environment contains `change-me-*`, and that worker/setup/proxy environments do not contain the four application secrets. If a dev/debug override is added, render it separately and confirm direct bindings are loopback-only.
- Run `docker compose config` with non-secret dummy values supplied only for validation; inspect `docker compose config --services` and the rendered `ports`/`environment` sections. Also render the root plus `.devcontainer/docker-compose.yml` and any new development override to catch merge behavior. Do not commit the temporary validation values.
- Search the runtime path for residual executable fallbacks, including `docker-compose*.yml`, `.env.example` loading, web getters, and all service loaders. Documentation may name the already-known placeholder strings to explain migration, but no runtime path may select them as defaults.

## Scope and non-goals

- Keep the existing session-cookie, visitor-cookie, service-token header, constant-time comparison, route authorization, and control-operation semantics intact; this task changes how credentials enter and gate process startup.
- Do not redesign the authorization model, add a secret manager product, rotate real deployed credentials, or place secrets in browser-readable `NEXT_PUBLIC_*` variables.
- Do not remove container health checks or internal service ports. Remove host publication from the base runtime while preserving Compose-network reachability.
- Do not redesign PostgreSQL/Redis authentication in this task. Reducing their default host exposure is in scope; broader infrastructure credential hardening is separate.
- Preserve the full local reference topology, explicit setup lifecycle, host-native development option, and current single-origin dashboard contract. Adjust scripts/overrides/docs only as needed to make those workflows explicit and compatible with the hardened defaults.
