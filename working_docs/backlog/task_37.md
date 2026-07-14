# Task 37: Add a delete/archive path for admin-created presets

## Execution context

- **Execution order:** This is task 37 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** web + API / admin console
- **Source:** browser testing (medium, confirmed)
- **Solved elsewhere:** n/a — capability gap; a tester code-scan found list/save/duplicate/copy-to-custom paths but no preset delete route at all.
- **Locations:** `/admin` preset panel; API preset routes

Duplicated presets remain selectable forever; the only actions are `Start Admin Run`, `Save Preset`, `Copy to Custom`, and `Duplicate`. Accidental duplicates (see entry 36) permanently clutter the operator console. Requires an API delete route (protected), a UI control with confirmation, and probably guardrails for seeded/public presets.

## Implementation record (Task 37)

### Status
Complete. Soft archival of operator-created admin presets is implemented end to end with contracts, migration, API service/route, protected web proxy, and admin UI. Hard deletion was deliberately not added.

### Completed scope by boundary
- **`@checkout-surge/contracts`** (`packages/contracts/src/demo.ts`): added `adminPresetListItemSchema`/`AdminPresetListItem` (strict `demoPresetContractSchema` + server-computed `canArchive`); changed `adminPresetListResponseSchema` to use the admin item type; added strict `archiveAdminPresetRequestSchema` (`{ slug }` trimmed/non-empty) and `archiveAdminPresetResponseSchema` (`{ slug, archivedAt, timestamp }` with ISO validation). `DELETE` reuses the existing `adminPresetListPath` (`/admin/demo/presets`). Active lists never expose raw archive timestamps.
- **`@checkout-surge/db`**: added `demo_presets.is_system` (boolean, default false, not null) and `demo_presets.archived_at` (nullable timestamptz) plus an `archived_at` index; hand-authored migration `0009_demo_preset_archive_lifecycle.sql` (idempotent `ADD COLUMN IF NOT EXISTS`, index, and `is_system = true` backfill for the eight canonical slugs) with a journal entry; `seed.ts` now writes every canonical seed preset with `isSystem: true`, and mutable seeded admin presets keep their operator configuration on reseed; the `ON CONFLICT DO UPDATE` uses a `setWhere` predicate (`is_system = false`) so the system-marker repair and `updatedAt` bump fire only when the existing row is falsely non-system, making an already-system row a true no-op on reseed.
- **API service** (`demo-run-service.ts`): centralized archive eligibility properties (admin + editable + non-custom + non-system + active) drive both the admin-list `canArchive` capability and archival enforcement; `listPublicPresets`/`listAdminPresets`/`readPreset` ignore archived rows (so archived presets cannot be saved, copied, duplicated, or started); duplicate target conflict check still scans all rows (global slug index); duplicated presets are explicitly non-system/active; `archiveAdminPreset` anchors its update to the loaded row ID and atomically rechecks every persisted eligibility dimension before setting `archivedAt`; a lost race to an archive remains `preset_not_found`, while a lost race to a protection change is `preset_not_archivable`; unknown/already-archived → `preset_not_found`, ineligible → `preset_not_archivable`.
- **API route** (`demo-run-routes.ts`): registered `DELETE adminPresetListPath` — token check before body parse, validates with the request schema, calls only the service, returns 200 with the validated response; `mapDemoRunError` maps `preset_not_found` → 404 and `preset_not_archivable` → 409. Controller fake in `api.test.ts` updated.
- **Web proxy** (`apps/web/src/app/api/admin/demo/presets/route.ts`): added a `DELETE` export reusing `authorizeAdminProxy` then `readJsonRequest`/`validateJson` (shared request schema), proxying `DELETE` to `${apiBaseUrl()}${adminPresetListPath}` with the server-owned control token and validating the upstream success with the archive response schema.
- **Admin controller/view**: `AdminPresetView`/`AdminPresetController` consume `AdminPresetListItem`; an `Archive Preset` control is disabled for non-archivable presets and while pending; `window.confirm` (preset-name-specific message explaining the preset leaves the active list while historical runs are retained) gates the request; on confirm it sends the validated DELETE, refreshes the list, selects the first remaining preset (or clears draft state), resets dirty-draft bookkeeping, resets the duplicate target to the newly selected slug (or empty state), and shows a success/failure notice. The archive workflow is explicit and does not reuse the generic `mutate` helper (whose response carries a live preset). Task 36's FormData duplicate submission is untouched.
- **Documentation** (`docs/`): updated `architecture.md` (`/admin` capability summary and admin-surface-abuse section), `core_business_entities.md` (`DemoPreset` logical fields include `isSystem`/nullable `archivedAt`; archival semantics), `admin_access_protection.md` (goals, admin role/capabilities, admin controls, access matrix, preset implementation note, frontend note, security testing expectations), and `local_development.md` (`/admin` operator-surface description). No `docs/` file promises physical deletion, slug reuse, or a restore UI.

### Material design decisions and rationale
- **Soft archive, not delete.** `demo_runs.preset_id` is `ON DELETE RESTRICT`; a used preset cannot be hard-deleted without breaking history. Archival keeps the row and the FK reference intact while excluding it from active reads/lists.
- **System provenance.** `is_system` distinguishes seeded/reserved slugs from operator duplicates so only operator-created presets are archivable. The migration backfill and seed both mark the canonical reserved slugs as system, and the seed conditionally repairs the marker on conflict (only when the existing row is falsely non-system) so a reserved slug can never stay falsely non-system while an already-system row is a true no-op on reseed.
- **Protected presets.** Public presets, `public-custom`, the persisted `custom` scratch preset, and all seeded/system admin presets are non-archivable by predicate on the service boundary (not merely UI disabling).
- **Idempotent migration.** `ADD COLUMN IF NOT EXISTS` keeps the migration safe under the repo's "delete last N journal rows and re-run" integration tests.

### Migration / backfill behavior
`0009_demo_preset_archive_lifecycle.sql` adds `is_system` (default false) and `archived_at`, creates the `archived_at` index, and backfills `is_system = true` for `preview-1k`, `surge-5k`, `surge-10k`, `idempotency-check-200`, `public-custom`, `admin-smoke-steady`, `admin-failure-path`, `custom`. Pre-existing operator/duplicate rows remain `is_system = false` and active.

### Verification commands and results
- `pnpm --filter @checkout-surge/contracts test:unit` / `type-check` / `lint` — pass (56 tests).
- `packages/db` `pnpm test:integration` — pass (63 tests); includes new `0009` migrate-only backfill test (canonical slug backfilled to `is_system = true`, operator duplicate stays `is_system = false`, both active) and two new seed-idempotency tests (already-system mutable admin preset is a true no-op on reseed; falsely non-system mutable preset is repaired to `is_system = true` without overwriting operator configuration). `type-check`/`lint` — pass.
- `apps/api` `pnpm type-check`/`lint`/`build` — pass; `pnpm test:api` (full suite) — 334 pass, 1 pre-existing unrelated failure (see below). The focused `api.test.ts` DELETE-route tests pass (tokenless 401, invalid 400, valid 200 with `archiveAdminPresetResponseSchema`, `preset_not_archivable` → 409, `preset_not_found` → 404); the focused preset-management service run passes (11 tests) and includes deterministic lost-race coverage for both a protection change (`preset_not_archivable`, still active) and a concurrent archive (`preset_not_found`).
- `apps/web` `pnpm test:unit` — pass (138 tests), including controller assertions that archive refresh resets the duplicate target to the newly selected preset and removes the editor when the last preset is archived; `type-check`/`lint` — pass. The original Task 37 web build also passed.
- `git diff --check` — clean.

### Skipped checks with reasons
- `pnpm test:composition` / `pnpm test:characterization` — intentionally not run (repo policy; slow, Docker-bound).
- `apps/api` full `pnpm test:api` shows one pre-existing unrelated failure: `demo-run-finalization-service.test.ts > "keeps run and summary terminal state consistent when reset races with finalization"` fails via an unhandled rejection (`Admin reset traffic aborter is not configured`). It reproduces in isolation, touches no Task 37 files (no preset/archive/route code), and is a reset/finalization race leak. Not introduced by this task; not fixed by this correction pass; recorded as follow-up below.

### Follow-up / remaining risk
- The pre-existing `demo-run-finalization-service` reset-race unhandled-rejection flake should be investigated separately (out of scope for Task 37; do not bundle).
- Task 38 owns the canonical error-envelope/correlation refactor; this task preserved current proxy/error conventions and 409-for-not-archivable mapping.
- Archival is irreversible from the console (no restore control); intentionally minimal per scope. A future restore would clear `archived_at`; the predicate already keys off `archivedAt === null`.
