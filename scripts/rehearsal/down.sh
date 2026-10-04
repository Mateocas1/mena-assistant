#!/usr/bin/env bash
# Stops everything `up.sh` started: the bot, the web dev server and the
# mena-nails compose stack (project `mena-rehearsal` only).
#
# Usage: scripts/rehearsal/down.sh [--purge]
#   --purge  also removes the PostgreSQL volume, so the next `up.sh` seeds a
#            fresh database.
set -euo pipefail

# shellcheck source=./lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

stop_bg() {
  local name="$1" pid_file="$2"
  pid_alive "$pid_file" || {
    log "$name is not running"
    rm -f "$pid_file"
    return 0
  }
  local pid
  pid="$(cat "$pid_file")"
  log "stopping $name (pid $pid)"
  # The pid is a session leader (setsid), so signal the whole process group to
  # reach child processes like npm → vite.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 15); do
    pid_alive "$pid_file" || break
    sleep 1
  done
  if pid_alive "$pid_file"; then
    warn "$name did not stop with SIGTERM; sending SIGKILL"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

main() {
  stop_bg "bot" "$BOT_PID_FILE"
  stop_bg "web" "$WEB_PID_FILE"

  if docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -q 2>/dev/null | grep -q .; then
    log "stopping mena-nails compose (project $PROJECT)…"
    if [ "$PURGE" = "1" ]; then
      compose_seed down -v --remove-orphans
    else
      compose_seed down --remove-orphans
    fi
  else
    log "mena-nails compose (project $PROJECT) is not running"
  fi

  # e2e:stock uses its own project; never touch it here, just report it.
  if docker compose -p m3e2e -f "$COMPOSE_FILE" ps -q 2>/dev/null | grep -q .; then
    warn "the e2e project m3e2e is still up (pnpm e2e:stock --keep); remove it with its own command"
  fi

  if [ "$PURGE" = "1" ]; then
    log "stack down (volume removed)"
  else
    log "stack down (PostgreSQL volume preserved; use --purge to remove it)"
  fi
}

main "$@"
