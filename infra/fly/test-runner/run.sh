#!/usr/bin/env bash
# Runs a pnpm script (default: the full `test` suite) for a pushed git ref on the cs-test-runner
# Machine, streaming output. Exits non-zero when the remote run fails. Stops the Machine at the end.
# Usage: infra/fly/test-runner/run.sh <branch|sha|origin/branch> [pnpm-script]
set -uo pipefail
export MSYS_NO_PATHCONV=1 # keep Git Bash from rewriting the remote /data paths

app=cs-test-runner
ref=${1:?usage: run.sh <branch|sha|origin/branch> [pnpm-script]}
ref=${ref#origin/}
script=${2:-test}
[[ $ref =~ ^[A-Za-z0-9._/-]+$ && $script =~ ^[A-Za-z0-9:._-]+$ ]] || { echo "Invalid ref or script." >&2; exit 2; }

machine=$(flyctl machines list --app "$app" --quiet | awk 'NF { print $1; exit }')
[[ -n $machine ]] || { echo "No Machine in $app; see README.md." >&2; exit 2; }
trap 'echo "Stopping $machine..."; flyctl machine stop "$machine" --app "$app" >/dev/null' EXIT

flyctl machine start "$machine" --app "$app" >/dev/null 2>&1 # already started is fine
flyctl machine wait "$machine" --app "$app" --state started >/dev/null

remote=$(cat <<EOF
set -euo pipefail
timeout 60 sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done'
[ -d /data/repo/.git ] || git clone -q https://github.com/DayriseA/checkout-surge.git /data/repo
cd /data/repo
git fetch -q origin $ref
git -c advice.detachedHead=false checkout -qf FETCH_HEAD
git clean -qfd
echo "==> \$(git rev-parse --short HEAD): pnpm $script"
pnpm install --frozen-lockfile
pnpm test:infra:up
pnpm $script
EOF
)

# Base64 sidesteps quoting through flyctl and the remote shell.
flyctl ssh console --app "$app" --machine "$machine" --quiet -C "bash -c 'echo $(base64 -w0 <<<"$remote") | base64 -d | bash'"
status=$?
echo "==> $ref: pnpm $script exited $status after ${SECONDS}s"
exit "$status"
