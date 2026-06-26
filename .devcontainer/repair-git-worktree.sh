#!/usr/bin/env bash
set -euo pipefail

workspace_dir="${1:-/workspaces/checkout-surge}"
common_git_dir="${DEVCONTAINER_COMMON_GIT_DIR:-/workspaces/checkout-surge-host-git}"
git_file="${workspace_dir}/.git"

configure_safe_directory() {
  if ! git config --global --get-all safe.directory | grep -Fxq "$workspace_dir"; then
    git config --global --add safe.directory "$workspace_dir"
  fi
}

if [ -d "$git_file" ]; then
  configure_safe_directory
  exit 0
fi

if [ ! -f "$git_file" ]; then
  exit 0
fi

if git -C "$workspace_dir" rev-parse --git-dir >/dev/null 2>&1; then
  configure_safe_directory
  exit 0
fi

host_gitdir="$(sed -n 's/^gitdir: //p' "$git_file" | head -n 1 | tr '\\' '/')"
if [ -z "$host_gitdir" ]; then
  echo "Unable to repair Git metadata: ${git_file} does not contain a gitdir pointer." >&2
  exit 1
fi

worktree_name="$(basename "$host_gitdir")"
container_gitdir="${common_git_dir}/worktrees/${worktree_name}"

if [ ! -d "$common_git_dir" ]; then
  echo "Unable to repair Git metadata: ${common_git_dir} is not mounted." >&2
  exit 1
fi

if [ ! -d "$container_gitdir" ]; then
  echo "Unable to repair Git metadata: ${container_gitdir} does not exist." >&2
  exit 1
fi

container_git_file="/tmp/checkout-surge-${worktree_name}.git"
printf 'gitdir: %s\n' "$container_gitdir" > "$container_git_file"
sudo mount --bind "$container_git_file" "$git_file"

configure_safe_directory
git -C "$workspace_dir" rev-parse --show-toplevel >/dev/null
