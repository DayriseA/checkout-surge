#!/bin/sh
# Supplementary probe: a sold-out-heavy constant arrival near the local sold-out capacity, both modes.
set -e
cd "$(dirname "$0")/.."
measure() { node scripts/run-with-env.mjs node scripts/capacity-measurement.mjs "$@"; }
measure study-21/runs/probe.json study-21/results/probe-baseline.jsonl
API_BUY_PATH_MODE=redis node scripts/run-with-env.mjs docker compose -f docker-compose.yml \
  -f docker-compose.dev.yml up -d --force-recreate --wait api
measure study-21/runs/warmup.json study-21/results/warmup-redis-probe.jsonl
measure study-21/runs/probe.json study-21/results/probe-redis.jsonl
echo done
