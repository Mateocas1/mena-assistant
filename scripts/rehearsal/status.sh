#!/usr/bin/env bash
# Shows the health of every piece of the rehearsal: mena-nails API, web dev
# server, bot process (heartbeat + Telegram getMe) and the turnos backend.
#
# Usage: scripts/rehearsal/status.sh
# Exit code: 0 when every started piece is healthy, 1 otherwise.
set -euo pipefail

# shellcheck source=./lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

FAILED=0
ok() { printf '  ok    %s\n' "$*"; }
bad() {
  printf '  FAIL  %s\n' "$*"
  FAILED=1
}

echo "mena-nails API ($API_ORIGIN)"
live="$(http_code "$API_ORIGIN/livez" || true)"
ready="$(http_code "$API_ORIGIN/readyz" || true)"
[ "$live" = "200" ] && ok "/livez 200" || bad "/livez -> ${live:-no answer}"
[ "$ready" = "200" ] && ok "/readyz 200 (database reachable)" || bad "/readyz -> ${ready:-no answer}"

echo "mena-nails compose (project $PROJECT)"
if docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null | grep -q .; then
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps --format '  {{.Service}} {{.State}} {{.Health}}' 2>/dev/null
else
  bad "no containers for project $PROJECT"
fi

echo "web dev server ($WEB_ORIGIN)"
web="$(http_code "$WEB_ORIGIN/" || true)"
[ "$web" = "200" ] && ok "HTTP 200" || bad "HTTP ${web:-no answer} (log: $WEB_LOG)"

echo "bot"
if pid_alive "$BOT_PID_FILE"; then
  ok "process alive (pid $(cat "$BOT_PID_FILE"))"
  if [ -f "$STATE_DIR/bot-alive" ]; then
    age="$(( $(date +%s) - $(stat -c %Y "$STATE_DIR/bot-alive") ))"
    if [ "$age" -le 90 ]; then ok "heartbeat ${age}s old"; else bad "heartbeat ${age}s old (stale)"; fi
  else
    bad "no heartbeat file at $STATE_DIR/bot-alive"
  fi
  load_env_file "$TELEGRAM_ENV" no >/dev/null 2>&1 || true
  load_telegram_env || warn "no Telegram credentials in $TELEGRAM_ENV — the bot was skipped"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    me="$(
      printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$TELEGRAM_BOT_TOKEN" |
        curl -s --max-time 15 -K - | jq -r 'if .ok then "@" + .result.username else ("error: " + (.description // "unknown")) end'
    )"
    case "$me" in
      @*) ok "Telegram getMe $me" ;;
      *) bad "Telegram getMe $me" ;;
    esac
  fi
else
  bad "not running (log: $BOT_LOG)"
fi

echo "turnos backend"
turnos="$(grep -m1 '^TURNOS_BACKEND=' "$STATE_FILE" 2>/dev/null | cut -d= -f2 || true)"
turnos="${turnos:-mock}"
if [ "$turnos" = "http" ]; then
  base="${ASSISTANT_API_BASE_URL:-}"
  if [ -z "$base" ]; then
    bad "TURNOS_BACKEND=http but ASSISTANT_API_BASE_URL is empty"
  else
    ok "http -> $base (Convex dev)"
  fi
else
  printf '  ok    mock (in-memory fixtures; Convex dev deployment not attached)\n'
fi

exit "$FAILED"
