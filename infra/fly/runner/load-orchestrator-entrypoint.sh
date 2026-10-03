#!/bin/sh
# Fly runner load-orchestrator entrypoint. It runs as root only to apply the kernel settings
# the k6 burst needs (what Compose sets through `ulimits` and `sysctls`), then drops to the
# image's non-root `node` user. Any refused setting fails the start (set -e plus read-back),
# so k6 never runs with silently reduced limits.
set -eu

nofile_limit=1048576
port_range="10240 65535"
tcp_tw_reuse=1

# k6 inherits this limit through the Node process that spawns it.
ulimit -Hn "$nofile_limit"
ulimit -Sn "$nofile_limit"

set_sysctl() {
  echo "$2" >"/proc/sys/$1"
  if [ "$(tr -s '[:space:]' ' ' <"/proc/sys/$1" | sed 's/ $//')" != "$2" ]; then
    echo "$1 was not set to $2" >&2
    exit 1
  fi
}

set_sysctl net/ipv4/ip_local_port_range "$port_range"
set_sysctl net/ipv4/tcp_tw_reuse "$tcp_tw_reuse"

# setpriv keeps root's HOME; k6 refuses to start when it cannot stat $HOME/.config/k6.
export HOME=/home/node
exec setpriv --reuid=node --regid=node --init-groups "$@"
