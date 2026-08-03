ALTER TABLE "demo_run_summaries" ADD COLUMN "replay_possible" boolean NOT NULL DEFAULT false;
ALTER TABLE "demo_run_summaries" ALTER COLUMN "replay_possible" DROP DEFAULT;
