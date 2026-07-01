#!/usr/bin/env bash
set -euo pipefail

apt_packages=(bubblewrap ripgrep curl jq)
apt_max_attempts=5

bash .devcontainer/repair-git-worktree.sh

persist_home_config() {
  local name="$1"
  local target_dir="$2"
  local home_dir="$HOME/${name}"

  sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$target_dir"

  if [ -L "$home_dir" ]; then
    if [ "$(readlink "$home_dir")" = "$target_dir" ]; then
      return
    fi

    rm "$home_dir"
  elif [ -d "$home_dir" ]; then
    if [ "$home_dir" -ef "$target_dir" ]; then
      return
    fi

    cp -a "$home_dir"/. "$target_dir"/
    rm -rf "$home_dir"
  elif [ -e "$home_dir" ]; then
    rm "$home_dir"
  fi

  mkdir -p "$(dirname "$home_dir")"
  ln -s "$target_dir" "$home_dir"
}

setup_codex_persistence() {
  if [ "${CODESPACES:-}" = "true" ]; then
    persist_home_config ".codex" "/workspaces/.codex"
  else
    persist_home_config ".codex" "/mnt/codex-config"
  fi
}

setup_claude_persistence() {
  if [ "${CODESPACES:-}" = "true" ]; then
    persist_home_config ".claude" "/workspaces/.claude"
  else
    persist_home_config ".claude" "/mnt/claude-config"
  fi
}

setup_kilo_persistence() {
  if [ "${CODESPACES:-}" = "true" ]; then
    persist_home_config ".config/kilo" "/workspaces/.kilo-config"
    persist_home_config ".local/share/kilo" "/workspaces/.kilo-data"
  else
    persist_home_config ".config/kilo" "/mnt/kilo-config"
    persist_home_config ".local/share/kilo" "/mnt/kilo-data"
  fi
}

prefer_https_apt_sources() {
  local sources_file

  for sources_file in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
    if [ -f "$sources_file" ]; then
      sudo sed -i \
        -e 's|http://archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
        -e 's|http://security.ubuntu.com/ubuntu|https://security.ubuntu.com/ubuntu|g' \
        "$sources_file"
    fi
  done
}

run_with_retries() {
  local description="$1"
  local attempt=1
  shift

  until "$@"; do
    if [ "$attempt" -ge "$apt_max_attempts" ]; then
      echo "${description} failed after ${apt_max_attempts} attempts." >&2
      return 1
    fi

    echo "${description} failed; retrying (${attempt}/${apt_max_attempts})..." >&2
    attempt=$((attempt + 1))
    sleep $((attempt * 2))
  done
}

apt_update() {
  sudo apt-get \
    -o Acquire::Retries=3 \
    -o Acquire::http::Timeout=30 \
    -o Acquire::https::Timeout=30 \
    -o APT::Update::Error-Mode=any \
    update
}

install_apt_packages() {
  local missing_packages=()
  local package

  for package in "${apt_packages[@]}"; do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed"; then
      missing_packages+=("$package")
    fi
  done

  if [ "${#missing_packages[@]}" -eq 0 ]; then
    return
  fi

  prefer_https_apt_sources
  run_with_retries "apt-get update" apt_update
  run_with_retries "apt-get install" sudo env DEBIAN_FRONTEND=noninteractive apt-get \
    -o Acquire::Retries=3 \
    install -y --no-install-recommends "${missing_packages[@]}"
}

setup_codex_persistence
setup_claude_persistence
setup_kilo_persistence
install_apt_packages

npm i -g @openai/codex
npm i -g @anthropic-ai/claude-code

corepack enable
corepack prepare pnpm@10.33.2 --activate

sudo mkdir -p /pnpm-store
sudo chown -R "$(id -u):$(id -g)" /pnpm-store
pnpm config set store-dir /pnpm-store --location user

find . -path './.git' -prune -o -type d -name node_modules -exec sudo chown -R "$(id -u):$(id -g)" {} +

if [ -f package.json ]; then
  pnpm install
else
  echo "No package.json found; skipping pnpm install until the workspace is scaffolded."
fi
