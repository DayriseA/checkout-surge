# Fly test runner

Runs the heavy test suite for a pushed git ref on a dedicated Fly Machine (app `cs-test-runner`, org `playground-416`, region `cdg`) instead of the local laptop.

## Usage (Git Bash, from the repo root)

```bash
infra/fly/test-runner/run.sh origin/dev              # pnpm test:infra:up && pnpm test
infra/fly/test-runner/run.sh <branch|sha> type-check # any other root pnpm script
```

The script starts the Machine, fetches the ref from GitHub (push it first), runs `pnpm install --frozen-lockfile`, `pnpm test:infra:up`, then the script, streams the output, exits non-zero on failure and stops the Machine. Run one at a time: concurrent runs share the same checkout.

## How it works

- The image (`Dockerfile`) is Node 22 + pnpm + a Docker engine, so `docker-compose.test.yml` runs unchanged (PostgreSQL on 56432, Redis on 6380).
- The `data` volume (`/data`) keeps the checkout, `node_modules`, the pnpm store, turbo's local cache and Docker images, so reruns are warm. Turbo may replay cached `test:unit` results for unchanged inputs, exactly as it does locally.
- Safeguard: the Machine's main process is `sleep $MAX_RUNTIME_SECONDS` (2 h, `fly.toml`), so a forgotten Machine stops itself.
- Size: `performance-8x` (8 CPUs, 16 GB); on `performance-4x` the concurrent unit phase starved a 5 s web test into a timeout. Peak memory is about 3 GB. Cost in `cdg`: about $0.42/hour while running, plus about $3/month for the 20 GB volume.

## Setup and image updates

```bash
cd infra/fly/test-runner
flyctl apps create cs-test-runner --org playground-416   # once
flyctl deploy --app cs-test-runner --config fly.toml --ha=false --yes
flyctl machines list --app cs-test-runner --quiet        # then stop it: flyctl machine stop <id> --app cs-test-runner
```
