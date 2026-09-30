#!/usr/bin/env bash
# Prepares Claude Code cloud sessions: nothing here survives between sessions
# (daemons, containers, gitignored env files). Local sessions are left untouched.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

if ! docker info >/dev/null 2>&1; then
  (nohup dockerd >/var/log/dockerd.log 2>&1 &)
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi

[ -f .env ] || cp .env.example .env
[ -f .env.test ] || cp .env.test.example .env.test
for key in CONTROL_SERVICE_TOKEN ADMIN_DASHBOARD_PASSPHRASE ADMIN_SESSION_SECRET PUBLIC_CLIENT_COOKIE_SECRET; do
  grep -q "^$key=." .env || sed -i "s|^$key=.*|$key=$(openssl rand -hex 24)|" .env
done

pnpm install

echo 'export NEXT_TELEMETRY_DISABLED=1' >>"${CLAUDE_ENV_FILE:-/dev/null}"
exit 0
