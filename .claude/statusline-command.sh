#!/usr/bin/env bash
input=$(cat)

# Colors
CYAN=$'\033[36m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
MAGENTA=$'\033[35m'
DIM=$'\033[2m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

model=$(echo "$input" | jq -r '.model.display_name // "unknown"')
effort=$(echo "$input" | jq -r '.effort.level // empty')

line1="${BOLD}${CYAN}${model}${RESET}"
[ -n "$effort" ] && line1="$line1 ${MAGENTA}(effort: $effort)${RESET}"

fmt_tokens() {
  awk -v n="$1" 'BEGIN {
    if (n >= 1000000) printf "%.1fM", n/1000000;
    else if (n >= 1000) printf "%.1fk", n/1000;
    else printf "%d", n
  }'
}

fmt_reset() {
  # Accepts unix epoch or ISO timestamp -> local HH:MM (with weekday if not today)
  local ts="$1" ref
  case "$ts" in
    ''|*[!0-9]*) ref="$ts" ;;       # ISO string
    *) ref="@$ts" ;;                 # unix epoch
  esac
  if [ "$(date -d "$ref" +%F 2>/dev/null)" = "$(date +%F)" ]; then
    date -d "$ref" +'%H:%M' 2>/dev/null || echo "$ts"
  else
    date -d "$ref" +'%a %H:%M' 2>/dev/null || echo "$ts"
  fi
}

pct_color() {
  # Color a usage percentage: green < 50, yellow < 80, red otherwise
  awk -v p="$1" 'BEGIN { if (p < 50) print "g"; else if (p < 80) print "y"; else print "r" }'
}

color_for() {
  case "$(pct_color "$1")" in
    g) echo "$GREEN" ;;
    y) echo "$YELLOW" ;;
    r) echo "$RED" ;;
  esac
}

five=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
five_reset=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
week=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
week_reset=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')

line2=""
if [ -n "$five" ]; then
  part="$(color_for "$five")5h limit: $(printf '%.0f' "$five")%${RESET}"
  [ -n "$five_reset" ] && part="$part ${DIM}(resets $(fmt_reset "$five_reset"))${RESET}"
  line2="$part"
fi
if [ -n "$week" ]; then
  part="$(color_for "$week")7d limit: $(printf '%.0f' "$week")%${RESET}"
  [ -n "$week_reset" ] && part="$part ${DIM}(resets $(fmt_reset "$week_reset"))${RESET}"
  line2="${line2:+$line2  }$part"
fi

ctx_remaining=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')
ctx_in=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
ctx_out=$(echo "$input" | jq -r '.context_window.total_output_tokens // empty')
ctx_size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')
cu_cc=$(echo "$input" | jq -r '.context_window.current_usage.cache_creation_input_tokens // empty')
cu_cr=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // empty')
over200k=$(echo "$input" | jq -r '.exceeds_200k_tokens // empty')

ctx_parts=()
if [ -n "$ctx_remaining" ]; then
  used=$(awk -v r="$ctx_remaining" 'BEGIN { print 100 - r }')
  ctx_parts+=("$(color_for "$used")$(printf '%.0f%%' "$ctx_remaining") free${RESET}")
fi
[ -n "$ctx_in" ] && ctx_parts+=("input: $(fmt_tokens "$ctx_in")")
[ -n "$ctx_out" ] && ctx_parts+=("output: $(fmt_tokens "$ctx_out")")
[ -n "$ctx_size" ] && ctx_parts+=("window: $(fmt_tokens "$ctx_size")")
[ -n "$cu_cc" ] && ctx_parts+=("${DIM}cache write: $(fmt_tokens "$cu_cc")${RESET}")
[ -n "$cu_cr" ] && ctx_parts+=("${DIM}cache read: $(fmt_tokens "$cu_cr")${RESET}")
[ "$over200k" = "true" ] && ctx_parts+=("${RED}over 200k!${RESET}")

if [ ${#ctx_parts[@]} -gt 0 ]; then
  ctx_str="Context: $(IFS='|'; echo "${ctx_parts[*]}")"
  ctx_str="${ctx_str//|/ ${DIM}|${RESET} }"
else
  ctx_str="Context: n/a"
fi
line1="$line1  $ctx_str"

printf '%b\n%b' "$line1" "${line2:-}"
