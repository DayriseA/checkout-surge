#!/usr/bin/env bash
set -euo pipefail

max_attempts=30
attempt=1

bash .devcontainer/repair-git-worktree.sh

until docker info >/dev/null 2>&1; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Docker daemon did not become ready after ${max_attempts} attempts." >&2
    exit 1
  fi

  echo "Waiting for Docker daemon to become ready (${attempt}/${max_attempts})..."
  attempt=$((attempt + 1))
  sleep 2
done

echo "Docker daemon is ready. Start infrastructure explicitly with pnpm infra:up, pnpm test:infra:up, or pnpm runtime:up."

if ! npm update -g @openai/codex @kilocode/cli; then
  echo "Could not update Codex and Kilo Code CLI; continuing with the installed versions." >&2
fi

if ! claude update; then
  echo "Could not update Claude Code; continuing with the installed version." >&2
fi
