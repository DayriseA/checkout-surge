-- This hand-authored expression index is the authoritative cross-writer admission
-- invariant. Drizzle schema generation does not reliably round-trip it; preserve
-- this migration when resetting, squashing, or regenerating migrations.
--
-- The CREATE intentionally fails when historical data contains more than one
-- non-terminal run. Inspect and resolve such data explicitly before migrating:
-- SELECT id, status FROM demo_runs
-- WHERE status IN ('starting', 'active', 'draining') ORDER BY created_at;
CREATE UNIQUE INDEX "demo_runs_single_non_terminal_idx"
  ON "demo_runs" ((status IN ('starting', 'active', 'draining')))
  WHERE status IN ('starting', 'active', 'draining');
