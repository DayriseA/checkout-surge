#!/bin/sh
# Runs a core data service (PostgreSQL or Redis) and delays its shutdown. Fly signals every
# container of the Machine at the same time, so without this delay the data services stop
# while the application containers are still draining.
# Usage: delayed-stop.sh <stop-signal> <command> [args...]
set -u

stop_signal="$1"
shift

"$@" &
service_pid=$!
stopping=false
trap 'stopping=true; sleep 10; kill -s "$stop_signal" "$service_pid"' INT TERM

# A trapped signal interrupts the first wait; the service then exits after the delayed signal.
wait "$service_pid"
status=$?
if [ "$stopping" = true ]; then
  wait "$service_pid"
  status=$?
fi
exit "$status"
