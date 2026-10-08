#!/bin/sh
# Samples container CPU about every two seconds: "<epoch seconds> <container> <cpu%>".
while true; do
  docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' | sed "s/^/$(date +%s.%N) /"
done
