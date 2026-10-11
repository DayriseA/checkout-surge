#!/bin/sh
set -eu
role="$1"
mkdir -p /persistent/cpu
while :; do
  if [ -r /sys/fs/cgroup/cpu.stat ]; then
    usage=$(awk '$1=="usage_usec" { print $2 }' /sys/fs/cgroup/cpu.stat)
    version=2
  elif [ -r /sys/fs/cgroup/cpu,cpuacct/cpuacct.usage ]; then
    usage=$(awk '{ printf "%.0f", $1/1000 }' /sys/fs/cgroup/cpu,cpuacct/cpuacct.usage)
    version=1
  else
    usage=$(awk '{ printf "%.0f", $1/1000 }' /sys/fs/cgroup/cpuacct/cpuacct.usage)
    version=1
  fi
  if [ -r /sys/fs/cgroup/memory.current ]; then
    memory=$(cat /sys/fs/cgroup/memory.current)
  else
    memory=$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes)
  fi
  printf '{"epochSeconds":%s,"cgroupVersion":%s,"usageUsec":%s,"memoryBytes":%s}\n' "$(date +%s)" "$version" "$usage" "$memory" > "/persistent/cpu/$role.next"
  mv "/persistent/cpu/$role.next" "/persistent/cpu/$role.json"
  sleep 1
done
