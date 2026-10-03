#!/bin/sh
# Fly core API entrypoint. It runs as root only to apply the kernel settings the API
# needs, then drops to the image's non-root `node` user. Any refused setting fails the
# start (set -e), so the API never listens with silently reduced limits.
set -eu

nofile_limit=1048576
somaxconn="${API_LISTEN_BACKLOG:-8192}"

# rlimits are per process and not inherited across containers, so they are raised here.
ulimit -Hn "$nofile_limit"
ulimit -Sn "$nofile_limit"

# net.core.somaxconn belongs to the network namespace that all core containers share.
echo "$somaxconn" >/proc/sys/net/core/somaxconn
if [ "$(cat /proc/sys/net/core/somaxconn)" != "$somaxconn" ]; then
  echo "net.core.somaxconn was not set to $somaxconn" >&2
  exit 1
fi

exec setpriv --reuid=node --regid=node --init-groups "$@"
