#!/bin/sh
# Runs the grid against each buy-path mode, restarting the API (and a warm-up run) per series.
set -e
cd "$(dirname "$0")/.."
measure() { node scripts/run-with-env.mjs node scripts/capacity-measurement.mjs "$@"; }
for mode in ${MODES:-redis baseline}; do
  echo "$(date -u +%FT%T.%3NZ) restart api mode=$mode"
  API_BUY_PATH_MODE=$mode node scripts/run-with-env.mjs docker compose -f docker-compose.yml \
    -f docker-compose.dev.yml up -d --force-recreate --wait api
  measure study-21/runs/warmup.json "study-21/results/warmup-$mode.jsonl"
  measure study-21/runs/grid.json "study-21/results/grid-$mode.jsonl"
done
echo "$(date -u +%FT%T.%3NZ) done"
