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

# Image builds go through a TLS-intercepting proxy whose CA the official node image
# does not trust. The CA only exists once the session starts (and is refreshed during
# it), so shadow the base tag used by every Dockerfile here, from the untouched copy
# the environment setup script tags as node-upstream.
PROXY_CA=/root/.ccr/ca-bundle.crt
if [ -f "$PROXY_CA" ] && docker image inspect node-upstream:22-bookworm-slim >/dev/null 2>&1; then
  ca_build_dir=$(mktemp -d)
  cp "$PROXY_CA" "$ca_build_dir/proxy-ca.crt"
  cat >"$ca_build_dir/Dockerfile" <<'EOF'
FROM node-upstream:22-bookworm-slim
COPY proxy-ca.crt /usr/local/share/ca-certificates/proxy-ca.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/proxy-ca.crt
EOF
  docker build -q -t node:22-bookworm-slim "$ca_build_dir" >&2
  rm -rf "$ca_build_dir"
else
  echo "session-start: $PROXY_CA or node-upstream:22-bookworm-slim missing, skipping proxy-trusting node base image" >&2
fi

[ -f .env ] || cp .env.example .env
[ -f .env.test ] || cp .env.test.example .env.test
for key in CONTROL_SERVICE_TOKEN ADMIN_DASHBOARD_PASSPHRASE ADMIN_SESSION_SECRET PUBLIC_CLIENT_COOKIE_SECRET; do
  grep -q "^$key=." .env || sed -i "s|^$key=.*|$key=$(openssl rand -hex 24)|" .env
done

# stdout of a SessionStart hook is added to Claude's context: keep it for the note below.
pnpm install >&2

# Chromium refuses its sandbox when running as root, which is always the case here.
sed 's/"chromiumSandbox": true/"chromiumSandbox": false/' .playwright/cli.config.json >.playwright/cli.config.cloud.json

echo 'export NEXT_TELEMETRY_DISABLED=1' >>"${CLAUDE_ENV_FILE:-/dev/null}"
echo "Cloud session: pass --config=.playwright/cli.config.cloud.json to 'playwright-cli open' (the default config enables the Chromium sandbox, which fails as root)."
exit 0
